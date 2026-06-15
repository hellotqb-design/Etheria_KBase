# 伊瑟 GameKee 知识库整理

这个目录已经整理成浅层结构，日常只需要看 `01_AI知识库`。

## 目录结构

- `01_AI知识库/`: 最终给 AI 使用的清洗版知识库。
- `02_原始抓取数据/`: 从 GameKee 抓取下来的原始页面、索引和 API 响应。
- `tools/`: 爬取、结构化、清洗脚本。

## 推荐入口

- `01_AI知识库/00_使用说明.md`: 给人看的知识库说明。
- `01_AI知识库/00_索引.json`: 当前清洗统计。
- `01_AI知识库/knowledge_units.jsonl`: 全部 AI 知识单元。
- `01_AI知识库/entities.characters.jsonl`: 角色实体。
- `01_AI知识库/entities.character_skills.jsonl`: 角色技能实体。
- `01_AI知识库/entities.yuanqi.jsonl`: 源器实体。
- `01_AI知识库/entities.zhike.jsonl`: 智壳实体。
- `01_AI知识库/rules.system.jsonl`: 游戏系统规则。
- `01_AI知识库/guides.reference.jsonl`: 攻略参考。

## 重新构建

已有原始数据时，按顺序运行：

```powershell
node .\tools\build-yise-kb.mjs
node .\tools\build-yise-ai-kb.mjs
```

需要重新爬取时：

```powershell
node .\tools\crawl-yise.mjs --output-dir 02_原始抓取数据 --concurrency 2 --delay-ms 800 --retries 5
node .\tools\build-yise-kb.mjs
node .\tools\build-yise-ai-kb.mjs
```

`01_AI知识库` 会被构建脚本重建；手动补充的规则建议先放在单独文件里，再纳入脚本流程。

运行 `build-yise-kb.mjs` 时会临时生成 `03_构建缓存/`，它只是中间产物；确认 `01_AI知识库/` 已重建后可以删除。
