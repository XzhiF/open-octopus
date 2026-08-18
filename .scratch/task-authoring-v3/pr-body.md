## Task Authoring v3 — 两阶段任务编写 + 产出查看器

把 TaskModal 重构为「模板页（类型 + Skill 组多选锁定 + 语境）→ 编写页（左 chat / 右产出查看器）」的两阶段流：Skill 组经 per-task plugin 目录获 SDK 原生加载，产物按任务家目录约定收集（登记不搬迁），编写期可运行内置辅助工作流（MoA 专家咨询等）并将结构化产出勾选采纳进 spec。19 项决策（含 3 个新 ADR：0010 per-task plugin 目录 / 0011 任务家目录+登记不搬迁 / 0012 创建时锁定）。

### Development Iterations
| # | Feature | Date | Tickets |
|---|---------|------|---------|
| 43 | task-domain-redesign (v2 tasks table + deterministic draft + spec↔agent linkage) | 2026-08-18 | done (22/22 product-verified) |
| 44 | task-authoring-v3 (本 PR 新增) | 2026-08-18 | 11 (DAG 7 stages) |

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

14/14 browser E2E PASS（retries=0），19 张截图证据，API↔DB↔FS↔SSE↔UI 五层交叉验证（R1–R8 合规），156 assertions。Code review 3-axis：5 项 🔴/🟡 全部修复并二次验证（含 D6 task context 注入、D19 SSE 无轮询）。

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
- `task-domain-simple/composite` sibling E2E specs 对 v3 TemplatePicker 流过时（correct-by-design，单独跟进）
- 分支预存 31 个环境漂移测试失败（与本特性无关，已记录基线）
- manual checklist：real-LLM MoA 完成、agent 建议气泡、@@task_context 对话投递

<!-- MANUAL-START -->
<!-- MANUAL-END -->
