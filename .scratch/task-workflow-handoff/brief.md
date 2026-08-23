# Requirement Brief — task-workflow-handoff

## Overview
让 authoring agent 在入队前完成 HOW 选择并绑定：枚举可复用工作流 → 用户确认 → (无合适则自建 + validate + 模拟器) → 以 spec-field 通道绑定 `workflow_ref`，SpecPanel 可见可查；自建 flow 落 task home 并在分发时拷进执行 ws；gate 从"非空"升级为"可解析预检"。补上 ADR-0008 "spec + workflow_ref" 模型中无人认领的 HOW 供给环节（ADR-0013）。

## Projects Involved
- [x] packages/core-pack (skill: task-author HOW-handoff 步骤 + update_task_spec_field 签名)
- [x] packages/server (spec-field `workflow_ref` + fail-fast 预检 + `/workflow-ref` 查看端点 + dispatch 拷贝 + ready-gate 升级)
- [x] packages/web-app (SpecPanel 显示 workflow_ref + 打开查看器 + ClientSpecField)
- [x] docs/adr (0013 已写)

## Feature Scope
**Do:**
- S1: task-author skill 增加 HOW-handoff —— 入队前枚举已安装 flow → 推荐 + 用户确认 → 复用 or 自建(validate 必过 + 模拟器必跑) → 绑定 workflow_ref
- S2: task home 增加 `workflows/` 目录；dispatch 时经 `task_workflows_dir` 注入、拷进执行 ws `workflows/`（S2a）
- S3: ready-gate 的 workflow_ref 从"非空"升级为"可解析预检"（与绑定预检同一 resolver）
- S5: SpecPanel 增加 workflow_ref 显示 + 打开查看（组件测试；**不做浏览器 E2E**）
- D5: 绑定即 fail-fast 预检；解析集 = 已安装内置 ∨ task home `workflows/`；全局 `~/.octopus/workflows/` 排除

**Don't:**
- S4: composite 的 subunit workflow_ref 校验（本轮砍）
- 项目仓库内工作流供给机制（无施工路径，S4 方向）
- 浏览器 E2E（D7）
- 自建 flow 真跑预验证（D6：validate + 模拟器已够；真实执行 = 入队后第一次跑）
- 停用 `copyBuiltInWorkflows` 全局种子（独立清理，记 Risks）

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | 范围 | S1+S2(+S3)，S4 砍 | 最小闭环；composite 与 simple 断裂无关 |
| D2 | HOW 选择权 | 归 authoring agent，绑定需用户确认；SpecPanel 可见可查，gate 一部分 | 你原话："用户看都不看直接下一步，那是他的问题" |
| D3 | 自建落位 | task home `workflows/` + dispatch 拷贝进执行 ws（S2a） | 引擎零改动；复用 task_artifacts_dir 注入模式（ADR-0013 否决 B/C） |
| D4 | 绑定通道 | workflow_ref 并入 spec-field 可绑集 | SSE 实时更新机制免费到手；确认 UX 与 goal/ac 统一 |
| D5 | 预检时机 | 绑定即 fail-fast；三处共用 resolver | agent 同回合纠错；resolve 只写一遍 |
| D6 | 测试强度 | 自建 flow：validate 必过 + 模拟器必跑（硬门槛）；不真跑 | "test 好"必须有可校验操作定义 |
| D7 | 验证层 | server unit+integration 全自动；S1 手动清单；S5 组件测试；无浏览器 E2E | S1 是 skill 无码可测 |

## Data Model Changes
| Table | Operation | Details |
|-------|-----------|---------|
| tasks | 无 schema 变更 | `workflow_ref` 列已存在；仅新增写入路径（spec-field） |
| 文件系统 | 新增 | `~/.octopus/tasks/{id}/workflows/` — 自建工作流落位（ADR-0013） |
| 文件系统 | 拷贝 | dispatch 时 `{home}/workflows/*.yaml` → 执行 ws `workflows/` |

## API Contracts
| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| POST | /api/tasks/:id/spec-field | server | `{field:"workflow_ref", value:"<ref>", source}` | 200 `{version}` / 400 `workflow not resolvable` | value 非空字符串；fail-fast 预检（内置 ∨ task-home） |
| GET | /api/tasks/:id/workflow-ref | server | — | 200 `{ref, content, source:"builtin"\|"task-home"\|null}` | 未绑定/不可解析 → 400/404 语义由实现定 |
| GET | /api/workflows/built-in | server | — | 已安装工作流清单 | S1 枚举源（已存在，复用） |
| POST | /api/tasks/:id/ready | server | — | 409 missing 含 workflow_ref | simple v3：非空 → 可解析预检（升级） |
| _engine_ | dispatch 拷贝 | server | `input_values.task_workflows_dir` | ws `workflows/` 填充 | WorkflowExecutor createFromSpec 后注入 |

## Design Specs (if any)
- Figma link: none
- Fidelity: n/a

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| US1 | 作者在 authoring 对话中接近完成时，agent 自动开始 HOW-handoff | AC1: agent 枚举已安装 flow 并给出推荐 + 理由，等待用户确认或指定替代；AC2: 用户可拒绝全部推荐 → agent 自建 | **手动清单**（真实 authoring 会话观察） |
| US2 | 用户复用已选 flow | AC3: 确认后 `workflow_ref` 经 spec-field 绑定成功，SpecPanel 实时显示（SSE） | 集成测试（spec-field → SSE 断言）+ 组件测试 |
| US3 | 用户/agent 自建 flow | AC4: flow 写入 `{home}/workflows/`；绑定前 validate 通过（失败则 agent 修复再试）；AC5: 模拟器必跑（AC6: 生命周期含真实外部副作用 → agent 显式声明 + 理由记入 `task_spec.decisions`） | 集成测试（task-home resolver 命中）+ 手动清单（skill 指令） |
| US4 | 绑定无效 ref 被拒 | AC7: 绑定不可解析 ref → 400 `workflow not resolvable`，task 保持 draft | 集成测试（三项源：内置/ task-home 命中 / 其余拒绝） |
| US5 | 查看绑定内容 | AC8: SpecPanel 打开查看 → 返回绑定的 flow 内容 + 来源 | 组件测试 + 集成测试（/workflow-ref 端点） |
| US6 | 入队 gate 强化 | AC9: simple v3 任务 workflow_ref 不可解析 → 409，missing 含 workflow_ref，task 保持 draft；可解析 → 放行 | 集成测试（ready-gate 升级 + 既有 gates 套件回归） |
| US7 | 分发可执行 | AC10: simple v3 任务绑定 task-home flow 入队后，执行 ws `workflows/` 出现该 YAML，create(workflow_ref) 解析成功 | 集成测试（temp-base 注入，沿用 tasks-v3-dispatch AC1-seam 模式） | 

## Verification Strategy

### Global Config
- Environment: local (dev 模式)
- Test user: n/a
- Data prefix: 测试 task ids 沿用 `e2e-td-*` 惯例；任务 home 用 temp base 注入

### Per-layer Methods
#### Unit Tests
- spec-field `workflow_ref` 校验（空值 / 非字符串 → 400）；fail-fast resolver 三源命中矩阵
- ready-gate：simple 无 ref / 不可解析 ref → missing；composite 不受影响

#### Integration Tests
- 绑定成功 → `SPEC_FIELD_UPDATE` SSE 事件携带 `field:"workflow_ref"` + 列落库（version bump）
- `GET /:id/workflow-ref` 返回 content（builtin / task-home 两源）
- dispatch 拷贝：temp-base home 注入 → ready → WorkflowExecutor createFromSpec 后 ws workflows/ 含 YAML → create 成功
- 既有 4 个 tasks 套件回归（tasks-routes / tasks-v3-gates / tasks-v3-dispatch / tasks-v3-routes）

#### Browser E2E
- **无**（D7 否决）

#### Contract Tests
- `ClientSpecField` 与 server `ServerSpecField` 同步含 `workflow_ref`（web-app 契约，轻量）

#### Manual Checklist
- 一次真实 authoring 会话：agent 自动 HOW-handoff → 推荐 → 确认 → 绑定 → SpecPanel 可见可查 → 入队放行
- 拒绝推荐 → 自建：validate 失败一次 → 修复 → 通过 → 绑定
- 用户不看绑定直接入队 → 门禁照常执行（责任归用户）

### Prerequisites
- [ ] spec-field `workflow_ref` + resolver 落地（US1-4 → US5-7 依赖）
- [ ] dispatch 拷贝 + `task_workflows_dir` 注入（US7 依赖）
- [ ] ready-gate 升级（US6 依赖）
- [ ] task-author skill HOW-handoff 步骤（US1/3 手动项依赖）

## Risks & Notes
- R1: `copyBuiltInWorkflows` 全局种子与"全局非有效来源"语义冲突 —— 运行时可能命中预检拒绝的 ref。停用全局种子为独立清理项，非本轮。
- R2: 绑定即预检强约束"先建后绑"顺序 —— 与 S1 流程一致；未来 bind-before-create 形态需放开。
- R3: 项目仓库内工作流供给（S4 方向）无施工路径 —— 本轮 bound 的 ref 只能来自内置 ∨ task-home。
- R4: 自建 flow 的"真实副作用"声明由 agent 自行判断，存在 agent 误报风险 —— 手动清单覆盖，纳入验收观察项。

## Glossary (new domain terms)
| Term | Meaning |
|------|---------|
| HOW-handoff | task-author 对话收尾阶段的行为步骤：枚举→推荐→用户确认→(自建+测试)→绑定 workflow_ref |
| 解析集 (workflow resolution set) | 任务 workflow_ref 的有效来源集合：已安装内置 ∨ task home `workflows/`。全局 `~/.octopus/workflows/` 排除 |
| task home workflows/ | `~/.octopus/tasks/{id}/workflows/` — 自建工作流落位目录；dispatch 时拷进执行 ws |
| fail-fast 预检 | 绑定 `workflow_ref` 时立即 resolve 校验，未命中解析集 → 400 拒绝 |