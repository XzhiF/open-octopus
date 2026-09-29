# P1 B2 — 测试 fixture 迁 PG 双引擎配方（tasks/审查域）

> 给 B2 批次的测试迁移子任务。基准已证：`src/__tests__/tasks-routes.test.ts` 已按本配方
> 迁完且 18/18 绿（先读它作为金样板）。

## 背景（一句话）

B2 批次把 6 个 DAO（TaskDAO/AcceptanceDAO/PendingReviewDAO/SafetyDAO/
InteractionMessageDAO/KnowledgeEffectivenessDAO）迁到了 postgres.js；tasks / task_phase_acceptances /
pending_review / safety_events / reports / scheduled_job_executions / interaction_messages /
knowledge_effectiveness 这 8 张表在测试运行期落在 **PG**，其余表（executions/workspaces/schedules/
sessions/messages…）仍在 **SQLite**。测试要同时喂两座库。

## 配方

1. **注册 PG 池（每文件一座库）**——文件顶部：
   ```ts
   import { setupRegisteredPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture" // 路径按层级调
   let pg: PgFixture | null = null
   ```
   `beforeAll(async () => { pg = await setupRegisteredPgSchema() /* 再建原来的 sqlite db */ })`；
   `afterAll(async () => { await pg?.close(); pg = null; db.close() })`。
   `setupRegisteredPgSchema` 会把池注册进全局 registry —— service 内部 `pgSql()` 与 registry
   lazyDAO 都能拿到它，**SQLite 侧构造完全不用改**。

2. **`new XxxDAO(db)`（这 6 个 DAO）→ `new XxxDAO(pg!.sql)`**。
   其它 DAO（ExecutionDAO/ScheduleRunDAO/AgentSessionDAO/…）继续吃 sqlite db。

3. **造数分表走两侧**：
   - 8 张 PG 表的直插 `db.prepare("INSERT INTO tasks …")` → `await pg!.sql.unsafe(…$n…)`
     （占位符 `?`→`$1..`；`datetime('now')`→`now()`；列语义见 dao/*.ts 头注）。
   - 经 service/DAO 造的数据不用动（await 就行）。

4. **断言侧直读 PG**：`db.prepare("SELECT … FROM tasks …")` → `await pg!.sql\`SELECT …\``。
   时间戳列断言用 DAO 同款投影：`to_char(col AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`；
   jsonb 列用 `col #>> '{}'`（读回是规范化 JSON 文本：键序/空白与写入串不同 →
   **禁止 `expect(str).toBe(inputStr)`，一律 JSON.parse 后 deep-equal**）。
   `trigger_enabled`/`auto_approve` 读回 0/1（DAO 投影）或 boolean（裸 sql 读）—— 裸 sql 断言用
   `col::int`。

5. **跨引擎 FK 父行**：PG `tasks.source_chat_session_id → sessions`、
   PG `interaction_messages.execution_id → executions`。测试里任务绑会话/消息绑执行时，
   PG 侧要有父行：用最小裸 INSERT 复制过去
   （sessions: id, org, title, created_at, updated_at；executions: id, workspace_id,
   workflow_ref, workflow_name, status, org, created_at, updated_at —— NOT NULL 列都给上）。

6. **await 传播**：service/DAO 方法已是 async；`it(...)` 回调本就是 async。
   注意 `(await f()).prop` 优先级坑（不是 `await f().prop`）。

## 硬约束

- **用例数一条不许少、不许 skip 化、不许改断言语义蒙绿**。只许加 await/换数据源/等语义投影。
- 不许改：`src/db/dao/*`（DAO 本体）、`registry.ts`、`base-pg.ts`、`schema.sql`、
  `services/**`、`routes/**`、其它批的测试文件。发现生产代码 bug → 记入报告，不动手。
- 每个文件独立跑绿：
  `cd packages/server && OCTOPUS_PG_TEST_URL=postgres://octopus:octopus@127.0.0.1:5432/octopus npx vitest run src/__tests__/<file>.test.ts`
- **绝不 TRUNCATE/DROP `octopus` 或 `octopus_template` 库**（真库有并行 agent 在用）；
  只动 harness 随机建的 `octopus_test_*`。
- 不 commit、不 git add。
- 环境没跑绿之前不许宣布完成；报告里给每文件 `passed/总数`。

## 已趟平的地雷（别重踩）

- postgres.js 把 JS number 0/1 绑进 boolean 列会**静默存 false** —— 测试造数写 bool 列用 true/false。
- PG `ON CONFLICT DO UPDATE SET col = col + 1` 裸列名报 ambiguous —— DAO 已修，测试裸 sql 学 DAO 写法。
- `COUNT(*)` 裸 sql 读回是 string —— 断言 `Number()` 或 `::int`。
- 金样板：`src/__tests__/tasks-routes.test.ts`（18 例全绿）。
