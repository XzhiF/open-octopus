## task-workflow-handoff — HOW 供给闭环 (ADR-0013)

把 ADR-0008 "spec (WHAT) + workflow_ref (HOW)" 模型里无人认领的 HOW 供给环节闭环：authoring agent 入队前完成 HOW 选择并绑定 `workflow_ref`（spec-field 通道 → SSE 实时更新 → SpecPanel 可见可查）；自建 flow 落 task home 并在分发时拷进执行 ws；ready-gate 从"非空"升级为"可解析预检"（fail-fast，解析集 = 已安装内置 ∨ task-home，全局 `~/.octopus/workflows/` 排除）。

### Development Iterations
| # | Feature | Date | Tickets |
|---|---------|------|---------|
| 43 | task-domain-redesign | 08-18 | done（v2 一等 tasks 域） |
| 44 | task-authoring-v3 | 08-18 | done（两阶段 authoring 流） |
| 45 | task-authoring-v3-r2 | 08-18 | done（gap-fix） |
| 46 | **task-workflow-handoff** | 08-23 | **8/8**（ADR-0013） |

### 本轮验证（task-workflow-handoff）
| 项 | 结果 |
|----|------|
| Code Review | Standards 0 hard · Spec 0 缺失/0 creep/0 错；5×🔵 备注记档 |
| Build | 全仓 `pnpm build` exit 0（shared 类型变更 → server DTS 编译绿） |
| Tests | 255 pass / 14 文件（AC1-10 全覆盖） |
| E2E | **SKIP per D7**（grill 决策：无浏览器 E2E；S5 组件测试 + S1 手动清单） |

### Changed Files（分支累积 vs main，包级摘要）
```
packages/shared/      +tsv types (TaskSpecFieldSchema + workflow_ref)      ~18
packages/server/      resolver + TaskHome workflows/ + spec-field bind +
                      /:id/workflow-ref + tasks_workflows_dir 拷贝 + S3 gate   ~450
packages/web-app/     SpecPanel WorkflowRefDisplay + view endpoint          ~150
packages/core-pack/   skill task-author HOW-handoff 步骤                     ~110
docs/adr/0013         workflow-ref-authoring-provisioning.md
```
**本 feature 精确 diff**（`ee60fc5e...HEAD`）：30 files / +1763 -31。分支相对 main 累积 322 files / +47796 -935（含 43-45 期 v2 + authoring 历史）。

<details><summary>本 feature 完整文件清单（ee60fc5e...HEAD）</summary>

- packages/shared/src/types/task.ts
- packages/server/src/services/tasks/{workflow-ref-resolver,tasks-service,task-home-service}.ts + 2 test files
- packages/server/src/routes/tasks.ts
- packages/server/src/services/scheduler/{scheduler-service,executors/workflow-executor}.ts
- packages/server/src/index.ts + 4 test files
- packages/web-app/components/tasks/spec-panel.tsx + test
- packages/core-pack/skills/task-author/SKILL.md + .claude/skills/task-author/SKILL.md
- docs/adr/0013 · .scratch/task-workflow-handoff/*

</details>

### Remaining
- R1: `copyBuiltInWorkflows` 全局种子与解析集语义冲突 → 独立清理项（workspace-scaffold 停用全局种子）
- 项目内工作流供给（S4 方向）无施工路径 → 后续加进统一 resolver

<!-- MANUAL-START -->
<!-- MANUAL-END -->