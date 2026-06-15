import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_URL = "https://docs.qq.com/sheet/DSGxZd05GYmNXa0pN?tab=7ptfa0";
const BASE_URL = "https://docs.qq.com/sheet/DSGxZd05GYmNXa0pN";
const DEBUG_URL = process.env.CHROME_DEBUG_URL || "http://127.0.0.1:9222";
const OUTPUT_DIR = path.resolve("02_原始抓取数据", "手工补充资料");
const DEFAULT_RAW_FILE = path.join(OUTPUT_DIR, "tencent-yise-tier-list.raw.json");

const TABS = [
  { id: "7ptfa0", name: "节奏榜" },
  { id: "4xkc1k", name: "刻影一览" },
  { id: "c6nrvx", name: "刻影元件传说图纸" },
  { id: "defowf", name: "打铁教程" },
  { id: "oig40t", name: "源器词条" },
  { id: "mzr0bf", name: "一图流" },
  { id: "wu9qn3", name: "资料缓存" },
  { id: "bl899r", name: "更新日志" },
];

const EXTRACT_WORKBOOK = String.raw`(() => {
  const app = window.SpreadsheetApp;
  const wm = app.workbook.worksheetManager;
  function cellValue(cell) {
    if (!cell) return "";
    try {
      const x = app.e2eTools.getValueAndTypeFromCell(cell);
      if (x && x.value != null) {
        if (typeof x.value === "object") return JSON.stringify(x.value);
        return String(x.value);
      }
    } catch (error) {}
    for (const fn of ["getFormattedValue", "getValue", "getSourceValue"]) {
      try {
        if (typeof cell[fn] === "function") {
          const v = cell[fn]();
          if (v == null) continue;
          if (typeof v === "object") {
            if (v.value != null) return String(v.value);
            if (v.text != null) return String(v.text);
            const s = JSON.stringify(v);
            if (s && s !== "{}") return s;
          } else {
            return String(v);
          }
        }
      } catch (error) {}
    }
    if (cell.value != null) return String(cell.value);
    return "";
  }
  function clean(value) {
    const text = String(value == null ? "" : value).replace(/\r/g, "").trim();
    return text === "{}" ? "" : text;
  }
  const sheets = wm.getSheetList().map((sheet) => {
    const rowCount = sheet.getRowCount();
    const colCount = sheet.getColCount();
    const matrix = [];
    let maxRow = -1;
    let maxCol = -1;
    let nonEmpty = 0;
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row = [];
      for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
        const value = clean(cellValue(sheet.getCellDataAtPosition(rowIndex, colIndex)));
        row.push(value);
        if (value) {
          nonEmpty += 1;
          if (rowIndex > maxRow) maxRow = rowIndex;
          if (colIndex > maxCol) maxCol = colIndex;
        }
      }
      matrix.push(row);
    }
    const rows = matrix.slice(0, maxRow + 1).map((row) => row.slice(0, maxCol + 1));
    return {
      id: sheet.getSheetId(),
      name: sheet.getSheetName(),
      rowCount,
      colCount,
      usedRows: maxRow + 1,
      usedCols: maxCol + 1,
      nonEmpty,
      rows,
    };
  });
  return {
    title: (window.clientVars && window.clientVars.title) || document.title,
    sourceUrl: location.href,
    shortLink: window.clientVars && window.clientVars.shortLink,
    updatedAt: window.clientVars && window.clientVars.lastModifyTime
      ? new Date(window.clientVars.lastModifyTime).toISOString()
      : null,
    watermark: (window.clientVars && window.clientVars.watermark) || "",
    globalPadId: window.clientVars && window.clientVars.globalPadId,
    sheets,
  };
})()`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${url}`);
  return response.json();
}

async function findOrCreateTarget() {
  const targets = await fetchJson(`${DEBUG_URL}/json`);
  const existing = targets.find((target) => target.type === "page" && target.url.includes("docs.qq.com/sheet"));
  if (existing) return existing;
  return fetchJson(`${DEBUG_URL}/json/new?${encodeURIComponent(SOURCE_URL)}`, { method: "PUT" });
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      ws.close();
    },
  };
}

async function evaluate(client, expression, awaitPromise = true) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  return result.result.value;
}

async function waitForSpreadsheet(client, tabId) {
  const started = Date.now();
  while (Date.now() - started < 45000) {
    try {
      const ready = await evaluate(
        client,
        `Boolean(window.SpreadsheetApp?.workbook?.worksheetManager?.getSheetList?.().length) && location.href.includes(${JSON.stringify(tabId)})`,
      );
      if (ready) {
        await sleep(1000);
        return;
      }
    } catch (error) {}
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Tencent Docs sheet tab ${tabId}`);
}

async function extractTabs(client) {
  const results = [];
  for (const tab of TABS) {
    const url = `${BASE_URL}?tab=${encodeURIComponent(tab.id)}`;
    await client.send("Page.navigate", { url });
    await waitForSpreadsheet(client, tab.id);
    const workbook = await evaluate(client, EXTRACT_WORKBOOK);
    const active = workbook.sheets.find((sheet) => sheet.id === tab.id)
      || workbook.sheets.find((sheet) => sheet.name === tab.name)
      || workbook.sheets[0];
    results.push({
      tab,
      active,
      title: workbook.title,
      updatedAt: workbook.updatedAt,
      sourceUrl: workbook.sourceUrl,
      shortLink: workbook.shortLink,
      watermark: workbook.watermark,
      globalPadId: workbook.globalPadId,
    });
  }
  return results;
}

function cleanCell(value) {
  return String(value ?? "").replace(/\r/g, "").trim();
}

function oneLine(value) {
  return cleanCell(value).replace(/\n+/g, " / ").replace(/\s+/g, " ").trim();
}

function tsvCell(value) {
  return cleanCell(value).replace(/\t/g, " ").replace(/\n/g, " / ");
}

function trimRow(row) {
  const copy = Array.isArray(row) ? row.map((cell) => cleanCell(cell)) : [];
  while (copy.length && !copy[copy.length - 1]) copy.pop();
  return copy;
}

function countStars(value) {
  const stars = [...cleanCell(value)].filter((char) => char === "⭐").length;
  return stars || null;
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function makeUniqueHeaders(headers) {
  const totals = new Map();
  for (const header of headers) totals.set(header, (totals.get(header) ?? 0) + 1);
  return headers.map((header, index) => {
    if ((totals.get(header) ?? 0) <= 1) return header;
    return `${header}（${columnName(index)}列）`;
  });
}

function buildCharacterPayload(allTabExtracts, extractedAt) {
  const tierSheetEntry = allTabExtracts.find((entry) => entry.active?.name === "节奏榜") ?? allTabExtracts[0];
  const tierRows = tierSheetEntry.active.rows ?? [];
  const header0 = tierRows[0] ?? [];
  const header1 = tierRows[1] ?? [];
  let currentGroup = "";
  const headers = [];
  for (let col = 0; col < Math.max(header0.length, header1.length, tierSheetEntry.active.usedCols ?? 0); col += 1) {
    const top = oneLine(header0[col]);
    const sub = oneLine(header1[col]);
    if (top) currentGroup = top;
    if (col <= 3) headers[col] = top || sub || `列${col + 1}`;
    else if (currentGroup && sub && currentGroup !== sub) headers[col] = `${currentGroup} - ${sub}`;
    else headers[col] = currentGroup || sub || `列${col + 1}`;
  }
  const uniqueHeaders = makeUniqueHeaders(headers);

  const characters = tierRows.map((row, rowIndex) => {
    const name = oneLine(row[2]);
    const rarityText = cleanCell(row[3]);
    if (rowIndex < 4 || !name || name === "名字") return null;
    const hasCharacterShape = /[\u4e00-\u9fa5A-Za-z]/.test(name)
      && (rarityText.includes("⭐") || /^T\d/i.test(oneLine(row[4])) || /^T\d/i.test(oneLine(row[15])) || oneLine(row[18]));
    if (!hasCharacterShape) return null;
    const scores = {};
    const details = {};
    for (let col = 4; col < Math.max(row.length, headers.length); col += 1) {
      const value = cleanCell(row[col]);
      if (!value) continue;
      const key = uniqueHeaders[col] || `列${col + 1}`;
      if (/^T\d/i.test(oneLine(value))) scores[key] = value;
      else details[key] = value;
    }
    return {
      rowIndex: rowIndex + 1,
      attribute: oneLine(row[0]),
      avatarText: oneLine(row[1]),
      character: name,
      rarity: rarityText,
      rarityStars: countStars(rarityText),
      scores,
      details,
    };
  }).filter(Boolean);

  return {
    title: "伊瑟 国服节奏榜 - 角色评分结构化提取",
    source: "腾讯文档",
    sourceUrl: SOURCE_URL,
    extractedAt,
    sheet: "节奏榜",
    columns: uniqueHeaders,
    characterCount: characters.length,
    characters,
  };
}

function sheetBlock(entry) {
  const sheet = entry.active;
  const rows = sheet.rows ?? [];
  const dataLines = rows
    .map((row) => trimRow(row))
    .filter((row) => row.some(Boolean))
    .map((row, index) => `${index + 1}\t${row.map(tsvCell).join("\t")}`);
  const lines = [];
  lines.push(`### ${sheet.name}`);
  lines.push("");
  lines.push(`- 子表 ID：${sheet.id}`);
  lines.push(`- 原始尺寸：${sheet.rowCount ?? 0} 行 x ${sheet.colCount ?? 0} 列`);
  lines.push(`- 有效文本范围：${sheet.usedRows ?? 0} 行 x ${sheet.usedCols ?? 0} 列`);
  lines.push(`- 非空文本单元格：${sheet.nonEmpty ?? 0}`);
  if (entry.sourceUrl) lines.push(`- 来源链接：${entry.sourceUrl}`);
  if (entry.updatedAt) lines.push(`- 文档更新时间：${entry.updatedAt}`);
  lines.push("");
  if (!dataLines.length) {
    lines.push("该子表没有抓取到可读文本单元格，可能主要由图片、嵌入内容或空白区域组成。");
  } else {
    lines.push("```tsv");
    lines.push(["行号", "A列起文本内容"].join("\t"));
    lines.push(...dataLines);
    lines.push("```");
  }
  return lines.join("\n");
}

function characterSummaryLine(item) {
  const scoreText = Object.entries(item.scores).map(([key, value]) => `${key}: ${oneLine(value)}`).join("；");
  const detailKeys = Object.keys(item.details);
  const detailText = detailKeys.length ? `；补充字段：${detailKeys.join("、")}` : "";
  return `| ${item.character} | ${item.rarityStars ?? ""} | ${scoreText || "无明确 T 评分"}${detailText} |`;
}

function stripPrefix(key, prefix) {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function findEntry(object, key) {
  return Object.entries(object).find(([entryKey]) => entryKey === key)?.[1] ?? "";
}

function entriesWithPrefix(object, prefix) {
  return Object.entries(object)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [stripPrefix(key, prefix), value]);
}

function pushField(lines, label, value) {
  const text = cleanCell(value);
  if (!text) return;
  if (text.includes("\n")) {
    lines.push(`- ${label}：`);
    lines.push("");
    lines.push("```text");
    lines.push(text);
    lines.push("```");
  } else {
    lines.push(`- ${label}：${text}`);
  }
}

function characterDetailBlock(item) {
  const lines = [];
  lines.push(`### ${item.character}`);
  lines.push("");
  lines.push(`- 原表行号：${item.rowIndex}`);
  if (item.attribute) lines.push(`- 属性：${item.attribute}`);
  if (item.rarityStars) lines.push(`- 稀有度：${item.rarityStars} 星`);
  else if (oneLine(item.rarity)) lines.push(`- 稀有度：${oneLine(item.rarity)}`);
  lines.push("");

  const pveScores = entriesWithPrefix(item.scores, "PVE强度评分 - ");
  if (pveScores.length) {
    lines.push("#### PVE 强度评分");
    lines.push("");
    for (const [scene, value] of pveScores) lines.push(`- ${scene}：${oneLine(value)}`);
    lines.push("");
  }

  const pvpScore = findEntry(item.scores, "PVP综合分析 - PVP / 强度");
  const pvpDetails = entriesWithPrefix(item.details, "PVP综合分析 - ");
  if (pvpScore || pvpDetails.length) {
    lines.push("#### PVP 综合分析");
    lines.push("");
    if (pvpScore) lines.push(`- PVP 强度：${oneLine(pvpScore)}`);
    for (const [field, value] of pvpDetails) pushField(lines, field, value);
    lines.push("");
  }

  const knownDetailFields = [
    "推荐矩阵",
    "右三 / 主词条",
    "智壳推荐",
    "智壳词条",
    "战术刻影",
    "刻影元件 / （施工中）",
    "技能加点",
    "备注",
    "视频 / 链接",
    "推荐 / 面板",
  ];
  const hasKnownDetails = knownDetailFields.some((field) => cleanCell(item.details[field]));
  if (hasKnownDetails) {
    lines.push("#### 配装与养成字段");
    lines.push("");
    for (const field of knownDetailFields) pushField(lines, field, item.details[field]);
    lines.push("");
  }

  const externalLinks = Object.entries(item.details).filter(([key]) => key.startsWith("各主播/选手"));
  if (externalLinks.length) {
    lines.push("#### 外部配置链接");
    lines.push("");
    for (const [field, value] of externalLinks) pushField(lines, field, value);
    lines.push("");
  }

  const emitted = new Set([
    ...pvpDetails.map(([field]) => `PVP综合分析 - ${field}`),
    ...knownDetailFields,
    ...externalLinks.map(([field]) => field),
  ]);
  const otherDetails = Object.entries(item.details).filter(([key]) => !emitted.has(key));
  if (otherDetails.length) {
    lines.push("#### 其他字段");
    lines.push("");
    for (const [field, value] of otherDetails) pushField(lines, field, value);
    lines.push("");
  }

  return lines.join("\n");
}

function buildMarkdown(allTabExtracts, charactersPayload, extractedAt) {
  const lines = [];
  lines.push("# 伊瑟 国服角色节奏榜");
  lines.push("");
  lines.push("## 来源");
  lines.push("");
  lines.push("- 来源：腾讯文档《伊瑟 国服节奏榜》");
  lines.push(`- 链接：${SOURCE_URL}`);
  lines.push(`- 抓取时间：${extractedAt}`);
  lines.push("- 归档说明：本文件用于补充角色强度、PVE/PVP 场景评分、推荐矩阵、智壳、右三主词条、刻影元件、技能加点和备注等知识库信息。");
  lines.push("- 注意：节奏榜是社区制作资料，会随版本变化；使用时应结合更新时间和后续更新日志判断有效性。");
  lines.push("");
  lines.push("## 字段说明");
  lines.push("");
  lines.push("- 角色字段来自“节奏榜”子表的两行表头合并结果。");
  lines.push("- PVE 强度评分按副本/场景拆分，包括重构兵祸、多琪、奥洛拉、妮可娜娜、莎朗、猎焰赫妍、炼狱津、柯洛罗、刺血大公、维斯佩拉、高难。");
  lines.push("- PVP 综合分析拆成 PVP 强度、专项能力、克制关系。");
  lines.push("- 配装与养成字段包括推荐矩阵、右三主词条、智壳推荐、智壳词条、战术刻影、刻影元件、技能加点、备注、视频链接、推荐面板和外部配置链接。");
  lines.push("- 空字段不会在逐角色档案中展开；需要核对原始排版时再看“工作表原文”。");
  lines.push("");
  lines.push("## 子表索引");
  lines.push("");
  lines.push("| 子表 | 有效文本范围 | 非空单元格 | 说明 |");
  lines.push("| --- | --- | --- | --- |");
  for (const entry of allTabExtracts) {
    const sheet = entry.active;
    const note = (sheet.nonEmpty ?? 0) > 0 ? "已归档文本内容" : "未抓取到可读文本，可能为图片或空白内容";
    lines.push(`| ${sheet.name} | ${sheet.usedRows ?? 0} 行 x ${sheet.usedCols ?? 0} 列 | ${sheet.nonEmpty ?? 0} | ${note} |`);
  }
  lines.push("");
  lines.push("## 结构化角色评分");
  lines.push("");
  lines.push(`共识别 ${charactersPayload.characterCount} 个角色评分条目。评分字段来自“节奏榜”工作表，非 T 评分字段保留在结构化 JSON 的 details 中，并在下方摘要列出字段名。`);
  lines.push("");
  lines.push("| 角色 | 稀有度星级 | 评分摘要 |");
  lines.push("| --- | ---: | --- |");
  for (const item of charactersPayload.characters) lines.push(characterSummaryLine(item));
  lines.push("");
  lines.push("## 逐角色字段化档案");
  lines.push("");
  lines.push("以下内容是给 AI/agent 优先读取的版本：每个值都带字段名，不依赖 TSV 列位置推断。");
  lines.push("");
  for (const item of charactersPayload.characters) {
    lines.push(characterDetailBlock(item));
    lines.push("");
  }
  lines.push("## 工作表原文");
  lines.push("");
  for (const entry of allTabExtracts) {
    lines.push(sheetBlock(entry));
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const fromRawIndex = process.argv.indexOf("--from-raw");
  const rawFile = fromRawIndex >= 0 ? path.resolve(process.argv[fromRawIndex + 1] || DEFAULT_RAW_FILE) : "";
  const target = rawFile ? null : await findOrCreateTarget();
  const client = target ? await connect(target) : null;
  try {
    const extractedAt = new Date().toISOString();
    let allTabExtracts;
    let previousRawPayload = null;
    if (rawFile) {
      previousRawPayload = JSON.parse(await readFile(rawFile, "utf8"));
      allTabExtracts = previousRawPayload.tabs.map((entry) => ({
        tab: entry.tab,
        active: entry.sheet,
        title: entry.title,
        updatedAt: entry.updatedAt,
        sourceUrl: entry.sourceUrl,
        shortLink: entry.shortLink,
        watermark: entry.watermark,
        globalPadId: entry.globalPadId,
      }));
    } else {
      await client.send("Runtime.enable");
      await client.send("Page.enable");
      allTabExtracts = await extractTabs(client);
    }
    const rawPayload = {
      title: "伊瑟 国服节奏榜",
      source: "腾讯文档",
      sourceUrl: SOURCE_URL,
      extractedAt: previousRawPayload?.extractedAt || extractedAt,
      note: "由公开可读的腾讯文档工作表抓取并归档；保留每个子表的文本单元格内容，图片型页面只记录可读文本。",
      tabs: allTabExtracts.map((entry) => ({
        tab: entry.tab,
        title: entry.title,
        updatedAt: entry.updatedAt,
        sourceUrl: entry.sourceUrl,
        shortLink: entry.shortLink,
        watermark: entry.watermark,
        globalPadId: entry.globalPadId,
        sheet: entry.active,
      })),
    };
    const charactersPayload = buildCharacterPayload(allTabExtracts, rawPayload.extractedAt);
    const markdown = buildMarkdown(allTabExtracts, charactersPayload, rawPayload.extractedAt);

    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(path.join(OUTPUT_DIR, "tencent-yise-tier-list.raw.json"), JSON.stringify(rawPayload, null, 2), "utf8");
    await writeFile(path.join(OUTPUT_DIR, "tencent-yise-tier-list.characters.json"), JSON.stringify(charactersPayload, null, 2), "utf8");
    await writeFile(path.join(OUTPUT_DIR, "tencent-yise-tier-list.md"), markdown, "utf8");

    console.log(JSON.stringify({
      outputDir: OUTPUT_DIR,
      tabs: allTabExtracts.length,
      characters: charactersPayload.characterCount,
      source: rawFile ? rawFile : DEBUG_URL,
      files: [
        "tencent-yise-tier-list.raw.json",
        "tencent-yise-tier-list.characters.json",
        "tencent-yise-tier-list.md",
      ],
    }, null, 2));
  } finally {
    client?.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
