# 03 — Mock 数据智能: Agent 怎么知道生成什么 mock 数据?

Type: research
Status: resolved
Blocked by: None

## Answer

### 1. xzf-dev.yaml 变量流向全图 (619 行旗舰工作流)

#### Stage 0: init (agent)
- **Mock 输出**: `vars_update` JSON → `{ branch, feature, remote_type }`
- **VarPool 写入**: `$vars.branch`, `$vars.feature`, `$vars.remote_type`
- **下游依赖**: 几乎所有后续节点的 prompt 都引用 `$vars.feature` 和 `$vars.branch`
- **Mock 数据样例**:
  ```json
  {
    "output": "初始化完成。分支: feat/engine-init-sync, feature: engine-init-sync, remote: github",
    "update_vars": { "branch": "feat/engine-init-sync", "feature": "engine-init-sync", "remote_type": "github" }
  }
  ```

#### Stage 1: idea-research (swarm, debate, dynamic)
- **Auto-vars 自动写入 VarPool** (由 `writeAutoOutputs`):
  - `{nodeId}_synthesis` → 综合报告文本
  - `{nodeId}_consensus_score` → 共识分数 (0-1)
  - `{nodeId}_rounds_used` → 实际轮数
  - `{nodeId}_expert_count` → 专家数
  - `{nodeId}_experts` → JSON 数组 `["codebase-architect", ...]`
  - `{nodeId}_history` → 讨论历史 JSON
  - `{nodeId}_expert_outputs` → `[{ role, output }]` JSON
  - `{nodeId}_failed_experts` → 失败专家 JSON
  - `{nodeId}_task_breakdown` → 任务分解 JSON (dispatch 模式)
  - `{nodeId}_budget_exhausted` → boolean
  - `{nodeId}_timeout_exceeded` → boolean
- **Host 额外输出**: `vars_update.requirements_checklist_status` = `"INCOMPLETE: ..."`
- **Mock 数据样例**:
  ```json
  {
    "output": "研究结论: 涉及 engine 和 shared 两个包，无重大风险。3 个待澄清问题。",
    "update_vars": { "requirements_checklist_status": "INCOMPLETE: 缺少验证策略" }
  }
  ```

#### Stage 2a: requirements-clarify-loop (loop)
- **break_when**: `$vars.clarify_decision == "proceed" && $vars.requirements_checklist_status == "COMPLETE"`
- **内部节点**:
  - **requirements-approval** (approval)
    - `options`: `[{ label: "继续", value: "continue" }, { label: "完成", value: "proceed" }]`
    - `outputs`: `{ "$vars.clarify_decision": "$last_output" }` → 用户选择写入 VarPool
    - **Mock**: `{ choice: "proceed" }` (happy path) 或 `{ choice: "continue", comment: "需要补充 X" }` (迭代)
  - **requirements-clarify** (agent)
    - 引用 `$requirements-approval.output.comment` → 需要 approval mock 提供 comment
    - `vars_update.requirements_checklist_status` → `"COMPLETE"` 或 `"INCOMPLETE: ..."`
    - `execute_when`: `$vars.clarify_decision != "proceed" || $vars.requirements_checklist_status != "COMPLETE"`
- **Mock 收敛约束**: 最终迭代必须同时满足 `clarify_decision == "proceed"` AND `requirements_checklist_status == "COMPLETE"`

#### Stage 2b: verification-clarify-loop (loop)
- **结构同 2a**, 变量名不同:
  - `$vars.verify_decision` (approval choice)
  - `$vars.env_checklist_status` (agent vars_update)
- **break_when**: `$vars.verify_decision == "proceed" && $vars.env_checklist_status == "COMPLETE"`

#### Stage 3: brief-maker (agent)
- 无 `outputs:` 映射，仅写文件
- Mock: 简单文本输出即可

#### Stage 4: spec-planner (agent)
- 无 `outputs:` 映射，仅写文件
- Mock: 简单文本输出即可

#### Stage 5: execution (agent with sub-agents)
- `outputs`: `{ "$vars.spec_status": "$last_output" }`
- `vars_update.spec_status` = `"passed"` | `"partial"`
- **Mock 数据样例**:
  ```json
  {
    "output": "所有 spec 执行完毕: 3/3 passed",
    "update_vars": { "spec_status": "passed" }
  }
  ```

#### Stage 6: e2e-verify-loop (loop)
- **break_when**: `$vars.e2e_status == "passed" || $vars.e2e_decision == "skip"`
- **内部节点**:
  - **e2e-runner** (agent) → `$vars.e2e_status` = `"passed"` | `"failed"`
  - **e2e-notify** (bash) → `execute_when: $vars.e2e_status == "failed"`
  - **e2e-approval** (approval) → `execute_when: $vars.e2e_status == "failed"`
    - `outputs`: `{ "$vars.e2e_decision": "$last_output", "$vars.user_guidance": "$last_output.comment" }`
    - `options`: `[{ label: "重试", value: "retry" }, { label: "跳过", value: "skip" }]`
- **Mock 场景**:
  - Happy path: e2e-runner 直接 `"passed"`, e2e-notify/e2e-approval 被 skip
  - Failure + retry: e2e-runner `"failed"` → e2e-notify runs → e2e-approval `"retry"` → 下一轮 e2e-runner `"passed"`
  - Failure + skip: e2e-runner `"failed"` → e2e-approval `"skip"` → loop breaks

#### Stage 7: ship (agent)
- 无 `outputs:` 映射，仅执行 git/gh 命令
- Mock: 简单文本输出

---

### 2. Swarm 模板 Mock 模式

#### tech-decision.yaml (debate, 3 rounds)
- **Auto-vars**: `decision_synthesis`, `decision_consensus_score`, `decision_rounds_used`, `decision_expert_count`, `decision_experts`
- **用户 outputs 映射**: `decision: "$vars.decision_synthesis"`, `consensus: "$vars.decision_consensus_score"`
- **Mock 关键**: consensus_score 需 >= consensus_threshold (0.75) 才算达成共识

#### fullstack-dev.yaml (dispatch, DAG)
- **专家间 depends_on**: frontend-developer depends_on backend-architect; code-reviewer depends_on both
- **Auto-vars**: `implement_synthesis`, `implement_experts`
- **Mock 关键**: dispatch 模式产出 task_breakdown，每个专家有独立 output

#### code-review.yaml (review, 1 round)
- **Auto-vars**: `review_synthesis`, `review_experts`
- **Mock 关键**: review 模式最简单，一轮并行 + Host 综合

---

### 3. 变量系统完整知识 (从源码 + skill 文档)

#### 引用语法 → mock 必须填充的变量源

| 语法 | 含义 | Mock 数据来源 |
|------|------|-------------|
| `$vars.xxx` | VarPool 全局变量 | 上游节点的 `vars_update` 或 `outputs:` 映射 |
| `$node-id.output` | 前序节点 lastOutput | 该节点的 mock `output` 字段 |
| `$node-id.output.xxx` | 前序节点输出子字段 | 该节点的 mock `outputs` 或特定字段 |
| `$inputs.xxx` | 工作流输入参数 | TestScenario 的 `inputs` 字段 |
| `$last_output` | 当前节点自身输出 | 仅用于 `outputs:` 块内的自引用 |
| `$iteration` | loop 迭代计数 (1-based) | Loop executor 自动提供 |
| `$file:path` | 文件内容读取 | Approval 节点 prompt 中的文件引用 |

#### outputs: 映射 — 5 种表达式语法

```yaml
outputs:
  "$vars.result": "$last_output"                    # 1. 引用自身输出
  "$vars.status": "$last_output.status"             # 2. 引用输出子字段
  "$vars.choice": "$last_output"                    # 3. 写入 VarPool
  "$vars.count": "$vars.count + 1"                  # 4. 表达式计算
  "$vars.data": '"literal_string"'                  # 5. 字符串字面量 (二次引号)
```

#### execute_when — 条件表达式

```yaml
execute_when: '$vars.e2e_status == "failed"'       # 字符串等值
execute_when: '$vars.clarify_decision != "proceed" || $vars.requirements_checklist_status != "COMPLETE"'  # 复合条件
```

#### 表达式求值器 (evaluateExpression) 支持的语法

| 操作符 | 语法 | 示例 |
|--------|------|------|
| 等值 | `==`, `!=` | `$vars.status == "passed"` |
| 数值比较 | `<`, `>`, `<=`, `>=` | `$vars.attempt < 5` |
| 逻辑与 | `&&` | `$vars.a == "x" && $vars.b == "y"` |
| 逻辑或 | `\|\|` | `$vars.a == "x" \|\| $vars.b == "y"` |
| 逻辑非 | `!` | `!$vars.done` |
| 集合成员 | `in` | `$vars.env in ['prod', 'uat']` |

**安全限制**: 表达式经白名单正则 `/^[a-zA-Z0-9_\s'".\[\],:!|<>=()\-&]+$/` 过滤，不允许任意代码执行。

**字符串必须加引号**: `$vars.status == "passed"` ✅ / `$vars.status == passed` ❌ (ReferenceError)

**`"default"` 特殊值**: condition 节点的 `when: default` 始终返回 true。

#### VarPool 内部实现

- 扁平 `Map<string, any>` — 无嵌套键遍历
- `get("branch")` → 直接查 map
- `fork()` 创建子池，`merge()` 只合并 dirty 键
- `substituteVars` 将 `$vars.xxx` 替换为 `String(val)` (无引号)
- `toJsLiteral` 用于表达式求值: 字符串 → JSON.stringify (带引号), 数字 → 原样

---

### 4. 各节点类型 Mock 数据模式

#### Agent 节点

**真实输出协议**:
1. Agent 返回 `finalText` (自由文本)
2. 引擎从 finalText 末尾提取 `{"vars_update": {...}}` JSON
3. `__status` 在 vars_update 内 → 可强制标记 `"failed"`
4. `outputs:` 映射进一步写入 VarPool

**Mock def 结构** (`AgentMockDef`):
```typescript
{
  status?: "completed" | "failed",
  output?: string,                    // → lastOutput + $last_output
  outputs?: Record<string, any>,      // → 额外 outputs 字段
  update_vars?: Record<string, any>,  // → 直接写入 VarPool
  error?: string                      // status=failed 时的错误信息
}
```

**Mock 样例** (带 vars_update):
```json
{
  "output": "执行完毕。\n{\"vars_update\": {\"spec_status\": \"passed\", \"conclusion\": \"3/3 specs passed\"}}",
  "update_vars": { "spec_status": "passed" }
}
```

#### Bash 节点

**真实输出协议**:
1. 执行 shell 脚本，捕获 stdout + exit_code
2. stdout 末尾同样可提取 `vars_update` JSON
3. `outputs:` 映射支持 `$last_output`, `$last_output.xxx`, `$exit_code`, `$vars.xxx`

**Mock def 结构** (`BashMockDef`):
```typescript
{
  status?: "completed" | "failed",
  output?: string,
  outputs?: Record<string, any>,
  update_vars?: Record<string, any>,
  exit_code?: number,    // 默认: status=failed ? 1 : 0
  error?: string
}
```

**Mock 样例** (简单):
```json
{
  "output": "通知已发送",
  "exit_code": 0
}
```

#### Python 节点

**同 Bash 节点** — stdout + exit_code + vars_update 协议一致。

#### Condition 节点

**真实输出协议**:
1. 遍历 `cases` 数组，对每个 `when` 调用 `evaluateExpression`
2. 首个匹配 → `jumpTo` 到 `then` 目标
3. `when: default` 始终匹配 (必须放最后)
4. 特殊跳转: `then: break` / `then: continue`

**Mock 不需要**: Condition 节点不使用 mock executor — 它直接基于 VarPool 当前值求值。Mock 数据通过设置正确的 VarPool 值来间接控制 condition 走向。

**关键**: 要让 condition 匹配特定 case，必须确保 VarPool 中相关变量的值满足该 case 的 `when` 表达式。

#### Approval 节点

**真实输出协议**:
1. 有 `userChoice` → 直接返回结果 (模拟模式)
2. 无 `userChoice` → 返回 `pending_approval` 状态等待用户
3. `outputs:` 映射: `$vars.xxx: "$last_output"` → 将 choice 写入 VarPool
4. `$last_output.comment` → 用户评论内容

**Mock def 结构** (`ApprovalMockDef`):
```typescript
{
  choice: string,      // 必须匹配 options 中某个 value
  comment?: string     // 用户评论 (可选)
}
```

**Mock 样例**:
```json
{ "choice": "proceed", "comment": "需求已明确，可以进入下一阶段" }
```

**Reject 判定**: choice 值为 `"reject"`, `"no"`, `"deny"`, `"abort"` 或 `endsWith("-reject")` → status = `"rejected"`

#### Loop 节点

**真实输出协议**:
1. 内部节点数组按 `depends_on` DAG 执行
2. 每轮检查 `while` (继续条件) 和 `break_when` (退出条件)
3. `$iteration` 自动注入 (1-based)
4. 支持 `max_iterations` 兜底
5. 循环变量 fallback: agent 未输出 vars_update 时，引擎尝试 force-advance 数值变量

**Mock def 结构** (`LoopMockDef`):
```typescript
{
  iterations?: number,                      // 预期迭代次数
  nodes: Record<string, MockDef | MockDef[]>  // 内部节点 mock (数组 = 每轮不同)
}
```

**Mock 收敛约束**:
- `break_when` 表达式引用的变量必须在某轮迭代后满足条件
- 内部节点的 mock 必须通过 `update_vars` 逐步改变控制变量
- 例: `$vars.e2e_status == "passed"` → e2e-runner 的 mock 必须在某轮设置 `e2e_status: "passed"`

#### Swarm 节点

**Auto-vars** (引擎自动写入, 无需 `outputs:` 映射):
```
{nodeId}_synthesis          → Host 综合报告文本
{nodeId}_consensus_score    → 共识分数 (0-1, debate 模式)
{nodeId}_rounds_used        → 实际使用轮数
{nodeId}_expert_count       → 参与专家数
{nodeId}_experts            → JSON: ["role1", "role2"]
{nodeId}_history            → JSON: 完整讨论历史
{nodeId}_task_breakdown     → JSON: 任务分解 (dispatch 模式)
{nodeId}_budget_exhausted   → boolean
{nodeId}_timeout_exceeded   → boolean
{nodeId}_expert_outputs     → JSON: [{ role, output }]
{nodeId}_failed_experts     → JSON: 失败专家列表
```

**Mock def 结构** (`SwarmMockDef`):
```typescript
{
  status?: "completed" | "failed",
  output?: string,                    // → synthesis + lastOutput
  outputs?: Record<string, any>,      // → 额外字段
  update_vars?: Record<string, any>,  // → VarPool 写入
  error?: string
}
```

---

### 5. Mock 数据生成约束求解 — Agent 需要的知识

#### 约束 1: outputs 映射 → VarPool 填充

Agent 必须解析每个节点的 `outputs:` 块，确定哪些 VarPool key 会被设置:

```yaml
outputs:
  $vars.clarify_decision: "$last_output"      # → VarPool["clarify_decision"] = approval.choice
  $vars.spec_status: "$last_output"           # → VarPool["spec_status"] = agent.lastOutput
```

#### 约束 2: 下游 condition/execute_when → 值约束

Agent 必须前向扫描，收集所有引用某变量的 condition 表达式:

```
$vars.e2e_status 被引用在:
  - e2e-notify.execute_when: '$vars.e2e_status == "failed"'
  - e2e-approval.execute_when: '$vars.e2e_status == "failed"'
  - e2e-verify-loop.break_when: '$vars.e2e_status == "passed" || ...'
```

→ Happy path mock: `e2e_status = "passed"` (跳过 e2e-notify + e2e-approval)
→ Failure path mock: `e2e_status = "failed"` (触发通知 + 审批)

#### 约束 3: Loop break_when → 迭代收敛

Agent 必须确保 loop 内部节点的 mock 值在某轮满足 break_when:

```yaml
break_when: '$vars.clarify_decision == "proceed" && $vars.requirements_checklist_status == "COMPLETE"'
```

→ 最后一轮迭代 mock:
- requirements-approval: `{ choice: "proceed" }`
- requirements-clarify: `{ update_vars: { requirements_checklist_status: "COMPLETE" } }`

#### 约束 4: Approval options → 合法选择

Mock choice 必须匹配节点定义的 `options[].value`:

```yaml
options:
  - { label: "继续", value: "continue" }
  - { label: "完成", value: "proceed" }
```

→ Mock choice 只能是 `"continue"` 或 `"proceed"`

#### 约束 5: Swarm auto-vars → 可预测命名

Agent 可根据 swarm 节点 id 推断 auto-var 名称:

```
节点 id: "idea-research"
→ $vars.idea-research_synthesis
→ $vars.idea-research_consensus_score
→ ...
```

#### 约束 6: $nodeId.output 引用 → 链式依赖

当一个节点引用 `$requirements-approval.output.comment` 时:
- requirements-approval 的 mock 必须提供 `comment` 字段
- 该值会作为文本注入到下游节点的 prompt 中

#### 约束 7: vars_update JSON 协议

Agent mock 的 `output` 字符串末尾应包含合法 JSON:

```
文本输出...\n{"vars_update": {"key": "value"}}
```

引擎从末尾反向搜索 `"vars_update"` 标记，支持:
- 单行 JSON
- Markdown 代码块包裹的 JSON
- 多行 JSON (从 `{` 到匹配的 `}`)

---

### 6. 现有 Mock 基础设施 (V1 已交付)

| 文件 | 作用 |
|------|------|
| `simulator/types.ts` | MockDef 类型定义 (AgentMockDef, BashMockDef, etc.) |
| `simulator/mock-executors.ts` | 6 个 Mock executor 类 |
| `simulator/mock-factory.ts` | Mock 工厂 (从 fixture 创建 executor) |
| `simulator/assertions.ts` | 断言引擎 |
| `simulator/simulator-engine.ts` | 模拟引擎主循环 |
| `simulator/test-runner.ts` | 测试运行器 |
| `simulator/syntax-checker.ts` | YAML 语法检查 |

**已有 MockDef 的共享结构** (`BaseMockDef`):
```typescript
{
  status?: "completed" | "failed",
  output?: string,
  outputs?: Record<string, any>,
  update_vars?: Record<string, any>,
  error?: string
}
```

**`resolveMockOutputs` 核心逻辑**: 对 output/outputs/update_vars 执行变量替换后写入 VarPool，与真实 executor 行为一致。

---

### 7. Skill 需要教给 Agent 的知识清单

1. **解析 YAML 结构** — 识别所有节点类型、depends_on 拓扑、outputs 映射
2. **变量流分析** — 从 outputs/vars_update 追踪哪些 VarPool key 被哪些节点设置
3. **约束收集** — 前向扫描 condition/execute_when/break_when，收集对变量值的约束
4. **场景生成** — 为每个路径 (happy/failure/retry) 生成一致的 mock 数据集
5. **收敛保证** — Loop mock 的 update_vars 必须在 N 轮内满足 break_when
6. **类型匹配** — Approval choice 必须匹配 options，字符串比较必须加引号
7. **Auto-vars 感知** — Swarm 节点的 11 个自动变量命名规则
8. **断言生成** — 对应的 assertions (status, vars snapshot, node_trace, log patterns)

---

### 8. 现有测试基础设施 (V1 已交付)

#### Golden Workflow + Fixture 对 (5 组)

模拟器已有 5 个内置测试场景，覆盖核心拓扑:

| 场景 | 覆盖路径 | 关键 Mock 模式 |
|------|---------|---------------|
| linear | 串行 agent→bash→python | 简单 output 链 |
| branch/DAG | condition 分支 + 并行节点 | execute_when + depends_on |
| loop | 循环 + break_when 收敛 | 多轮迭代 mock 数组 |
| swarm | 多专家协作 | auto-vars + synthesis |
| failure | 节点失败路径 | status: "failed" + error |

#### 测试运行器

- **自动发现约定**: `workflow.yaml` → `workflow.test.yaml` (同目录)
- **TestRunner** 类: 加载 fixture → 创建 SimulatorEngine → 运行 → 断言 → 报告
- **CLI 入口**: `octopus workflow test <yaml>` (v1 已实现)

#### 共享测试工具

`packages/engine/src/__tests__/helpers.ts` 提供:
- 创建测试用 VarPool 实例
- 构建 NodeDef mock 对象
- 辅助断言比较

#### 断言引擎 (5 种断言类型)

```typescript
interface AssertionDef {
  status?: "completed" | "failed" | "completed_with_failures" | "paused" | "cancelled"
  vars?: Record<string, any>                      // VarPool 快照比较
  node_trace?: {
    executed?: string[]                            // 必须执行的节点
    skipped?: string[]                             // 必须跳过的节点
    order?: string[]                               // 执行顺序
  }
  node_outputs?: Record<string, {                  // 按节点 ID
    output?: string
    outputs?: Record<string, any>
    status?: string
  }>
  logs?: Record<string, {                          // 按节点 ID
    contains?: string[]
    not_contains?: string[]
  }>
}
```

---

### 9. 当前 Mock 系统的 Gaps

| Gap | 描述 | 对 fixture 生成的影响 |
|-----|------|---------------------|
| **无磁盘 fixture 文件** | Golden fixtures 内嵌在测试代码中，无 `.test.yaml` 约定文件 | V2 需要定义 on-disk fixture schema |
| **无组合式 fixture 工厂** | 每个场景手写 mock，无 builder pattern | Agent 需要从零生成完整 fixture |
| **无 per-expert swarm mock** | Swarm mock 只模拟整体输出，不模拟单个专家 | 无法测试依赖特定专家输出的场景 |
| **无 Hook/Notify mock** | hooks (notify, bash, agent) 不参与模拟 | 无法验证 hook 触发逻辑 |
| **无跨包 fixture 共享** | 测试数据仅在 engine 包内 | Server/Web-App 无法复用 |
| **无 `$parent`/`$ancestor` mock** | 子工作流引用父执行的变量未模拟 | 嵌套工作流测试不完整 |

#### 跨执行引用 (V2 可暂不覆盖)

```
$ref:workflow.yaml.nodeId.outputKey    — 同 workspace 其他工作流最近一次执行的输出
$parent.var_pool.xxx                   — 父执行变量池
$parent.input_values.xxx               — 父执行输入参数
$parent.$nodeId.outputs.xxx            — 父执行特定节点输出
$ancestor[N].var_pool.xxx              — N 级祖先变量池 (0=parent)
$ancestor[N].$nodeId.outputs.xxx       — N 级祖先节点输出
```

这些引用在模拟模式下无法解析 (需要 DB 查询)，mock 生成器需要为它们提供静态替代值。

---

### 10. `__status` 控制信号详解

`__status` 是唯一的 "控制信号" 变量 — 不写入 VarPool，仅影响节点状态:

```json
{"vars_update": {"__status": "failed", "error_detail": "compilation failed"}}
```

**处理流程** (在 `parse-vars-update.ts`):
1. 从 vars_update 中提取 `__status`
2. 写入 `outputs.__status` (不是 VarPool)
3. 删除 vars_update 中的 `__status` 键
4. 引擎检查 `outputs.__status === "failed"` → 节点状态改为 `"failed"`

**Mock 意义**: 可以模拟 "agent 成功执行但业务逻辑失败" 的场景:
```json
{
  "output": "编译失败: 3 个类型错误",
  "update_vars": { "__status": "failed", "error_detail": "3 type errors" }
}
```

---

### 11. `outputs:` 映射完整处理管线

每种 executor 的 `applyOutputsMapping()` 处理顺序:

1. **`$last_output`** → 取 `outputs.last_output` (节点的 stdout/finalText)
2. **`$last_output.field`** → JSON.parse stdout 后取子字段 (bash/python 特有)
3. **`$exit_code`** → 取 exit code (bash/python 特有)
4. **`$vars.xxx = expr`** → evaluateExpression 求值后写入 pool + outputs
5. **`$vars.xxx`** → 从 pool 读取现有值
6. **`$other_ref`** → substituteVars 通用替换
7. **字面量** → 直接存储

**关键**: 映射同时写入 VarPool (`pool.set`) 和 outputs record → 使值对下游 `execute_when` 和 `$nodeId.output.key` 都可用。

**`$vars.` 前缀处理**: key 可以是 `"$vars.my_key"` 或 `"my_key"` — 前缀在写入 pool 前被剥离。
