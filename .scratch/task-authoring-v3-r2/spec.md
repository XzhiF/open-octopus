# Spec: task-authoring-v3-r2 — Gap-Fix Iteration

> Round 2 of the verification loop. Root spec: `.scratch/task-authoring-v3/spec.md`（D1-D19、US1-US14 全部继承，受 iteration-handoff.md Protected Decisions 约束）.
> 本迭代仅覆盖 Round 1 verification-report 的 gap（78.5/100 REVIEW）。

## Gap Stories

### GS1 — 删除 throwaway 原型路由（carryover D12 → PASS）
删除 `packages/web-app/app/tasks/prototype/`。约束：web-app build 通过；`/tasks/prototype` 在 packages/ 下零代码引用。
**AC**:
- AC1: 目录已删除
- AC2: `pnpm build`（web-app）成功
- AC3: grep 零引用（.scratch 历史文档除外）

### GS2 — sibling E2E specs 迁移到 v3 流（cross-feature regression）
`task-domain-simple.spec.ts` / `task-domain-composite.spec.ts` 的新建任务入口改为 v3 TemplatePicker 流（选 task_type + skill_groups → 创建 → 编写页），保留原有 dispatch/物化断言意图。
**AC**:
- AC1: 两个 spec 全绿（retries=0 优先；真实浏览器执行）
- AC2: 原覆盖意图保留（simple 单工作流 dispatch、composite/subunit 断言不被删除，仅入口迁移）
- AC3: 不引入轮询/睡眠等待（沿用 helper 的等待原语）

### GS3 — 报告修正 + ticket hygiene
pipeline-report.md 的 Changed Files 表改为 vs 9917e986 口径；截图数注明 18 v3-specific（19 含遗留 1 张）；ticket-01 AC checkboxes 勾选。
**AC**:
- AC1: 表格与 `git diff --shortstat 9917e986...HEAD` 一致（注明含后续 doc commits）
- AC2: ticket-01 checkboxes 全勾

### GS4 — US8 carryover：MANUAL-CHECKLIST + 机制断言
(a) `.scratch/task-authoring-v3/MANUAL-CHECKLIST.md`：US5 @@spec_updated 投递 / US8 对话改产物 / US9 建议气泡 / D6 @@task_context 可见 / real-LLM MoA 完成，各含步骤+期望+证据栏。(b) 机制层断言补齐：persona 文本含 artifacts.json/产物目录指引（builtin-clones 单测）。
**AC**:
- AC1: checklist 存在，5 项完整（步骤/期望/证据栏）
- AC2: persona 机制断言测试绿
- AC3: US8 LLM 残差在 checklist 与 loop carryover 中标记 BLOCKED-pending-human

### GS5 — dispatch 套件断言强化（真实 edge/negative，禁 padding）
tasks-v3-dispatch.test.ts 补充：legacy config 键缺席断言、composite 保留注入键且他键不丢、composition 非 string 值类型保持、注入 seam 行为。目标 ≥32 asserts。
**AC**:
- AC1: suite 全绿
- AC2: asserts ≥32，无 expect(true)/toBeDefined-only/仅 status 断言

## AC Mapping（gap ↔ 验证）
| Gap | ACs | Verification |
|-----|-----|-------------|
| GS1 | AC1-3 | fs + build + grep |
| GS2 | AC1-3 | playwright（真实执行 + screenshot） |
| GS3 | AC1-2 | git diff 对照 |
| GS4 | AC1-3 | file + vitest |
| GS5 | AC1-2 | vitest + count |

## Out of Scope（Protected — 不得触碰）
- Round 1 已验证接口（见 iteration-handoff.md Confirmed Interfaces）
- 31 个环境漂移基线失败（单独任务）
- 任何新 feature
