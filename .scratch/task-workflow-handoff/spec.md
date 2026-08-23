# Spec: task-workflow-handoff — ADR-0013 实施

> 把 ADR-0008 "spec (WHAT) + workflow_ref (HOW)" 模型里**无人认领的 HOW 供给环节**闭环：authoring agent 在入队前完成 HOW 选择并绑定 `workflow_ref`，经 spec-field 通道（免费获得 SSE 实时更新），SpecPanel 可见可查；自建 flow 落 task home 并在分发时拷进执行 ws；gate 从"非空"升级为"可解析预检"。
>
> 根 brief：`.scratch/task-workflow-handoff/brief.md`
> 架构决策：`docs/adr/0013-workflow-ref-authoring-provisioning.md`

## User Stories

### US1 — 作者在 authoring 对话接近完成时，agent 自动开始 HOW-handoff
agent 枚举已安装 flow 并给出推荐 + 理由，等待用户确认或指定替代；用户可拒绝全部推荐 → agent 自建。
- **AC1**: agent 枚举已安装 flow + 推荐 + 用户确认（**手动清单** — 真实 authoring 会话观察）
- **AC2**: 用户拒绝全部 → agent 自建（**手动清单**）

### US2 — 用户复用已选 flow
确认后 `workflow_ref` 经 spec-field 绑定成功，SpecPanel 实时显示（SSE）。
- **AC3**: 集成测试（spec-field → SSE 断言）+ 组件测试

### US3 — 用户/agent 自建 flow
flow 写入 `{home}/workflows/`；绑定前 validate 通过；模拟器必跑；含真实外部副作用 → agent 显式声明 + 理由记入 `task_spec.decisions`。
- **AC4**: 集成测试（task-home resolver 命中）
- **AC5**: 集成测试（task-home resolver 命中）
- **AC6**: 手动清单（skill 指令 + decisions 字段落库）

### US4 — 绑定无效 ref 被拒
绑定不可解析 ref → 400 `workflow not resolvable`，task 保持 draft。
- **AC7**: 集成测试（三项源：内置/ task-home 命中 / 其余拒绝）

### US5 — 查看绑定内容
SpecPanel 打开查看 → 返回绑定的 flow 内容 + 来源。
- **AC8**: 组件测试 + 集成测试（/workflow-ref 端点）

### US6 — 入队 gate 强化
simple v3 任务 workflow_ref 不可解析 → 409，missing 含 workflow_ref，task 保持 draft；可解析 → 放行。
- **AC9**: 集成测试（ready-gate 升级 + 既有 gates 套件回归）

### US7 — 分发可执行
simple v3 任务绑定 task-home flow 入队后，执行 ws `workflows/` 出现该 YAML，create(workflow_ref) 解析成功。
- **AC10**: 集成测试（temp-base 注入，沿用 tasks-v3-dispatch AC1-seam 模式）

## Seam Contracts（归一化接口）

### workflow-ref resolver（共享 seam，bind/ready/view 三处复用）
文件：`packages/server/src/services/tasks/workflow-ref-resolver.ts`

```ts
type WorkflowRefSource = "builtin" | "task-home"

interface WorkflowRefResolution {
  ref: string
  source: WorkflowRefSource
  content: string
}

interface WorkflowResolverDeps {
  builtIn: BuiltInWorkflowService | null   // 注入 stub → 测试可脱离 ResourceManager
  taskHome: TaskHomeService                // 注入 temp baseDir → 测试可脱离真实 homedir
  taskId: string
}

function resolveWorkflowRef(ref: string, deps: WorkflowResolverDeps): WorkflowRefResolution | null
function isWorkflowRefResolvable(ref: string, deps: WorkflowResolverDeps): boolean
```

**解析集（resolution set）**：
- ① 已安装内置工作流（`BuiltInWorkflowService.get(ref)` 非 null）— ref 形态 `group/name` 或 bare `name`
- ② task home `{home}/workflows/{ref}` — 裸文件名（`.yaml` / `.yml` 自动扩展）
- ③ **排除**：全局 `~/.octopus/workflows/`（ADR-0013 显式否决）

**解析顺序**：builtin 先（显式安装胜）→ task-home。首命中即返回。

### TaskHomeService（workflows/ 扩展）
- `workflowsDir(taskId): string` — 纯路径推导
- `readWorkflowFile(taskId, ref): string | null` — 命中返回内容，miss / 路径越界返回 null
- `listWorkflowFiles(taskId): string[]` — 列 YAML 文件名（`*.yaml` ∪ `*.yml`）
- `createHome` 额外建 `{home}/workflows/` 空目录（与 `skills/`、`artifacts/` 并列）

### materializeTaskSpecToConfig（扩展签名）
```ts
function materializeTaskSpecToConfig(
  task_spec, project_ids, org, workflow_ref?, skills?, resources?,
  taskArtifactsDir?,      // 已有
  taskWorkflowsDir?,      // 新增（ADR-0013）
): WorkflowConfig
```
注入 `$vars.task_workflows_dir` 到 `workflow_chain[0].input_values`（simple + composite 两路）。v2 任务（无 `task_type`）不注入。

### WorkflowExecutor.execute（dispatch copy）
`createFromSpec` 之后、`execution.create` 之前，从 `firstStep.input_values.task_workflows_dir` 读源路径，把 `{src}/*.yaml` 拷进 `{wsPath}/workflows/`。非致命：拷贝失败 log + 继续，引擎 resolver 会在 miss 时清晰报 "Workflow not found"。

### spec-field `workflow_ref` 绑定（fail-fast）
`updateSpecField(field="workflow_ref", value)`：
1. 共享 validator 拒 empty / non-string → 400
2. resolver 预检；不可解析 → 400 `workflow not resolvable`
3. 命中 → 写入 `tasks.workflow_ref` 顶层列（**不**进 `task_spec`，与 `skills`/`projects` 同处理模式）
4. bump version + emit `spec_field_update` SSE

### GET /:id/workflow-ref（view endpoint）
| 状态 | 响应 |
|------|------|
| task 不存在 | 404 |
| 未绑定 (workflow_ref 空) | 200 `{ref, content, source} = null` |
| 绑定但不可解析 | 400 |
| 绑定且可解析 | 200 `{ref, content, source}` |

### readyTask gate（S3 升级）
v3 简单任务（`subunits.length < 2`）：
- 原：`workflow_ref` 非空
- 现：`workflow_ref` **可解析**（同 resolver）
- composite（`subunits.length >= 2`）不变（走内置 composition-task，无需 task 级 ref）

### ServerSpecField / TaskSpecField（共享 enum）
`TaskSpecFieldSchema` 新增 `"workflow_ref"` 成员；`validateSpecFieldValue` 增加 `workflow_ref` 分支（non-empty string）。`ServerSpecField = TaskSpecField | "goal_confirmed" | "ac_confirmed"` 自动继承。

### SpecPanel UI（web-app）
- 读 `task.workflow_ref`（顶层列，非 `task_spec` 字段）
- SSE `spec_field_update(workflow_ref)` 实时更新
- 绑定后显示 ref + [查看] 按钮 → 调 GET /:id/workflow-ref 渲染 content + source
- 未绑定显示降级提示

### task-author SKILL.md（v2.1.0）
新增 §HOW-handoff：
- 步骤 1：`GET /api/workflows/built-in` 枚举
- 步骤 2：推荐 + 用户确认（禁止擅自绑定）
- 步骤 3a：接受 → 绑定 builtin ref
- 步骤 3b：拒绝 → 自建（validate + 模拟器硬门槛 + decisions 声明副作用）→ 写入 `{home}/workflows/*.yaml` → 绑定 filename ref
- 步骤 4：`GET /:id/workflow-ref` 检查绑定

## Out of Scope（本轮不碰）
- **S4** composite 的 subunit workflow_ref 校验（brief D1 砍）
- 项目仓库内工作流供给机制（无施工路径，ADR-0013 Risks §R3）
- 浏览器 E2E（brief D7 否决）
- 自建 flow 真实执行预验证（brief D6：validate + 模拟器已够；真实执行 = 入队后第一次跑）
- 停用 `copyBuiltInWorkflows` 全局种子（独立清理，ADR-0013 §Consequences）
- `update_task_spec_field` native SDK 工具签名（仅 REST 端点；agent 经 Bash curl 调）

## Verification Strategy

### Unit Tests（resolver / validator）
- `workflow-ref-resolver.test.ts`：11 cases（empty / builtin / task-home / precedence / path-escape / boolean mirror / null builtIn）
- `task-domain-schema.test.ts`：`EXPECTED_SPEC_FIELDS` 含 `workflow_ref` + `decisions`

### Integration Tests（server / real DB / real FS）
- `tasks-v3-gates.test.ts`：AC7 bind resolvable → 200 + SSE + column；AC7 bind unresolvable → 400；AC7 empty → 400；AC9 S3 gate upgrade（non-empty 不可解析 → 409 missing）；AC8 view endpoint × 4 (unbound/bound/stale/missing)
- `tasks-v3-dispatch.test.ts`：AC1-seam `task_workflows_dir` 注入；AC10 dispatch-copy helper（YAML filter / missing / empty）

### Component Tests（web-app / no-browser）
- `task-modal-spec-panel.test.tsx`：unbound hint / bound ref + 查看 / SSE 实时更新

### Contract Tests
- `TaskSpecFieldSchema` + `validateSpecFieldValue` 含 `workflow_ref`（shared schema tests 覆盖）

### Manual Checklist（S1 / S3 手动项）
- 一次真实 authoring 会话：agent 自动 HOW-handoff → 推荐 → 确认 → 绑定 → SpecPanel 可见可查 → 入队放行
- 拒绝推荐 → 自建：validate 失败一次 → 修复 → 通过 → 绑定
- 用户不看绑定直接入队 → 门禁照常执行

## Test Fixtures 约定
- task-id prefix `e2e-td-*`
- 测试用 stub `BuiltInWorkflowService`：`ref.includes("e2e-td")` 即返回 `{ ref, content: "stub-builtin" }`
- TaskHomeService 注入 temp `baseDir`（never touch `~/.octopus`）
- 所有测试独立，并行安全

## References
- ADR-0013 `docs/adr/0013-workflow-ref-authoring-provisioning.md`
- Brief `.scratch/task-workflow-handoff/brief.md`
- Analog task_artifacts_dir injection (ticket 08 / ADR-0011)
