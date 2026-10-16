# 04: v3 页格式基座

**What to build:** wiki 页形态从「词条=规则容器」升级为 v3 五类页（entity 实体 / concept 概念 / topic 主题 / source 来源 / case 判例）：编译器、结构闸（lint）、INDEX、LOG 全量支持 v3——为多页编译与重蒸馏铺好地基。

**Blocked by:** 01（Ops 前置）

**Reference:** spec §Implementation Decisions「三层架构」页格式 v3 · prototype Tab②（页样例：entities/open-octopus、topics/prd-impl-workflow + INDEX/LOG 样例）

**Status:** done

- [x] front-matter v3 schema：`type` 五值 / `links`（[[wikilink]] 编译期断链校验保留）/ entity 增 `aliases`、`entity_kind`；stability/confidence/sources/last_compiled 保留；正文零日期纪律不变
- [x] 锚点 `<!--#oct-NNN-->` 仅存在于 topic 页「硬约束」小节（全库唯一、永不复用）；v2 锚点格式兼容可读（为重蒸馏留路）
- [x] INDEX.md 程序化重建：必读节（user_preference）+ 五类分组 + Optional 节；≤800 token 预算纪律保留
- [x] LOG.md 行格式 `## [date] ingest|compile|query|lint|revert | title → 结果`（grep 前缀友好），程序化 append
- [x] lint L1-L6 适配 v3：容量闸按页；拆分出口 = 编译失败返回拆分建议（供策展人对话内自纠），**无入队语义**
- [x] 编译服务读写 v3 页；DAO/FTS 的类型值面适配（domain 列存 v3 type 值）
- [x] S1 测试（tmpdir fixture）：v3 编译产物逐项断言（INDEX 分组 / LOG 行格式 / lint 阻塞 / 断链失败 / 锚点小节约束）——expected 值取自 prototype Tab② 样例（独立真相源，禁 tautological）

## Comments

**2026-10-13 实现（kc/04-v3-format @ecdf3684 → 并入集成分支 6cb1fc97，零冲突）**

- shared 增 `WikiPageTypeValues/WIKI_PAGE_DIR_BY_TYPE/WIKI_DOMAIN_TO_PAGE_TYPE/normalizeWikiLinks/WikiPageFrontmatterSchema`（types/wiki.ts）；server wiki/ 域 format.ts 三向分派 parse+serialize、lint.ts `L5_ANCHOR_SCOPE`+`nextRuleAnchor`（fs+DB 双检唯一）+`WikiLintError.suggestion`、compile.ts `compilePage`（v3 INDEX/LOG 渲染，**入队语义全删**、PendingReviewDAO 依赖摘除）、paths.ts 五类骨架（WIKI_PAGE_DIRS 收敛 re-export 票02 global-paths 单源）
- 测试：新增 wiki-page-v3 10 例；合并后 server 域 501 tests 中仅 archive-routes 预存 10 红（基线同形）；web app/wiki 13/13；expected 逐字取 prototype Tab② 样例
- 裁定注记（主控）：① links 写侧序列化采嵌套 `[[a], [b]]`（原型空格串非可解析 YAML），读侧三形态归一——验收按此形态。② 'case' DB 值统一与 LOG 旧表转换留票 07；③ 旧 /wiki 对新 LOG 行的渲染错位由票 11/09 消解（旧 UI 本要删）；④ 判例写面仍 P0 形态 domain:cases，读面容忍 type:case。
- AC2「真 provider 端到端投喂」按票面属票 05 主链条，本票交付编译 seam；票 15 链①真跑复证。
