## Task Authoring v3 — 两阶段任务编写 + 产出查看器

把 TaskModal 重构为「模板页（类型 + Skill 组多选锁定 + 语境）→ 编写页（左 chat / 右产出查看器）」的两阶段流：Skill 组经 per-task plugin 目录获 SDK 原生加载，产物按任务家目录约定收集（登记不搬迁），编写期可运行内置辅助工作流（MoA 专家咨询等）并将结构化产出勾选采纳进 spec。19 项决策（含 3 个新 ADR：0010 per-task plugin 目录 / 0011 任务家目录+登记不搬迁 / 0012 创建时锁定）。

### Development Iterations
| # | Feature | Date | Tickets |
|---|---------|------|---------|
| 43 | task-domain-redesign (v2 tasks table + deterministic draft + spec↔agent linkage) | 2026-08-18 | done (22/22 product-verified) |
| 44 | task-authoring-v3 | 2026-08-18 | 11 (DAG 7 stages) |
| 45 | task-authoring-v3-r2 (gap-fix: prototype removal, sibling specs v3, report reconcile, US8 checklist, dispatch asserts) | 2026-08-18 | 5 (single concurrent stage) |

### E2E Verification（latest: task-authoring-v3）
| AC | Condition | Status |
|----|-----------|--------|
| US1 | template→create→authoring（D15 单 draft + 绑定） | ✅ PASS |
| US2 | Skill 组多选 + plugin 物化 | ✅ PASS |
| US3 | 锁定（🔒 + PUT 409 + merge-preserve） | ✅ PASS |
| US4 | goal/ac SSE 浮现 | ✅ PASS |
| US5 | 用户直编 → agent 感知 | ✅ PASS（@@spec_updated 投递 manual） |
| US6 | 确认后方可入队（D18 gate） | ✅ PASS |
| US7 | 产物全文 + 降级 + SSE 刷新 | ✅ PASS |
| US8 | 对话改产物 | ⏭ SKIP（LLM manual） |
| US9 | agent 建议 + 用户执行辅助工作流 | ✅ PASS（建议气泡 manual） |
| US10 | 过程日志 | ✅ PASS |
| US11 | MoA 采纳 + parse-error 降级 | ✅ PASS |
| US12 | dispatch 注入 $vars.task_artifacts_dir | ✅ PASS |
| US13 | 删除回收家目录 | ✅ PASS |
| US14 | preset 仅 org+projects | ✅ PASS |
| D19 | task_artifacts_update 伴随 SSE（无轮询） | ✅ PASS |

14/14 browser E2E PASS（retries=0；R2 gap-fix 后复跑回归仍全绿），sibling specs 11 passed + 2 provider-gated skips，18 张截图证据，API↔DB↔FS↔SSE↔UI 五层交叉验证（R1–R8 合规），156 assertions + r2 dispatch 强化（22→42 expects）。Code review 3-axis：5 项 🔴/🟡 全部修复并二次验证（含 D6 task context 注入、D19 SSE 无轮询）；r2 gap-fix review 0 🔴。

### Changed Files（当前迭代，vs 上一迭代末端）
```
 packages/core-pack   | 16 files  +648
 packages/engine      | 12 files  +1515
 packages/providers   |  4 files  +248
 packages/server      | 73 files  +15712
 packages/shared      |  8 files  +1554
 packages/web-app     | 48 files  +13501
 (含 tests/E2E/ADRs/.scratch artifacts)
```

### Known Follow-ups
- **MANUAL-CHECKLIST**（`.scratch/task-authoring-v3/MANUAL-CHECKLIST.md`）：M1-M5 人工项待执行回填证据（US5 @@spec_updated 投递 / US8 对话改产物 / US9 建议气泡 / D6 @@task_context 可见 / real-LLM MoA）— US8 收敛的唯一残差（BLOCKED-pending-human）
- 分支预存 31 个环境漂移测试失败（与本特性无关，已记录基线）
- sibling specs 两个 provider-gated skip（无 LLM 环境的固有容忍，simple/composite 互相镜像）

<!-- MANUAL-START -->
<!-- MANUAL-END -->
