# Requirement Brief — Dynamic Sub-Workflow Node

## Overview
为 Octopus 工作流引擎新增 `dynamic_sub_workflow` 节点类型，在运行时由 Agent 根据上游数据动态生成一个可并行执行的 DAG 子工作流，持久化到 workspace/workflows/ 目录，UI 中以容器框形式展示（生成前标注 "Dynamic"，生成后显示子节点）。

## Projects Involved
- [ ] shared (类型定义、Zod Schema、NodeDef 扩展)
- [ ] engine (DynamicSubWorkflowExecutor、三层验证 Harness、纠错循环、DAG 执行)
- [ ] server (API 适配、SSE 事件传播、DB 输出记录)
- [ ] web-app (SubWorkflowContainerNode Dynamic 状态渲染、历史加载)
- [ ] core-pack (octo-workflow-dev、octo-workflow-test skills 更新)

## Feature Scope
**Do:**
- 新增 `dynamic_sub_workflow` 节点类型，Agent 在运行时生成 DAG nodes JSON 并执行
- 三层验证 Harness（L1 结构 / L2 图 / L3 语义）+ 最多 3 轮自动纠错循环
- 生成的 DAG 持久化为 YAML 文件 + meta.json 到 workspace/workflows/ 目录
- 可选 `workflow` 字段让用户预定义生成文件名，未指定时引擎自动生成
- Loop 内执行时自动追加 `-iter{N}` 后缀
- 上下文感知重跑：比较 input hash，未变则复用已有 DAG，变了则重新生成
- UI：生成前显示 "Dynamic" badge + "⚡ 运行时生成"，生成后与静态 sub_workflow 一致
- 日志和 SSE 完全兼容现有 sub_workflow 机制（scoped ID: `parentId:childId`）
- 更新 octo-workflow-dev 和 octo-workflow-test skills 覆盖新节点类型

**Don't:**
- 不支持 template / inline 等非 agent 生成策略
- 生成 DAG 中仅允许 `agent` 类型节点（不支持 bash/python/sub_workflow 等）
- 不做跨工作空间的动态子工作流
- 不修改现有节点类型的行为
- 不做动态子工作流的暂停/恢复（首版）

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | DAG 拓扑生成者 | Agent（LLM）| 最灵活，能适应各种场景（tickets 执行、角色分派等）|
| 2 | 生成策略选项 | 仅 agent，砍掉 template/inline | 核心价值是 agent 动态规划，预定义模板违背初衷 |
| 3 | YAML 核心字段 | `prompt` + `model` + `skills`（与 agent 节点对齐）| 精炼，无冗余字段，复用现有字段语义 |
| 4 | 生成 DAG 节点类型 | 仅 `agent` | 约束少 = 出错概率低，prompt+skills+depends_on 已覆盖编排需求 |
| 5a | 错误处理 | 三层验证 Harness + 3 轮纠错循环 | 保证生成质量，防止长流程因生成错误而中断 |
| 5b | 重跑行为 | 上下文感知：input hash 未变复用，变了重生成 | 避免不必要的 token 消耗，同时保证数据一致性 |
| 6 | Skills 注入 | 用户显式声明 `skills: [octo-workflow-dev, octo-workflow-test]` | 用户控制 agent 知识来源 |
| 7 | 文件命名 | 可选 `workflow` 字段预定义，否则 `{parent}__{node-id}.yaml`，loop 内加 `-iter{N}` | 灵活 + 确定性 + loop 兼容 |
| 8 | DB 关联 | node_executions.outputs.generated_workflow 存储生成的 workflow 名称 | 复用现有表结构，无需 DDL 变更 |
| 9 | Meta 文件 | `{workflow}.meta.json` 存储 input_hash + 时间戳 + 验证轮数 | 支持重跑检测和审计 |

## Data Model Changes
| Table | Operation | Details |
|-------|-----------|---------|
| NodeDef (TypeScript) | 新增 type 枚举值 | `"dynamic_sub_workflow"` 加入联合类型 |
| NodeSchema (Zod) | 新增枚举值 | Zod enum 扩展 |
| NodeTypeSchema (workspace) | 新增枚举值 | UI 节点类型选择器 |
| node_executions | 无 DDL 变更 | outputs JSON 字段存储 `generated_workflow` 名称 |

### Dynamic Sub-Workflow Node YAML Schema
```yaml
- id: plan-and-execute
  type: dynamic_sub_workflow
  workflow: ticket-dag                    # 可选：预定义生成文件名
  prompt: |                               # 必需：DAG 生成指令
    使用 octo-workflow-dev skill 的知识，分析 $vars.tickets，
    规划执行 DAG，输出 nodes JSON 数组。
  model: claude-sonnet-4-20250514         # 可选：默认用 workflow 级 model
  skills: [octo-workflow-dev, octo-workflow-test]  # 显式声明 skills
  depends_on: [to-tickets]                # 标准 DAG 依赖
  on_error: fail                          # 可选：fail(默认) | continue
```

### Agent 输出格式（DAG JSON 契约）
```json
{
  "nodes": [
    {
      "id": "frontend-login",
      "type": "agent",
      "prompt": "实现登录页面 UI 组件",
      "skills": ["frontend-dev"],
      "depends_on": []
    },
    {
      "id": "backend-auth",
      "type": "agent",
      "prompt": "实现 JWT 认证 API",
      "skills": ["backend-dev"],
      "depends_on": []
    },
    {
      "id": "integration",
      "type": "agent",
      "prompt": "对接前后端，编写集成测试",
      "depends_on": ["frontend-login", "backend-auth"]
    }
  ]
}
```

### 生成文件结构
```
workspace/workflows/
├── main-pipeline.yaml                  # 父工作流
├── ticket-dag.yaml                     # 生成的 DAG（或 {parent}__{node-id}.yaml）
├── ticket-dag.meta.json                # 元数据
├── ticket-dag-iter0.yaml               # loop 迭代 0
├── ticket-dag-iter0.meta.json
└── ticket-dag-iter1.yaml               # loop 迭代 1
```

### Meta 文件格式
```json
{
  "generated_at": "2026-08-03T10:00:00Z",
  "input_hash": "a1b2c3d4...",
  "input_snapshot": { "tickets": [...] },
  "validation_rounds": 1,
  "execution_status": "completed",
  "node_count": 3
}
```

## API Contracts
| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| (existing) | GET `/api/workspaces/:wsId/workflows/:name` | Server | name = generated_workflow | Workflow YAML | UI 加载生成的子节点 |
| (existing) | SSE `runtime_node_added` | Server→Web | scoped node data | - | 生成的子节点注册 |

无新 API 端点。完全复用现有 sub_workflow 的 API 和 SSE 机制。

## Design Specs (if any)
- Figma link: none
- UI 沿用 SubWorkflowContainerNode 组件，新增 "Dynamic" badge 状态

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| AC-1 | 作为用户，我想在工作流中添加一个动态编排节点 | YAML 中写 `type: dynamic_sub_workflow` + prompt + skills，引擎正确解析 | Unit Test: Zod schema 验证通过 |
| AC-2 | Agent 根据上游数据生成有效的 DAG | 生成 JSON 通过 L1/L2/L3 验证，0 轮纠错 | Integration Test: mock agent 输出有效 JSON，验证通过 |
| AC-3 | 生成的 DAG 有错误时自动纠错 | L2 检测到循环依赖 → 纠错 agent 修正 → 重新验证通过 | Integration Test: mock agent 首次输出有循环，纠错后通过 |
| AC-4 | 3 轮纠错后仍失败 | 节点 status=failed，错误信息包含最后一轮验证错误，文件保留 | Integration Test: mock agent 始终输出无效 JSON |
| AC-5 | 生成的 DAG 正确并行执行 | computeExecutionLevels 输出 [[t1,t2],[t3]]，t1/t2 并发执行 | Integration Test: 验证执行顺序和并行性 |
| AC-6 | 生成的 workflow 持久化到文件 | workflows/ 目录有 YAML 文件 + meta.json | Integration Test: 检查文件存在和内容 |
| AC-7 | Loop 内执行生成独立文件 | 每次迭代生成 `{name}-iter{N}.yaml` | Integration Test: 3 次迭代，检查 3 个文件 |
| AC-8 | 重跑时上下文未变复用 DAG | input hash 相同 → 不重新生成，直接执行已有 DAG | Integration Test: 两次执行相同输入 |
| AC-9 | 重跑时上下文已变重新生成 | input hash 不同 → 重新生成，覆盖旧文件 | Integration Test: 修改输入后重跑 |
| AC-10 | UI 执行前显示 Dynamic 状态 | SubWorkflowContainerNode 显示 "Dynamic" badge + "⚡ 运行时生成" | E2E: 截图验证 |
| AC-11 | UI 执行后显示生成的子节点 | 容器框内显示子节点 + 实时状态，与静态 sub_workflow 一致 | E2E: 截图验证 |
| AC-12 | 执行日志完整 | 子节点事件正确分组，scoped ID 格式 `parentId:childId` | Integration Test: 检查日志输出 |
| AC-13 | 历史查看加载生成 DAG | 重新打开执行记录，从 outputs.generated_workflow 加载 YAML | E2E: 重新打开执行详情页面 |
| AC-14 | Skills 更新 | octo-workflow-dev 和 octo-workflow-test 覆盖 dynamic_sub_workflow | Manual: 检查 skill 文档 |

## Verification Strategy

### Global Config
- Environment: local dev (主仓库 server:3001, web:3000)
- Test user: N/A (engine 层无需认证)
- Data prefix: `E2E_TEST_DYNAMIC_`

### Per-layer Methods

#### Unit Tests
- `packages/engine/src/__tests__/dynamic-sub-workflow.test.ts`
  - L1 验证：有效/无效 JSON 结构
  - L2 验证：循环依赖检测、depends_on 引用检查
  - L3 验证：type 白名单、prompt 非空
  - 文件名生成：普通 / loop 内 / 自定义 workflow 名
  - Input hash 比较：相同/不同

#### Integration Tests
- `packages/engine/src/__tests__/dynamic-sub-workflow-e2e.test.ts`
  - 场景 1：Happy path — DAG 生成并执行
  - 场景 2：纠错循环 — 首次有错，自动修复
  - 场景 3：3 轮纠错后仍失败
  - 场景 4：Loop 内执行（3 次迭代）
  - 场景 5：重跑 — 上下文未变（复用）
  - 场景 6：重跑 — 上下文已变（重新生成）

#### Browser E2E
- Playwright 脚本:
  1. 创建 workspace
  2. 创建父工作流（含 dynamic_sub_workflow 节点）
  3. 执行并观察 UI 状态变化
  4. 截图验证 Dynamic badge → 子节点渲染
  5. 验证历史查看

#### Contract Tests
- TypeScript 编译检查：NodeDef 新 type 在 shared/engine/server/web-app 一致

#### Manual Checklist
- [ ] octo-workflow-dev skill 包含 dynamic_sub_workflow 文档
- [ ] octo-workflow-test skill 包含 dynamic_sub_workflow 测试模式

### Prerequisites
- [x] sub_workflow 节点功能完整
- [ ] octo-workflow-dev skill 更新（本次任务）
- [ ] octo-workflow-test skill 更新（本次任务）
- [ ] Playwright 环境就绪

## Risks & Notes
- R1: Agent 生成 DAG 的 token 消耗可能较高（尤其纠错循环）— 通过 skills 知识注入降低首次成功率
- R2: 生成的 DAG 复杂度不可控（agent 可能生成过多节点）— 可在 prompt 中约束 max_nodes
- R3: Loop + dynamic_sub_workflow 嵌套可能导致执行时间很长 — 首版接受，后续可优化
- R4: 生成的 workflow 文件积累 — 需要清理策略（后续 feature）

## Glossary (new domain terms)
| Term | Meaning |
|------|---------|
| **Dynamic Sub-Workflow** | 运行时由 Agent 动态生成的 DAG 子工作流，区别于静态定义的 sub_workflow。节点类型为 `dynamic_sub_workflow`。 |
| **Validation Harness** | 三层验证 + 自动纠错循环机制，确保 LLM 生成的 DAG JSON 结构正确、图无环、语义合法。 |
| **Input Hash** | 上游输入数据的哈希值，用于重跑时检测上下文是否变化，决定复用或重新生成 DAG。 |
| **Generated Workflow** | 引擎执行 dynamic_sub_workflow 节点后生成的 YAML 文件，存储在 workspace/workflows/ 目录。 |
| **Meta File** | 与 Generated Workflow 配对的 JSON 文件，记录 input_hash、生成时间、验证轮数等元数据。 |
