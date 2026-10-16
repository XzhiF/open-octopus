# 06: effectiveness 记账解析器

**What to build:** 规则的被消费与实效开始记账：服务端增量解析执行 JSONL（wiki_refs 引用、wiki 页 Read 序列、review 节点 blocker），经 LLM seam 判"同类 blocker 是否再现"，落 knowledge_effectiveness 账（引用计数/helpful/not_helpful/最近引用）。agent 运行时零感知。

**Blocked by:** 01（P3 合入）

**Reference:** spec §Implementation Decisions「effectiveness v2」· 故事 1-2/6-7 · schema 内表边界注（**勿复活旧关键词匹配近似**——关联判定必须走 LLM seam；旧 effectiveness.ts 已删，教训在其 git 史）

**Status:** done (merged → integration `e41f673c`；进化波留集成待终 PR)

- [x] 表迁移（蓝绿）：knowledge_effectiveness 列义对齐 v2（injected_count → 引用计数语义更名或加列，边界注随之更新为"消费中"）
- [x] 解析器：输入 executions JSONL——wiki_refs（页#锚点逐锚记账）、wiki 页 Read 工具调用（页级查阅记账）、review 节点产出 blocker；**增量游标**持久（记至 execution），重跑幂等零重复记账
- [x] 关联判定走 LLM seam（"同类 blocker 是否再现于被引锚点的话题域"，mock 先例：summarize seam / finding 修订 seam 同款；生产适配器带离线闸）；helpful+1 / not_helpful+1 落账
- [x] 触发面：夜巡 scheduler 步骤挂载 + 手动触发端点（解析至最新）
- [x] 首批烟测数据：KC/P3 E2E 存量执行（含 wiki_refs 真锚点的执行行）解析落账可查
- [x] 运行时零感知断言：执行链路（engine/prompt/VarPool）零改动（负断言）
- [x] S1（JSONL fixture→账目断言：引用/helpful/not_helpful/游标幂等/离线闸）+ S2（手动触发端点契约）

## Comments

- **2026-10-15 implementer（we/06-effectiveness @ 3d56fba4，5 commits，无新 opKind）**：v55 蓝绿迁移（injected_count→cited_count/last_injected→last_cited ALTER RENAME 存量零丢+新库直带新名，SCHEMA_VERSION 54→55 两处版本钉同步，effectiveness_cursors 新表 PK=execution_id）；解析器 effectiveness-ledger.ts 三面输入（wiki_refs 逐锚/页归一键锚点全库唯一·stale 剥前缀不虚增 / JSONL Read 页级 WIKI_PAGE_DIRS 去 sources 回执 / blocker），游标逐执行事务先 LLM 后落账=崩溃可重放、时刻=落库时刻非挂钟。seam 契约 buildLinkJudgePrompt（锚+规则原文[lint ruleLinesForFormCheck 同族]+blocker 全文）→ verdicts{helpful|not_helpful|unrelated}，unrelated/漏判/越权锚=零计数，诚实缺席码族 skipped:no_llm|empty|bad_json|error（mock 复用 archive-ingest:167-176 prompt 捕获制式）；DAO 只落计数**不动 confidence**（滚动=票07 地盘）。触发=夜巡 parseLedger 腿（afterPatrol 显形不炸作业）+ POST /api/knowledge/effectiveness/parse（S2 三例逐字报告形）。
- **spec-现实偏差裁定（照 P3 先例记）**：票面「review 节点 blocker」无现行结构化信道（分支库 var_pool review_blockers 0 行、真 JSONL 仅自由 text_block、archive.ts 读已死 state 面）→ 与 wiki_refs 同款 DB 权威键 `var_pool.review_blockers`（native∨JSON 双形，坏条目诚实弃），契约钉服务头注裁定③+常量单源；agent 侧 vars_update 上报纪律属 octo-wiki skill 面不在本票（运行时零改）。同执行判定口径：blocker×锚点皆存在才判，无 blocker=link_status 空（判定对象不存在≠缺席）。
- **烟测（tmp 副本，原库零写）**：KC 分支库真执行 23 行解析，落账 oct-007/008/014/015 各 cited=2 + 页级 prj-open-octopus/wf-prd-impl cited=2（env 闸 opt-in 默认 skip 不污染基线）；主 dev 库 wiki_refs 0 行故取分支库（E2 口径）。
- **测试**：票自测 28 例全绿（schema5/DAO6/S1-10/trigger4/S2-3）；merge 集成分支后全套 36 红 ⊆ main 基线 40=零新增红；engine/providers/web-app 零 diff（红线5 执行链路零感知）。
- **merger 账（e41f673c）**：we-int --no-ff 零冲突并入；build 复绿；effectiveness 定向 5+10+trigger4+routes3 全绿、wiki-write-queue 14/14（逐字枚举未受扰）；push origin。
- **spec 回写（评审波 Spec 轴点名）**：故事2 后半句「同执行（**及后续同 task 执行**）的 blocker 关联」未实现——解析器逐 execution 自闭环；跨执行（同 task 后续运行）关联列入 **P4 改进账 DEFER**（真盘同 task 多执行样本现零，随有机数据厚起再设计；游标 execution_id 粒度键制已预留可扩）。原裁定注仅备案同执行口径，此处显式点名丢弃半句不含糊。
- **治理落笔注**：真盘 SCHEMA.md「实效账目与置信度」节已 owner 通道落稿（2026-10-15 主控，对齐票07/08/09 措辞包与 seed 模板）；GLOSSARY-MAP「effectiveness(记账)」词条入册。
