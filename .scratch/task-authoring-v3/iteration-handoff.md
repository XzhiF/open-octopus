# Iteration Handoff — task-authoring-v3 Round 1

## Loop Position
- Round: 1 / 5
- Score: pending verification-report
- Next feature-slug: task-authoring-v3-r2 (if needed)
- Branch: feat/task-domain-redesign

## Protected Architecture Decisions
<!-- gap-fix 迭代不得违背 -->

| # | Decision | Conclusion | Source |
|---|---------|-----------|--------|
| A1 | Skill 组加载机制 | per-task plugin 目录（junction→symlink→copy），SDK 原生加载 | ADR-0010 |
| A2 | 产物收集 | 任务家目录 `~/.octopus/tasks/{id}/`，登记不搬迁（artifacts.json 索引） | ADR-0011 |
| A3 | 创建时锁定 | skill_groups/task_type 创建后 PUT→409，merge-preserve 未提交字段 | ADR-0012 |
| A4 | 前端刷新通道 | 纯 SSE（taskpool 流 task_artifacts_update / assist_run_update），**禁止轮询** | spec D19 |
| A5 | 参数兼容 | 既有函数签名仅尾部追加可选参数（SW-BP15），不重排 | spec SW-BP15 |
| A6 | 创建顺序 | 会话优先（先 session 后 task，source_chat_session_id 绑定） | spec D15 |
| A7 | ready 门禁 | v3 任务 goal_confirmed ∧ ac⊆ac_confirmed 才 200，否则 409+missing | spec D18 |

## Confirmed Interfaces (Do NOT Change)
<!-- Round 1 验证通过的接口 — gap-fix 不得破坏 -->

| Interface | Location | Verified In |
|-----------|----------|-------------|
| GET /api/skill-groups（default 空标记组在前） | server/src/routes/skill-groups.ts | R1 E2E US2/US14 |
| POST /api/tasks（task_type+skill_groups+preset → home+materialize） | server/src/routes/tasks.ts + tasks-service.ts | R1 E2E US1/US2 |
| POST /api/tasks/:id/spec-field（source flag + 9 shared fields + goal_confirmed/ac_confirmed） | server/src/routes/tasks.ts | R1 server tests 15/15 + E2E US4-US6 |
| POST /api/tasks/:id/ready（D18 gate + $vars.task_artifacts_dir 注入） | tasks-service.ts readyTask | R1 E2E US6/US12 |
| GET /api/tasks/:id/artifacts + /artifacts/content（白名单 403/404） | routes/tasks.ts + task-home-service.ts | R1 E2E US7 |
| POST/GET /api/tasks/:id/assist-workflows（模板白名单 + run 查询 + parse 兜底） | routes/tasks.ts + assist-workflow-service.ts | R1 E2E US9-US11 |
| SSE taskpool: spec_field_update / task_artifacts_update / assist_run_update | shared/types/task.ts 常量 | R1 server+E2E D19 |
| CloneRuntime.chat 9 位参数序（尾追加 taskHomePath, taskContextContent） | clone-runtime.ts | R1 clone-spec-notice 7/7 |
| @@task_context system-prompt 注入（产物目录绝对路径 + 锁定上下文） | routes/clone/index.ts | R1 D6 tests 3/3 |
| 前端组件集 template-picker/goal-ac-card/authoring-workspace/output-viewer/两 dialog/adoption panel | web-app/components/tasks/authoring/ | R1 E2E 14/14 |
| e2e helpers: task-domain-helpers.ts（v3ScreenshotPath、SSE subscribers、artifact/assist 助手） | web-app/e2e/helpers/ | R1 E2E |

## Gap Targets for Next Iteration
<!-- 待 verification-report section 6 填充 -->

（pending）

## BLOCKED Gaps (Excluded from Next Iteration)
- （暂无）

## Carryover List
<!-- 待 verification-report 确定 SKIP/PARTIAL ACs -->

已知 manual-only 项（spec accepted exclusions，不算 gap）：
- US8 对话改产物（LLM 行为）
- US9 agent 建议气泡（LLM 行为）
- real-LLM MoA 完整运行
- @@spec_updated/@@task_context 对话内投递的人工观察

## Prerequisite Status
- Dev server running: yes（3001 新 dist 含 review fixes；3000 Next.js dev）
- E2E actually executed: yes（matt-e2e-tester，14/14，retries=0）
- E2E execution evidence: .scratch/task-authoring-v3/e2e-screenshots/（19 PNG，2026-08-18 22:01）

## Pipeline Completeness
- All 5 phases produced artifacts: yes
- Missing phases: none

## Key File Paths
- Root brief: .scratch/task-authoring-v3/brief.md
- Spec: .scratch/task-authoring-v3/spec.md
- Loop state: .scratch/task-authoring-v3/loop-state.json
- Pipeline report: .scratch/task-authoring-v3/pipeline-report.md
- Verification report: .scratch/task-authoring-v3/verification-report.md
- Carryover: .scratch/task-authoring-v3/carryover.md
- 基线失败清单: .scratch/task-authoring-v3/known-baseline-failures.txt

## What Worked (Do Not Re-implement)
- shared schemas（taskSpec 扩展 + validateSpecFieldValue + artifact/assist schemas）：23 tests，契约单源
- TaskHomeService（纯函数 homePath + idempotent createHome + 损坏索引兜底 + junction-safe reap）：19 tests
- PluginMaterializer（junction→symlink→copy + default 空标记）：14 tests
- spec-field source/notice + ready gate + lock merge-preserve：server 15+ tests + E2E
- 三路径 $vars.task_artifacts_dir 注入（含 engine task-dispatch input_mapping 修复）：7 tests
- assist workflow 模板 ×3 + service（run_id==execution_id、parse 兜底、workspace reap 降级）：16+12 tests
- 前端两阶段流 + 产出查看器全套组件：44 unit + 14 E2E

## 同分支已知跟进项（非本特性 gap）
- task-domain-simple/composite sibling E2E specs 对 v3 TemplatePicker 流过时（correct-by-design）
- 31 个环境漂移基线失败测试
