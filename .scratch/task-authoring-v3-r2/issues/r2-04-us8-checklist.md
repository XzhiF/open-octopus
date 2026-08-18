# r2-04 — US8 carryover：MANUAL-CHECKLIST + 机制断言

## What to build
US8（对话改产物）在 R1 为 PARTIAL（manual-only）。LLM 对话行为不可确定性自动化（spec R2 策略），残差标记为 human-run prerequisite；本 ticket 完成收敛路径的可自动化部分：

1. **MANUAL-CHECKLIST.md** — 新建 `.scratch/task-authoring-v3/MANUAL-CHECKLIST.md`，5 项，每项含：前置条件 / 操作步骤 / 期望观察 / 证据栏（待人工填写）：
   - M1 (US5): 用户直编 goal（SpecPanel/GoalAcCard source=user）→ 下一轮 task-author 对话 system prompt 收到 `@@spec_updated: goal` 并作出调和回应
   - M2 (US8): 对话中要求 agent 产出/修改一个产物文件 → agent 用绝对路径写入 `{home}/artifacts/` 并登记 artifacts.json → OutputViewer 刷新可见 + 全文弹窗内容 == 磁盘
   - M3 (US9): 对话中 agent 主动建议运行辅助工作流（建议气泡/文本建议），用户点击触发 → run 卡片出现
   - M4 (D6): v3 任务第二轮对话中，确认 agent 行为体现 `@@task_context`（知道产物目录绝对路径、不建议修改已锁定 Skill 组）
   - M5 (real-LLM MoA): 真实 provider 触发 moa-requirements-review → 运行至终态 → 日志弹窗含专家步骤 → 结构化产出可采纳
2. **机制断言补齐** — 可行性预检（Step 4.5）核实：persona 文本**不含**产物/artifacts.json 措辞，US8 的机制侧实际由 `@@task_context` 注入承载（D6，routes/clone → clone-runtime append；clone-spec-notice.test.ts 已断言含 artifacts.json 登记指引，不重复）。新建或扩展 server 单测（可放 `packages/server/src/__tests__/persona-v3-instructions.test.ts`），断言 persona 文本：
   - 可用字段列表含 `decisions`
   - 显式创建示例含 `source_chat_session_id`（D15 会话优先）
   - 含 `@@spec_updated` 反向通知说明（US5 机制侧）
   并在测试注释中记录：产物目录/artifacts.json 指引的机制断言归属 @@task_context（clone-spec-notice D6 套件），避免未来 audit 误判 persona 缺项。

## Blocked by
None

## Status
done

## Acceptance Criteria
- [x] AC1: MANUAL-CHECKLIST.md 存在，M1-M5 五项完整（步骤/期望/证据栏）
- [x] AC2: persona 机制断言测试全绿（vitest 执行）
- [x] AC3: checklist 顶部声明：LLM 对话残差为 BLOCKED-pending-human，需人工执行并回填证据后方可视为 US8 PASS

## Verification Method
文件检查 + vitest run

## Exploration

**Analog studied:** `packages/server/src/__tests__/clone-spec-notice.test.ts` — closest existing test that pins mechanism-side content (the `@@task_context` injection + `@@spec_updated` reverse-notice delivery) through real seams. Mirrored its style: header comment stating scope + audit note, `describe`/`it` with a gate case.

**Files needing modification (my lane only):**
- NEW `packages/server/src/__tests__/persona-v3-instructions.test.ts` — persona contract assertions (decisions / source_chat_session_id / @@spec_updated).
- NEW `.scratch/task-authoring-v3/MANUAL-CHECKLIST.md` — M1-M5 human-run checklist.

**Files explicitly NOT modified:**
- `packages/server/src/services/agent/builtin-clones.ts` — persona text asserted AS IS; `git diff --stat` empty. Assertions target existing strings (decisions field-list line, source_chat_session_id + "D15 会话优先" curl example, @@spec_updated reverse-notice line).

**Specific functions chosen:**
- `getBuiltinCloneDef("task-author")` (exported from `builtin-clones.ts`) — the public seam to read `.persona`. Chosen over importing the module-local `TASK_AUTHOR_PERSONA` const (not exported) so the test stays at the public interface and the const can be refactored without breaking the test.
- Artifact-dir / artifacts.json guidance NOT asserted here — that mechanism lives in `@@task_context` (D6, asserted in `clone-spec-notice.test.ts` D6 suite: `capture.taskContext` contains artifacts dir absolute path + `artifacts.json` + skill-group lock line). Recorded in the test header comment to prevent future audit misjudging the persona as missing artifact wording.

## Verification Result

- AC1: MANUAL-CHECKLIST.md created at `.scratch/task-authoring-v3/MANUAL-CHECKLIST.md` — M1-M5 present, each with 前置条件 / 操作步骤 / 期望观察 / 证据栏（待人工填写）. PASS.
- AC2: `cd packages/server && pnpm vitest run src/__tests__/persona-v3-instructions.test.ts` → 4 tests passed (gate + US8 decisions field + D15 source_chat_session_id + US5 @@spec_updated). PASS.
- AC3: Checklist top line declares `STATUS: BLOCKED-pending-human` — US8 stays PARTIAL until a human executes M1-M5 against a real LLM provider and back-fills the 证据 columns; convergence note at the bottom restates this. PASS.

Note: US8 itself remains PARTIAL (BLOCKED-pending-human) by design — the automated portion (mechanism assertions + checklist scaffold) is complete; the LLM-behavior residual requires human execution per spec R2 strategy.
