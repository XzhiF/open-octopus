# 01 — shared:schema 字段升级 + planning 废弃 + warnings 通道

## What to build
工作流解析/校验层的字段契约:NodeDef 新增 `tools/max_turns/max_budget_usd/disallowed_tools`;`planning` 整块废弃且老文件得到明确迁移错误(不被 Zod 静默吞);`validateWorkflow` 返回 warnings(非 claude engine 使用 claude-only 字段)。下游 engine/providers 全部以本工单的字段定义为契约。

## Blocked by
None — can start immediately

## Status
done

## Exploration

**Analog studied**: existing goal-mode field plumbing — `PlanningSchema`/`planning` in `types/workflow.ts` + `_validateGoalPromptExclusion` in `yaml/parser.ts` (pre-Zod semantic checks), and the `command → bash` alias in `NodeSchema.transform` (precedent for node-level field revival).

**Files needing modification**:
- `packages/shared/src/types/workflow.ts` — delete `PlanningDef`/`PlanningSchema`/`planning` field; add `tools?: string[]`, `max_turns?: number|string`, `max_budget_usd?: number|string`, `disallowed_tools?: string[]` to NodeDef + NodeSchema (union via `z.union([z.number(), z.string()])`)
- `packages/shared/src/yaml/parser.ts` — pre-Zod recursive raw scan for `planning` key (incl. loop nested) → ValueError with migration text; delete planning-requires-goal rule; `validateWorkflow → { warnings: string[] }` with claude-only-field warnings
- `packages/shared/src/__tests__/goal-mode.test.ts` — flip planning-accepts cases to planning-rejects; add tools-survives-parse / string max_turns / warning cases
- `packages/cli/src/commands/workflow.ts:37,169` — the ONLY two production call sites of `validateWorkflow` (AC5: print warnings). Server does NOT call validateWorkflow (only parseWorkflow); web-app's `validateWorkflow` in api-client is an unrelated HTTP helper. Engine test callers use `expect(() => ...).toThrow()` — return-shape change is non-breaking there.

**Engine chain decision**: use `node.engine ?? workflow.engine ?? "claude"` per spec, AND treat `"claude-code"` as claude — executor-factory.ts:187-188 maps `claude-code → claude` provider right after the `??` chain (and shared's own yaml-parser/workflow tests already use `engine: "claude-code"`), so warning on claude-code would be a false positive.

**Migration error text** (verbatim from spec walkthrough G): `planning 已废弃: max_turns/max_budget_usd/disallowed_tools 提升为节点字段, verify 删除` — prepended with the offending node path from the raw scan.


## Acceptance Criteria
- [ ] AC1: `tools?: z.array(z.string())` 声明(现状缺失,非 strict 静默剥离);`max_turns`/`max_budget_usd` 类型 `union(number,string)`;`disallowed_tools?: string[]`
- [ ] AC2: parseWorkflow **pre-Zod 递归预扫**(含 loop 子节点)发现 `planning` 键 → ValueError,信息含迁移指引(新字段名+verify 已删)
- [ ] AC3: PlanningSchema 删除;planning-requires-goal 校验规则删除;goal/prompt 互斥、constraints-requires-goal 保留
- [ ] AC4: `validateWorkflow → { warnings: string[] }`;engine 判定链 `node.engine ?? workflow.engine ?? "claude"`,≠claude 且节点带 max_turns/max_budget_usd/tools/disallowed_tools → warning 不 reject
- [ ] AC5: CLI workflow validate 打印 warnings(调用点跟签名改;web 侧不消费不炸)

## Verification Method
**Verification type**: 单元测试
**Verification steps**:
```bash
cd packages/shared && pnpm vitest run src/__tests__/goal-mode.test.ts src/__tests__/  # 既有用例更新+新增
pnpm build   # dist 重建(下游 tsc 依赖)
```
用例:planning 递归报错(loop 内层也报)、tools 字段 parse 保留不剥离、string max_turns 合法、validate warnings 断言(非claude+字段→1 warning;claude+字段→0)、老文件(无 planning 无新字段)零 warning。
**Pass criteria**: 全绿且既有 goal-mode 测试(除 planning 用例改造外)不回归
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Verification Record (2026-08-29)
- PASS — `goal-mode.test.ts` + `yaml-parser.test.ts` + `workflow.test.ts`: 88/88 green (planning-accepts cases flipped to migration-rejects; tools-survives-parse, string max_turns, warning-chain cases added)
- `pnpm --filter @octopus/shared build` green; dist confirms `max_turns?: number | string`, `max_budget_usd?: number | string`, tools/disallowed_tools present, `planning` count = 0
- Full `src/__tests__/` dir: 835 pass / 4 fail — pre-existing environment failures in `model-alias.test.ts` (real `~/.octopus/models.yaml` on this machine) and `resource-clone-lifecycle.test.ts` (PATH_TRAVERSAL guard on local dirs); both files untouched since 2f2899e2 and do not import workflow-schema code — not regressions from this ticket
- CLI `tsc --noEmit`: only pre-existing error is `agents-cmd.test.ts` mock typing; `commands/workflow.ts` clean
- Downstream known-broken (by design, ticket 03 lane): `packages/engine/src/executors/agent.ts` still reads `node.planning` → engine tsc fails until ticket 03
