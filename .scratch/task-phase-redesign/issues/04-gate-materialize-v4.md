# 04 — v4 ready-gate + per-phase 物化 + 占位符词表

## What to build
`readyTask` 按 `format` 分叉：v3 原 6 项保留；v4 gate=phases≥1 ∧ 每 phase specPath 文件存在 ∧ 每 phase workflow_ref 在解析集内可解析 ∧ required inputs 非空，missing key 格式 `phase:<i>:<why>`。materialize：v4 生成 per-phase WorkflowConfig 信封（一 task 一 schedule 信封不变，phase 配置内嵌）；`resolveInputValues` 扩展词表 `${phase.slug}/${phase.spec_dir}/${task.home}/${task_artifacts_dir}`。

## Blocked by
01, 02

## Status
done

## Exploration

**Analog studied**: v3 ready gate (tasks-service.ts `readyTask` — 实际路径 `packages/server/src/services/tasks/tasks-service.ts:984-1069`，票面行号 1006-1069 因票 02/03 并发位移) + T5 input gate (`tasks-v3-ready-inputs.test.ts` 模式：Hono 路由 + stub BuiltInWorkflowService.get + tmpDir TaskHomeService)。

**关键函数选定**:
- `resolveWorkflowRef(ref, deps)` (workflow-ref-resolver.ts:50) — 与 v3 gate 同一解析集 (builtin ∪ task-home workflows/)。单调用既判可解析又取 content 给 required-inputs 检查（v3 已有 single-resolve 先例）。
- `parseWorkflowInputDefs(content)` (template-resolver.ts:93) — inputs 段解析，直接复用。
- `resolveInputValues(inputValues, goal, ac, ctx?)` (template-resolver.ts:49) — 扩第 4 参 ctx（phase.slug/phase.spec_dir/task.home/task_artifacts_dir），3 参旧调用点行为逐字节不变；正则 `\$\{(\w+)\}` → `\$\{([\w.]+)\}`（现网仅无点名被测试，扩宽对 v3 零影响；有点未知名从「字面保留」改为「→ "" + unresolved」更符合 AC3 纪律）。
- `materializeTaskSpecToConfig` (scheduler-service.ts:195) — 尾追加第 9 参 `v4Phases?`（SW-BP15 惯例：永不动已有位参）。
- `TaskHomeService.homePath(id)` (task-home-service.ts:116) — specPath 相对 home 解析用。

**文件改动面**: tasks-service.ts (gate 分叉 + gateV4Phases 私有方法 + readyTask 传 v4Phases)、scheduler-service.ts (materialize v4 分支：per-phase 信封 `config.format='v4'` + `config.phases[]`，workflow_chain[0]=phase1 立即可触发)、template-resolver.ts (词表)、新 tasks-v4-gate.test.ts。WorkflowConfig 类型在 shared（禁碰）→ 用本地扩展类型 cast 嵌入（先例：skills 键 post-validation re-attach，scheduler-service.ts:281）。

**v4 gate missing 格式**: 无 phases → `phase:0:no-phases`；per-phase i = 数组序 1 起 → `phase:<i>:spec-missing` / `phase:<i>:workflow-ref` / `phase:<i>:input:<name>`（unresolved 与 required-empty 两路同 key，Set 去重，镜像 v3）。

## Acceptance Criteria
- [x] AC1: v4 gate 4 类缺失各自产生精确 missing key（409）
- [x] AC2: v3 payload 入队行为与现网逐字节一致（回归：现 tasks-v3-gates.test 不改仍绿）
- [x] AC3: 未知占位符 `${nope}` 进 missing 不 500（继承 v3 纪律）
- [x] AC4: 物化产物断言：schedule 信封 status=draft、origin=task、config 含 phases 解析结果

## Verification Method
**Verification type**: integration test（真 DB + tmp task home fixture）

**Verification steps**:
1. 新 `packages/server/src/__tests__/tasks-v4-gate.test.ts`（参照 gates.test 模式）
2. `pnpm -F @octopus/server test -- tasks-v4-gate tasks-v3-gates`（v3 回归同跑）

**Pass criteria**: 新测试全绿 + v3 gates 测试零修改通过
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Verification Result (2026-09-03)

`npx vitest run tasks-v4-gate tasks-v3-gates`（server 目录）→ **42/42 绿**（v4 新 17 + v3 回归 25，v3 测试文件零修改）。
邻近回归：template-resolver / materialize-input-values / tasks-v3-ready-inputs / tasks-v3-dispatch / 06-schedules-origin / tasks-routes / tasks-trigger-mutex / scheduler-task-spec → 97 pass / 2 skip（skip 预存）。
scheduler-routes.test.ts 2 例 G7 失败 = 预存陈旧断言（`POST /jobs trigger_source=requirement` 自动 clone-session 路径已在 v2 重构删除，routes/scheduler.ts:241 注释明证；与本票 3 个文件零交集，非本票回归）。
v3 测试适配：无（未改任何 v3 测试即绿）。
