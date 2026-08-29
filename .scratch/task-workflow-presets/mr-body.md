## task-workflow-presets — 任务工作流绑定体系(含 task-board 5 项修复)

任务能按技能组看到/选中正确工作流并带齐输入预设:preset catalog(task-author clone 目录)给 agent 推荐与绑定提供依据;`${goal}`/`${ac}` 模板映射 input_values;入队 gate 校验必填输入,杜绝"白执行";SpecPanel/v3 工作区呈现 目标&验收 → 工作流 → 产物 三级结构。

> 本分支基于 **bugfix-task-board**(含 codebase 命名/项目回显/技能范围/产物扫描为底/查看器滚动 5 项修复),按用户要求一起输出。

### E2E Verification (31/31 PASS)
| AC | Condition | Status |
|----|-----------|--------|
| 1 | WorkflowBox 渲染(v3+v2)+ 绑定弹窗搜索/preset 预填 | PASS |
| 2 | `${goal}` 物化进调度配置 input_values | PASS |
| 3 | 缺必填 input→409 `input:<name>`;未知占位符→409 非 500 | PASS |
| 4 | 复合任务跳过 task 级输入校验 | PASS |
| 5 | 种子 catalog:general 兜底 + skills_group 过滤 | PASS |
| 6 | PUT 原子持久化 workflow_ref+input_values;UI 反映已绑定 | PASS |

### Decision Trail
- wayfinder 9 决策票 → [`/.scratch/task-workflow-presets/`]  → brief/spec/issues/pipeline-report
- 关联 ADR-0013(workflow_ref 归属与供给)

### Changed Files
`git diff --stat origin/main...HEAD` → 见 PR files 页(shared schemas / server preset-gate / web-app WorkflowBox / skills)

<!-- MANUAL-START -->
<!-- MANUAL-END -->
