# Spec: Task Authoring v3 — 两阶段任务编写 + 产出查看器

## Problem Statement

当前 TaskModal（v2）是固定字段的编写界面：没有方法论/Skill 组的概念，agent 只能靠共享 skills；ResourceManager 安装的方法论套件（open-spec、mattpocock-skills 等）无法被 task-author 会话以原生方式加载；产物（spec.md、proposal.md）散落无处统一查看；重型编写辅助（专家团评审需求）无法在编写期运行。用户在原型讨论（变体 A→L）中逐步确认了目标交互模型。

## Solution

两阶段编写流：**模板页**选定任务类型 + Skill 组（多选，创建后锁定）+ 编写语境（org/projects），**编写页**左 chat 右产出查看器。Skill 组经 per-task plugin 目录获得 Claude Agent SDK 原生渐进式披露；产物按任务家目录约定收集（第三方产物登记不搬迁）；goal/ac 由 agent 绑定时浮现、用户可直编（@@spec_updated 反向通知）；编写期可运行内置辅助工作流（MoA 专家咨询等），结构化产出勾选采纳进 spec。

## Projects Involved

- [x] packages/server（TaskHomeService / PluginMaterializer / AssistWorkflowService / routes / getPlugins 扩展）
- [x] packages/web-app（TaskModal 两阶段重构 + 产出查看器）
- [x] packages/core-pack（3 个内置辅助工作流 YAML）
- [x] packages/shared（类型扩展）
- [ ] packages/engine（不改动 — 复用 swarm executor `mode: moa`）

## Feature Scope

**Do:**
- 两阶段流 UI（模板页 + 编写页，TaskModal 内部重构，复用已有全屏能力）
- Skill 组多选 + 创建后锁定；Skill 组数据源 = ResourceManager registry `group`（type=skill 过滤）+ 内置「默认通用」组
- Per-task plugin 目录物化（symlink/junction，失败降级 copy）
- 预设瘦身：coding 任务仅 org + projects（执行技能归 workflow.requires，不在预设）
- goal/ac 浮现式 + 双通道编辑（agent spec-field 绑定 / 用户直编 → @@spec_updated）
- 任务家目录约定 + artifacts.json 索引 + 产物完整内容查看
- 辅助工作流：3 个内置固定模板、agent 建议 + 用户执行、过程日志查看、结构化产出勾选采纳
- dispatch 时向 workflow 注入 `$vars.task_artifacts_dir`

**Don't:**
- 会话中途切换/追加 Skill 组（创建时锁定，ADR-0012）
- 产物审批操作（无批阅/驳回按钮 — 有意见走对话）
- 自定义辅助工作流模板（本 feature 仅内置固定 3 个）
- 执行期产物写回项目仓库 `.scratch/`（ADR-0011 已决策为 dispatch 后自然发生，物化拷贝留作后续 feature）
- DB schema 变更（task_spec JSON 承载新字段，家目录由 id 推出）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | Skill 组加载机制 | per-task plugin 目录（`~/.octopus/tasks/{id}/skills/` symlink 所选组 skills，getPlugins 追加第三目录） | SDK 原生渐进式披露 + Skill 工具 + /slash + 关联 skills 可发现；避免全文注入 token 膨胀（ADR-0010） |
| D2 | Skill 组选择时机 | 创建时选定（可多选），创建后锁定；换组=新建任务 | 消除 plugin/session 中途变更；心智模型简单（ADR-0012） |
| D3 | Skill 组数据源 | registry `group` 字段聚合（type=skill）+ 内置「默认通用」组 | registry 已有 group 概念（installed/{type}/{group}/{name}/），零新存储 |
| D4 | Skill 组选择存储 | task_spec JSON `skill_groups: string[]` + `task_type`；**不写** authoring_resources | authoring_resources 会触发 augmenter 全文注入，与 plugin 目录重复 |
| D5 | 产物收集 | 任务家目录 `~/.octopus/tasks/{id}/artifacts/` + artifacts.json 索引；登记不搬迁 | 不强制第三方 skill 改道；索引是单一事实来源；零 DB 字段（ADR-0011） |
| D6 | 产物目录告知 agent | system prompt append 一行绝对路径（随 task context 注入） | author agent cwd 不变（built-in/task-author/），Write 用绝对路径 |
| D7 | goal/ac 编辑权 | 双通道：agent spec-field 绑定 + 用户直编（POST spec-field → @@spec_updated 通知 agent） | 机制已存在（S1 specUpdateNotice），零新机制 |
| D8 | goal/ac 浮现 | agent 绑定后 SSE spec_field_update → UI 即时浮现；未绑定显示 ghost 占位 | 不预渲染空框；出现时机与对话同步 |
| D9 | 辅助工作流触发 | agent 建议权 + 用户执行权；内置 3 模板（moa-requirements-review / spec-review-swarm / clarify-debate） | 重型流程显式化；引擎已有 swarm moa 子模式 |
| D10 | MoA 产出采纳 | 三段式结构（ac 候选 / 方案建议 / 风险提示），勾选采纳；ac→spec-field(ac)；建议→决策备忘（task_spec.decisions） | 专家意见服务决策而非强制 |
| D11 | 右侧面板形态 | 产出查看器：产物看完整内容、工作流看过程日志；无审批；无 Skill 组卡片 | 用户核心原则；Skill 组信息已在 chat 上方命令栏 |
| D12 | UI 载体 | TaskModal 内部重构（复用已有全屏切换），不加新路由 | 入口不变，风险最小 |
| D13 | 预设内容 | coding：仅 org + projects；generic：名称+描述（对话澄清） | skills 归 workflow.requires；workflow_ref 由 agent 后续推荐 |
| D14 | dispatch 交接 | server `scheduler-service.ts` 物化时注入 `$vars.task_artifacts_dir`（simple 路径 + composite `buildCompositeInputValues`），composition 工作流经 input_mapping 透传给子单元 | 物化发生在 server 而非 engine task-dispatch（后者仅 composite fan-out 执行）；三条路径都要断言 |
| D15 | 创建顺序与会话绑定（SW-BP1） | UI 先 `POST /api/clones/task-author/sessions` 建会话，再 `POST /api/tasks {source_chat_session_id, task_type, skill_groups[], preset}`（SG3 回写 sessions.scope_id） | autosave/spec-field/SSE 全部经 source_chat_session_id 解析任务；无绑定则首轮 autosave 产生孪生 draft |
| D16 | 辅助工作流执行宿主（SW-BP6，用户确认） | 每个 assist run 建**临时 workspace**：workspaces 表 `source='task-assist'`，workspacePath=任务家目录；ExecutionService 完全复用；task_id+template 记入 executions.pipeline_config | draft 任务无 workspace；复用执行架构（日志/恢复/harness）优于绕过 engine 另起路径 |
| D17 | 「默认通用」组语义（SW-BP11，用户确认） | **空标记，不物化**：选它 = 只用内置 spec-field 流程 + 共享 skills（plugin #1 已暴露）；物化会造成 SDK 重复发现 | 共享 skills 无需二次暴露 |
| D18 | 确认状态持久化 + ready 门禁（SW-BP5） | task_spec 增 `goal_confirmed?: boolean` + `ac_confirmed?: string[]`（走 spec-field）；`readyTask` 校验 goal 非空 ∧ ac≥1 ∧ 全部已确认，否则 409 + 缺失项清单 | UI 临时态会随弹窗关闭丢失；入队必须有服务端门禁 |
| D19 | 产出/运行刷新通道（SW-BP8） | 现有 taskpool SSE 流新增事件 `task_artifacts_update` / `assist_run_update`（不引入轮询） | 与 spec_field_update 同一机制，前端已有 collector |

## User Stories

1. 作为用户，我创建任务时选择任务类型 + Skill 组（可多选）+ org/项目，一键进入编写，以便 agent 从一开始就有完整语境。
2. 作为用户，我多选 Skill 组整合使用，以便尝试自己的方法论组合。
3. 作为用户，我在模板页的选择创建后锁定（🔒），以便会话内零歧义；换组通过新建任务，旧草稿保留。
4. 作为用户，对话中 agent 澄清出 goal/ac 时右侧自动浮现，以便不用手工誊写。
5. 作为用户，我直接在右侧编辑 goal/ac，agent 下一轮感知变更（@@spec_updated），以便快速接管。
6. 作为用户，我逐条确认 goal/ac（状态持久化到 task_spec），未全部确认时服务端拒绝入队（409 + 缺失项），以便任务不带未确认意图入队，且确认态不随弹窗关闭丢失。
7. 作为用户，我点击产物查看完整内容（弹窗），以便审阅细节。
8. 作为用户，我对产物有意见时直接在对话里说，agent 修改并更新产物，以便不需要额外审批 UI。
9. 作为用户，agent 建议运行辅助工作流时由我决定执行或跳过，以便重型流程在我的控制下。
10. 作为用户，我查看辅助工作流的过程日志（时间戳 + 各专家步骤），以便知道中间发生了什么。
11. 作为用户，我把 MoA 产出的 ac 候选/方案建议勾选采纳进 spec，以便专家意见服务我的决策。
12. 作为用户，入队时系统把产物目录注入执行上下文（$vars.task_artifacts_dir），以便执行工作流能读到编写期产物。
13. 作为用户，删除 draft 时任务家目录被 reap，以便无孤儿目录。
14. 作为用户，coding 任务预设只有 org + projects，以便不被无关选项干扰。

## Implementation Decisions

### Modules involved

| Module | New/Modified | Responsibility |
|--------|-------------|----------------|
| `server/src/services/tasks/task-home-service.ts` | NEW | 家目录创建/删除/reap；artifacts.json 读写与 schema 校验 |
| `server/src/services/tasks/plugin-materializer.ts` | NEW | 所选 Skill 组 skills → `{home}/skills/` symlink（win: junction，失败降级 copy） |
| `server/src/services/tasks/assist-workflow-service.ts` | NEW | 触发 core-pack 内置辅助工作流执行；run 状态/日志/结构化产出查询。执行宿主见 D16：workspaces 表 `source` 枚举增 `'task-assist'`，临时 workspace 行随 run 创建、终态后 reap |
| `server/src/services/agent/clone-runtime.ts` | MODIFIED | `getPlugins(taskHomePath?)` — task-author 会话追加第三 plugin 目录。注意：新可选参数需穿透 `chat()`/`sendWithProvider()` 签名（代码中明确警告过参数顺序兼容性 — 追加在尾部，不重排既有参数，SW-BP15） |
| `server/src/routes/tasks.ts` | MODIFIED | POST / 扩展（**source_chat_session_id** + skill_groups/task_type → 物化）；新增 artifacts / assist-workflows 端点；spec-field 增 `source` 判别；ready 增确认门禁；PUT 拒绝改 skill_groups/task_type（SW-BP9）；DELETE 联动家目录 reap |
| `server/src/routes/skill-groups.ts` | NEW | GET /api/skill-groups（registry group 聚合；description 读 SKILL.md frontmatter，best-effort 可空，SW-BP13） |
| `server/src/services/scheduler/scheduler-service.ts` | MODIFIED | `materializeTaskSpecToConfig` 注入 `$vars.task_artifacts_dir`（simple 路径）；`buildCompositeInputValues` 同步注入（composite 路径）（SW-BP7） |
| `server/src/services/agent/clone/...`（task-author send path） | MODIFIED | system prompt append 产物目录一行；Skill 组锁定上下文 |
| `core-pack/workflows/` | NEW ×3 | moa-requirements-review.yaml / spec-review-swarm.yaml / clarify-debate.yaml（聚合器输出 JSON + 解析失败兜底 `output_raw`+`output_parse_error`，SW-BP10） |
| `shared/src/types/task.ts` | MODIFIED | AssistWorkflowRun / ArtifactIndexEntry 类型；TaskSpecFieldSchema 增 `"decisions"`；`validateSpecFieldValue` 增 decisions 分支（SW-BP3） |
| `shared/src/types/scheduler-job.ts` | MODIFIED | **taskSpecSchema 在此文件**（非 task.ts）：增 `task_type`（enum optional）/ `skill_groups`（string[] default []）/ `decisions`（string[] default []）/ `goal_confirmed`（bool optional）/ `ac_confirmed`（string[] optional），避免 z.object 剥除未知键（SW-BP2） |
| `web-app/components/tasks/task-modal.tsx` | MODIFIED | 两阶段流骨架（TemplatePicker → AuthoringWorkspace） |
| `web-app/components/tasks/authoring/*` | NEW | TemplatePicker / OutputViewer / ArtifactViewerDialog / WorkflowLogDialog / MoaAdoptionPanel |
| `engine/src/executors/task-dispatch.ts` | MODIFIED | 物化时注入 `$vars.task_artifacts_dir` |

### Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| tasks | **不改列** | task_spec JSON 新增：`task_type: "coding"|"generic"`、`skill_groups: string[]`、`decisions?: string[]`（决策备忘）、`goal_confirmed?: boolean`、`ac_confirmed?: string[]`（D18）。全部经扩展后的 taskSpecSchema（shared/scheduler-job.ts）校验，PUT 往返不丢失 |
| workspaces | source 枚举增值 | `'task-assist'` — 辅助工作流临时宿主（D16），workspacePath=任务家目录 |
| executions | 复用 | 辅助工作流 run = 一次 execution；`pipeline_config` 记 `{task_id, template}`（表名为 executions，**无** metadata 列，SW-BP6） |
| 文件系统 | NEW 约定 | `~/.octopus/tasks/{task-id}/{skills/,artifacts/,artifacts/artifacts.json}` |

**artifacts.json schema**：
```json
[{ "path": "spec.md", "by": "open-spec", "title": "...", "external": false, "updated_at": "..." }]
```
`external: true` 时 path 为绝对路径（原生位置）；`false` 时相对 artifacts/ 目录。

### API Contracts

| Method | Path | Params | Response | Notes |
|--------|------|--------|----------|-------|
| GET | /api/skill-groups | ?org= | `{ groups: [{group, displayName, skills:[{name,description?}]}] }` | registry type=skill 按 group 聚合 + 内置 default 组（空标记，D17）；description 读 frontmatter best-effort |
| POST | /api/clones/task-author/sessions | 已有 | `{ sessionId }` | **创建顺序第一步**（D15）：先建会话 |
| POST | /api/tasks | body 扩展 `source_chat_session_id`, `task_type`, `skill_groups[]`, `preset:{org,projects}` | Task（含 version） | 创建顺序第二步（D15）：建 draft + SG3 回写 scope_id + 建家目录 + 物化 plugin 目录。断言：首轮后仅一个 draft ∧ 双向绑定 |
| GET | /api/tasks/:id/artifacts | — | `ArtifactIndexEntry[]` | 读 artifacts.json；不存在→[]；**损坏→[] + log**（SW-BP12） |
| GET | /api/tasks/:id/artifacts/content | ?path= | `{ path, content }` | 白名单校验：家目录内相对路径 或 索引中已登记的 external 绝对路径；拒绝越权 |
| POST | /api/tasks/:id/spec-field | body 增 `source?: "user"|"agent"`（默认 agent） | `{version}` | `source==="user"` 时 setSpecNotice（@@spec_updated 下轮送达）；agent 源不触发（SW-BP4）。field 枚举含新增 `"decisions"` |
| POST | /api/tasks/:id/assist-workflows | `{ template, input? }` | `{ run_id, execution_id, workspace_id }` | 仅允许 3 个内置 template id；建临时 workspace（D16） |
| GET | /api/tasks/:id/assist-workflows/:runId | — | `{ status, logs: [{t,icon,text}], output?: {ac_candidates[], suggestions[], risks[]}, output_raw?, output_parse_error? }` | logs 来自 execution 节点日志；聚合 JSON 解析失败 → output_raw + output_parse_error=true（SW-BP10） |
| PUT | /api/tasks/:id | 已有 | — | 扩展：拒绝变更 `skill_groups/task_type`（创建后锁定，SW-BP9）→ 409 |
| POST | /api/tasks/:id/ready | 已有 | — | 扩展门禁（D18）：goal 非空 ∧ ac≥1 ∧ goal_confirmed ∧ ac 全部在 ac_confirmed 中，否则 409 + 缺失项清单 |
| DELETE | /api/tasks/:id | 已有 | — | 扩展：draft 删除时 reap 家目录（**不跟随 junction**，SW-BP14）；非 draft 保留家目录至 hard-delete |
| SSE | /api/tasks/events | 已有流 | 新增事件类型 `task_artifacts_update` / `assist_run_update`（D19） | 与 spec_field_update 同流 |

### 辅助工作流 YAML 形态（core-pack）

```yaml
# moa-requirements-review.yaml（示意）
name: moa-requirements-review
nodes:
  - id: experts
    type: swarm
    mode: moa
    experts:
      - { role: 需求专家, prompt: "评审 ac 完整性与可验证性..." }
      - { role: 架构专家, prompt: "分析集成点与影响面..." }
      - { role: 安全专家, prompt: "识别安全风险..." }
    aggregator:
      prompt: "汇总为 JSON: {ac_candidates[], suggestions[], risks[]}"
```
input：task_spec（goal/ac/projects）经 `$vars` 注入。output：聚合器 JSON → AssistWorkflowService 解析为结构化产出。

### 前端结构（参照原型 Variant L）

原型主源：`packages/web-app/app/tasks/prototype/page.tsx` VariantL（`?variant=L`）。
- TemplatePicker：任务类型卡片 + Skill 组 checkbox 列表（多选提示整合模式）+ org/projects
- AuthoringWorkspace 顶栏：类型 badge + 🔒 Skill 组 badges + 语境按钮（预设弹窗仅 org+projects）
- Chat：Skill 组命令栏（所有选中组的 /命令）+ 辅助工作流按钮 + agent 建议气泡 + MoA 卡片（含采纳面板）
- OutputViewer：goal/ac 卡（浮现+直编+逐条确认）→ 产物列表（点击弹完整内容）→ 工作流运行记录（点击弹日志）→ 决策备忘 → 入队检查条
- ArtifactViewerDialog / WorkflowLogDialog：全内容/日志弹窗

## Verification Strategy

### Verification Environment

| Item | Value |
|------|-------|
| Environment | local dev: `pnpm dev`（server :3001 / web :3000） |
| API prefix | `/api/` |
| Database | SQLite: `~/.octopus/db/octopus.db` |
| 家目录 | `~/.octopus/tasks/{id}/` |
| Admin UI | `http://localhost:3000` |

### Test Users & Data

| Item | Value |
|------|-------|
| 测试 org | `E2E_TD_org`（沿用 task-domain 约定） |
| Data prefix | `E2E_TD_` |
| 测试 Skill 组 | E2E 通过 resource API 安装测试组（resource-helpers.ts） |
| Cleanup | DELETE task + 断言家目录 reap |

### AC to Verification Method Mapping

| US# | User Story 摘要 | Verification Level | Verification Method |
|-----|----------------|-------------------|---------------------|
| US1 | 模板页选择→创建→进入编写 | Browser E2E | 会话先行 → POST /api/tasks → 断言**恰好一个 draft ∧ source_chat_session_id==sessionId ∧ sessions.scope_id==task.id**（D15）+ DB task_spec + 家目录 readdir |
| US2 | Skill 组多选整合 | Integration | POST 多组 → plugin 目录含两组 skills（default 组不物化，D17） |
| US3 | 创建后锁定 | Integration + E2E | 编写页 🔒 badge 无下拉；**PUT 变更 skill_groups/task_type → 409**（SW-BP9）；taskSpecSchema PUT 往返保留三字段（SW-BP2） |
| US4 | goal/ac 浮现 | Browser E2E | chat 触发 spec-field(agent 源) → SSE spec_field_update → UI 浮现；agent 源**不触发** @@spec_updated |
| US5 | 用户直编→agent 感知 | Integration + Manual | POST spec-field(**source=user**) → DB version+1 ∧ setSpecNotice；下一轮 system prompt append 含 @@spec_updated（manual） |
| US6 | 确认后才可入队 | Integration + E2E | 确认态走 spec-field(goal_confirmed/ac_confirmed) 持久化（重开弹窗仍在）；未确认 POST ready → **409+缺失项**；全确认 → 200（D18） |
| US7 | 产物完整内容查看 | Integration + E2E | artifacts.json 写入 → GET content == 磁盘内容；越权路径 403；损坏索引 → []+log（SW-BP12）；UI 弹窗断言；SSE task_artifacts_update 刷新（D19） |
| US8 | 对话改产物 | Manual checklist | LLM 行为，manual 验证 |
| US9 | agent 建议+用户执行 | Manual + Integration | POST assist → executions 行**可按 task_id 解析** ∧ 临时 workspace(source=task-assist) 创建（D16）；非法 template 400；建议气泡 manual |
| US10 | 过程日志 | Integration | GET assist-workflows/:runId logs[] 非空 + 时间戳格式；SSE assist_run_update（D19） |
| US11 | 勾选采纳 | Integration + E2E | ac 采纳→spec-field(ac) → DB 含候选项；建议采纳→**spec-field(decisions) 200+持久化+SSE**（SW-BP3）；聚合 JSON 畸形 → output_raw+output_parse_error（SW-BP10） |
| US12 | dispatch 注入 artifacts_dir | Integration | **三条断言**：simple 主路径 / composition 工作流 / subunit 子单元，均 `$vars.task_artifacts_dir == {home}/artifacts`（D14/SW-BP7） |
| US13 | 删除 reap | Integration | DELETE draft → 家目录不存在；**reap 不跟随 junction**（Windows 单测，SW-BP14） |
| US14 | 预设仅 org+projects | Browser E2E | 预设弹窗无 skills 选项 |

### Verification Methods Detail

#### Unit Tests
- `task-home-service.test.ts`：创建/读写 artifacts.json/schema 校验/reap
- `plugin-materializer.test.ts`：symlink 成功路径、junction 降级、copy 兜底、组为空

#### Integration Tests
- `tasks-routes.test.ts` 扩展：创建带 skill_groups → DB + 家目录交叉断言；artifacts content 白名单（越权路径 403）
- `assist-workflow.test.ts`：模板白名单（非法 template 400）、run 生命周期、output 解析

#### Browser E2E
- `e2e/task-authoring-v3.spec.ts`：扩展 task-domain-helpers；覆盖 US1/3/4/6/7/14 的 UI 路径；screenshot 证据

#### Manual Checklist
- LLM 主动绑定 goal/ac 的时机与话术
- agent 建议辅助工作流的气泡出现
- 对话修改产物后索引更新

### Anti-Fake-Run Standards (R1-R8)

| # | Criterion | Description |
|---|-----------|-------------|
| R1 | Real service | 真 server :3001，不 mock routes |
| R2 | Business data | 断言 task_spec 具体字段值（skill_groups/task_type） |
| R3 | Cross-validation | API ↔ DB ↔ 文件系统三方交叉 |
| R4 | Evidence | 响应体 + SQL 查询 + readdir + screenshot |
| R5 | Side effects | 创建/删除断言家目录存在/消失 |
| R6 | Real user path | 走真实 TaskModal UI 路径 |
| R7 | Data isolation | E2E_TD_ 前缀 |
| R8 | Repeatable | 无手工前置（测试组经 API 安装） |

### Prerequisites

- [ ] `pnpm build` 全包构建通过
- [ ] dev server 运行（:3001/:3000）
- [ ] registry 可写（E2E 安装测试组）

## Risks & Notes

- R1: Windows symlink 权限 — junction（无需管理员）优先，失败降级 copy；materializer 单测覆盖
- R2: LLM 非确定性 — 自动断言只打机制层；对话内容 manual
- R3: MoA 执行时长 — E2E 用最小配置（1-2 expert + 短 prompt）；模板 YAML 支持 test 变体（沿用 `.test.yaml` 模式）
- R4: external 产物登记靠 agent 自觉 — persona 指令 + artifacts.json schema 校验 + UI 对缺失文件显示降级态
- R5: 与现有 authoring_resources 机制并存 — 所选组 skills 不进 authoring_resources（避免双重注入）；旧机制保留为兜底，需 integration 测试锁定边界
- R6: 原型是 throwaway — 实现组件从 VariantL 结构移植但代码重写，不复制原型代码
- R7: 创建顺序依赖前端纪律（先会话后任务）— integration 测试锁定「无 source_chat_session_id 的 POST → autosave 孪生 draft」回归（SW-BP1）
- R8: 聚合器 LLM 输出 JSON 不稳定 — output_raw 兜底 + UI 降级卡 + fixture 测试（SW-BP10）

## Glossary (new domain terms)

已录入 CONTEXT-MAP.md：Skill 组 / Per-task Plugin 目录 / 任务家目录 / 登记不搬迁 / 辅助工作流。

## Appendix: Core User Stories（闭环验证）

Story Walk-Through 独立走查报告：[story-walkthrough.md](./story-walkthrough.md)（4 条核心故事逐层 trace + 6 反模式审计，含 file:line 证据）。

走查发现 16 个断点（2 CRITICAL / 5 HIGH / 5 MEDIUM / 4 LOW），已按用户确认的处理原则全部合入本 spec：

| SW# | 断点 | 修复落点 |
|-----|------|---------|
| BP1 | 创建顺序/会话绑定缺失 → autosave 孪生 draft | D15 + API 契约 + US1 断言 |
| BP2 | taskSpecSchema 剥除新字段（且在 scheduler-job.ts） | 模块表更正 + schema 扩展 + US3 断言 |
| BP3 | decisions 孤儿字段无写入路径 | TaskSpecFieldSchema/validate 扩展 + US11 断言 |
| BP4 | 用户直编 @@spec_updated 链断裂 | spec-field `source` 判别 + US4/US5 断言 |
| BP5 | 确认态无持久化、ready 无门禁 | D18 + US6 断言 |
| BP6 | 辅助工作流无执行宿主（用户确认：临时 workspace） | D16 + US9 断言 |
| BP7 | artifacts_dir 注入模块错误、三路径未覆盖 | D14 更正 + US12 三断言 |
| BP8 | 产物/run 无刷新通道 | D19 SSE 事件 |
| BP9 | 锁定无服务端写保护 | PUT 409 + US3 断言 |
| BP10 | MoA JSON 解析无兜底 | output_raw + US11 断言 |
| BP11 | 「默认通用」组语义未定（用户确认：空标记） | D17 |
| BP12 | artifacts.json 损坏无降级 | 损坏→[]+log + US7 断言 |
| BP13 | ResourceEntry 无 description | best-effort frontmatter 读取 |
| BP14 | reap 跟随 junction 风险 | 不跟随 + Windows 单测 |
| BP15 | getPlugins 参数穿透签名风险 | 模块表注记（尾部追加不重排） |
| — | spec_field_update SSE / @@spec_updated / registry group / moa YAML 约束等 | 走查确认 clean，无需改动 |
