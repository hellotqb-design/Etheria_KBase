import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG = {
  archiveDir: "02_原始抓取数据",
  outputDir: "03_构建缓存/_kb",
  classifiedDir: "03_构建缓存/分类归档",
  outputSubdir: "",
  chunkSize: 1200,
  chunkOverlap: 120,
};

function parseArgs(argv) {
  const config = { ...DEFAULT_CONFIG };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--archive-dir") config.archiveDir = argv[++index];
    else if (arg === "--output-dir") config.outputDir = argv[++index];
    else if (arg === "--classified-dir") config.classifiedDir = argv[++index];
    else if (arg === "--output-subdir") config.outputSubdir = argv[++index];
    else if (arg === "--chunk-size") config.chunkSize = Number(argv[++index]);
    else if (arg === "--chunk-overlap") config.chunkOverlap = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return config;
}

function printHelp() {
  console.log(`Usage: node tools/build-yise-kb.mjs [options]

Options:
  --archive-dir <path>     Raw archive directory. Default: 02_原始抓取数据
  --output-dir <path>      Structured cache directory. Default: 03_构建缓存/_kb
  --classified-dir <path>  Human-readable classified cache. Default: 03_构建缓存/分类归档
  --output-subdir <name>   Backward-compatible output folder inside archive.
  --chunk-size <n>         Approximate text chunk size. Default: 1200
  --chunk-overlap <n>      Character overlap between chunks. Default: 120
`);
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\uFEFF/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function listFilesRecursive(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(fullPath)));
    else files.push(fullPath);
  }
  return files;
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

function editorText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return cleanText(value);
  if (Array.isArray(value)) {
    const inline = value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (Object.prototype.hasOwnProperty.call(item, "text") ||
          ["button", "link", "image"].includes(String(item.type || "")))
    );
    return cleanText(value.map(editorText).filter(Boolean).join(inline ? "" : "\n"));
  }
  if (typeof value !== "object") return "";
  if (value.type === "simpleEditor" && value.data) return editorText(value.data);
  if (Object.prototype.hasOwnProperty.call(value, "text")) return cleanText(value.text);
  if (value.type === "image") return "";
  if (["paragraph", "button", "link"].includes(String(value.type || "")) && value.children) {
    return editorText(value.children);
  }
  if (/^header\d$/.test(String(value.type || "")) && value.children) {
    return editorText(value.children);
  }
  if (value.children) return editorText(value.children);
  if (value.data && (value.data.children || value.data.type === "simpleEditor")) return editorText(value.data);
  return cleanText(Object.values(value).map(editorText).filter(Boolean).join("\n"));
}

function extractImages(value) {
  const images = [];
  walk(value, (item) => {
    if (typeof item !== "string") return;
    const url = normalizeUrl(item);
    if (/\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(url)) images.push(url);
  });
  return unique(images);
}

function attrPairs(attrList) {
  return asArray(attrList)
    .map((item) => ({
      key: editorText(item.title),
      value: editorText(item.content),
    }))
    .filter((item) => item.key || item.value);
}

function pairsToObject(pairs) {
  const object = {};
  for (const pair of pairs) {
    if (pair.key) object[pair.key] = pair.value;
  }
  return object;
}

function tableList(tableList) {
  return asArray(tableList)
    .map((table) => {
      const headers = asArray(table.head).map(editorText).filter(Boolean);
      const rows = asArray(table.body)
        .map((row) => asArray(row).map(editorText))
        .filter((row) => row.some(Boolean));
      return {
        title: editorText(table.title),
        headers,
        rows,
      };
    })
    .filter((table) => table.title || table.headers.length || table.rows.length);
}

function extractStructured(contentJson) {
  const structured = {
    profiles: [],
    basicProfile: null,
    stats: null,
    recommendations: [],
    combatSkills: [],
    archiveStories: [],
    upgrades: [],
    relations: [],
    galleries: [],
    albums: [],
    tables: [],
    componentTypes: {},
  };

  walk(contentJson, (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const type = String(node.type || "");
    if (!type) return;
    structured.componentTypes[type] = (structured.componentTypes[type] || 0) + 1;
    const data = node.data && typeof node.data === "object" && !Array.isArray(node.data) ? node.data : node;

    if (type === "character-profile") {
      const attrs = attrPairs(data.attrList);
      const profile = {
        title: editorText(data.title),
        name: editorText(data.name),
        descTitle: editorText(data.descTitle),
        description: editorText(data.desc),
        attributes: attrs,
        attributesObject: pairsToObject(attrs),
        images: unique([...extractImages(data.imageList), ...extractImages(data.imagesList)]),
      };
      structured.profiles.push(profile);
      if (/基本资料|基础信息|资料|档案/.test(profile.title) && !structured.basicProfile) {
        structured.basicProfile = profile;
      } else if (/详细属性|基础属性|属性|面板/.test(profile.title) && !structured.stats) {
        structured.stats = profile;
      } else if (/推荐|搭配/.test(profile.title)) {
        structured.recommendations.push(profile);
      }
    }

    if (type === "weapon-info") {
      const section = editorText(data.title);
      const tables = tableList(data.tableList);
      if (tables.length) structured.tables.push(...tables.map((table) => ({ section, ...table })));
      for (const skill of asArray(data.skillData)) {
        structured.combatSkills.push({
          section,
          name: editorText(skill.name) || editorText(skill.label),
          label: editorText(skill.label),
          icon: normalizeUrl(skill.icon),
          description: editorText(skill.desc),
          upgradeText: editorText(skill.moreInfo),
          tables,
        });
      }
    }

    if (type === "skill-info") {
      const tabMap = new Map(asArray(data.tabs).map((tab) => [tab.key, tab.label]));
      for (const item of asArray(data.skillList)) {
        structured.archiveStories.push({
          section: editorText(data.title),
          tab: tabMap.get(item.filterTabKey) || "",
          name: editorText(item.name),
          icon: normalizeUrl(item.icon),
          description: editorText(item.desc),
          more: editorText(item.moreInfo),
        });
      }
    }

    if (type === "upgrade-info") {
      for (const item of asArray(data.upgradeList)) {
        structured.upgrades.push({
          section: editorText(data.title),
          title: editorText(item.title),
          content: asArray(item.content).map(editorText).filter(Boolean),
          other: asArray(item.other).map(editorText).filter(Boolean),
        });
      }
    }

    if (type === "relation-info") {
      for (const group of asArray(data.list)) {
        structured.relations.push({
          title: editorText(group.title),
          content: asArray(group.content).map((item) => ({
            name: editorText(item.name),
            avatar: normalizeUrl(item.avatar),
          })),
          other: asArray(group.other).map(editorText).filter(Boolean),
        });
      }
    }

    if (type === "tab-info") {
      structured.galleries.push({
        title: editorText(data.title),
        tabs: asArray(data.tabList).map((tab) => ({
          title: editorText(tab.title),
          type: tab.type || "",
          images: extractImages(tab.content),
          text: editorText(tab.content),
        })),
      });
    }

    if (type === "image-album") {
      structured.albums.push({
        title: editorText(node.title),
        images: extractImages(node.data),
      });
    }

    if (type === "table") {
      structured.tables.push({
        section: "",
        title: editorText(node.title),
        headers: [],
        rows: asArray(node.children).map((row) => [editorText(row)]).filter((row) => row[0]),
      });
    }
  });

  structured.images = extractImages(contentJson);
  structured.isRoleLike = Boolean(
    structured.basicProfile &&
      ["稀有度", "原质属性", "所属势力", "性别", "职业", "ReA芯片状态"].some(
        (key) => structured.basicProfile.attributesObject[key]
      )
  );
  return structured;
}

function markdownBody(markdown) {
  return cleanText(
    String(markdown || "")
      .replace(/^---[\s\S]*?---\s*/, "")
      .replace(/!\[[^\]]*]\([^)]+\)/g, "")
      .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
      .replace(/^# .+$/m, "")
  );
}

function stripFrontMatter(markdown) {
  return String(markdown || "").replace(/^---[\s\S]*?---\s*/, "").trim();
}

function safePathName(value, fallback = "未命名") {
  const text = cleanText(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();
  return (text || fallback).slice(0, 90);
}

function relativeArchivePath(root, file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

function headings(markdown) {
  return String(markdown || "")
    .split("\n")
    .map((line) => line.match(/^(#{1,6})\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((match) => ({ level: match[1].length, text: cleanText(match[2]) }));
}

function chunkText(page, config) {
  const chunks = [];
  const parts = page.fullText.split(/\n(?=#{1,4}\s)|\n{2,}/).map(cleanText).filter(Boolean);
  let buffer = "";
  let heading = "";
  let index = 0;
  const flush = () => {
    const text = cleanText(buffer);
    if (!text) return;
    chunks.push({
      chunkId: `${page.id}-${String(index + 1).padStart(4, "0")}`,
      pageId: page.id,
      title: page.title,
      category: page.category,
      url: page.url,
      heading,
      text,
    });
    index += 1;
    buffer = text.slice(Math.max(0, text.length - config.chunkOverlap));
  };

  for (const part of parts) {
    const headingMatch = part.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) heading = cleanText(headingMatch[1]);
    if ((buffer + "\n\n" + part).length > config.chunkSize) flush();
    buffer = cleanText(buffer ? `${buffer}\n\n${part}` : part);
  }
  flush();
  return chunks;
}

function flattenEntryTree(node, pathParts = [], rootName = "", out = []) {
  if (!node) return out;
  const currentPath = [...pathParts, node.name].filter(Boolean);
  const currentRoot = rootName || node.name || "";
  if (node.content_id) {
    out.push({
      entryId: node.id,
      contentId: Number(node.content_id),
      entryName: node.name,
      rootName: currentRoot,
      groupName: currentPath.length > 1 ? currentPath[1] : "",
      path: currentPath,
      entryAuto: Boolean(node.entry_auto),
      icon: normalizeUrl(node.icon),
      bindUpdated: node.bind_updated || 0,
    });
  }
  for (const child of node.child || []) flattenEntryTree(child, currentPath, currentRoot, out);
  return out;
}

function normalizeCatalogRoot(rootName) {
  if (rootName === "角色图鉴") return "角色图鉴";
  if (rootName === "智壳图鉴") return "智壳图鉴";
  if (rootName === "矩阵图鉴") return "源器图鉴";
  return "";
}

function makeCatalogItem(page, entry, catalogType) {
  return {
    id: page.id,
    title: page.title,
    entryName: entry.entryName,
    catalogType,
    groupName: entry.groupName,
    entryId: entry.entryId,
    entryPath: entry.path,
    url: page.url,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    author: page.author,
    profile: page.detail.basicProfile,
    stats: page.detail.stats,
    recommendations: page.detail.recommendations,
    combatSkills: page.detail.combatSkills,
    archiveStories: page.detail.archiveStories,
    upgrades: page.detail.upgrades,
    relations: page.detail.relations,
    galleries: page.detail.galleries,
    albums: page.detail.albums,
    tables: page.detail.tables,
    assets: page.assets,
    fullText: page.fullText,
    sourceFiles: page.sourceFiles,
  };
}

async function buildReadableMarkdown(archiveDir, page) {
  const sourceMarkdownPath = page.sourceFiles.markdown ? path.join(archiveDir, page.sourceFiles.markdown) : "";
  let sourceMarkdown = "";
  if (sourceMarkdownPath) {
    try {
      sourceMarkdown = await readFile(sourceMarkdownPath, "utf8");
    } catch {
      sourceMarkdown = "";
    }
  }

  const sourceBody = stripFrontMatter(sourceMarkdown) || page.fullText || "";
  const lines = [
    `# ${page.title}`,
    "",
    "## 知识库信息",
    "",
    `- 页面 ID：${page.id}`,
    `- 分类：${page.category}`,
    `- 原始归档分类：${page.archiveCategory || ""}`,
    `- 官网链接：${page.url}`,
    `- 更新时间：${page.updatedAt || ""}`,
  ];

  if (page.officialEntry?.path?.length) {
    lines.push(`- 官方目录：${page.officialEntry.path.join(" / ")}`);
  }
  if (page.officialEntry?.groupName) {
    lines.push(`- 图鉴分组：${page.officialEntry.groupName}`);
  }
  if (page.assets?.length) {
    lines.push(`- 图片资源数：${page.assets.length}`);
  }

  lines.push("", "## 正文", "", sourceBody);
  return lines.join("\n").trim() + "\n";
}

function numberedGroupName(category, groupName) {
  const group = safePathName(groupName || "未分组");
  const orders = {
    角色图鉴: {
      SSR: "01_SSR",
      SR: "02_SR",
      R: "03_R",
    },
    源器图鉴: {
      攻击类: "01_攻击类",
      "速度/技能冷却类": "02_速度_技能冷却类",
      速度_技能冷却类: "02_速度_技能冷却类",
      "防御/护盾类": "03_防御_护盾类",
      防御_护盾类: "03_防御_护盾类",
      "生命/治疗类": "04_生命_治疗类",
      生命_治疗类: "04_生命_治疗类",
      "特殊/控制类": "05_特殊_控制类",
      特殊_控制类: "05_特殊_控制类",
    },
    智壳图鉴: {
      传说: "01_传说",
      卓越: "02_卓越",
      特异: "03_特异",
      稀有: "04_稀有",
    },
  };
  return orders[category]?.[groupName] || group;
}

function classifiedPathParts(page) {
  if (page.category === "角色图鉴") {
    return ["03_图鉴词条", "01_角色图鉴", numberedGroupName(page.category, page.officialEntry?.groupName)];
  }
  if (page.category === "源器图鉴") {
    return ["03_图鉴词条", "02_源器图鉴", numberedGroupName(page.category, page.officialEntry?.groupName)];
  }
  if (page.category === "智壳图鉴") {
    return ["03_图鉴词条", "03_智壳图鉴", numberedGroupName(page.category, page.officialEntry?.groupName)];
  }
  if (page.category === "03_图鉴词条") {
    return ["03_图鉴词条", "99_其他图鉴词条"];
  }
  return [safePathName(page.category || "99_未分类")];
}

async function resetClassifiedRoot(rootDir) {
  const resolvedWorkspace = path.resolve(process.cwd());
  const resolvedRoot = path.resolve(rootDir);
  if (path.basename(resolvedRoot) !== "分类归档" || !resolvedRoot.startsWith(resolvedWorkspace + path.sep)) {
    throw new Error(`Refusing to clear unexpected classified directory: ${resolvedRoot}`);
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}

async function writeClassifiedFolders(archiveDir, pages, rootDir) {
  const dirIndexes = {};
  const topLevelCounts = {};

  await resetClassifiedRoot(rootDir);
  await mkdir(rootDir, { recursive: true });

  for (const page of pages) {
    const parts = classifiedPathParts(page);
    const targetDir = path.join(rootDir, ...parts);
    const stem = `${page.id}_${safePathName(page.title)}`;
    const markdownPath = path.join(targetDir, `${stem}.md`);
    const jsonPath = path.join(targetDir, `${stem}.json`);

    await mkdir(targetDir, { recursive: true });
    await writeFile(markdownPath, await buildReadableMarkdown(archiveDir, page), "utf8");
    await writeFile(jsonPath, JSON.stringify(page, null, 2), "utf8");

    const dirKey = parts.join("/");
    dirIndexes[dirKey] ||= [];
    dirIndexes[dirKey].push({
      id: page.id,
      title: page.title,
      category: page.category,
      groupName: page.officialEntry?.groupName || "",
      url: page.url,
      markdown: relativeArchivePath(rootDir, markdownPath),
      metadata: relativeArchivePath(rootDir, jsonPath),
      updatedAt: page.updatedAt,
    });
    topLevelCounts[parts[0]] = (topLevelCounts[parts[0]] || 0) + 1;
  }

  for (const [dirKey, items] of Object.entries(dirIndexes)) {
    const categoryDir = path.join(rootDir, ...dirKey.split("/"));
    const sortedItems = items.sort((a, b) => {
      const groupCompare = String(a.groupName || "").localeCompare(String(b.groupName || ""), "zh-Hans-CN");
      if (groupCompare) return groupCompare;
      return String(a.title || "").localeCompare(String(b.title || ""), "zh-Hans-CN");
    });
    const title = dirKey.split("/").at(-1).replace(/^\d+_/, "");
    await mkdir(categoryDir, { recursive: true });
    await writeFile(path.join(categoryDir, "_index.json"), JSON.stringify(sortedItems, null, 2), "utf8");
    await writeFile(
      path.join(categoryDir, "_index.md"),
      [
        `# ${title}`,
        "",
        `共 ${sortedItems.length} 条。`,
        "",
        ...sortedItems.map((item) => {
          const prefix = item.groupName ? `【${item.groupName}】` : "";
          return `- ${prefix}[${item.title}](${item.markdown})`;
        }),
        "",
      ].join("\n"),
      "utf8"
    );
  }

  await writeFile(
    path.join(rootDir, "_index.md"),
      [
        "# 伊瑟分类归档",
        "",
        "这里是面向人工查看的实体文件夹归档。每个页面都有 `.md` 正文和同名 `.json` 结构化详情。",
        "",
        ...Object.entries(topLevelCounts)
        .sort(([a], [b]) => a.localeCompare(b, "zh-Hans-CN"))
          .map(([category, count]) => `- ${category}：${count} 条`),
        "",
      ].join("\n"),
    "utf8"
  );

  await writeFile(path.join(rootDir, "_index.json"), JSON.stringify(dirIndexes, null, 2), "utf8");
  return { rootDir, dirIndexes };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const archiveDir = path.resolve(config.archiveDir);
  const outputDir = path.resolve(config.outputSubdir ? path.join(archiveDir, config.outputSubdir) : config.outputDir);
  const classifiedDir = path.resolve(config.classifiedDir);
  const rawDetailDir = path.join(archiveDir, "_raw_api", "details");
  const index = JSON.parse(await readFile(path.join(archiveDir, "_index.json"), "utf8"));
  const discovery = JSON.parse(await readFile(path.join(archiveDir, "_raw_api", "discovery.json"), "utf8"));
  const entryRoots = discovery.wikiEntry?.data?.entry_list || [];
  const officialEntries = entryRoots.flatMap((root) => flattenEntryTree(root));
  const officialByContentId = new Map(officialEntries.map((entry) => [entry.contentId, entry]));
  const officialRoleEntries = officialEntries.filter((entry) => entry.rootName === "角色图鉴");
  const officialRoleIds = new Set(officialRoleEntries.map((entry) => entry.contentId));
  const officialZhikeEntries = officialEntries.filter((entry) => entry.rootName === "智壳图鉴");
  const officialYuanqiEntries = officialEntries.filter((entry) => entry.rootName === "矩阵图鉴");
  const officialZhikeIds = new Set(officialZhikeEntries.map((entry) => entry.contentId));
  const officialYuanqiIds = new Set(officialYuanqiEntries.map((entry) => entry.contentId));
  const allFiles = await listFilesRecursive(archiveDir);
  const markdownById = new Map();
  const metaById = new Map();

  for (const file of allFiles) {
    if (
      file.includes(`${path.sep}_raw_api${path.sep}`) ||
      (config.outputSubdir && file.includes(`${path.sep}${config.outputSubdir}${path.sep}`)) ||
      file.includes(`${path.sep}分类归档${path.sep}`)
    ) {
      continue;
    }
    const base = path.basename(file);
    const id = Number(base.match(/^(\d+)_/)?.[1]);
    if (!id) continue;
    if (file.endsWith(".md")) markdownById.set(id, file);
    if (file.endsWith(".json")) metaById.set(id, file);
  }

  const pages = [];
  const roles = [];
  const chunks = [];

  for (const summary of index.pages) {
    const id = Number(summary.id);
    const rawPath = path.join(rawDetailDir, `${id}.json`);
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    const meta = metaById.has(id) ? JSON.parse(await readFile(metaById.get(id), "utf8")) : {};
    const markdown = markdownById.has(id) ? await readFile(markdownById.get(id), "utf8") : "";
    const contentJson = tryParseJson(raw.content_json, []);
    const detail = extractStructured(contentJson);
    const fullText = markdownBody(markdown);

    const officialEntry = officialByContentId.get(id) || null;
    const normalizedOfficialCategory = normalizeCatalogRoot(officialEntry?.rootName || "");
    const page = {
      id,
      title: summary.title,
      url: summary.url,
      category: normalizedOfficialCategory || summary.category,
      archiveCategory: summary.category,
      officialCategory: normalizedOfficialCategory,
      officialEntry,
      type: summary.type,
      tag: summary.tag,
      entryId: summary.entryId,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      author: meta.user || null,
      metrics: {
        viewCount: summary.viewCount || 0,
        commentCount: summary.commentCount || 0,
        likeCount: meta.likeCount || 0,
        favoriteCount: meta.favoriteCount || 0,
      },
      summary: meta.summary || raw.summary || "",
      fullText,
      headings: headings(markdown),
      assets: unique([...(meta.assets || []), ...detail.images]).filter((url) =>
        /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(url)
      ),
      detail,
      sourceFiles: {
        markdown: markdownById.get(id) ? path.relative(archiveDir, markdownById.get(id)).replace(/\\/g, "/") : "",
        metadata: metaById.get(id) ? path.relative(archiveDir, metaById.get(id)).replace(/\\/g, "/") : "",
        rawApi: path.relative(archiveDir, rawPath).replace(/\\/g, "/"),
      },
    };
    pages.push(page);
    chunks.push(...chunkText(page, config));

    if (officialRoleIds.has(id)) {
      const roleEntry = officialByContentId.get(id);
      roles.push({
        ...makeCatalogItem(page, roleEntry, "角色图鉴"),
        rarity: roleEntry.groupName,
        category: "角色图鉴",
        officialCategory: "角色图鉴",
      });
    }
  }

  const catalogItems = {
    角色图鉴: roles,
    智壳图鉴: pages
      .filter((page) => officialZhikeIds.has(page.id))
      .map((page) => makeCatalogItem(page, officialByContentId.get(page.id), "智壳图鉴")),
    源器图鉴: pages
      .filter((page) => officialYuanqiIds.has(page.id))
      .map((page) => makeCatalogItem(page, officialByContentId.get(page.id), "源器图鉴")),
  };

  const byCategory = {};
  for (const page of pages) {
    byCategory[page.category] ||= [];
    byCategory[page.category].push({
      id: page.id,
      title: page.title,
      url: page.url,
      updatedAt: page.updatedAt,
      textLength: page.fullText.length,
      detailKinds: Object.keys(page.detail.componentTypes),
    });
  }

  await mkdir(outputDir, { recursive: true });
  await mkdir(path.join(outputDir, "categories"), { recursive: true });
  await writeFile(path.join(outputDir, "pages.json"), JSON.stringify(pages, null, 2), "utf8");
  await writeFile(path.join(outputDir, "pages.jsonl"), pages.map((page) => JSON.stringify(page)).join("\n") + "\n", "utf8");
  await writeFile(path.join(outputDir, "chunks.jsonl"), chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n", "utf8");
  await writeFile(path.join(outputDir, "roles.json"), JSON.stringify(roles, null, 2), "utf8");
  await writeFile(path.join(outputDir, "roles.jsonl"), roles.map((role) => JSON.stringify(role)).join("\n") + "\n", "utf8");
  await writeFile(path.join(outputDir, "zhike.json"), JSON.stringify(catalogItems.智壳图鉴, null, 2), "utf8");
  await writeFile(
    path.join(outputDir, "zhike.jsonl"),
    catalogItems.智壳图鉴.map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8"
  );
  await writeFile(path.join(outputDir, "yuanqi.json"), JSON.stringify(catalogItems.源器图鉴, null, 2), "utf8");
  await writeFile(
    path.join(outputDir, "yuanqi.jsonl"),
    catalogItems.源器图鉴.map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8"
  );
  await writeFile(path.join(outputDir, "catalog-items.json"), JSON.stringify(catalogItems, null, 2), "utf8");
  await writeFile(
    path.join(outputDir, "role-catalog.json"),
    JSON.stringify(officialRoleEntries.map((entry) => ({ ...entry, catalogType: "角色图鉴" })), null, 2),
    "utf8"
  );
  await writeFile(
    path.join(outputDir, "zhike-catalog.json"),
    JSON.stringify(officialZhikeEntries.map((entry) => ({ ...entry, catalogType: "智壳图鉴" })), null, 2),
    "utf8"
  );
  await writeFile(
    path.join(outputDir, "yuanqi-catalog.json"),
    JSON.stringify(officialYuanqiEntries.map((entry) => ({ ...entry, catalogType: "源器图鉴" })), null, 2),
    "utf8"
  );
  const detectedExtraRoles = pages
    .filter((page) => page.detail.isRoleLike && !officialRoleIds.has(page.id))
    .map((page) => ({
      id: page.id,
      title: page.title,
      url: page.url,
      category: page.category,
      officialEntry: page.officialEntry,
      sourceFiles: page.sourceFiles,
    }));
  await writeFile(path.join(outputDir, "roles-detected-extra.json"), JSON.stringify(detectedExtraRoles, null, 2), "utf8");
  await writeFile(path.join(outputDir, "category-index.json"), JSON.stringify(byCategory, null, 2), "utf8");
  for (const [category, list] of Object.entries(byCategory)) {
    await writeFile(path.join(outputDir, "categories", `${category}.json`), JSON.stringify(list, null, 2), "utf8");
  }
  const classified = await writeClassifiedFolders(archiveDir, pages, classifiedDir);
  await writeFile(
    path.join(outputDir, "README.md"),
    [
      "# 伊瑟知识库结构化数据",
      "",
      `- 页面总数：${pages.length}`,
      `- 官方角色图鉴词条：${roles.length}`,
      `- 官方智壳图鉴词条：${catalogItems.智壳图鉴.length}`,
      `- 官方源器图鉴词条：${catalogItems.源器图鉴.length}`,
      `- 文本切片：${chunks.length}`,
      "",
      "## 文件",
      "",
      "- `pages.json`: 全量页面，包含分类、正文、元数据、结构化 detail",
      "- `pages.jsonl`: 与 pages.json 相同，每行一页，便于导入向量库或数据库",
      "- `chunks.jsonl`: 按正文切片后的检索单元",
      "- `roles.json`: 官方 `角色图鉴` 下的 92 个角色/异格者结构化知识库",
      "- `roles.jsonl`: 官方角色/异格者 JSONL",
      "- `zhike.json` / `zhike.jsonl`: 官方 `智壳图鉴` 结构化知识库",
      "- `yuanqi.json` / `yuanqi.jsonl`: 官方 `矩阵图鉴`，在知识库中命名为 `源器图鉴`",
      "- `catalog-items.json`: 按 `角色图鉴`、`智壳图鉴`、`源器图鉴` 汇总的全部官方图鉴条目",
      "- `role-catalog.json`: 从 GameKee entry 树提取的官方角色目录（SSR/SR/R）",
      "- `zhike-catalog.json`: 官方智壳目录",
      "- `yuanqi-catalog.json`: 官方源器/矩阵目录",
      "- `roles-detected-extra.json`: 页面结构像角色但不在官方角色目录中的历史/测试条目",
      "- `category-index.json`: 分类索引",
      "- `categories/*.json`: 单分类页面列表",
      "- `../分类归档/`: 面向人工查看的实体分类文件夹，每页包含 `.md` 正文和同名 `.json` 详情",
      "",
    ].join("\n"),
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        outputDir,
        pages: pages.length,
        roles: roles.length,
        officialRoleCatalog: officialRoleEntries.length,
        zhike: catalogItems.智壳图鉴.length,
        yuanqi: catalogItems.源器图鉴.length,
        detectedExtraRoles: detectedExtraRoles.length,
        chunks: chunks.length,
        classifiedDir: classified.rootDir,
        categories: Object.fromEntries(Object.entries(byCategory).map(([key, value]) => [key, value.length])),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
