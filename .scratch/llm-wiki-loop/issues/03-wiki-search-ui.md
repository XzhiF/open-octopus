# 03: 检索 API + /wiki 只读页

**What to build:** 平台用户打开 Web-UI 新路由 /wiki，在三栏界面（域树 / 词条渲染+元数据 chips / 溯源面板）浏览全部知识词条，用顶部检索做 FTS 全文搜索（命中规则锚点级），并在健康概览条看到知识库整体状态——人可以预览这座 LLM-WIKI 了。

**Blocked by:** 01（wiki 编译 tracer-bullet）

**Status:** done

**Reference:** spec.md §服务端 API 与存储、§Web-UI · prototype.html Tab⑤（三栏 mockup，主色/布局照抄原型）

- [ ] wiki search API：参数 q/org/topK/domain，FTS5 MATCH 主检索 + LIKE 降级（session_memory_fts 同款先例），返回命中词条/规则锚点片段与定位
- [ ] /wiki 三栏只读页：左域树（各域计数 + System 组含 LOG.md/健康入口）、中词条渲染（复用 MarkdownPreview：react-markdown + remark-gfm + rehype-sanitize）、右元数据面板（sources 溯源、git 近史、LOG 摘录、confidence/stability chips）
- [ ] 顶部检索框接 search API，结果可跳转词条并高亮命中锚点
- [ ] 健康概览条：词条数/规则数/案例数/最近编译/待审核数（故事 32）
- [ ] LOG.md 有渲染视图（策展日志表格）
- [ ] 暗色 TUI 主题与全站一致（globals.css 既有 token，不新增配色）；本期只读——无任何编辑/审核操作入口
- [ ] 既有 /experience KnowledgeTab 不动、不合并（Out of Scope 约束）
- [ ] 组件测试（billing __tests__ .test.tsx 先例）：mock API 断言域树/渲染/检索交互；路由契约测试补 search 形状与降级路径
- [ ] 可演示：浏览器完成"浏览→检索→看溯源"全程

## Comments
- Merged to integration as 8e5d3335 (merge of 18cd4085). Build+`/wiki` route live; server 2941/44 & web 985/6 both baseline (no new genuine failures); wiki routes 10 + app/wiki page test 8 green; web lint 0 errors; KnowledgeTab/app-experience zero diff (out-of-scope guard held).
- Landed: `GET /api/knowledge/wiki/search` (q/org/topK 1–50/domain, FTS5→LIKE fallback + `mode` flag, CJK+bad-syntax fallback assertions, `?domain=cases` already wired both paths) + read-only `/wiki` three-col page (`app/wiki/page.tsx`+layout, `lib/knowledge/wiki-api.ts`, nav `知识词条`, grid `220px_1fr_250px`, search jump + `data-anchor-hit`). Additive: tree.log, article.gitHistory, factory optional `{rootDir}`.
- Ticket 04 reuses this layout (Cases tree group + weighted cases search + 5-section detail via MarkdownPreview). Handoff: `C:\tmp\llm-wiki-notes\handoff-03.md`.
