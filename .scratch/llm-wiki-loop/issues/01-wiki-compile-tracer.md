# 01: Wiki 编译 tracer-bullet（最小闭环）

**What to build:** 平台维护者手写一个样例知识词条，经编译服务收口落入 org 级 wiki（独立 git 仓库），INDEX.md 与 LOG.md 程序化生成，FTS 索引同步，随后通过只读 API（域树 + 单词条）可见——知识从"文件堆积"变成"可编译、可版本化、可查询"的第一条完整通路。

**Blocked by:** None (can start immediately)

**Status:** done

**Reference:** spec.md §Implementation Decisions（知识表示/编译服务/API）· prototype.html Tab③ · 测试缝 S1+S3（spec §Testing Decisions）

- [ ] wiki 根在 org 目录下初始化为独立 git 仓库（以代码现实 orgs/ 路径布局为准）；目录骨架含四域 + cases/ + _retired/
- [ ] 词条 front-matter 过 Zod schema 校验（id/domain/title/summary/topics/stability/last_compiled/sources/confidence；volatile 必带 review_after），不合规拒绝编译并给出可读错误
- [ ] 编译服务为唯一写入口，事务性收口：校验 → 写词条 → INDEX.md 程序化重建（llms.txt 风格：H1+blockquote+H2 域节+每词条一行摘要）→ LOG.md append（|日期|动作|词条|摘要|来源|审核|）→ FTS 同步 → git commit；任一步失败原子回滚（临时目录+原子替换），不留半成品状态
- [ ] 正文规则行锚点格式（不可见 id 注释，来自原型样例）被解析并全库唯一性校验；正文出现日期（regex 巡检）即 L5 预检 warn
- [ ] wiki_articles + wiki_fts（FTS5）建表走蓝绿迁移，旧库升级不丢既有行（experiences_fts 迁移先例）
- [ ] wiki tree（域树+统计）与 article（正文+元数据）两个只读 API 契约测试通过（archive-routes 路由测试先例）
- [ ] S1 缝测试：编译环级测试（knowledge-loop.test 先例）+ 真 fs tmpdir（file-ops.test 先例）；expected 值取自原型样例（禁止 Tautological Test）
- [ ] 可演示：手写样例词条编译后 API 返回、git log 出现该 commit、LOG.md 出现首行、INDEX.md 含该词条行
- [ ] GLOSSARY-MAP 入册新词条：词条 (Entry)、INDEX/LOG 导航层（domain.md 消费规则）

## Comments
- Merged to integration as db2aa6e8 (merge of 693596b6/16e6716e). Build green; server suite 2925/44 exactly on main-baseline (no new failures), 27 new wiki tests green (wiki-compile 7, format 10, schema 5, routes 5); injection chain zero diff; SCHEMA_VERSION 51→52 (wiki_articles PK (org,id) + wiki_fts FTS5) on integration.
- Reuse contract for 02/03/04/05/06/07 in `C:\tmp\llm-wiki-notes\handoff-01.md`: `WikiCompileService.compileEntry(...)` = sole write entry (transactional rollback, injectable GitRunner); root env hook `OCTOPUS_WIKI_DIR`; format helpers `extractRuleAnchors`/`findDateOccurrences`; `renderWikiIndex`/`scanWikiEntries`/`formatLogRow`; `WikiArticleDAO.search(org,query,limit)` (org-scoped, FTS manual rowid).
- Legacy rule ids contain `/` and fail `isValidRuleId` (validators.ts:34) — ticket 05 must remap to `oct-NNN`, never reuse. `countPendingByType` counts only rule|skill — ticket 02 must extend for wiki types.
