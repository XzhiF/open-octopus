# 10 — built-in 工作流列表/详情缓存（根治 S1/S4 卡顿）

## What to build
`builtin-workflow.list()/detail()` 内存缓存（key=工作流目录 mtime+文件名，失效粒度到单文件）；phase 绑定的目录浏览数据源正式切此端点（preset 链退役不删码但 coding UI 不再调用）。

## Blocked by
None — can start immediately.

## Exploration

**Analog studied**: none — no existing cache pattern in server services for fs-backed resource reads. Studied `builtin-workflow.ts` call graph instead.

**Critical finding**: `BuiltInWorkflowService` is instantiated **per-request / per-call-site** —
`routes/builtin-workflow.ts:10,16`, `routes/workflow.ts:29,76`, `routes/repair.ts:50,74`,
`services/execution-service-registry.ts:52`, `services/execution.ts:79`, plus a singleton at
`index.ts:721`. An instance-level `Map` cache would never survive a second HTTP request.
→ Cache must be **module-level** in `builtin-workflow.ts` (covers all call sites without touching
non-owned files).

**Cache design**:
- Two-tier: (a) dir-scan cache keyed by dir path, validated by dir `mtimeMs` (catches yaml add/remove/rename → re-`readdirSync`);
  (b) parse cache keyed by yaml path, validated by file `mtimeMs + size` — invalidation granularity to single file.
  In-place content edit changes the file mtime but NOT the dir mtime, so file-level validation is mandatory (AC2).
- `statSync` failure (e.g. fake paths in existing unit tests) → bypass cache, read directly. Keeps `builtin-workflow-service.test.ts` (mocked fs, nonexistent paths) green.
- `list()` and `get()` share the same parse-cache entry → one parse serves both (AC1/AC3).

**Test seam** (no timing assertions, per hard rules):
- parse counter via `vi.mock("@octopus/shared")` wrapping the real `parseWorkflow` (`vi.hoisted` counters).
- read count via `vi.spyOn(fs, "readFileSync")` forwarding to real impl.
- Real fs tmp dirs per test (unique paths → module cache can't collide across tests); mtime bumped explicitly with `utimesSync` after rewrites to avoid same-ms flakiness.

**Files changed**: `packages/server/src/services/builtin-workflow.ts` (impl), new test
`packages/server/src/services/__tests__/builtin-workflow-cache.test.ts`. No route change needed
(module-level cache makes per-request instantiation harmless).

## Status
done

## Acceptance Criteria
- [x] AC1: 连续两次 list，第二次不发生 readFileSync/parseWorkflow（计数注入或 mock fs 断言）
- [x] AC2: 修改任一 YAML 文件后下一次请求反映新内容（mtime 失效）
- [x] AC3: detail 同样命中缓存；冷/热响应差实测 <10ms（本机）

## Verification Evidence (2026-09-03)
- `packages/server/src/services/__tests__/builtin-workflow-cache.test.ts`（4 tests）：
  - AC1 — `vi.mock("@octopus/shared")` 包装真实 `parseWorkflow` 计数 + `fs.readFileSync` call-through spy：cold list Δparse=1/Δread≥1；warm list Δ=0/Δ=0；detail 复用 list 解析结果（Δ=0）；warm detail Δ=0。
  - AC2 — 两工作流预热后只改文件 A：list Δparse=1（非 2，失效粒度到单文件），detail 见新内容零额外 parse；AC2b 目录增删文件 → readdir 缓存随目录 mtime 失效；非 octopus yaml 的 skip 决策同被缓存。
  - mtime 用 `utimesSync` 单调未来偏移显式驱动，无 timing 断言。
- AC3 实测（一次性 bench，非入测试）：5×40 节点 fixture — coldList 74.4ms → warmList 0.12ms；coldGet 0.13ms（list 已共享 parse）；warmGet 0.016ms。冷/热差 ≪10ms。
- 回归：`vitest run builtin-workflow` 9/9 绿（含既有 builtin-workflow-service.test.ts 5/5——fake 路径 stat 失败自动绕过缓存，行为不变）；repair(31)/ref-resolver(8)/workflow-service 全绿；`tsc --noEmit` 本票文件零错误。
- 注：execution-lifecycle/harness-* 测试当前在 `db/schema.ts` 报 `migrateTasksStatusCheckV40 is not defined` —— 工作树内票 02 并发实施中的脏文件，与本票无关、未触碰。

## Verification Method
**Verification type**: integration test

**Verification steps**:
1. `packages/server/src/services/__tests__/builtin-workflow-cache.test.ts`：fs 调用计数代理 + 改写文件失效断言
2. `pnpm -F @octopus/server test -- builtin-workflow-cache`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
