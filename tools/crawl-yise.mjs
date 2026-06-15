import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG = {
  siteUrl: "https://www.gamekee.com",
  alias: "yise",
  outputDir: "02_原始抓取数据",
  maxPages: Number.POSITIVE_INFINITY,
  concurrency: 3,
  delayMs: 450,
  timeoutMs: 30000,
  retries: 4,
  rawApi: true,
  downloadAssets: false,
  userAgent:
    "Mozilla/5.0 (compatible; GamekeeYiseArchive/1.0; +https://www.gamekee.com/yise/)",
};

const CATEGORY_RULES = [
  {
    name: "01_公告资讯",
    tests: [/公告|维护|版本更新|上线|服务器|运营|新闻|资讯|测试招募|预下载/i],
  },
  {
    name: "02_活动卡池",
    tests: [/活动|赛季|签到|投票|盛典|限时|福利|UP|卡池|祈灵|联动/i],
  },
  {
    name: "03_图鉴词条",
    tests: [/character-profile|异格者协会评定|基本资料|详细属性|普攻|必杀|终结技|潜能/i],
  },
  {
    name: "04_新手开荒",
    tests: [/萌新|新手|入门|开荒|初始|从零开始|指南|答疑|问答|预约奖励/i],
  },
  {
    name: "05_副本玩法",
    tests: [/副本|月塔|探索|玩法|关卡|炼狱|经验本|源网|BOSS|打法|通关|试炼|剧场|梦境|列车/i],
  },
  {
    name: "06_装备智壳",
    tests: [/装备|智壳|源器|套装|词条|芯片|法典|逆翎|属性/i],
  },
  {
    name: "07_攻略评测",
    tests: [/节奏榜|强度榜|排行榜|评测|推荐榜|T0|T1|梯度|排行|攻略|养成|配队|阵容|技能|面板|定位|PVP|PVE|SSR|SR|R卡/i],
  },
  {
    name: "08_图鉴资料",
    tests: [/图鉴|资料|数据|表格|一览|汇总|数据库|wiki|档案|道具/i],
  },
  {
    name: "09_社区帖子",
    tests: [/提问|用户发帖|评论|求助|怎么|什么时候|吗？|吗\?/i],
  },
];

function parseArgs(argv) {
  const config = { ...DEFAULT_CONFIG };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--max-pages") config.maxPages = Number(argv[++index]);
    else if (arg === "--output-dir") config.outputDir = argv[++index];
    else if (arg === "--concurrency") config.concurrency = Number(argv[++index]);
    else if (arg === "--delay-ms") config.delayMs = Number(argv[++index]);
    else if (arg === "--timeout-ms") config.timeoutMs = Number(argv[++index]);
    else if (arg === "--retries") config.retries = Number(argv[++index]);
    else if (arg === "--alias") config.alias = argv[++index];
    else if (arg === "--download-assets") config.downloadAssets = true;
    else if (arg === "--no-raw-api") config.rawApi = false;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (
    config.maxPages !== Number.POSITIVE_INFINITY &&
    (!Number.isFinite(config.maxPages) || config.maxPages < 1)
  ) {
    throw new Error("--max-pages must be a positive number");
  }
  return config;
}

function printHelp() {
  console.log(`Usage: node tools/crawl-yise.mjs [options]

Options:
  --max-pages <n>       Archive only the first n discovered content items.
  --output-dir <path>   Output directory. Default: archive/yise
  --concurrency <n>     Number of concurrent detail fetch workers. Default: 3
  --delay-ms <n>        Delay before each request per worker. Default: 450
  --timeout-ms <n>      Request timeout. Default: 30000
  --retries <n>         Retries for network errors, 429, and 5xx. Default: 4
  --alias <name>        GameKee wiki alias. Default: yise
  --download-assets     Also mirror image assets into _assets.
  --no-raw-api          Do not save raw API JSON files.
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function tryParseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function decodeHtml(value) {
  if (!value) return "";
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)))
    .replace(/&([a-z]+);/gi, (_, name) => named[name.toLowerCase()] ?? `&${name};`);
}

function stripTags(html) {
  return String(html || "").replace(/<[^>]+>/g, "");
}

function cleanText(value) {
  return decodeHtml(value || "")
    .replace(/\r/g, "")
    .replace(/\uFEFF/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeFilePart(value, fallback = "untitled") {
  const clean = cleanText(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return clean || fallback;
}

function normalizeUrl(value, base = "https://www.gamekee.com/") {
  if (!value || typeof value !== "string") return "";
  let candidate = value.trim();
  if (!candidate) return "";
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  try {
    return new URL(candidate, base).toString();
  } catch {
    return "";
  }
}

function contentUrl(id, config) {
  return `${config.siteUrl}/${config.alias}/${id}.html`;
}

function extractContentIdFromUrl(value) {
  const match = String(value || "").match(/\/(\d+)\.html(?:$|[?#])/);
  return match ? Number(match[1]) : null;
}

function toIsoTime(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number) || number <= 0) return "";
  return new Date(number * 1000).toISOString();
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function fetchWithRetry(url, options, config) {
  let lastError;
  for (let attempt = 0; attempt <= config.retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "user-agent": config.userAgent,
          ...options?.headers,
        },
      });
      clearTimeout(timeout);
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < config.retries) {
        await sleep(1800 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < config.retries) await sleep(800 * (attempt + 1));
    }
  }
  throw lastError;
}

async function apiGet(apiPath, params, config) {
  const url = new URL(apiPath, config.siteUrl);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetchWithRetry(
    url,
    {
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
        "device-num": "1",
        "game-alias": config.alias,
        lang: "zh-cn",
        "x-requested-with": "XMLHttpRequest",
      },
    },
    config
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  const json = tryParseJson(text);
  if (!json || typeof json !== "object") throw new Error(`Non-JSON response from ${url}`);
  if (json.code !== 0) throw new Error(`API code ${json.code}: ${json.msg || url}`);
  return { url: url.toString(), json };
}

async function fetchJsonUrl(url, config) {
  const normalized = normalizeUrl(url, config.siteUrl);
  const response = await fetchWithRetry(
    normalized,
    {
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
      },
    },
    config
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${normalized}`);
  const json = tryParseJson(text);
  if (!json) throw new Error(`Non-JSON CDN response from ${normalized}`);
  return { url: normalized, json };
}

function addSummary(map, raw, source, config) {
  if (!raw) return;
  const id = Number(raw.id ?? raw.content_id ?? raw.c_id);
  if (!Number.isFinite(id) || id <= 0) return;
  const previous = map.get(id) || { id, sources: [] };
  const merged = {
    ...previous,
    ...Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined && value !== null)),
    id,
    url: raw.url || previous.url || contentUrl(id, config),
    sources: [...new Set([...(previous.sources || []), source])],
  };
  map.set(id, merged);
}

function walk(value, visitor, seen = new Set()) {
  if (value == null) return;
  if (typeof value !== "object") {
    visitor(value);
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor, seen);
  } else {
    for (const item of Object.values(value)) walk(item, visitor, seen);
  }
}

function collectLinkedContent(value, map, source, config) {
  walk(value, (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    for (const key of ["jump_url", "link_url", "url", "href"]) {
      const id = extractContentIdFromUrl(item[key]);
      if (id) addSummary(map, { ...item, id, url: contentUrl(id, config) }, source, config);
    }
    if (Number.isFinite(Number(item.content_id))) {
      addSummary(map, { ...item, id: Number(item.content_id) }, source, config);
    }
  });
}

async function collectContentSummaries(config, rawDir) {
  const summaries = new Map();
  const raw = {};

  const firstPage = await apiGet("/v1/content/pageList", { page_no: 1, limit: 100 }, config);
  raw.pageListPage1 = firstPage.json;
  for (const item of asArray(firstPage.json.data)) addSummary(summaries, item, "content-pageList", config);

  const pagination = firstPage.json.meta?.pagination || {};
  const pageTotal = Number(pagination.page_total || 1);
  for (let page = 2; page <= pageTotal; page += 1) {
    await sleep(config.delayMs);
    const pageResponse = await apiGet("/v1/content/pageList", { page_no: page, limit: 100 }, config);
    raw[`pageListPage${page}`] = pageResponse.json;
    for (const item of asArray(pageResponse.json.data)) addSummary(summaries, item, "content-pageList", config);
  }

  await sleep(config.delayMs);
  const entryIndex = await apiGet("/v1/entry/query-entry-list-from-cdn", {}, config);
  raw.entryIndex = entryIndex.json;
  for (const item of asArray(entryIndex.json.data?.dict)) {
    addSummary(
      summaries,
      {
        id: Number(item.c_id),
        entry_id: item.id,
        entry_type: item.e_tp,
        entry_active: item.e_at,
      },
      "entry-dict",
      config
    );
  }

  const cdnPath = entryIndex.json.data?.cdn_path;
  if (cdnPath) {
    try {
      await sleep(config.delayMs);
      const entryCdn = await fetchJsonUrl(cdnPath, config);
      raw.entryCdn = entryCdn.json;
      collectLinkedContent(entryCdn.json, summaries, "entry-cdn", config);
    } catch (error) {
      raw.entryCdnError = { message: error?.message || String(error), cdnPath };
    }
  }

  for (const [name, apiPath] of [
    ["wikiIndex", "/v1/wiki/index"],
    ["wikiIndexV2", "/v1/wiki/indexV2"],
    ["wikiEntry", "/v1/wiki/entry"],
  ]) {
    try {
      await sleep(config.delayMs);
      const response = await apiGet(apiPath, name === "wikiIndexV2" ? { game_alias: config.alias } : {}, config);
      raw[name] = response.json;
      collectLinkedContent(response.json, summaries, name, config);
      walk(response.json.data, (item) => {
        if (item && typeof item === "object" && !Array.isArray(item) && Number.isFinite(Number(item.id))) {
          if (item.title && (item.summary || item.content_id || item.entry_id)) {
            addSummary(summaries, item, name, config);
          }
        }
      });
    } catch (error) {
      raw[`${name}Error`] = { message: error?.message || String(error) };
    }
  }

  if (config.rawApi) {
    await mkdir(rawDir, { recursive: true });
    await writeFile(path.join(rawDir, "discovery.json"), JSON.stringify(raw, null, 2), "utf8");
  }

  return [...summaries.values()]
    .filter((item) => Number.isFinite(Number(item.id)))
    .sort((a, b) => {
      const left = Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0);
      if (left !== 0) return left;
      return Number(b.id) - Number(a.id);
    });
}

function applyMarks(text, node) {
  let result = cleanText(text);
  if (!result) return "";
  if (node.code) result = `\`${result}\``;
  if (node.bold) result = `**${result}**`;
  if (node.italic) result = `_${result}_`;
  if (node.underline) result = `<u>${result}</u>`;
  return result;
}

function renderChildren(children, context) {
  return asArray(children)
    .map((child) => renderSlateNode(child, context))
    .filter(Boolean)
    .join("");
}

function renderSlateNode(node, context = {}) {
  if (node == null) return "";
  if (typeof node === "string") return cleanText(node);
  if (Array.isArray(node)) return node.map((item) => renderSlateNode(item, context)).join("\n\n");
  if (typeof node !== "object") return "";

  if (Object.prototype.hasOwnProperty.call(node, "text")) return applyMarks(node.text, node);

  const type = String(node.type || "").toLowerCase();
  const children = renderChildren(node.children, context);
  const url = normalizeUrl(node.url || node.href || node.link || node.src || "", context.baseUrl);

  if (type.includes("image") || node.src) {
    const src = normalizeUrl(node.src || node.url || "", context.baseUrl);
    if (!src) return children;
    const alt = cleanText(node.alt || node.title || "image");
    return `\n![${alt}](${src})\n`;
  }
  if (type.includes("video")) {
    return url ? `\n[Video](${url})\n` : children;
  }
  if (type.includes("link") || node.href || node.url) {
    const label = cleanText(children || node.title || url);
    return url && label ? `[${label}](${url})` : label;
  }
  if (type.includes("heading-one") || type === "h1") return `\n# ${cleanText(children)}\n\n`;
  if (type.includes("heading-two") || type === "h2") return `\n## ${cleanText(children)}\n\n`;
  if (type.includes("heading-three") || type === "h3") return `\n### ${cleanText(children)}\n\n`;
  if (type.includes("heading-four") || type === "h4") return `\n#### ${cleanText(children)}\n\n`;
  if (type.includes("block-quote") || type.includes("quote")) {
    return `\n${cleanText(children)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n\n`;
  }
  if (type.includes("list-item")) return `\n- ${cleanText(children)}`;
  if (type.includes("numbered-list") || type.includes("ordered-list")) {
    const lines = asArray(node.children)
      .map((child, index) => `${index + 1}. ${cleanText(renderSlateNode(child, context)).replace(/^- /, "")}`)
      .join("\n");
    return `\n${lines}\n\n`;
  }
  if (type.includes("bulleted-list") || type.includes("unordered-list")) return `\n${children}\n\n`;
  if (type.includes("table-row")) return `| ${cleanText(children).replace(/\n+/g, " | ")} |\n`;
  if (type.includes("table-cell")) return `${cleanText(children)}\n`;
  if (type.includes("table")) return `\n${children}\n`;
  if (type.includes("code")) return `\n\`\`\`\n${cleanText(children)}\n\`\`\`\n\n`;
  if (type.includes("paragraph") || type === "p") return `\n${cleanText(children)}\n\n`;
  return children;
}

function renderEditorValue(value, context = {}) {
  if (value == null) return "";
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return cleanText(value.map((item) => renderGenericRich(item, context)).join("\n"));
  if (typeof value !== "object") return "";
  if (value.type === "simpleEditor" && value.data) return cleanText(renderSlateNode(value.data, context));
  if (Object.prototype.hasOwnProperty.call(value, "text") || value.children) {
    return cleanText(renderSlateNode(value, context));
  }
  return cleanText(renderGenericRich(value, context));
}

function renderMaybeHeading(label, level = 2) {
  const text = cleanText(label);
  if (!text) return "";
  const hashes = "#".repeat(Math.max(1, Math.min(level, 4)));
  return `\n${hashes} ${text}\n`;
}

function renderImageList(values, context = {}) {
  return asArray(values)
    .map((value) => {
      const src = normalizeUrl(value, context.baseUrl);
      return src && /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(src) ? `![image](${src})` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function renderAttrList(attrList, context = {}) {
  const rows = asArray(attrList)
    .map((item) => {
      const title = renderEditorValue(item.title, context);
      const content = renderEditorValue(item.content, context);
      return title || content ? `| ${title.replace(/\|/g, "\\|")} | ${content.replace(/\|/g, "\\|")} |` : "";
    })
    .filter(Boolean);
  if (!rows.length) return "";
  return ["| 项目 | 内容 |", "| --- | --- |", ...rows].join("\n");
}

function renderTableList(tableList, context = {}) {
  return asArray(tableList)
    .map((table) => {
      const title = renderEditorValue(table.title, context);
      const head = asArray(table.head).map((cell) => renderEditorValue(cell, context));
      const body = asArray(table.body).map((row) => asArray(row).map((cell) => renderEditorValue(cell, context)));
      const lines = [];
      if (title) lines.push(renderMaybeHeading(title, 4));
      if (head.length) {
        lines.push(`| ${head.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`);
        lines.push(`| ${head.map(() => "---").join(" | ")} |`);
      }
      for (const row of body) {
        if (row.some(Boolean)) lines.push(`| ${row.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`);
      }
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function renderSkillData(skillData, context = {}) {
  return asArray(skillData)
    .map((skill) => {
      const lines = [];
      const name = renderEditorValue(skill.name, context) || renderEditorValue(skill.label, context);
      if (name) lines.push(renderMaybeHeading(name, 4));
      const icon = normalizeUrl(skill.icon, context.baseUrl);
      if (icon) lines.push(`![${name || "skill"}](${icon})`);
      const desc = renderEditorValue(skill.desc, context);
      if (desc) lines.push(desc);
      const more = renderEditorValue(skill.moreInfo, context);
      if (more) lines.push(`\n${more}`);
      return lines.join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function renderUpgradeList(upgradeList, context = {}) {
  return asArray(upgradeList)
    .map((item) => {
      const lines = [];
      const title = renderEditorValue(item.title, context);
      if (title) lines.push(`- ${title}`);
      const content = asArray(item.content).map((part) => renderEditorValue(part, context)).filter(Boolean);
      const other = asArray(item.other).map((part) => renderEditorValue(part, context)).filter(Boolean);
      if (content.length) lines.push(content.join("\n"));
      if (other.length) lines.push(other.join("\n"));
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function renderTabList(tabList, context = {}) {
  return asArray(tabList)
    .map((tab) => {
      const lines = [];
      const title = renderEditorValue(tab.title, context);
      if (title) lines.push(renderMaybeHeading(title, 4));
      if (tab.type === "image") lines.push(renderImageList(tab.content, context));
      else lines.push(renderGenericRich(tab.content, context));
      return lines.filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function renderGenericRich(value, context = {}, seen = new Set(), depth = 0) {
  if (value == null) return "";
  if (typeof value === "string") {
    const normalized = normalizeUrl(value, context.baseUrl);
    if (normalized && /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(normalized)) {
      return `![image](${normalized})`;
    }
    return cleanText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return "";
  if (Array.isArray(value)) {
    return cleanText(value.map((item) => renderGenericRich(item, context, seen, depth)).filter(Boolean).join("\n\n"));
  }
  if (typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);

  if (value.type === "simpleEditor" && value.data) return cleanText(renderSlateNode(value.data, context));
  if (Object.prototype.hasOwnProperty.call(value, "text") || value.children) {
    const rendered = cleanText(renderSlateNode(value, context));
    if (rendered) return rendered;
  }

  const type = String(value.type || "").toLowerCase();
  const rawData = value.data;
  const data = rawData && typeof rawData === "object" && !Array.isArray(rawData) ? rawData : value;
  const lines = [];

  if (Array.isArray(rawData)) {
    const renderedData = renderGenericRich(rawData, context, seen, depth + 1);
    if (renderedData) lines.push(renderedData);
  }

  const title = renderEditorValue(data.title, context);
  if (title && !["tab-info"].includes(type)) lines.push(renderMaybeHeading(title, depth >= 1 ? 3 : 2));

  if (type === "tab-info" || data.tabList) lines.push(renderTabList(data.tabList, context));

  if (type.includes("character-profile") || data.attrList || data.desc || data.imageList) {
    const name = renderEditorValue(data.name, context);
    const descTitle = renderEditorValue(data.descTitle, context);
    const desc = renderEditorValue(data.desc, context);
    if (name && name !== title) lines.push(`**${name}**`);
    if (descTitle) lines.push(`**${descTitle}**`);
    if (desc) lines.push(desc);
    const attrs = renderAttrList(data.attrList, context);
    if (attrs) lines.push(attrs);
    lines.push(renderImageList(data.imageList, context));
    lines.push(renderImageList(data.imagesList, context));
  }

  if (type.includes("weapon-info") || data.skillData || data.tableList) {
    const icon = normalizeUrl(data.icon, context.baseUrl);
    if (icon) lines.push(`![${title || "icon"}](${icon})`);
    const name = renderEditorValue(data.name, context);
    const desc = renderEditorValue(data.desc, context);
    if (name && name !== title) lines.push(`**${name}**`);
    if (desc) lines.push(desc);
    const tables = renderTableList(data.tableList, context);
    if (tables) lines.push(tables);
    const skills = renderSkillData(data.skillData, context);
    if (skills) lines.push(skills);
  }

  if (type.includes("upgrade-info") || data.upgradeList) {
    const upgrades = renderUpgradeList(data.upgradeList, context);
    if (upgrades) lines.push(upgrades);
  }

  for (const key of ["content", "body", "head", "other", "moreInfo", "data"]) {
    if (!data[key] || data[key] === value) continue;
    const rendered = renderGenericRich(data[key], context, seen, depth + 1);
    if (rendered) lines.push(rendered);
  }

  return cleanText(lines.filter(Boolean).join("\n\n"));
}

function htmlToMarkdownish(html, baseUrl) {
  let text = String(html || "");
  text = text.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style\b[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, inner) => `\n# ${cleanText(stripTags(inner))}\n\n`);
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, inner) => `\n## ${cleanText(stripTags(inner))}\n\n`);
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, inner) => `\n### ${cleanText(stripTags(inner))}\n\n`);
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${cleanText(stripTags(inner))}`);
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(?:p|div|section|article|tr|table|ul|ol)>/gi, "\n");
  text = text.replace(/<img\b([^>]+)>/gi, (_, attrs) => {
    const src =
      attrs.match(/\bsrc=["']([^"']+)["']/i)?.[1] ||
      attrs.match(/\bdata-src=["']([^"']+)["']/i)?.[1] ||
      "";
    const normalized = normalizeUrl(src, baseUrl);
    const alt = cleanText(attrs.match(/\balt=["']([^"']*)["']/i)?.[1] || "image");
    return normalized ? `\n![${alt}](${normalized})\n` : "";
  });
  text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const label = cleanText(stripTags(inner));
    const normalized = normalizeUrl(href, baseUrl);
    return label && normalized ? `[${label}](${normalized})` : label || normalized;
  });
  return cleanText(stripTags(text));
}

async function hydrateDetailContent(detail, config) {
  const data = { ...detail };
  if (data.content_cdn) {
    try {
      const cdn = await fetchJsonUrl(data.content_cdn, config);
      if (data.editor_type === 0) data.content = cdn.json.content ?? data.content;
      else data.content_json = cdn.json.content ?? data.content_json;
      data._content_cdn_url = cdn.url;
    } catch (error) {
      data._content_cdn_error = error?.message || String(error);
    }
  }
  if (data.entry_data_bind_cdn) {
    try {
      const cdn = await fetchJsonUrl(data.entry_data_bind_cdn, config);
      data.entry_data_bind = cdn.json.entry_data_bind ?? data.entry_data_bind;
      data._entry_data_bind_cdn_url = cdn.url;
    } catch (error) {
      data._entry_data_bind_cdn_error = error?.message || String(error);
    }
  }
  return data;
}

function renderContent(detail, config) {
  const baseUrl = contentUrl(detail.id, config);
  const contentJson = tryParseJson(detail.content_json);
  if (contentJson) {
    const slate = cleanText(renderSlateNode(contentJson, { baseUrl }));
    const generic = cleanText(renderGenericRich(contentJson, { baseUrl }));
    const slateTextLength = cleanText(slate.replace(/!\[[^\]]*]\([^)]+\)/g, "")).length;
    const genericTextLength = cleanText(generic.replace(/!\[[^\]]*]\([^)]+\)/g, "")).length;
    return genericTextLength > slateTextLength * 1.2 ? generic : slate;
  }
  if (detail.content) return htmlToMarkdownish(detail.content, baseUrl);
  if (detail.summary) return cleanText(detail.summary);
  return "";
}

function collectAssetUrls(detail, markdown, config) {
  const assets = new Set();
  const add = (value) => {
    const normalized = normalizeUrl(value, config.siteUrl);
    if (normalized && /^https?:\/\//i.test(normalized)) assets.add(normalized);
  };
  for (const part of String(detail.thumb || "").split(",")) add(part);
  const video = tryParseJson(detail.video, {});
  add(video?.cover);
  add(video?.video);

  walk(detail, (item) => {
    if (typeof item !== "string") return;
    if (/^\/\//.test(item) || /^https?:\/\//i.test(item)) {
      if (/\.(?:avif|gif|jpe?g|png|webp|mp4|webm)(?:$|[?#])/i.test(item)) add(item);
    }
  });

  for (const match of String(markdown || "").matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) add(match[1]);
  return [...assets].sort();
}

function classifyPage(detail, markdown, summary) {
  const titleHaystack = [detail.title, summary?.title].join("\n");
  const titleRules = [
    ["01_公告资讯", /公告|维护|版本更新|上线|服务器|运营|新闻|资讯|测试招募|预下载/i],
    ["02_活动卡池", /活动|赛季|签到|投票|盛典|限时|福利|UP|卡池|祈灵|联动/i],
    ["06_装备智壳", /装备|智壳|源器|套装|词条|芯片|法典|逆翎|属性/i],
    ["04_新手开荒", /萌新|新手|入门|开荒|初始|从零开始|指南|答疑|问答|预约奖励/i],
    ["05_副本玩法", /副本|月塔|探索|玩法|关卡|炼狱|经验本|源网|BOSS|打法|通关|试炼|剧场|梦境|列车/i],
    ["07_攻略评测", /节奏榜|强度榜|排行榜|评测|推荐榜|T0|T1|梯度|排行|攻略|养成|配队|阵容/i],
  ];
  for (const [category, test] of titleRules) {
    if (test.test(titleHaystack)) return category;
  }

  const componentHaystack = [detail.content_json, markdown.slice(0, 6000)].join("\n");
  if (/character-profile|异格者协会评定|基本资料|详细属性|普攻|必杀|终结技/i.test(componentHaystack)) {
    return "03_图鉴词条";
  }

  const haystack = [
    detail.title,
    detail.summary,
    detail.tag,
    summary?.title,
    markdown.slice(0, 3500),
  ].join("\n");
  for (const rule of CATEGORY_RULES) {
    if (rule.tests.some((test) => test.test(haystack))) return rule.name;
  }
  if (Number(detail.type) === 2) return "01_公告资讯";
  if (Number(detail.entry_id) > 0) return "08_图鉴资料";
  return "99_未分类";
}

async function downloadAsset(url, assetsDir, config) {
  const normalized = normalizeUrl(url, config.siteUrl);
  const parsed = new URL(normalized);
  const originalName = sanitizeFilePart(path.posix.basename(parsed.pathname), "asset");
  const ext = path.extname(originalName) || ".bin";
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 14);
  const filename = `${hash}_${originalName.endsWith(ext) ? originalName : `${originalName}${ext}`}`;
  const target = path.join(assetsDir, filename);
  const response = await fetchWithRetry(
    normalized,
    {
      headers: {
        accept: "*/*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
      },
    },
    config
  );
  if (!response.ok) throw new Error(`HTTP ${response.status} ${normalized}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(target, buffer);
  return { url: normalized, file: path.relative(path.dirname(assetsDir), target).replace(/\\/g, "/") };
}

async function archiveDetail(summary, dirs, config) {
  const id = Number(summary.id);
  const response = await apiGet(`/v1/content/detail/${id}`, {}, config);
  const detail = await hydrateDetailContent(response.json.data, config);
  const markdown = renderContent(detail, config);
  const category = classifyPage(detail, markdown, summary);
  const assets = collectAssetUrls(detail, markdown, config);
  const title = detail.title || summary.title || String(id);
  const slug = `${id}_${sanitizeFilePart(title)}`;
  const categoryDir = path.join(dirs.root, category);
  await mkdir(categoryDir, { recursive: true });

  const assetDownloads = [];
  if (config.downloadAssets && assets.length) {
    await mkdir(dirs.assets, { recursive: true });
    for (const asset of assets) {
      try {
        await sleep(Math.max(100, Math.floor(config.delayMs / 2)));
        assetDownloads.push(await downloadAsset(asset, dirs.assets, config));
      } catch (error) {
        assetDownloads.push({ url: asset, error: error?.message || String(error) });
      }
    }
  }

  const metadata = {
    id,
    url: contentUrl(id, config),
    apiUrl: response.url,
    title,
    category,
    type: detail.type,
    tag: detail.tag,
    entryId: detail.entry_id,
    gameId: detail.game_id,
    createdAt: toIsoTime(detail.created_at),
    updatedAt: toIsoTime(detail.updated_at),
    commentCount: detail.comment_count || 0,
    likeCount: detail.like_count || 0,
    favoriteCount: detail.favorite_count || 0,
    viewCount: detail.view_count || 0,
    summary: detail.summary || "",
    textLength: cleanText(markdown.replace(/!\[[^\]]*]\([^)]+\)/g, "")).length,
    imageCount: assets.length,
    assets,
    assetDownloads,
    sources: summary.sources || [],
    user: detail.user
      ? {
          uid: detail.user.uid,
          username: detail.user.username,
          description: detail.user.description,
        }
      : null,
    crawledAt: new Date().toISOString(),
  };

  const frontMatter = [
    "---",
    `id: ${JSON.stringify(metadata.id)}`,
    `url: ${JSON.stringify(metadata.url)}`,
    `title: ${JSON.stringify(metadata.title)}`,
    `category: ${JSON.stringify(metadata.category)}`,
    `createdAt: ${JSON.stringify(metadata.createdAt)}`,
    `updatedAt: ${JSON.stringify(metadata.updatedAt)}`,
    `crawledAt: ${JSON.stringify(metadata.crawledAt)}`,
    "---",
    "",
    `# ${title}`,
    "",
    markdown,
    "",
  ].join("\n");

  await writeFile(path.join(categoryDir, `${slug}.md`), frontMatter, "utf8");
  await writeFile(path.join(categoryDir, `${slug}.json`), JSON.stringify(metadata, null, 2), "utf8");
  if (config.rawApi) {
    await mkdir(dirs.detailRaw, { recursive: true });
    await writeFile(path.join(dirs.detailRaw, `${id}.json`), JSON.stringify(detail, null, 2), "utf8");
  }
  return metadata;
}

async function runWorkers(items, worker, concurrency) {
  let cursor = 0;
  const results = [];
  const failures = [];
  async function run(workerId) {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        const result = await worker(items[index], index, workerId);
        results.push(result);
      } catch (error) {
        failures.push({
          item: items[index],
          error: error?.message || String(error),
        });
        console.warn(`[worker ${workerId}] failed ${items[index]?.id}: ${error?.message || error}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, index) => run(index + 1)));
  return { results, failures };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const root = path.resolve(config.outputDir);
  const dirs = {
    root,
    raw: path.join(root, "_raw_api"),
    detailRaw: path.join(root, "_raw_api", "details"),
    assets: path.join(root, "_assets"),
  };
  await mkdir(root, { recursive: true });

  console.log(`Archive root: ${root}`);
  console.log(`Discovering public content for alias "${config.alias}"...`);

  const summaries = await collectContentSummaries(config, dirs.raw);
  const selected = summaries.slice(0, config.maxPages);
  console.log(`Discovered ${summaries.length} content item(s). Archiving ${selected.length}.`);

  const { results, failures } = await runWorkers(
    selected,
    async (summary, index, workerId) => {
      await sleep(config.delayMs);
      const result = await archiveDetail(summary, dirs, config);
      console.log(
        `[${index + 1}/${selected.length}] [worker ${workerId}] ${result.category} | ${result.title}`
      );
      return result;
    },
    Math.max(1, config.concurrency)
  );

  results.sort((a, b) => {
    const category = a.category.localeCompare(b.category, "zh");
    if (category !== 0) return category;
    return a.title.localeCompare(b.title, "zh");
  });

  const categories = {};
  for (const result of results) categories[result.category] = (categories[result.category] || 0) + 1;

  const index = {
    site: `${config.siteUrl}/${config.alias}/`,
    alias: config.alias,
    crawledAt: new Date().toISOString(),
    discoveredCount: summaries.length,
    pageCount: results.length,
    failureCount: failures.length,
    downloadAssets: config.downloadAssets,
    categories,
    pages: results.map(
      ({
        id,
        url,
        title,
        category,
        type,
        tag,
        entryId,
        createdAt,
        updatedAt,
        textLength,
        imageCount,
        viewCount,
        commentCount,
      }) => ({
        id,
        url,
        title,
        category,
        type,
        tag,
        entryId,
        createdAt,
        updatedAt,
        textLength,
        imageCount,
        viewCount,
        commentCount,
      })
    ),
    failures,
  };

  const csvLines = [
    [
      "id",
      "category",
      "title",
      "url",
      "type",
      "entryId",
      "createdAt",
      "updatedAt",
      "textLength",
      "imageCount",
      "viewCount",
      "commentCount",
    ]
      .map(csvEscape)
      .join(","),
    ...index.pages.map((record) =>
      [
        record.id,
        record.category,
        record.title,
        record.url,
        record.type,
        record.entryId,
        record.createdAt,
        record.updatedAt,
        record.textLength,
        record.imageCount,
        record.viewCount,
        record.commentCount,
      ]
        .map(csvEscape)
        .join(",")
    ),
  ];

  await writeFile(path.join(root, "_index.json"), JSON.stringify(index, null, 2), "utf8");
  await writeFile(path.join(root, "_index.csv"), `${csvLines.join("\n")}\n`, "utf8");
  await writeFile(
    path.join(root, "_summary.md"),
    [
      "# 伊瑟 GameKee 归档摘要",
      "",
      `- 站点：${index.site}`,
      `- 抓取时间：${index.crawledAt}`,
      `- 发现内容：${index.discoveredCount}`,
      `- 归档页面：${index.pageCount}`,
      `- 失败页面：${index.failureCount}`,
      `- 图片本地镜像：${index.downloadAssets ? "是" : "否，已保留原始 URL"}`,
      "",
      "## 分类统计",
      "",
      ...Object.entries(categories).map(([category, count]) => `- ${category}: ${count}`),
      "",
      "## 文件说明",
      "",
      "- `_index.json`: 完整索引、分类统计和失败列表",
      "- `_index.csv`: 表格索引",
      "- `_raw_api/`: 发现接口与详情接口原始 JSON",
      "- `_assets/`: 使用 `--download-assets` 时保存图片资源",
      "- 分类目录：每篇内容的 Markdown 正文和元数据 JSON",
      "",
    ].join("\n"),
    "utf8"
  );

  console.log(`Done. Saved ${results.length} content item(s).`);
  console.log(`Index: ${path.join(root, "_index.json")}`);
  if (failures.length) console.log(`Failures: ${failures.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
