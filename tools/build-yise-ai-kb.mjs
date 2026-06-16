import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG = {
  archiveDir: "02_原始抓取数据",
  structuredDir: "03_构建缓存/_kb",
  outputDir: "01_AI知识库",
  outputSubdir: "",
};

const MANUAL_SUPPLEMENTS = [
  {
    file: "etheria-worldview.md",
    id: "local-etheria-worldview",
    title: "伊瑟世界观",
    kind: "lore",
    subtype: "worldview",
    parts: ["06_世界观设定", "00_世界观总览"],
    reason: "手工补充的伊瑟世界观、年表、阵营势力和核心设定资料",
  },
  {
    file: "game-systems.md",
    id: "local-game-systems",
    title: "游戏系统",
    kind: "system_rule",
    parts: ["02_游戏系统规则", "00_系统总览"],
    reason: "手工补充的游戏系统规则、养成结构和玩法框架",
  },
  {
    file: "dungeon-guides.md",
    id: "local-dungeon-guides",
    title: "副本攻略",
    kind: "guide",
    parts: ["03_攻略参考", "03_副本攻略"],
    reason: "手工补充的 PvE 副本机制、配队思路和开荒建议",
  },
  {
    file: "tencent-yise-tier-list.md",
    id: "local-tencent-yise-tier-list",
    title: "国服角色节奏榜",
    kind: "guide",
    subtype: "tier_list",
    parts: ["03_攻略参考", "02_阵容配队与强度评测"],
    reason: "手工补充的国服角色节奏榜、PVE/PVP 强度评分、推荐矩阵和配装参考",
  },
  {
    file: "terminology.md",
    id: "local-terminology",
    title: "术语表",
    kind: "terminology",
    subtype: "standard_terminology",
    parts: ["05_术语与社区语言", "01_标准术语"],
    reason: "手工补充的官方/标准术语对照资料",
  },
  {
    file: "community-slang.md",
    id: "local-community-slang",
    title: "玩家黑话与简称",
    kind: "terminology",
    subtype: "community_slang",
    parts: ["05_术语与社区语言", "02_玩家黑话"],
    reason: "手工补充的玩家社区黑话、简称和口语化说法",
  },
];

function parseArgs(argv) {
  const config = { ...DEFAULT_CONFIG };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--archive-dir") config.archiveDir = argv[++index];
    else if (arg === "--structured-dir") config.structuredDir = argv[++index];
    else if (arg === "--output-dir") config.outputDir = argv[++index];
    else if (arg === "--output-subdir") config.outputSubdir = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node tools/build-yise-ai-kb.mjs [options]

Options:
  --archive-dir <path>     Raw archive directory. Default: 02_原始抓取数据
  --structured-dir <path>  Structured cache directory. Default: 03_构建缓存/_kb
  --output-dir <path>      AI knowledge base directory. Default: 01_AI知识库
  --output-subdir <name>   Backward-compatible output folder inside archive.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return config;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\uFEFF/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safePathName(value, fallback = "未命名") {
  const text = cleanText(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();
  return (text || fallback).slice(0, 90);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function attr(object, key) {
  return object?.[key] ?? "";
}

function compactObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return value !== "" && value != null;
  }));
}

function readJson(file) {
  return readFile(file, "utf8").then((text) => JSON.parse(text));
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

async function writeJsonl(file, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

function rel(root, file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

function sourceOf(item) {
  return {
    pageId: item.id,
    title: item.title,
    url: item.url,
    updatedAt: item.updatedAt,
    sourceFiles: item.sourceFiles || {},
  };
}

function statBlock(attributesObject = {}) {
  return compactObject({
    生命: attr(attributesObject, "生命"),
    攻击: attr(attributesObject, "攻击"),
    防御: attr(attributesObject, "防御"),
    速度: attr(attributesObject, "速度"),
    暴击率: attr(attributesObject, "暴击率"),
    暴击伤害: attr(attributesObject, "暴击伤害"),
    效果命中: attr(attributesObject, "效果命中"),
    效果抵抗: attr(attributesObject, "效果抵抗"),
  });
}

function tableRows(object) {
  return Object.entries(object)
    .filter(([, value]) => value !== "" && value != null)
    .map(([key, value]) => `| ${key} | ${String(value).replace(/\n/g, "<br>")} |`)
    .join("\n");
}

function mdTable(object) {
  const rows = tableRows(object);
  if (!rows) return "";
  return ["| 字段 | 内容 |", "| --- | --- |", rows].join("\n");
}

function stripMarkdown(value) {
  return cleanText(
    String(value || "")
      .replace(/\*\*/g, "")
      .replace(/#+\s*/g, "")
      .replace(/\[[^\]]*]\([^)]+\)/g, "")
  );
}

function section(title, body) {
  const text = Array.isArray(body) ? body.filter(Boolean).join("\n\n") : cleanText(body);
  return text ? `## ${title}\n\n${text}` : "";
}

function skillText(skill) {
  return cleanText([skill.name, skill.label, skill.description, skill.upgradeText, skill.more].filter(Boolean).join("\n"));
}

function roleGroupName(rarity) {
  const orders = { SSR: "01_SSR", SR: "02_SR", R: "03_R" };
  return orders[rarity] || safePathName(rarity || "99_未知稀有度");
}

function yuanqiGroupName(groupName) {
  const orders = {
    攻击类: "01_攻击类",
    "速度/技能冷却类": "02_速度_技能冷却类",
    速度_技能冷却类: "02_速度_技能冷却类",
    "防御/护盾类": "03_防御_护盾类",
    防御_护盾类: "03_防御_护盾类",
    "生命/治疗类": "04_生命_治疗类",
    生命_治疗类: "04_生命_治疗类",
    "特殊/控制类": "05_特殊_控制类",
    特殊_控制类: "05_特殊_控制类",
  };
  return orders[groupName] || safePathName(groupName || "99_未分组");
}

function zhikeGroupName(groupName) {
  const orders = {
    传说: "01_传说",
    卓越: "02_卓越",
    特异: "03_特异",
    稀有: "04_稀有",
  };
  return orders[groupName] || safePathName(groupName || "99_未分组");
}

function normalizeRole(role) {
  const profile = role.profile || {};
  const profileAttrs = profile.attributesObject || {};
  const stats = statBlock(role.stats?.attributesObject || {});
  const rarity = role.rarity || role.groupName || attr(profileAttrs, "稀有度");
  const skills = asArray(role.combatSkills).map((skill, index) => compactObject({
    skillId: `${role.id}-skill-${index + 1}`,
    order: index + 1,
    section: skill.section || "",
    name: skill.name || skill.label || `技能${index + 1}`,
    label: skill.label || "",
    icon: skill.icon || "",
    description: cleanText(skill.description),
    upgradeText: cleanText(skill.upgradeText),
    tables: asArray(skill.tables),
  }));

  return compactObject({
    id: role.id,
    kind: "character",
    name: role.title,
    entryName: role.entryName,
    rarity,
    element: attr(profileAttrs, "原质属性"),
    faction: attr(profileAttrs, "所属势力"),
    title: attr(profileAttrs, "称号"),
    gender: attr(profileAttrs, "性别"),
    profession: attr(profileAttrs, "职业"),
    identityCode: attr(profileAttrs, "身份识别码"),
    chipStatus: attr(profileAttrs, "ReA芯片状态"),
    assessment: cleanText(profile.description),
    stats,
    skills,
    recommendations: role.recommendations || [],
    upgrades: role.upgrades || [],
    relations: role.relations || [],
    archiveStories: role.archiveStories || [],
    galleries: role.galleries || [],
    images: role.assets || [],
    source: sourceOf(role),
  });
}

function roleMarkdown(entity) {
  const skillSections = asArray(entity.skills).map((skill) => [
    `### ${skill.order}. ${skill.name}`,
    skill.section ? `- 类型/栏目：${skill.section}` : "",
    skill.label ? `- 标签：${skill.label}` : "",
    skill.description || "",
    skill.upgradeText ? `**升级/附加信息**\n\n${skill.upgradeText}` : "",
  ].filter(Boolean).join("\n\n"));

  return [
    `# ${entity.name}`,
    "",
    section("AI定位", [
      `- 知识类型：角色图鉴`,
      `- 稀有度：${entity.rarity || ""}`,
      `- 原质属性：${entity.element || ""}`,
      `- 职业：${entity.profession || ""}`,
      `- 所属势力：${entity.faction || ""}`,
      `- 来源页面：${entity.source?.url || ""}`,
    ].join("\n")),
    section("基础资料", mdTable(compactObject({
      称号: entity.title,
      性别: entity.gender,
      身份识别码: entity.identityCode,
      ReA芯片状态: entity.chipStatus,
    }))),
    section("异格者协会评定", entity.assessment),
    section("属性面板", mdTable(entity.stats || {})),
    section("角色技能", skillSections),
    section("养成与推荐", [
      asArray(entity.recommendations).map((item) => `### ${item.title || item.name || "推荐"}\n\n${cleanText(item.description || "")}`).join("\n\n"),
      asArray(entity.upgrades).map((item) => `### ${item.title || item.section || "养成项"}\n\n${asArray(item.content).join("\n")}\n${asArray(item.other).join("\n")}`).join("\n\n"),
    ]),
    section("档案与关系", [
      asArray(entity.archiveStories).map((item) => `### ${item.name || item.section || "档案"}\n\n${cleanText(item.description || item.more || "")}`).join("\n\n"),
      asArray(entity.relations).map((item) => `### ${item.title || "关系"}\n\n${asArray(item.content).map((relation) => relation.name).filter(Boolean).join("、")}`).join("\n\n"),
    ]),
  ].filter(Boolean).join("\n\n").trim() + "\n";
}

function roleSkillsMarkdown(entity) {
  const skills = asArray(entity.skills).map((skill) => [
    `## ${skill.order}. ${skill.name}`,
    skill.section ? `- 类型/栏目：${skill.section}` : "",
    skill.label ? `- 标签：${skill.label}` : "",
    "",
    skill.description || "",
    skill.upgradeText ? `\n### 升级/附加信息\n\n${skill.upgradeText}` : "",
  ].filter((line) => line !== "").join("\n"));

  return [
    `# ${entity.name} - 角色技能`,
    "",
    `- 角色 ID：${entity.id}`,
    `- 稀有度：${entity.rarity || ""}`,
    `- 原质属性：${entity.element || ""}`,
    `- 来源页面：${entity.source?.url || ""}`,
    "",
    skills.join("\n\n"),
  ].join("\n").trim() + "\n";
}

function normalizeYuanqi(item) {
  const profile = item.profile || {};
  const attrs = profile.attributesObject || {};
  const effect = extractMatrixEffectText(item, attrs);
  const setPointEffects = parseSetPointEffects(effect);
  return compactObject({
    id: item.id,
    kind: "yuanqi",
    name: item.title,
    entryName: item.entryName,
    group: item.groupName,
    effect,
    setPointRule: "矩阵效果中的数字表示源器套装生效所需点数，例如 4/8/12 分别表示装备源器累计达到对应点数时解锁该档效果。",
    setPoints: setPointEffects.map((item) => item.points),
    setPointEffects,
    obtain: attr(attrs, "获取途径"),
    description: cleanText(profile.description),
    attributes: attrs,
    images: item.assets || [],
    source: sourceOf(item),
  });
}

function extractMatrixEffectText(item, attrs) {
  const structuredEffect = attr(attrs, "矩阵效果");
  if (structuredEffect) return cleanText(structuredEffect);

  const fullText = cleanText(item.fullText);
  const tableMatch = fullText.match(/\|\s*(?:\*\*)?矩阵效果(?:\*\*)?\s*\|\s*([\s\S]*?)(?=\n\|\s*获取途径\s*\||\n\|\s*[^|]+\s*\|\s*[^|]+\s*\||$)/);
  if (tableMatch) return cleanText(tableMatch[1].replace(/\|\s*$/g, ""));

  const labeledMatch = fullText.match(/矩阵效果\s*[:：]?\s*([\s\S]*?)(?=\n\s*获取途径\s*[:：]?|$)/);
  if (labeledMatch) return cleanText(labeledMatch[1]);

  return fullText;
}

function parseSetPointEffects(effectText) {
  const text = stripMarkdown(effectText)
    .replace(/\|/g, "\n")
    .replace(/；\s*(?=\d{1,2}\s*[：:])/g, "\n")
    .replace(/;\s*(?=\d{1,2}\s*[：:])/g, "\n");
  const pattern = /(^|[\n。；;])\s*(\d{1,2})\s*[：:]\s*/g;
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return [];

  return matches
    .map((match, index) => {
      const start = match.index + match[0].length;
      const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
      const description = cleanText(text.slice(start, end).replace(/^\s*[。；;]\s*/, "").replace(/\s*\|\s*$/g, ""));
      return {
        points: Number(match[2]),
        description,
      };
    })
    .filter((item) => item.points > 0 && item.description);
}

function yuanqiMarkdown(entity) {
  const pointRows = asArray(entity.setPointEffects)
    .map((item) => `| ${item.points} | ${item.description.replace(/\n/g, "<br>")} |`)
    .join("\n");
  const pointTable = pointRows ? ["| 所需点数 | 套装效果 |", "| --- | --- |", pointRows].join("\n") : "";
  const effectSection = pointTable ? "" : section("套装效果", entity.effect);
  return [
    `# ${entity.name}`,
    "",
    section("AI定位", [
      "- 知识类型：源器/矩阵图鉴",
      `- 分组：${entity.group || ""}`,
      `- 来源页面：${entity.source?.url || ""}`,
    ].join("\n")),
    section("套装点数规则", entity.setPointRule),
    section("套装点数效果", pointTable),
    effectSection,
    section("获取途径", entity.obtain),
    section("说明", entity.description),
  ].filter(Boolean).join("\n\n").trim() + "\n";
}

function normalizeZhike(item) {
  const profile = item.profile || {};
  const attrs = profile.attributesObject || {};
  const stats = statBlock(attrs);
  const skills = asArray(item.archiveStories).map((skill, index) => compactObject({
    skillId: `${item.id}-skill-${index + 1}`,
    order: index + 1,
    section: skill.section || "宠物技能",
    name: skill.name || `技能${index + 1}`,
    description: cleanText(skill.description || skill.more),
  }));

  return compactObject({
    id: item.id,
    kind: "zhike",
    name: item.title,
    entryName: item.entryName,
    rarityGroup: item.groupName,
    starRarity: attr(attrs, "稀有度"),
    role: attr(attrs, "定位"),
    description: cleanText(profile.description),
    stats,
    skills,
    possibleMatrices: item.upgrades || [],
    attributes: attrs,
    images: item.assets || [],
    source: sourceOf(item),
  });
}

function zhikeMarkdown(entity) {
  const skills = asArray(entity.skills).map((skill) => `### ${skill.name}\n\n${skill.description}`).join("\n\n");
  const matrices = asArray(entity.possibleMatrices)
    .map((item) => `### ${item.title || item.section || "可出现矩阵"}\n\n${asArray(item.content).join("\n")}\n${asArray(item.other).join("\n")}`)
    .join("\n\n");

  return [
    `# ${entity.name}`,
    "",
    section("AI定位", [
      "- 知识类型：智壳图鉴",
      `- 稀有度分组：${entity.rarityGroup || ""}`,
      `- 星级：${entity.starRarity || ""}`,
      `- 定位：${entity.role || ""}`,
      `- 来源页面：${entity.source?.url || ""}`,
    ].join("\n")),
    section("基础说明", entity.description),
    section("属性", mdTable(entity.stats || {})),
    section("智壳技能", skills),
    section("可出现矩阵", matrices),
  ].filter(Boolean).join("\n\n").trim() + "\n";
}

function pageText(page) {
  return cleanText([page.title, page.summary, page.fullText].filter(Boolean).join("\n\n"));
}

function classifySupportPage(page) {
  const title = page.title || "";
  const text = pageText(page);
  const haystack = `${title}\n${text}`;
  const titleRuleLike = /规则|机制|系统|说明|介绍|玩法|基础|属性|效果|状态|公式|任务一览|BUFF|buff/.test(title);
  const bodyRuleLike = titleRuleLike && /规则|机制|系统|公式|效果命中|效果抵抗|行动条|冷却|增益|减益/.test(haystack);
  const ruleLike = titleRuleLike || bodyRuleLike;
  const guideLike = /攻略|测评|评测|推荐|节奏榜|强度榜|一图流|入坑|开荒|规划|通关|低配|高配|日记|搬运|指南|思路|建议|速通|培养|配装|搭配|分析|解读|PVE|pve|PVP|pvp/.test(title);
  const has = (pattern) => pattern.test(haystack);
  const titleHas = (pattern) => pattern.test(title);

  if (/测试模版|测试模板|临时/.test(title)) {
    return { kind: "cleanup_candidate", parts: ["99_待清洗", "99_临时测试页"], reason: "标题显示为临时或测试页" };
  }
  if (page.detail?.isRoleLike) {
    return { kind: "cleanup_candidate", parts: ["99_待清洗", "01_旧角色或非官方角色图鉴"], reason: "页面结构像角色，但不在官方角色图鉴目录" };
  }
  if (page.archiveCategory === "03_图鉴词条" && !page.officialCategory) {
    if (/源器|矩阵|乘势追击|攻势|收割|狂怒/.test(title)) {
      return { kind: "cleanup_candidate", parts: ["99_待清洗", "02_旧源器或重复条目"], reason: "图鉴粗分类残留，未命中官方源器目录" };
    }
  }
  if (/01_公告资讯|02_活动卡池/.test(page.archiveCategory || page.category || "")) {
    return { kind: "reference", parts: ["04_公告活动资料", safePathName(page.archiveCategory || "公告活动")], reason: "公告或活动资料" };
  }
  if (/^PVP$/i.test(title) || /PVP规则|竞技规则|巅峰竞技/.test(title)) {
    return { kind: "system_rule", parts: ["02_游戏系统规则", "02_PVP规则"], reason: "高置信PVP规则资料" };
  }
  if (/伤害计算公式|全buff相关|全BUFF相关|Buff图标|BUFF图标|技改/.test(title)) {
    return { kind: "system_rule", parts: ["02_游戏系统规则", "04_战斗机制"], reason: "高置信战斗机制或公式资料" };
  }
  if (/属性选择|任务一览/.test(title)) {
    return { kind: "system_rule", parts: ["02_游戏系统规则", "01_养成规则"], reason: "高置信养成或任务说明资料" };
  }
  if (guideLike) {
    if (titleHas(/PVP|pvp|竞技|天梯|排位|斗技|巅峰/)) {
      return { kind: "guide", parts: ["03_攻略参考", "04_PVP攻略"], reason: "PVP攻略、榜单或评测参考" };
    }
    if (titleHas(/副本|关卡|BOSS|boss|地狱|炼狱|兵祸|禁区|梦境|剧场|列车|试炼|熔断|多琪|凶影|PVE|pve/)) {
      return { kind: "guide", parts: ["03_攻略参考", "03_副本攻略"], reason: "副本或PVE攻略参考" };
    }
    if (titleHas(/养成|培养|技能加点|加点|角色|异格者|源器|智壳|矩阵|装备/)) {
      return { kind: "guide", parts: ["03_攻略参考", "01_角色养成与技能"], reason: "角色养成、技能、源器或智壳攻略参考" };
    }
    if (titleHas(/配队|阵容|队伍|排行|T0|T1/)) {
      return { kind: "guide", parts: ["03_攻略参考", "02_阵容配队与强度评测"], reason: "阵容、推荐或评测内容" };
    }
    return { kind: "guide", parts: ["03_攻略参考", "99_综合攻略评测"], reason: "攻略评测分类兜底" };
  }
  if (titleHas(/PVP|pvp|竞技|天梯|排位|斗技|巅峰/) && ruleLike) {
    return { kind: "system_rule", parts: ["02_游戏系统规则", "02_PVP规则"], reason: "PVP规则或机制相关" };
  }
  if (titleHas(/养成|培养|升级|突破|升格|装备|芯片|源器|智壳|矩阵|属性|潜能/) && ruleLike) {
    return { kind: "system_rule", parts: ["02_游戏系统规则", "01_养成规则"], reason: "养成、装备或属性规则相关" };
  }
  if (titleHas(/buff|debuff|增益|减益|控制|速度|回合|行动|效果命中|效果抵抗|伤害|治疗|护盾|冷却/) && ruleLike) {
    return { kind: "system_rule", parts: ["02_游戏系统规则", "04_战斗机制"], reason: "战斗状态、回合或数值机制相关" };
  }
  if (titleHas(/副本|关卡|BOSS|boss|地狱|炼狱|兵祸|禁区|梦境|剧场|列车|试炼|熔断/) && ruleLike) {
    return { kind: "system_rule", parts: ["02_游戏系统规则", "03_副本规则"], reason: "副本玩法规则相关" };
  }
  if (has(/配队|阵容|队伍|推荐|排行|强度榜|节奏榜|T0|T1|评测/)) {
    return { kind: "guide", parts: ["03_攻略参考", "02_阵容配队与强度评测"], reason: "阵容、推荐或评测内容" };
  }
  if (/攻略|评测/.test(page.archiveCategory || page.category || "")) {
    return { kind: "guide", parts: ["03_攻略参考", "99_综合攻略评测"], reason: "攻略评测分类兜底" };
  }
  return { kind: "cleanup_candidate", parts: ["99_待清洗", "03_未归类资料"], reason: "暂无足够规则判定到正式知识区" };
}

function supportMarkdown(page, classification) {
  return [
    `# ${page.title}`,
    "",
    "## AI整理信息",
    "",
    `- 知识类型：${classification.kind}`,
    `- 整理目录：${classification.parts.join(" / ")}`,
    `- 归类原因：${classification.reason}`,
    `- 原始分类：${page.archiveCategory || page.category || ""}`,
    `- 页面 ID：${page.id}`,
    `- 来源页面：${page.url}`,
    `- 更新时间：${page.updatedAt || ""}`,
    "",
    "## 正文",
    "",
    page.fullText || page.summary || "",
  ].join("\n").trim() + "\n";
}

function supportUnit(page, classification) {
  return compactObject({
    id: page.id,
    kind: classification.kind,
    title: page.title,
    domainPath: classification.parts,
    classifyReason: classification.reason,
    originalCategory: page.archiveCategory || page.category,
    officialCategory: page.officialCategory || "",
    text: pageText(page),
    assets: page.assets || [],
    source: sourceOf(page),
  });
}

function normalizeManualMarkdown(text) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .replace(/\uFEFF/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n## 查询脚本[\s\S]*?(?=\n## |$)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\]\([^)]*\/etheria\/([^)]*)\)/g, "]($1)")
    .replace(/\]\([^)]*\/(community-slang\.md|dungeon-guides\.md|etheria-worldview\.md|game-systems\.md|terminology\.md|activity-guides\.md|translation-index\.json)\)/g, "]($1)");
}

async function loadManualSupplements(archiveDir) {
  const manualDir = path.join(archiveDir, "手工补充资料");
  try {
    await readdir(manualDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const supplements = [];
  for (const config of MANUAL_SUPPLEMENTS) {
    const file = path.join(manualDir, config.file);
    try {
      const [text, fileStat] = await Promise.all([
        readFile(file, "utf8"),
        stat(file),
      ]);
      supplements.push({
        ...config,
        fullText: normalizeManualMarkdown(text),
        updatedAt: fileStat.mtime.toISOString(),
        sourceFile: rel(archiveDir, file),
      });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
  return supplements;
}

function manualMarkdown(entity) {
  return [
    `# ${entity.title}`,
    "",
    "## AI整理信息",
    "",
    `- 知识类型：${entity.kind}`,
    entity.subtype ? `- 资料子类：${entity.subtype}` : "",
    `- 整理目录：${entity.parts.join(" / ")}`,
    `- 归类原因：${entity.reason}`,
    `- 原始来源：${entity.sourceFile}`,
    `- 更新时间：${entity.updatedAt}`,
    "",
    "## 正文",
    "",
    entity.fullText,
  ].filter(Boolean).join("\n").trim() + "\n";
}

function manualUnit(entity) {
  return compactObject({
    id: entity.id,
    kind: entity.kind,
    subtype: entity.subtype,
    title: entity.title,
    domainPath: entity.parts,
    classifyReason: entity.reason,
    originalCategory: "手工补充资料",
    text: [entity.title, entity.fullText].filter(Boolean).join("\n\n"),
    source: {
      type: "local_manual",
      title: entity.title,
      url: "",
      updatedAt: entity.updatedAt,
      sourceFiles: {
        markdown: entity.sourceFile,
      },
    },
  });
}

async function resetOutput(archiveDir, outputDir) {
  const resolvedWorkspace = path.resolve(process.cwd());
  const resolvedOutput = path.resolve(outputDir);
  const allowedNames = new Set(["AI知识库", "01_AI知识库"]);
  if (!resolvedOutput.startsWith(resolvedWorkspace + path.sep) || !allowedNames.has(path.basename(resolvedOutput))) {
    throw new Error(`Refusing to clear unexpected AI KB directory: ${resolvedOutput}`);
  }
  try {
    await rm(resolvedOutput, { recursive: true, force: true });
  } catch (error) {
    if (!["EBUSY", "EPERM"].includes(error.code)) throw error;
    console.warn(`Warning: ${resolvedOutput} is busy; rebuilding files in place.`);
  }
  await mkdir(resolvedOutput, { recursive: true });
}

function addIndex(indexes, dirKey, row) {
  indexes[dirKey] ||= [];
  indexes[dirKey].push(row);
}

async function writeUnitFiles(outputDir, indexes, parts, stem, markdown, json) {
  const dir = path.join(outputDir, ...parts);
  const mdPath = path.join(dir, `${stem}.md`);
  const jsonPath = path.join(dir, `${stem}.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(mdPath, markdown, "utf8");
  await writeJson(jsonPath, json);
  addIndex(indexes, parts.join("/"), {
    id: json.id,
    title: json.name || json.title,
    kind: json.kind,
    markdown: rel(outputDir, mdPath),
    metadata: rel(outputDir, jsonPath),
    sourceUrl: json.source?.url || "",
    updatedAt: json.source?.updatedAt || "",
  });
  return { mdPath, jsonPath };
}

async function writeDirectoryIndexes(outputDir, indexes) {
  for (const [dirKey, rows] of Object.entries(indexes)) {
    const dir = path.join(outputDir, ...dirKey.split("/"));
    const sortedRows = rows.sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "zh-Hans-CN"));
    await writeJson(path.join(dir, "_index.json"), sortedRows);
    await writeFile(
      path.join(dir, "_index.md"),
      [
        `# ${dirKey.split("/").at(-1).replace(/^\d+_/, "")}`,
        "",
        `共 ${sortedRows.length} 条。`,
        "",
        ...sortedRows.map((row) => `- [${row.title}](${path.basename(row.markdown)})`),
        "",
      ].join("\n"),
      "utf8"
    );
  }
}

async function writeRuleTemplates(outputDir) {
  const templates = [
    ["02_游戏系统规则", "01_养成规则", "00_待补充_养成规则模板.md", "养成规则"],
    ["02_游戏系统规则", "02_PVP规则", "00_待补充_PVP规则模板.md", "PVP规则"],
    ["02_游戏系统规则", "03_副本规则", "00_待补充_副本规则模板.md", "副本规则"],
    ["02_游戏系统规则", "04_战斗机制", "00_待补充_战斗机制模板.md", "战斗机制"],
  ];

  for (const [top, sub, filename, title] of templates) {
    const file = path.join(outputDir, top, sub, filename);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      [
        `# ${title}补充模板`,
        "",
        "## 规则名称",
        "",
        "## 适用版本",
        "",
        "## 核心规则",
        "",
        "## 触发条件",
        "",
        "## 数值、限制与例外",
        "",
        "## AI理解要点",
        "",
        "## 来源与备注",
        "",
      ].join("\n"),
      "utf8"
    );
  }
}

function ontology() {
  return {
    purpose: "让 AI 理解《伊瑟》的角色、技能、源器、智壳、世界观设定，以及养成、PVP、副本、战斗等系统规则。",
    entityTypes: {
      character: "官方角色图鉴实体，包含基础档案、属性、技能、推荐、档案关系。",
      character_skill: "角色技能知识单元，挂靠角色，适合单独检索技能效果。",
      yuanqi: "官方矩阵/源器图鉴实体，包含套装效果、套装所需点数、获取途径和分组。",
      zhike: "官方智壳图鉴实体，包含属性、技能、可出现矩阵。",
      system_rule: "游戏系统规则、机制说明，优先承载养成、PVP、副本、战斗机制。",
      guide: "攻略和经验内容，可作为规则之外的参考。",
      terminology: "标准术语、英文对照、玩家黑话与社区简称，适合术语解释和口语理解。",
      lore: "世界观、年表、阵营势力、关键人物和叙事设定，适合回答剧情背景与设定关系。",
      cleanup_candidate: "疑似旧条目、重复页、测试页或暂未可靠归类的资料。",
    },
    recommendedRetrievalOrder: [
      "回答角色/技能问题时优先查 character 与 character_skill。",
      "回答源器/矩阵问题时优先查 yuanqi。",
      "回答智壳问题时优先查 zhike。",
      "回答世界观、剧情背景、阵营势力、关键人物关系时优先查 lore。",
      "回答术语、英文名、玩家黑话或简称时优先查 terminology。",
      "回答玩法规则时优先查 system_rule，再查 guide。",
      "cleanup_candidate 只在正式知识区没有答案时作为低置信参考。",
    ],
  };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const archiveDir = path.resolve(config.archiveDir);
  const kbDir = path.resolve(config.structuredDir);
  const outputDir = path.resolve(config.outputSubdir ? path.join(archiveDir, config.outputSubdir) : config.outputDir);
  await resetOutput(archiveDir, outputDir);

  const [pages, rolesRaw, yuanqiRaw, zhikeRaw, manualSupplements] = await Promise.all([
    readJson(path.join(kbDir, "pages.json")),
    readJson(path.join(kbDir, "roles.json")),
    readJson(path.join(kbDir, "yuanqi.json")),
    readJson(path.join(kbDir, "zhike.json")),
    loadManualSupplements(archiveDir),
  ]);

  const officialEntityIds = new Set([
    ...rolesRaw.map((item) => item.id),
    ...yuanqiRaw.map((item) => item.id),
    ...zhikeRaw.map((item) => item.id),
  ]);
  const indexes = {};
  const allUnits = [];
  const skillUnits = [];
  const ruleUnits = [];
  const guideUnits = [];
  const terminologyUnits = [];
  const loreUnits = [];
  const cleanupUnits = [];

  const roles = rolesRaw.map(normalizeRole);
  for (const role of roles) {
    const stem = `${role.id}_${safePathName(role.name)}`;
    await writeUnitFiles(
      outputDir,
      indexes,
      ["01_图鉴资料", "01_角色", roleGroupName(role.rarity)],
      stem,
      roleMarkdown(role),
      role
    );
    await writeUnitFiles(
      outputDir,
      indexes,
      ["01_图鉴资料", "02_角色技能", roleGroupName(role.rarity)],
      stem,
      roleSkillsMarkdown(role),
      { ...role, kind: "character_skill_bundle" }
    );
    allUnits.push(role);
    for (const skill of asArray(role.skills)) {
      const unit = compactObject({
        id: skill.skillId,
        kind: "character_skill",
        characterId: role.id,
        characterName: role.name,
        rarity: role.rarity,
        element: role.element,
        profession: role.profession,
        skillName: skill.name,
        order: skill.order,
        section: skill.section,
        label: skill.label,
        text: skillText(skill),
        source: role.source,
      });
      skillUnits.push(unit);
      allUnits.push(unit);
    }
  }

  const yuanqi = yuanqiRaw.map(normalizeYuanqi);
  for (const item of yuanqi) {
    const stem = `${item.id}_${safePathName(item.name)}`;
    await writeUnitFiles(
      outputDir,
      indexes,
      ["01_图鉴资料", "03_源器", yuanqiGroupName(item.group)],
      stem,
      yuanqiMarkdown(item),
      item
    );
    allUnits.push(item);
  }

  const zhike = zhikeRaw.map(normalizeZhike);
  for (const item of zhike) {
    const stem = `${item.id}_${safePathName(item.name)}`;
    await writeUnitFiles(
      outputDir,
      indexes,
      ["01_图鉴资料", "04_智壳", zhikeGroupName(item.rarityGroup)],
      stem,
      zhikeMarkdown(item),
      item
    );
    allUnits.push(item);
  }

  for (const page of pages) {
    if (officialEntityIds.has(page.id)) continue;
    const classification = classifySupportPage(page);
    const unit = supportUnit(page, classification);
    const stem = `${page.id}_${safePathName(page.title)}`;
    await writeUnitFiles(outputDir, indexes, classification.parts, stem, supportMarkdown(page, classification), unit);
    allUnits.push(unit);
    if (unit.kind === "system_rule") ruleUnits.push(unit);
    else if (unit.kind === "guide") guideUnits.push(unit);
    else if (unit.kind === "cleanup_candidate") cleanupUnits.push(unit);
  }

  for (const manual of manualSupplements) {
    const unit = manualUnit(manual);
    const stem = `${manual.id}_${safePathName(manual.title)}`;
    await writeUnitFiles(outputDir, indexes, manual.parts, stem, manualMarkdown(manual), unit);
    allUnits.push(unit);
    if (unit.kind === "system_rule") ruleUnits.push(unit);
    else if (unit.kind === "guide") guideUnits.push(unit);
    else if (unit.kind === "terminology") terminologyUnits.push(unit);
    else if (unit.kind === "lore") loreUnits.push(unit);
  }

  await writeDirectoryIndexes(outputDir, indexes);
  await writeRuleTemplates(outputDir);

  const manifest = {
    generatedAt: new Date().toISOString(),
    archiveDir,
    outputDir,
    counts: {
      characters: roles.length,
      characterSkills: skillUnits.length,
      yuanqi: yuanqi.length,
      zhike: zhike.length,
      systemRules: ruleUnits.length,
      guides: guideUnits.length,
      terminology: terminologyUnits.length,
      lore: loreUnits.length,
      cleanupCandidates: cleanupUnits.length,
      totalUnits: allUnits.length,
    },
    directories: {
      图鉴资料: "01_图鉴资料",
      游戏系统规则: "02_游戏系统规则",
      攻略参考: "03_攻略参考",
      公告活动资料: "04_公告活动资料",
      术语与社区语言: "05_术语与社区语言",
      世界观设定: "06_世界观设定",
      待清洗: "99_待清洗",
    },
  };

  await writeJson(path.join(outputDir, "00_索引.json"), manifest);
  await writeJson(path.join(outputDir, "00_知识本体.json"), ontology());
  await writeJsonl(path.join(outputDir, "knowledge_units.jsonl"), allUnits);
  await writeJsonl(path.join(outputDir, "entities.characters.jsonl"), roles);
  await writeJsonl(path.join(outputDir, "entities.character_skills.jsonl"), skillUnits);
  await writeJsonl(path.join(outputDir, "entities.yuanqi.jsonl"), yuanqi);
  await writeJsonl(path.join(outputDir, "entities.zhike.jsonl"), zhike);
  await writeJsonl(path.join(outputDir, "rules.system.jsonl"), ruleUnits);
  await writeJsonl(path.join(outputDir, "guides.reference.jsonl"), guideUnits);
  await writeJsonl(path.join(outputDir, "terminology.reference.jsonl"), terminologyUnits);
  await writeJsonl(path.join(outputDir, "lore.reference.jsonl"), loreUnits);
  await writeJsonl(path.join(outputDir, "cleanup_candidates.jsonl"), cleanupUnits);

  await writeFile(
    path.join(outputDir, "00_使用说明.md"),
    [
      "# 伊瑟 AI 知识库",
      "",
      "这层目录是对 GameKee 抓取结果的二次清洗，不替代原始归档。目标是让 AI 能区分实体图鉴、角色技能、系统规则和攻略参考。",
      "",
      "## 目录",
      "",
      "- `01_图鉴资料/01_角色`: 官方角色图鉴，按 SSR/SR/R 分组。",
      "- `01_图鉴资料/02_角色技能`: 每个角色的技能单独成文，便于技能问答检索。",
      "- `01_图鉴资料/03_源器`: 官方矩阵/源器图鉴，按功能分组。",
      "  - 源器实体里的 `setPoints` 是套装生效点数，`setPointEffects` 是每个点数档位对应的矩阵效果。",
      "- `01_图鉴资料/04_智壳`: 官方智壳图鉴，按稀有度分组。",
      "- `02_游戏系统规则`: 养成、PVP、副本、战斗机制等规则知识。当前从已有页面抽取，后续可按模板补充游戏内规则。",
      "- `03_攻略参考`: 攻略、推荐、评测等经验内容。",
      "- `05_术语与社区语言`: 标准术语、英文对照、玩家黑话、社区简称。",
      "- `06_世界观设定`: 世界观、年表、阵营势力、关键概念等叙事设定资料。",
      "- `99_待清洗`: 旧图鉴、重复页、测试页、低置信归类内容。",
      "",
      "## 机器读取文件",
      "",
      "- `knowledge_units.jsonl`: 全部 AI 知识单元。",
      "- `entities.characters.jsonl`: 角色实体。",
      "- `entities.character_skills.jsonl`: 角色技能实体。",
      "- `entities.yuanqi.jsonl`: 源器实体。",
      "- `entities.zhike.jsonl`: 智壳实体。",
      "- `rules.system.jsonl`: 系统规则与机制。",
      "- `guides.reference.jsonl`: 攻略参考。",
      "- `terminology.reference.jsonl`: 术语、英文对照与社区黑话。",
      "- `lore.reference.jsonl`: 世界观、年表、阵营势力与叙事设定。",
      "- `cleanup_candidates.jsonl`: 待人工确认资料。",
      "",
      "## 统计",
      "",
      `- 角色：${roles.length}`,
      `- 角色技能单元：${skillUnits.length}`,
      `- 源器：${yuanqi.length}`,
      `- 智壳：${zhike.length}`,
      `- 系统规则/机制页：${ruleUnits.length}`,
      `- 攻略参考页：${guideUnits.length}`,
      `- 术语与社区语言：${terminologyUnits.length}`,
      `- 世界观设定：${loreUnits.length}`,
      `- 待清洗页：${cleanupUnits.length}`,
      "",
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(outputDir, "00_清洗报告.md"),
    [
      "# 清洗报告",
      "",
      "## 已完成",
      "",
      "- 官方 `角色图鉴`、`矩阵图鉴/源器图鉴`、`智壳图鉴` 已作为高置信实体区输出。",
      "- 角色技能已从角色实体中拆成独立检索单元。",
      "- 非官方图鉴残留、测试页、旧条目进入 `99_待清洗`，避免污染正式实体知识。",
      "- 系统规则目录已建立，并提供养成、PVP、副本、战斗机制的补充模板。",
      "- `手工补充资料` 会进入正式知识区：世界观设定、系统总览、副本攻略、标准术语、玩家黑话均保留原文与元数据。",
      "",
      "## 后续建议",
      "",
      "- 从游戏内或权威资料补充 `02_游戏系统规则`，尤其是养成消耗、PVP赛制、副本重置/掉落/难度规则。",
      "- 对 `99_待清洗` 逐条确认：旧角色是否废弃、重复源器是否合并、攻略是否转入参考区。",
      "- 构建 RAG 时建议给 `character`、`character_skill`、`yuanqi`、`zhike`、`system_rule`、`terminology`、`lore` 设置高权重，`guide` 中权重，`cleanup_candidate` 低权重。",
      "",
    ].join("\n"),
    "utf8"
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
