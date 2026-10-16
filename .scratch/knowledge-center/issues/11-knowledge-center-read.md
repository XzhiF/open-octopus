# 11: /knowledge 知识中心 — 读面

**What to build:** 知识中心只读体验立起来：五类树浏览、v3 页渲染（溯源/git 近史）、Ctrl+K 检索、健康条（**没有"待审核"计数**）、LOG 时间线、user_preference 只读渲染。这是被否定的两个旧 UI 的替代物的第一半（读面）。

**Blocked by:** 03（全局库就位）, 04（v3 页格式）

**Reference:** spec §Implementation Decisions「知识中心 UI」· prototype Tab④（浏览模式 mockup + 健康条口径 + 交互纪律）

**Status:** done

- [x] /knowledge 路由 + 布局（对话列占位 + 右栏全宽浏览）；暗色 TUI 主题沿用既有 token；导航入口挂上
- [x] INDEX 五类树（必读/Entities/Concepts/Topics/Sources/Cases）+ v3 页渲染：type/aliases/links/sources chips + git 近史折叠区 + [[链接]] 可点跳页
- [x] Ctrl+K 检索命令条：页名/别名/锚点/FTS 全文，命中锚点定位高亮（服务端 FTS5+LIKE 降级沿用）
- [x] 健康条：页数按类 / raw 源数 / 本周 ingest / 开放 findings / 编译队列深度 / 最近编译 / git HEAD——**不存在"待审核"计数**
- [x] LOG.md 时间线视图（行格式渲染 + 前缀过滤）；user_preference 只读渲染 + 「人工文件，直接编辑」标注（零编辑入口）
- [x] MarkdownPreview 复用（sanitize 链既有保障）
- [x] S4 组件测试（mock API）：树/页渲染/检索交互/健康条口径断言（含"无待审核"负断言）

## Comments

**2026-10-13 实现（kc/11-knowledge-ui @b2acb569 → 并入集成分支 0961a04e，零冲突）**

- server 新 `routes/knowledge-read.ts`（GET /api/knowledge/raw|log|health 三端点，穿越三重闸）+ `raw.ts` 只读面 + `routes/wiki.ts` article 加 `page` 字段（aliases/links 数据源，fs 定向读）；web 新 `app/knowledge/*` + `components/knowledge-center/`（health-bar/knowledge-tree/wiki-page-view/search-palette/log-timeline/preference-view/raw-view）+ header「知识中心」+1；客户端 org 内部钉 global 零参数
- 测试：S2 17/17 + S4 19/19；并入后 scoped 复核 server 281 全绿、web 32 全绿（旧 app/wiki 13 未伤）；lint 0 error（新增面零告警）
- 健康条负断言双端落地：UI 查不到「待审核」；/health JSON 序列化不含 pending 字样
- **接位契约（主控记录给后续票）**：`/health` 形状 `{pages{total,5类},rawSources,ingestedThisWeek,openFindings,queueDepth,lastCompiled,gitHead}` —— 票 06 只换 `queueDepth` 值、票 13 只换 `openFindings` 值，形状冻结
- 裁定注记：① aliases 精确索引暂不入 DB（正文 FTS 兜底 + 票 07 重蒸馏后普遍含别名；DB 增列未拍板不开）；② Ctrl+K 用轻量弹层（cmdk/radix 无 jsdom 先例，结构同构 command-palette）；③ 对话列为占位抽屉，票 12 实装；④ 旧 tree 的 stats.pendingReview 字段暂留（旧 /wiki 仍消费，票 09 一并清）
