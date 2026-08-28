# 06 — web-app:绑定表单显示 inputs 默认值 + 换选清空

## What to build
WorkflowBox 绑定对话框两处修复(看板用户可见面):非 required inputs 渲染时显示工作流 def.default(否则用户看不到 max_turns=200);从"全部内置"换选手动工作流时清空已填 formInputs(串值 bug)。

## Blocked by
None — can start immediately

## Status
done

## Exploration

Analog studied: `workflow-box.tsx` itself (owned by task-workflow-presets T6) + test convention from
`__tests__/template-picker.test.tsx` / `__tests__/authoring-workspace.test.tsx` (fireEvent + findBy*,
vitest + @testing-library/react, jsdom; API modules mocked via `vi.mock("@/lib/workflow-presets-api")`).

Files needing modification (only these two — my lane):
- `packages/web-app/components/tasks/authoring/workflow-box.tsx`
  - AC1: line ~343 `value={formInputs[name] ?? ""}` → `value={formInputs[name] ?? def.default ?? ""}`
    (`def.default` typed `string` in `BuiltInWorkflowDetail.parsed.inputs` — lib/workflow-presets-api.ts:38).
    Save-side empty-drop already exists in `handleSave` (`if (v && v.trim()) cleaned[k] = v`) — behavior pinned by new test, no change needed.
  - AC2: `handleSelectWorkflow` (line ~167) — add `setFormInputs({})`; `handleSelectPreset` untouched (keeps `setFormInputs({...preset.inputs})` prefill).
- `packages/web-app/components/tasks/authoring/__tests__/workflow-box.test.tsx` — add dialog-interaction tests:
  1. manual-select workflow → `max_turns` input renders value "200" (def.default)
  2. preset A prefill + typed value → manual select B → form inputs empty
  3. save drops untouched-default + cleared fields (PUT input_values excludes `max_turns`, empty `ac`)

Dialog open path in tests: click `[data-workflow-bind-button]`; list items addressable via
`[data-preset-item="<name>"]` / `[data-workflow-item="<ref>"]`; inputs via `[data-input-field="<name>"]`;
save via `[data-bind-save-button]`. Radix Dialog content unmounts when closed — reset effect on `!open` keeps state clean.

## Acceptance Criteria
- [x] AC1: 表单初值 `formInputs[name] ?? def.default ?? ""`;保存时空值剔除(走 YAML default,不写空串)
- [x] AC2: `handleSelectWorkflow`(非 preset 路径)重置 formInputs;preset 点击预填行为不变
- [x] AC3: 组件测试两例:max_turns 字段渲染出 "200";preset A 填值后手动换选 B → 表单为空

## Verification Method
**Verification type**: 组件测试
**Verification steps**:
```bash
cd packages/web-app && pnpm vitest run components/tasks/authoring/__tests__/
```
**Pass criteria**: 新增 3 例绿 + 既有 WorkflowBox 测试不回归
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Verification Result (2026-08-29)

PASS — `pnpm vitest run components/tasks/authoring/__tests__/` → 4 files / 39 tests green, incl. 3 new dialog tests
(default "200" renders on manual pick; preset A → manual B resets form + leak-free save payload; untouched default
& cleared field both dropped from input_values). Load-bearing confirmed: reverting only workflow-box.tsx → 3 new tests red.
Zero act() warnings (userEvent + local ResizeObserver stub in test file). tsc: no errors in owned files.
Note for pipeline (out of lane, pre-existing on base branch): `components/tasks/__tests__/task-modal-spec-panel.test.tsx`
"displays bound workflow_ref" fails at HEAD too — SpecPanel's own ref text collides with WorkflowBox badge
(introduced by task-workflow-presets T6, commit c6e1613e).
