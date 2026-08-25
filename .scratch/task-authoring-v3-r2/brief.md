# Requirement Brief — task-authoring-v3 Iteration 2

## Overview
Gap-fix iteration for task-authoring-v3. This iteration targets ONLY the gaps
identified in the Round 1 verification report (78.5/100, REVIEW).

## Context
- Root feature: task-authoring-v3
- Previous iteration: task-authoring-v3 (Round 1)
- Previous score: 78.5/100 (adjusted: 78.5/100)
- Previous decision: REVIEW
- Branch: feat/task-domain-redesign (all iterations share the same git branch)

## Carryover from Previous Rounds

| AC# | Status | Round | Priority |
|-----|--------|-------|----------|
| US8 | PARTIAL (manual-only; LLM behavior) | R1 | P1 |
| D12 | PARTIAL (/tasks/prototype route still shipped) | R1 | P1 |

## Gap Targets

### Gap 1: D12 — prototype route still in app (P1)
**What failed**: spec R6 says 原型是 throwaway、代码不复制；但 `packages/web-app/app/tasks/prototype/page.tsx`（+3568 行）作为 live route 入库（spec 阶段产物）。D12 要求 TaskModal 内部重构、不加新路由。
**Why it matters**: dead 3.5k-line route in production bundle; D12 stays PARTIAL blocking convergence.
**Required fix**: 删除 `packages/web-app/app/tasks/prototype/` 目录；grep 确认无引用（E2E helpers、task-modal、docs 引用仅存历史说明可保留）；`pnpm build` 通过。
**Verification**: 目录不存在；web-app build 成功；grep `/tasks/prototype` 在 packages/ 零命中（.scratch 历史记录除外）。

### Gap 2: Cross-feature E2E regression — sibling specs red vs v3 flow (P1)
**What failed**: `task-domain-simple.spec.ts` test 1（及 composite 同类）期望 v2 `[data-task-spec-panel]`，但 v3 redesign 让新任务先走 TemplatePicker（correct-by-design）。E2E 套件留红侵蚀反假跑不变量。
**Why it matters**: audit risk #2；后续 feature 的 E2E 基线被污染。
**Required fix**: 迁移两个 sibling spec 的入口步骤到 v3 流（[+新建] → TemplatePicker 选类型+组 → 创建 → 进入编写页），保留其原有断言意图（simple/composite dispatch 验证）。只改流程入口假设，不删覆盖。
**Verification**: `npx playwright test e2e/task-domain-simple.spec.ts e2e/task-domain-composite.spec.ts` 全绿（server :3001 已运行最新 dist）。

### Gap 3: Reporting corrections (P2)
**What failed**: pipeline-report.md 的 Changed Files 表按 main 计算（providers 声称 4 文件，实际本迭代 0）；截图数 19 含 1 张上一迭代遗留 PNG（v3 实际 18）。ticket-01 的 AC checkboxes 未勾选。
**Required fix**: 修正 pipeline-report.md 表格为 vs 9917e986 口径（shared 5 / providers 0 / engine 2 / core-pack 7 / server 21 / web-app 21 + 测试/工件，总 82 files +15430/−106 含后续 doc commits 注明）；截图数注明 18 v3-specific；勾选 ticket-01 checkboxes。
**Verification**: 报告数字与 `git diff --shortstat 9917e986...HEAD` 一致；ticket-01 checkboxes 全勾。

### Gap 4: US8 carryover — manual checklist + mechanism assertions (P1)
**What failed**: US8（对话改产物）仅 manual checklist，无自动断言；US5/US9/D6/real-MoA 的对话层效果同为人工项但无集中清单。
**Required fix**: (a) 新建 `.scratch/task-authoring-v3/MANUAL-CHECKLIST.md`：US5 @@spec_updated 投递、US8 对话改产物、US9 建议气泡、D6 @@task_context 对话可见、real-LLM MoA 完成 — 每项含可执行步骤 + 期望观察 + 证据栏（待人工执行）；(b) 补齐机制层可自动断言的缺口：persona 文本含产物目录/artifacts.json 指引断言（builtin-clones 单测）；@@task_context append 字符串在 clone-runtime 段的顺序断言（如已有则不重复）。US8 的 LLM 对话残差标记为 human-run prerequisite（BLOCKED-pending-human），不作为自动收敛项。
**Verification**: checklist 文件存在且 5 项完整；新增机制断言测试绿。

### Gap 5: Dispatch suite assertion strengthening (P3)
**What failed**: tasks-v3-dispatch.test.ts 密度 0.072（22 asserts / 7 tests）为全特性最低，却承载三路径注入关键声明。
**Required fix**: 为三路径注入补充真实 edge/negative 断言（禁止 tautological padding）：如 legacy 任务 config 不含 task_artifacts_dir 键（键缺席断言而非仅不报错）、composite buildCompositeInputValues 保留注入键且其他键不丢失、composition input_mapping 对非 string 值的类型保持、taskHomeService 注入 seam（readyTask 用注入实例）行为断言。目标 ≥32 asserts。
**Verification**: suite 全绿且断言数 ≥32；密度提升无 expect(true)/toBeDefined-only。

## Prerequisites (mandatory — E2E gaps exist)
- Server running on 3001 (latest dist incl. R1 review fixes): RUNNING（如失效：`cd packages/server && pnpm build && PORT=3001 node packages/server/dist/index.js` 后台）
- Web-app on 3000 (Next.js dev): RUNNING

## Feature Scope
**Do:**
- 上述 5 个 gap 项

**Don't:**
- Do NOT modify working code from Round 1 (除非 Gap 2 sibling spec 迁移必要)
- Do NOT add new features beyond the gaps
- Do NOT refactor unless the gap requires it
- Do NOT pad assertions tautologically (Gap 5 明确禁止)

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | Scope | Gap-fix only | Minimize regression risk |
| D2 | Prototype route | 删除（不豁免） | R6 throwaway policy；3.5k 行 dead route |
| D3 | US8 残差 | BLOCKED-pending-human 标记 | LLM 对话行为不可确定性自动化；manual 证据由人执行 |

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| G1 | D12 PARTIAL→PASS | prototype 目录删除、零引用、build 绿 | grep + build |
| G2 | E2E 套件无红 | 两 sibling spec 迁移后全绿 | playwright run |
| G3 | 报告可信 | 数字与 git diff 一致 + ticket hygiene | 对照 git |
| G4 | US8 carryover 收敛路径 | checklist + 机制断言绿；残差 BLOCKED-pending-human | 文件 + tests |
| G5 | dispatch 密度 | ≥32 asserts，无 tautology | count + scan |

## Verification Strategy
### Global Config
- Environment: same as root feature (server 3001 / web 3000, main repo dev)
- Test user: same as root feature

### Per-layer Methods
- G1: 文件系统 + build + grep
- G2: Playwright 真实浏览器执行（screenshot 证据延续既有 spec 约定）
- G3: git diff 对照
- G4: unit tests + 文档检查
- G5: vitest 执行 + 断言计数

### Previous Iteration Evidence
Link to previous verification-report: .scratch/task-authoring-v3/verification-report.md

---

> **Execution requirement**: All tests MUST be executed, not just written.
> Tests written but not executed = 0% credit. Pipeline must produce execution
> evidence (test output, screenshots, DB queries).
