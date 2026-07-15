# Spec: mattpocock-dev-expert — Expert Grill Workflow

## Problem Statement

当前 mattpocock-dev 的 grill 阶段是单 agent 拷问用户——用户需要回答 13 个问题。这要求用户有充分的技术知识和时间来逐一回答。很多场景下，用户只有 idea，希望专家团队自动讨论出最佳方案。

## Solution

创建 `mattpocock-dev-expert.yaml`，将 grill 阶段从"拷问用户"改为"专家团讨论"。3-6 个专家通过 swarm debate 对每个问题达成多角色共识，用户只需最终审批。

## Architecture

### Workflow 节点结构

```
grill-classify (agent)
  → 生成问题 + 依赖分析 + 分批
  → 输出: batches JSON [{batch_id, questions, depends_on}]
  → Context 模式检测（结构优先，不看现有文件）

grill-loop (loop, max_iterations: 10)
  └── grill-batch (swarm, mode: debate)
      → 读当前 batch 的问题 + 前序 batch 的 decisions
      → 3-6 个专家 debate
      → Host 综合共识
      → 输出: batch decisions (JSON)
      → break_when: 所有 batch 完成

grill-approval (approval, conditional)
  → 仅审批模式时激活
  → 展示所有 batch decisions 给用户
  → auto_answers 默认自动通过

grill-synthesize (agent)
  → 综合所有 batch decisions → brief.md
  → domain-modeling → CONTEXT.md / CONTEXT-MAP.md
  → 输出: brief_file, context_file

spec (agent, skills: to-spec + codebase-design)
  → 和现有 mattpocock-dev 相同

tickets (agent, skills: to-tickets)
  → 和现有 mattpocock-dev 相同

tdd-loop (loop, max_iterations: 100)
  └── ticket-impl (agent, skills: implement + tdd + code-review + diagnosing-bugs)
      → 和现有 mattpocock-dev 相同（含工程师路由）

architecture-review (agent, skills: improve-codebase-architecture + codebase-design)
  → 和现有 mattpocock-dev 相同

ship (agent)
  → 和现有 mattpocock-dev 相同
```

### grill-classify 输出格式

```json
{
  "batches": [
    {
      "batch_id": 1,
      "questions": [
        {"id": "Q1", "text": "核心问题定义", "depends_on": []},
        {"id": "Q2", "text": "目标用户", "depends_on": []}
      ],
      "depends_on": []
    },
    {
      "batch_id": 2,
      "questions": [
        {"id": "Q3", "text": "MVP 边界", "depends_on": ["Q1"]}
      ],
      "depends_on": [1]
    }
  ],
  "context_mode": "single|multi",
  "context_packages": ""
}
```

### grill-batch swarm 配置

```yaml
- id: grill-batch
  type: swarm
  mode: debate
  max_rounds: 3
  consensus_threshold: 0.8
  experts:
    architect:
      description: "架构师 — 技术可行性、系统集成、模块设计"
      agent_file: ".claude/agents/architecture-explorer.md"
    product-manager:
      description: "产品经理 — 用户价值、MVP 边界、优先级"
      agent_file: ".claude/agents/product-manager.md"  # 需新建
    testing-expert:
      description: "测试专家 — 测试策略、Seam 设计、质量保障"
      agent_file: ".claude/agents/testing-engineering-software-architect.md"
    # 可选（classify 阶段根据项目决定）
    frontend-engineer:
      description: "前端专家 — UI/UX 需求、交互设计"
      agent_file: ".claude/agents/engineering-frontend-developer.md"
    backend-engineer:
      description: "后端专家 — API 设计、数据模型、性能"
      agent_file: ".claude/agents/engineering-backend-architect.md"
    security-expert:
      description: "安全专家 — 认证/授权/数据保护"
      agent_file: ".claude/agents/security-reviewer.md"
```

### 跨 batch 上下文传递

每个 grill-batch swarm 的 prompt 注入：
```
前序 batch decisions:
$vars.accumulated_decisions

当前 batch 问题:
$vars.current_batch_questions
```

grill-batch 输出追加到 `$vars.accumulated_decisions`。

## Implementation Decisions

### D1. grill-classify 节点

Agent 节点。读 idea + 项目探索 → 生成 grill 问题 + 依赖图 + 分批计划。
13 个 grill 维度作为参考模板，但 LLM 可根据 idea 调整措辞。
同时检测 context 模式（结构优先）。

### D2. grill-loop 节点

Loop 节点，max_iterations = batch 数量（从 classify 输出的 batches 长度）。
break_when: 所有 batch 完成。
每次迭代：读下一个 batch → swarm debate → 追加 decisions。

### D3. grill-batch swarm 节点

Swarm 节点（需 engine 支持 swarm-in-loop）。
mode: debate, max_rounds: 3, consensus_threshold: 0.8。
3 个核心专家必选 + 0-3 个可选专家（由 classify 决定）。

### D4. grill-approval 节点

Approval 节点，`execute_when: '$inputs.interactive == "true"'`。
展示所有 accumulated_decisions 给用户。
auto_answers 默认自动通过（非审批模式时跳过）。

### D5. grill-synthesize 节点

Agent 节点。读 accumulated_decisions → 综合为 brief.md。
同时执行 domain-modeling（CONTEXT.md / CONTEXT-MAP.md）。
关键分歧写入 brief.md 的"理由"字段。

### D6. 下游管线复用

spec → tickets → tdd-loop → architecture-review → ship
和现有 mattpocock-dev 完全一致。代码不共享（YAML 各自声明），但 prompt 和 skills 引用相同。

### D7. Engine 改动

loop.ts: 支持 swarm 类型子节点。
- constructor 加 checkpointStore, executionId, hookExecutor, agentResolver
- createExecutor() 加 case "swarm" + 删除 throw
engine.ts: 创建 LoopExecutor 时传入新参数。

### D8. 新 agent 文件

需要新建 `product-manager.md` agent（现有 agent 库中没有产品经理角色）。

## Testing Decisions

### Seam 约定

- grill-classify 的测试边界：输出 JSON 格式正确性 + 依赖图无环
- grill-batch swarm：swarm 节点内部测试（engine 层面）
- grill-synthesize：输出 brief.md 格式 + CONTEXT 文件存在性

### 需要测试的模块

1. loop.ts — swarm-in-loop 支持（新增 case + 参数传递）
2. engine.ts — LoopExecutor 构造参数传递
3. mattpocock-dev-expert.yaml — workflow validate + dry run

## Out of Scope

- Swarm-in-loop checkpoint/resume — 初版不支持，grill 阶段不需要
- 动态专家数量 — 固定 3 核心 + classify 决定可选
- 多语言 grill — 只支持中文/英文（跟随 idea 语言）
- 修改现有 mattpocock-dev — 独立文件，不改动

## Further Notes

- 产品经理 agent 需要新建 — 可以从 `product-behavioral-nudge-engine` 或 `product-manager`（agency-agents-zh）适配
- swarm debate 的 consensus_threshold 可能需要根据实际运行调优
- 首次运行建议用 `interactive: true` 验证专家输出质量
