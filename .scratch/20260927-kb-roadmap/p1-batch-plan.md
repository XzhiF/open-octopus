# P1 BaseDAO 异步化 — 可执行分批方案（只读勘察产出）

> 生成: 2026-09-28 · 勘察基线: feat-kb-p0-20260927 @ 349672ea
> 纪律: 未改任何 src 代码；所有数字来自实测 grep/rg 计数，命令附在文末附录。

---

## 0. 口径先修正（实测 vs 计划宣称）

| 计划口径 | 实测 | 修正说明 |
|---|---|---|
| 25 个 DAO | **21 个 DAO 类** + `base.ts` + `index.ts` + `usage-ledger.ts` + `usage-mapping.ts` = dao/ 目录恰好 25 个 .ts 文件 | "25" 是目录文件数，真实迁移单位是 21 个类 + 1 个基类 |
| 166 文件引用 better-sqlite3 | **167**（packages/server/src 全部 .ts，含 dist 外）= **54 个生产文件**（dao/ 内 22 + dao/ 外 32）+ **113 个测试文件** | 生产/测试比例 1:2 —— 测试 fixture 转换是第三块体量 |
| 542 处 stmt() | **542** ✓ = dao 21 文件内 540 + `base.ts` paginate 内 2 | 全部在 dao/ 目录，DAO 外零处 `this.stmt(` |
| PRAGMA 62 | `.pragma()` 调用 72 处 = **生产 12**（connection.ts×4、schema.ts×7、health-resolver.ts×1）+ **测试 60**；另 DAO SQL 串内 `PRAGMA` 0 处 | 生产侧只有 12 个真决策点 |
| INSERT OR IGNORE 33 | 全仓出现 32 次，**生产 DAO SQL 里只有 8 处**（archive 2、execution 3、org 1、token-usage 2），其余在测试/注释 | 方言改写点比宣称少 4 倍 |
| ON CONFLICT 13 | 出现 12 次，**生产 DAO SQL 8 处**（archive-draft:37、billing:249、harness:111、execution:564、org:37、token-usage:120、knowledge-effectiveness:22+59）| 已是 PG 兼容语法，多数零改动 |
| better-sqlite3 依赖范围 | **全部在 packages/server**，engine/providers/cli/shared 零引用 | 迁移面 = 单包 |

其余关键实测：`.iterate()` **0 处**；backup API **0 处**；`db.changes()` 0 处；GLOB 0 处；`INSERT OR REPLACE` 0 处 —— 计划里的迭代器风险不存在。

---

## 1. DAO 依赖图（grep 实测）

### 1a. import 层：**零耦合**

命令：`grep -nE '^import|from "\./' packages/server/src/db/dao/*-dao.ts`

结果：21 个 DAO 全部只 import `./base` + `../types` + 纯函数 helper（cjk-segmenter / turn-index / price-sql / shared 包常量），**没有任何 DAO import 另一个 DAO**。`usage-ledger.ts`/`usage-mapping.ts` 是被 token-usage/archive 引用的纯函数。

⇒ 图上唯一的树结构：`BaseDAO ← 21 个平级叶子`。**无环**。"先叶子、最后动 BaseDAO" 在 import 层天然成立。

### 1b. 真正的耦合在 **事务簇** 和 **split-brain 直写**，不在 import

- 跨 DAO 事务（§6）：`schedule.ts:184` 在 `configDAO.transaction()` 体内调 **execDAO**（经 `ensureContainerExecution`，schedule.ts:687）与 **runDAO**（经 `writeAuditLog`，schedule.ts:657）；`archive-service.ts:160` 在 archiveDAO 事务体内调 **workspaceDAO** + **executionDAO**。
- 跨引擎原子性不可桥接：某 DAO 已走 postgres.js、同事务内另一 DAO 仍走 better-sqlite3 时，`BEGIN` 只管一个连接 → 原子性破洞。因此**同事务簇的成员必须同批迁移**。
- 两个簇共享 ExecutionDAO ⇒ `{ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO, ArchiveDAO, WorkspaceDAO}` 构成**不可拆分的终批**（ArchiveDraftDAO 无事务、同表族，随批带入）。
- 直写逃生口（§4 各批携带）：`dao.getDb().prepare(...)` 在 17 个生产文件共 65 处（detector-pipeline 14、context-builder 11、archive-service 10、tasks-service 6、task-lifecycle-service 5、recall-service 4、其余 7 文件 1-3 处）+ schema.ts 45 + connection.ts 3。**某表迁移后若其直写路径不同批迁移，同一逻辑表被两个引擎双写 = split-brain**。

```
                    BaseDAO (sqlite, 最后动)
   ┌────┬────┬────┬───┴──┬─────┬─────┬─────┬─────┐
  B1×5  B2×6  B3×2  B4×2   └── 终批 B5×6（事务簇，含 Execution）──┘
（批间无 import 边；簇内边由事务/直写强制）
```

---

## 2. 逐 DAO 体量表（实测）

stmt = `this.stmt(` 计数；prodFiles = dao 目录外引用该 DAO 类名的生产文件数（不含测试）；探针测试 = 引用该类名的 .test.ts 文件数（含 dao/__tests__）；直测用例 = dao/__tests__ 下直接以该 DAO 为主题的用例数（基线账本，"不降"比对用）。

| DAO | 行数 | stmt | prodFiles | 探针测试文件 | 探针用例 | 直测用例基线 | 特殊构造（见 §3 编号） |
|---|---|---|---|---|---|---|---|
| ExecutionDAO | 1433 | **143** | 44 | 38 | 540 | 8 | S1×4, S2×4, S3(3), S4, S7, S10 |
| ScheduleConfigDAO | 602 | 58 | 14 | 17 | 278 | 0 | S1, S2×4, S3, S4(17), S5, S11 |
| TokenUsageDAO | 1072 | 50 | 24 | 28 | 141 | 0 | S1, S2, S3(2), S4, S6, S9 |
| ScheduleRunDAO | 447 | 45 | 15 | 17 | 278 | 14* | S2, S4(17), S5 |
| WorkspaceDAO | 198 | 35 | 21 | 23 | 250 | 0 | S1, S2, S4, S11 |
| AgentSessionDAO | 395 | 33 | 17 | 42 | 487 | 10 | S2×3, S8, S11 |
| EvolutionDAO | 469 | 31 | 8 | 8 | 49 | 0 | S2×3, S8, S5(json_extract) |
| SafetyDAO | 177 | 19 | 8 | 2 | 24 | 0 | S2×2, S8(reports_fts) |
| BillingDAO | 518 | 19 | 1 | 12 | 33 | 34 | S3, S12(CTE/price-sql) |
| TaskDAO | 233 | 16 | 8 | 13 | 61 | 34 | S5, S11 |
| ArchiveDAO | 207 | 15 | 4 | 3 | 20 | 14 | S1, S3(2), S13, named-@ |
| ChatDAO | 113 | 15 | 2 | 2 | 15 | 0 | S2 |
| PendingReviewDAO | 132 | 12 | 9 | 5 | 39 | 0 | S4, S13 |
| AgentVersionDAO | 101 | 9 | 3 | 1 | 15 | 0 | S1 |
| InteractionMessageDAO | 88 | 8 | 2 | 0 | 6 | 0 | S2 |
| CloneDAO | 60 | 7 | 3 | 1 | 10 | 0 | S2 |
| KnowledgeEffectivenessDAO | 82 | 7 | 5 | 2 | 21 | 6 | S4, S13 |
| OrgDAO | 40 | 6 | 5 | 2 | 30 | 0 | S3(1), S14(upsert 双写) |
| HarnessDAO | 123 | 5 | 9 | 8 | 50 | 11 | S3, S4, S11, 直写逃生口 |
| AcceptanceDAO | 63 | 4 | 2 | 0 | 13 | 13 | — |
| ArchiveDraftDAO | 57 | 3 | 4 | 0 | 4 | 4 | **不继承 BaseDAO**、无 stmt 缓存、构造函数内 ALTER TABLE（S7） |
| 合计 | — | 540(+2 base) | 115（去重并集） | — | — | 132 | |

\* ScheduleRunDAO 直测以 `count-active-work.test.ts`（14）形式存在。`*count-active-work`/`task-trigger`/`billing-report` 等文件名未带 DAO 名，已人工归账。

全量基线（每批必须 ≥ 此数且全绿）：**server 219 个测试文件 / 2653 用例**；其余包为常量基线（engine 902、providers 168、cli 136、shared 906、web-app 0）。

---

## 3. 特殊构造清单与改写方案（postgres.js 无直接对应物者）

| # | 构造 | 证据（file:line，packages/server/src/） | 改写方案 |
|---|---|---|---|
| S1 | `.transaction()` 19 处 | 见 §6 全列表 | 簇内最后成员迁移时统一转 `sql.begin(async tx => …)`；DAO 内部自事务转 `this.transaction(async tx => …)` |
| S2 | `lastInsertRowid` 21 处 / `Database.RunResult` 返回类型 151 处 | agent-session:3、chat、execution:4、clone、evolution:3、schedule-run:1、schedule-config:4、safety:2、workspace:1 等 | 写语句改 `… RETURNING id`，方法签名 `RunResult → {changes, id?}`；无 rowid 表则必须让调用方拿到显式 id |
| S3 | `INSERT OR IGNORE` 生产 8 处 | archive-dao×2、execution-dao×3（含 :564 区段）、org-dao:31 区段、token-usage:120 区段 | → `ON CONFLICT DO NOTHING`（PG 原生） |
| S4 | `datetime('now')` 27 处（schedule-run:17、archive-draft:2、pending-review:2、knowledge:2、schedule-config:2、harness:1、workspace:1） | 同上 | → `now()`；TIMESTAMP 文本列改 `timestamptz` 或保留 text + `to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` —— **统一裁决放 B0**，建议 B 期保留 text 降风险 |
| S5 | `json_extract(col,'$.path')` 2 处 | evolution-dao.ts:330、schedule-config-dao.ts:44 | → `(col #>> '{path}')`；JSON 列转 `jsonb` 后加 GIN |
| S6 | `GROUP_CONCAT(SUBSTR(...), '|||')` 1 处 | token-usage-dao.ts:701 | → `string_agg(…, '|||')` |
| S7 | 构造函数内 `db.exec("ALTER TABLE …")` 迁移 | archive-draft-dao.ts:18-20 | 删除（PG schema 由 B0 的 DDL 统一建）；构造函数不再有任何 DDL |
| S8 | **FTS5 虚拟表 + MATCH**（最大人判项） | agent-session-dao.ts:187 `session_memory_fts MATCH ?`；evolution-dao.ts:107/262/272 `experiences_fts MATCH ?`；safety-dao.ts:83 `reports_fts MATCH ?`；schema.sql 3 张 fts5 表 + schema.ts:729/763 迁移 | → ParadeDB pg_search BM25（deploy/pg-init 已备，commit 349672ea）。**中文链路重设计**：现有 `segIndex/buildFtsMatch/bm25ToScore`（cjk-segmenter）以 jieba 预分词喂 FTS5；PG 侧改为分词结果写入 tsvector 或直接 pg_search tokenized 列 —— 需 A/B 召回回归（chinese-recall-regression.test.ts 现成靶子） |
| S9 | **named parameter `@col` 批量插入** 2 处 | execution-dao.ts:1305-1318（agent_events）、token-usage-dao.ts:388-410（llm_calls），循环 `insertStmt.run(row)` | postgres.js 无 named param → 改 `INSERT … VALUES (…)` 模板参数化 + 批量可拼多行 VALUES（一条 SQL），顺带消掉 2 个 DAO 内事务 |
| S10 | `PRAGMA table_info` 直查 | services/harness/detector-pipeline.ts:553 | → `information_schema.columns` |
| S11 | 标量 `.get() as {cnt|c|n}` 35 处 + paginate 8 处 | pending-review:52、schedule-config:87/235、schedule-run:34/123/154、archive:39/76（paginate 调用点） | COUNT 结果 PG 返回 bigint→JS number 一般无损；paginate 转 `Promise`，两次 `await` |
| S12 | 分析型 SQL：CTE/窗口函数 | execution-dao 143 处 stmt 内多 CTE（effective_status/latest_children/root_executions 等）、price-sql.ts | PG 方言基本兼容，但 `COALESCE`/`||` 语义 OK，需逐条 explain 校验（PG 计划器与 sqlite 不同 —— 性能人判） |
| S13 | upsert `ON CONFLICT DO UPDATE` 生产 8 处 | §0 已列 | **PG 原生兼容，零改写**（利好：计划担心的 13 处不存在风险） |
| S14 | WAL/busy_timeout/synchronous pragma | connection.ts:67-73 | PG 无对应物 → 连接池（postgres.js `max`、`timeout`、`retry`）+ 锁超时 `lock_timeout` + 应用层死锁重试；busy_timeout 的"写排队"语义在 PG 是行锁 —— **R3 之外的 R5：并发写行为变化** |

无对应物风险确认：**`.iterate()` 0 处、backup API 0 处** —— 均无需改写方案。

---

## 4. 分批切法（拓扑 + 事务簇约束后的唯一可行序列）

**批 = 绿门禁单位**（全量 2653 用例不降）。数字为该批"新增涉及面"，跨批重叠已注明。

### B0 — 地基（0 个 DAO）
postgres.js 池工厂（package.json 已有 `postgres ^3.4.9` 依赖，src 零 import）+ **B0 产出**:
① `schema-pg.sql`（42 表 + 3 fts5 → pg_search 索引 + 102 索引转写，源 schema.sql 1110 行）；
② `BasePgDAO` 异步基类（`q/q1/exec/transaction/paginate`，§7）；
③ 测试 harness：每测试文件独立 PG schema（`TEST_PG_URL`，truncate/reset），`createTestDb()` 同时返回 `{sqlite, pg}` 句柄；
④ user_version pragma → PG 迁移账表（SCHEMA_VERSION=49 链冻结，新库直接终态 DDL）；
⑤ eslint 增补 `await-thenable` + `no-misused-promises`（见 §8）。
体量：新文件 ~6 + 改 connection/schema/index.ts 骨架。**串行前提，之后各批才能开工。**

### B1 — 边缘小叶子 ×5：`OrgDAO, ChatDAO, CloneDAO, AgentVersionDAO, HarnessDAO`
42 stmt · 18 生产文件 · 探针 15 文件/198 用例 · 测试 fixture 转换 10 文件/16 处。
携带直写逃生口：detector-pipeline.ts（harness 侧 14 处 prepare + :553 table_info）、harness-controller.ts:284。
**并行性：与 B2-B4 均无 import 边，理论可并行；实际因 `src/index.ts`、`routes/agent/index.ts` 重叠建议串行合入（§5 收口后可解锁）。**

### B2 — 任务/审查域 ×6：`AcceptanceDAO, TaskDAO, PendingReviewDAO, SafetyDAO, InteractionMessageDAO, KnowledgeEffectivenessDAO`
66 stmt · 26 生产文件 · 探针 24/305 · fixture 24/200（本批 fixture 转换偏重，tasks 测试爱直插 sqlite 造数）。
携带：tasks-service.ts 6 处 prepare、observability.ts；人判点：SafetyDAO `reports_fts`（S8 的缩微版，先行趟 pg_search 路）。
探测：task-dao(16)+task-trigger(18)+acceptance(13) 直测用例为最硬基线锚。

### B3 — 记忆/知识域 ×2：`AgentSessionDAO, EvolutionDAO`
64 stmt · 23 生产文件 · 探针 43/512 · fixture 39/231。
**全计划最大人判批**：3 张 FTS5 表里 2 张在此（S8 全量）+ cjk-segmenter 中文召回链路 + json_extract(S5) + recall-service 4 处 prepare（:335 区段）。建议本批拆两段：先方法体异步化（FTS 暂时用 `ILIKE`/tsvector 粗实现 + 现成回归测试守门），pg_search 精调可后置。

### B4 — 计量/计费域 ×2：`TokenUsageDAO, BillingDAO`
69 stmt · 25 生产文件 · 探针 30/335 · fixture 27/201。
携带：llm-call-ledger.ts（llm_calls 直写！不随批迁 = split-brain）、S9 named-@ 批量、S6 GROUP_CONCAT、price-sql.ts CTE。
**不可与 B5 并行**：billing-routes 测试同时触 TokenUsageDAO；`analytics` 路由触 B4+B5 两侧。

### B5 — 终批大簇 ×6：`ExecutionDAO + ScheduleConfigDAO + ScheduleRunDAO + WorkspaceDAO + ArchiveDAO + ArchiveDraftDAO`
**299 stmt（55%）· 61 生产文件 · 探针 61/791 · fixture 53/540**。
串行强制原因（§1b）：schedule.ts×5 + scheduler-service.ts×5 + cft×1 的事务体横跨 config/run/exec；archive-service:160 横跨 archive/workspace/exec —— 任何拆分都留下跨引擎事务破洞。批内提交序列建议：workspace → execution（4 个 DAO 内事务先转）→ schedule-config → schedule-run → **最后 11 个服务层事务点同 PR 切 `sql.begin`** → archive(+draft) → 调用面 await 传播（44 文件，SchedulerService/tasks 同步方法链式变 async）。
减压选项（需裁决，不默认）：若接受语义变更 —— 把 audit 写与 container-execution 写出事务（schedule.ts 的 10 处可只保 config 单 DAO 事务；archive:160 的 setArchiveStatus 本可幂等前置），B5 可拆成 2-3 批。**默认方案不拆，把"audit-out-of-txn"列为 B5 失败的 Plan B。**

### B6 — BaseDAO 收口（最后动 BaseDAO）
删 `getDb()`（base.ts:13，生产残余引用清零后）；`connection.ts`/`schema.ts` 切 PG（applySchema → B0 产物，12 处生产 pragma 中余量收口：connection×4、schema×7、health-resolver quick_check×1 → `amcheck`）；`index.ts` lazyDAO Proxy（19 处）改 PG 池懒构造；`d` 对象签名换 `Sql`；eslint baseline 26 → **0 锁死**；better-sqlite3 依赖出包。

**串行约束总表**：B0 → B1 → B2 → B3 → B4 → B5 → B6 全链串行执行（推荐）；若做 §5 收口，B1-B4 之间可并行，B5 永远单独。

---

## 5. 横切热点与收口建议

实测共享（文件出现在几批的调用面）：

| 文件 | 涉及批数 | 涉及 DAO 数 |
|---|---|---|
| `src/index.ts` | **7/7**（19 个 DAO 的 lazyDAO 注册，:377-400） | 19 |
| `src/routes/agent/index.ts` | 5 | 8（AgentSession/Clone/Evolution/Execution/Safety/ScheduleConfig/TokenUsage/Workspace） |
| `src/services/tasks/task-child-run.ts`、`src/routes/agent/task-routes.ts`、`src/services/actuator/actuator-service.ts` | 各 4 | 4-5 |
| `tasks-service.ts`、`task-lifecycle-service.ts`、`ExecutionLifecycle.ts`、`harness-controller.ts`、`suggestion-engine.ts`、`archive-analysis-service.ts`、`routes/{workspace,dashboard,analytics}.ts` | 各 3 | 3-4 |

**收口方案（B0 交付，一次性消除 7/7 重复改）**：
1. **DAO 注册表外提**：`const d = {…lazyDAO(×19)}` 从 index.ts 移入 `src/db/dao/registry.ts`；`lazyDAO(Ctor)` 泛型化为 `lazyDAO<T>(make: (sql: Sql|Database) => T)`。每批只改 registry 里自己那 1 行，index.ts 只在 B6 动一次。
2. **routes/agent/index.ts 拆 per-domain assembler**（chat/memory/execution/safety/schedule 各一），每批只碰自己的 assembler 文件。
3. **`getExecutionService`/`execution-service-registry.ts` 已是事实 DI 边界** —— 新异步 DAO 一律走 registry 注入，禁止新增 `new XxxDAO(getDb())`（17 个直写文件中 `src/routes/system.ts:226` 的 `new BillingDAO(getDb())` 属 B4 改造对象）。

不做收口的代价：index.ts 每批 2-3 行 ×7 批的持续冲突面 —— 收口 1 是 B0 里性价比最高的一项。

---

## 6. `.transaction()` 专项（19 处全列表）

better-sqlite3 语义：`db.transaction(fn)()` 默认 **deferred**（首次写才取写锁），同步、可嵌套（嵌套=savepoint）、返回值即 fn 返回值。postgres.js：`sql.begin(tx => …)` = BEGIN/COMMIT + 专用连接，**RC 隔离级**，中途 throw → 整事务 aborted（后续语句全 25P02），不支持同对象重入。

| 位置 | 簇内成员 | 语义风险 |
|---|---|---|
| schedule.ts:184 | config+run+**exec**（:687 insertContainerExecution） | 跨 DAO 原子性（B5 核心约束）；体内 throw → 全部回滚，现依赖 sqlite deferred |
| schedule.ts:300 | config+run | audit 写可否出事务 = 减压选项 |
| schedule.ts:317 | config+run（delete） | 同上 |
| schedule.ts:583 | config+run；**取返回值** `disabledCount` | PG 版 `const n = await sql.begin(async tx => …)` 可平移，但调用方必须 async 化（同步链 scheduler-engine → …） |
| schedule.ts:704 | config+run | 同 :300 |
| scheduler-service.ts:388/514/573/600/649 | config+run(audit)；600 为 CAS `updateScheduleWithVersion` | :600/649 的 read-then-CAS 在 sqlite deferred 下天然串行，PG RC 下并发双 UPDATE 谁先提交谁赢、version 条件兜住 —— 语义兼容但**失败路径不同**（busy vs 0-row），需保留重试 |
| consecutive-failure-tracker.ts:26 | config 仅；**取返回值** | 体内先 increment 后 read —— 同 tx 同连接可见，PG OK |
| agent-version-service.ts:208 | agentVersion 仅；体内纯 DB（Step1 git 在事务外） | 低风险，B1 批内转 |
| archive-service.ts:160 | archive+workspace+**exec** | **最高危**：体内 for 循环里 `try{…}catch{failures.push}` —— sqlite 下失败语句不污染事务；**PG 下第一条失败语句即 abort 整个事务，后续所有语句报 25P02，failures 收集逻辑全毁**。必须改 savepoint(`sql.savepoint`) 或预校验/逐 execution 独立事务 |
| workspace-dao.ts:143 | workspace 仅（cascade） | DAO 内转 |
| execution-dao.ts:474/596/697/1317 | exec 仅（474 replaceMergedEvents、596/697 cascadeDelete×2 多表级联含 llm_calls/agent_events、1317 named-@ 批量） | :1317 随 S9 批量插入改写**直接消掉**（一条 VALUES 多行天然原子）；级联删除体内混有自己的 `this.stmt(...)` 与 `this.method()` —— 方法级 async 传播后事务体必须整体 await 链 |
| token-usage-dao.ts:403 | tokenUsage 仅（named-@ 批量） | 同 :1317，S9 化后消失 |

净数：19 → 迁移终态 14 个真实 `sql.begin` + 2 个被批量插入消灭 + 3 个建议出事务（audit/container 标记，待裁决）。**deferred/immediate 无显式声明（实测 `.immediate|.exclusive|.deferred` 0 处），全部走默认 —— 好消息：无模式映射问题；坏消息：sqlite deferred 的"读不阻塞快照"直觉在 PG RC 下不成立，check-then-write 模式（cft、scheduler :600）已靠 CAS/单行 UPDATE 存活，逐一复核而非假设。**

---

## 7. BaseDAO 终批预案（B6）+ 机械改写模式

终态基类（新增并行类，非改造旧类 —— 旧 BaseDAO 活到 B5 结束）：

```ts
// src/db/dao/base-pg.ts（B0 产出）
import type { Sql, TransactionSql } from "postgres"
export type PgSql = Sql | TransactionSql

export abstract class BasePgDAO {
  constructor(protected readonly db: PgSql) {}
  /** 对应旧 stmt().all()：? 占位符 → $n，静态 SQL 无字符串内 ? —— 实测安全 */
  protected async q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return await (this.db as Sql).unsafe(sql.replace(/\?/g, (_, i) => `$${++i}`), params)
  }
  protected async q1<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.q<T>(sql, params))[0]
  }
  protected async exec(sql: string, params: unknown[] = []) {
    const r = await (this.db as Sql).unsafe(sql, params); return { changes: r.count }
  }
  async transaction<T>(fn: (tx: PgSql) => Promise<T>): Promise<T> {
    if ((this.db as any).BEGIN) return fn(this.db as any)      // 已在事务内 → savepoint 语义由调用方负责
    return (this.db as Sql).begin(fn)
  }
  protected async paginate<T>(…): Promise<PaginatedResult<T>>   // 两次 await
}
```

子类的机械改写模式 —— **OrgDAO before（现状，实测）/ after**：

```ts
// ── before ── packages/server/src/db/dao/org-dao.ts:9-39
export class OrgDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }
  findAll(): OrgRow[] {
    return this.stmt("SELECT * FROM orgs ORDER BY name ASC").all() as OrgRow[]
  }
  findById(id: number): OrgRow | null {
    return (this.stmt("SELECT * FROM orgs WHERE id = ?").get(id) as OrgRow) ?? null
  }
  insert(row: Omit<OrgRow, "id">): Database.RunResult {
    return this.stmt("INSERT OR IGNORE INTO orgs (name, path, created_at) VALUES (?, ?, ?)")
      .run(row.name, row.path, row.created_at)
  }
}

// ── after ──（B1 批内对 OrgDAO 的实际 diff 形态）
export class OrgDAO extends BasePgDAO {
  findAll(): Promise<OrgRow[]> {
    return this.q<OrgRow>("SELECT * FROM orgs ORDER BY name ASC")
  }
  async findById(id: number): Promise<OrgRow | null> {
    return (await this.q1<OrgRow>("SELECT * FROM orgs WHERE id = ?", [id])) ?? null
  }
  async insert(row: Omit<OrgRow, "id">): Promise<{ changes: number }> {
    return this.exec("INSERT INTO orgs (name, path, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      [row.name, row.path, row.created_at])
  }
}
```

模式规则（适用全部 540 处）：`stmt().all()` → `await this.q()`；`.get()` → `this.q1()`；`.run()` → `this.exec()`（返回 `{changes}`，S2 处补 `RETURNING`）；`extends BaseDAO` → `extends BasePgDAO`；构造签名 `Database.Database` → `Sql`；返回类型逐个方法包 `Promise<>`（**151 处 `Database.RunResult` 签名声明**）。调用侧：每处 `dao.x()` 加 `await`、宿主同步函数变 async（Hono handler 本已 async，主要 ripple 在 SchedulerService/ExecutionLifecycle 同步链）。

B6 本体三件事：删旧 base.ts、`getDb()` 全仓清零（实测生产残余引用 index.ts:364-370/429/514、execution:226 等已全部随各批消化）、`.eslint-baseline.json` 的 server:26 → 0。

---

## 8. 「漏 await」探测（R3）——每批四重网

1. **tsc 编译即探针**：同步值当 Promise 用（`rows.map` 于 `Promise<T[]>`）大多直接类型报错 —— 542 处 stmt + 151 签名让"静默漂移"多数无法过编译。每批门禁：`pnpm -r build` 零 error。
2. **no-floating-promises ratchet 已存在且可用作零新增闸门**：`scripts/eslint-ratchet.mjs` 对 `.eslint-baseline.json`（server=26）只降不升 —— 漏掉一个被丢弃返回值的调用 = +1 违例 = CI 红。**B0 追加两条 type-checked 规则**：`await-thenable`（抓对非 Promise 多余 await，混合期双引擎互调）与 `no-misused-promises`（抓 `setInterval(asyncFn)` / 同步回调里调 async DAO —— scheduler 全域是重灾区）。
3. **真 PG 集成回归 ×2**：批内探针测试文件在 PG harness（B0③）上跑两遍（vitest `--sequence.shuffle.seed` 固定 + 重复），漏 await 在同步引擎下"恰好对"的顺序依赖会以第二遍 flaky 暴露；archive:160 类 abort 语义由该批新增的"失败注入"用例守（无现成覆盖 —— B5 需先补 1 个用例再迁，属计划内新增，不算"用例数下降"）。
4. **用例数账本**：每批收尾跑 `rg -c "^\s*(it|test)(\.\w+)*\("` 全量 = **≥2653（server）** 逐文件 diff，dao/__tests__ 132 个直测用例按 §2 表逐 DAO 对账。

---

## 9. 每批机械/人判比例预估

| 批 | 体量锚 | 机械 % | 人判项（具体内容） |
|---|---|---|---|
| B0 | ~8 新文件 | 10 | schema 转写策略、时间戳/布尔列型裁决、PG 测试隔离模型 |
| B1 | 42 stmt / 18 files | **95** | harness 直写 14 处的归属拆分 |
| B2 | 66 stmt / 26 files | **90** | reports_fts 首战 pg_search、tasks-service 6 处 prepare |
| B3 | 64 stmt / 23 files | **55** | S8 全量（2 张 fts5 + 中文分词链路）+ 39 文件 fixture 的造数语义 |
| B4 | 69 stmt / 25 files | **80** | S9 批量插入重写、price-sql CTE 的 PG explain |
| B5 | 299 stmt / 61 files | **65** | §6 的 19→14 事务语义、archive 体内 catch、同步→async ripple（SchedulerService/ExecutionLifecycle 链）、540 处 fixture 调用 await 化 |
| B6 | base+连接收口 | **85** | migration 链终态、lazyDAO Proxy 异步化 |

机械部分（预计占全部工作量 ~72%）可由 codemod 辅助：`this.stmt(X).get(...)` 三态改写、签名 `Promise<>` 包裹均可半自动；调用侧 await 插入建议手工 + tsc 驱动，不写激进 AST 变换（混合期未迁移 DAO 不能碰）。

---

## 附录：实测命令

```bash
# 依赖图/耦合
grep -nE '^import|from "\./' packages/server/src/db/dao/*-dao.ts        # DAO 间 import：空
rg -l better-sqlite3 -g '*.ts' | wc -l                                   # 167
rg -l better-sqlite3 packages/server/src -g '*.ts' -g '!**/__tests__/*'  # 54 生产
# 体量
rg -c 'this\.stmt\(' packages/server/src -g '*.ts'                       # Σ=542（dao 540 + base 2）
rg -l "\b<X>DAO\b" packages/server/src -g '*.ts' -g '!src/db/dao/*' -g '!src/**/__tests__/*'   # 各批 prodFiles
# 特殊构造
rg -n '\.transaction\(' packages/server/src -g '*.ts'                    # 19 处（§6）
rg -n '\.iterate\(|\.backup\(' packages/server/src                       # 0 / 0
rg -c 'Database\.RunResult' packages/server/src/db/dao/*.ts              # 151
rg -o 'INSERT OR IGNORE|ON CONFLICT' packages/server/src -g '*.ts'       # 32/12（生产 DAO 8/8）
rg -c '\.pragma\(' packages/server/src -g '*.ts'                         # 72 = 生产 12 + 测试 60
# 测试基线
rg -c "^\s*(it|test)(\.\w+)*\(" packages/server/src -g '*.test.ts'       # Σ=2653 / 219 files
rg -l 'new Database\(|initDb\(' packages/server/src -g '*.test.ts'       # 135 测试直起 sqlite
# 门禁现状
cat packages/server/eslint.config.mjs .eslint-baseline.json scripts/eslint-ratchet.mjs
```
