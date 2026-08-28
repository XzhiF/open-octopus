---
name: octo-workflow-test
description: 工作流测试助手 — 分析工作流结构，智能生成 test.yaml fixture，运行模拟器，自动迭代修复直到测试通过。
category: devops
tags: [workflow, testing, simulation, mock, simulator, fixture]
---

# 工作流测试助手

教会 agent 完整的测试闭环：分析 YAML → 生成 fixture → 运行模拟 → 解析结果 → 自动修复（最多 3 轮）→ 诊断报告。

> **前置**: 需要已创建的 workflow.yaml（通过 `octo-workflow-dev` skill）。
> **模拟器类型定义**: `packages/engine/src/simulator/types.ts`
> **Fixture schema**: `packages/shared/src/simulator/schemas.ts`

---

## 1. 前置条件

- 已有 `workflow.yaml`（通过 octo-workflow-dev 创建并通过 validate）
- octopus CLI 可用（`pnpm build` 已执行）
- 模拟器引擎完整（V1 simulator 已交付）

---

## 2. 自动发现约定

测试 fixture 文件与 workflow YAML **同目录**，命名规则：

```
workflow.yaml      → workflow.test.yaml
my-flow.yaml       → my-flow.test.yaml
xzf-dev.yaml       → xzf-dev.test.yaml
```

CLI `octopus workflow simulate <yaml>` 自动发现同目录 `.test.yaml`，无需手动指定 `--test`。

---

## 3. 工作流分析（第一步）

读取目标 workflow.yaml，提取以下信息：

### 3.1 节点清单

对每个节点记录：
- `id` / `type` / `depends_on`
- 是否有 `outputs:` 映射
- 是否有 `execute_when`
- 是否在 loop 内部

### 3.2 副作用节点识别

以下类型需要 mock 定义（严格模式）：

| 节点类型 | 是否需要 mock | 说明 |
|---------|-------------|------|
| `agent` | ✅ 必须 | LLM 调用，用 mock 替代 |
| `swarm` | ✅ 必须 | 多专家协作，整体 mock |
| `bash` | ✅ 必须 | Shell 副作用，mock stdout |
| `python` | ✅ 必须 | Python 副作用，mock stdout |
| `approval` | ✅ 必须 | 用户审批，mock choice |
| `condition` | ❌ 不需要 | 基于 VarPool 实际求值 |
| `loop` | ✅ 必须 | 包含内部节点 mock |
| `task_dispatch` | ❌ 自动通过 | 模拟器无 `TaskDispatchPort` 注入；循环内无 mock 的内节点自动通过（`executeInnerNode`），即便提供 mock 也走 `createAndExecuteMock` 默认分支自动通过。真实 fan-out 由 server 注入的 port 完成，不参与模拟。 |

### 3.3 变量流向图

追踪：
- 每个节点的 `outputs:` 映射写入了哪些 VarPool key
- 每个节点的 `vars_update` 写入了哪些 VarPool key
- 下游节点的 `condition.when` / `execute_when` / `loop.while` / `loop.break_when` 引用了哪些 VarPool key

### 3.4 条件表达式收集

前向扫描所有引用某变量的条件：
- `condition.cases[].when`
- `execute_when`
- `loop.while` / `loop.break_when`

---

## 4. 变量系统完整知识

### 4.1 引用语法

| 语法 | 含义 | Mock 数据来源 |
|------|------|-------------|
| `$vars.xxx` | VarPool 全局变量 | 上游节点的 `vars_update` 或 `outputs:` 映射 |
| `$node-id.output` | 前序节点 lastOutput | 该节点的 mock `output` 字段 |
| `$node-id.output.xxx` | 前序节点输出子字段 | 该节点的 mock `outputs` 或特定字段 |
| `$inputs.xxx` | 工作流输入参数 | TestScenario 的 `inputs` 字段 |
| `$last_output` | 当前节点自身输出 | 仅用于 `outputs:` 块内的自引用 |
| `$iteration` | loop 迭代计数（1-based） | Loop executor 自动提供 |

### 4.2 outputs: 映射 — 5 种表达式语法

```yaml
outputs:
  "$vars.result": "$last_output"                    # 1. 引用自身输出
  "$vars.status": "$last_output.status"             # 2. 引用输出子字段
  "$vars.choice": "$last_output"                    # 3. 写入 VarPool
  "$vars.count": "$vars.count + 1"                  # 4. 表达式计算
  "$vars.data": '"literal_string"'                  # 5. 字符串字面量（二次引号）
```

**注意**：`$vars.` 前缀在写入 pool 前被自动剥离。key 可以是 `"$vars.my_key"` 或 `"my_key"`。

### 4.3 表达式求值器（evaluateExpression）支持的操作符

| 操作符 | 语法 | 示例 |
|--------|------|------|
| 等值 | `==`, `!=` | `$vars.status == "passed"` |
| 数值比较 | `<`, `>`, `<=`, `>=` | `$vars.attempt < 5` |
| 逻辑与 | `&&` | `$vars.a == "x" && $vars.b == "y"` |
| 逻辑或 | `\|\|` | `$vars.a == "x" \|\| $vars.b == "y"` |
| 逻辑非 | `!` | `!$vars.done` |
| 集合成员 | `in` | `$vars.env in ['prod', 'uat']` |

**字符串必须加引号**: `$vars.status == "passed"` ✅ / `$vars.status == passed` ❌

**`"default"` 特殊值**: condition 节点的 `when: default` 始终返回 true，必须放最后。

---

## 5. Mock 数据生成规则（按节点类型）

### 5.1 Agent 节点

从 `prompt` 字段推断输出语义。如果有 `outputs:` 映射，为每个 key 生成有意义的 mock 值。

**Mock def 结构**（`AgentMockDef`）：
```yaml
agent-node-id:
  status: "completed"               # 或 "failed"
  output: "执行完毕的文本输出"       # → lastOutput + $last_output
  outputs:                          # → 额外 outputs 字段
    key: value
  update_vars:                      # → 直接写入 VarPool
    var_name: var_value
  error: "错误信息"                 # status=failed 时使用
```

**Mock 样例**（带 vars_update）：
```yaml
init:
  output: "初始化完成。分支: feat/my-feature, feature: my-feature"
  update_vars:
    branch: "feat/my-feature"
    feature: "my-feature"
    remote_type: "github"
```

**`__status` 控制信号**：可在 `update_vars` 中设 `__status: "failed"` 模拟业务失败：
```yaml
build:
  output: "编译失败: 3 个类型错误"
  update_vars:
    __status: "failed"
    error_detail: "3 type errors"
```

### 5.2 Bash 节点

从 `bash` 脚本内容推断输出。如果脚本是 `echo "..."` → mock output = echo 的内容（变量已替换）。如果脚本有副作用（curl/git/npm）→ 只 mock output。

**Mock def 结构**（`BashMockDef`）：
```yaml
bash-node-id:
  status: "completed"
  output: "脚本输出文本"
  exit_code: 0                      # 默认: status=failed ? 1 : 0
  outputs:
    key: value
  update_vars:
    var_name: var_value
```

### 5.3 Python 节点

与 Bash 节点结构相同（stdout + exit_code + vars_update 协议一致）。

**Mock def 结构**（`PythonMockDef`）：
```yaml
python-node-id:
  status: "completed"
  output: "脚本输出"
  exit_code: 0
```

### 5.4 Swarm 节点

整体 mock — 从 `topic` 和 `mode` 推断合理的共识结果。

**Mock def 结构**（`SwarmMockDef`）：
```yaml
swarm-node-id:
  status: "completed"
  output: "综合报告文本"
  update_vars:
    requirements_checklist_status: "COMPLETE"
```

**Swarm auto-vars**（引擎自动写入，无需 `outputs:` 映射）：

| Auto-var | 说明 |
|----------|------|
| `{nodeId}_synthesis` | Host 综合报告文本 |
| `{nodeId}_consensus_score` | 共识分数 0-1（debate 模式） |
| `{nodeId}_rounds_used` | 实际使用轮数 |
| `{nodeId}_expert_count` | 参与专家数 |
| `{nodeId}_experts` | JSON: `["role1", "role2"]` |
| `{nodeId}_history` | 完整讨论历史 JSON |
| `{nodeId}_task_breakdown` | 任务分解 JSON（dispatch 模式） |
| `{nodeId}_expert_outputs` | `[{ role, output }]` JSON |
| `{nodeId}_failed_experts` | 失败专家 JSON |
| `{nodeId}_budget_exhausted` | boolean |
| `{nodeId}_timeout_exceeded` | boolean |

节点 id 为 `idea-research` → auto-var 为 `$vars.idea-research_synthesis`、`$vars.idea-research_consensus_score` 等。

**⚠️ Auto-var 约束求解（生成 Swarm mock 的必做步骤）**：

Swarm 节点的 auto-vars 由真实引擎自动写入 VarPool，但模拟器中 `MockSwarmExecutor` 不会自动填充。你必须：

1. **扫描下游引用**：对每个 swarm 节点，搜索整个工作流中引用了 `$vars.{nodeId}_xxx` 的所有位置：
   - `execute_when` 表达式
   - `condition.cases[].when` 表达式
   - `loop.while` / `loop.break_when` 表达式
   - 下游节点的 `outputs:` 映射
   - 下游节点的 `prompt` / `bash` / `python` 脚本内容

2. **为被引用的 auto-vars 填充 mock 值**：在 swarm mock 的 `update_vars` 中显式设置每个被引用的 auto-var：

```yaml
# 示例：下游节点引用了 $vars.idea-research_synthesis 和 $vars.idea-research_consensus_score
idea-research:
  status: "completed"
  output: "需求分析报告：3 个核心需求已识别"
  update_vars:
    idea-research_synthesis: "需求分析报告：3 个核心需求已识别"
    idea-research_consensus_score: "0.85"
    idea-research_rounds_used: "2"
    idea-research_expert_count: "3"
    idea-research_experts: '["产品经理", "架构师", "安全专家"]'
    idea-research_budget_exhausted: "false"
    idea-research_timeout_exceeded: "false"
```

3. **按 swarm mode 设置合理默认值**：

| Mode | 关键 auto-vars | 建议默认值 |
|------|---------------|-----------|
| **review** | `_synthesis` | mock output 内容 |
| **debate** | `_synthesis`, `_consensus_score`, `_rounds_used` | score=0.8+, rounds=2 |
| **dispatch** | `_synthesis`, `_task_breakdown`, `_expert_outputs` | 分解 JSON + 各专家输出 |
| **swarm** | `_synthesis`, `_expert_count` | 动态路由结果 |
| **moa** | `_synthesis`, `_expert_outputs` | 聚合器综合结果 |

**规则：如果下游引用了某个 auto-var 但 mock 中没有设置，模拟器会产生空值 → 断言失败。宁可多设置几个 auto-var，也不要遗漏。**

### 5.5 Approval 节点

默认 choice = 第一个 option。如果需要测试拒绝路径，生成第二个 scenario。

**Mock def 结构**（`ApprovalMockDef`）：
```yaml
approval-node-id:
  choice: "proceed"                 # 必须匹配 options 中某个 value
  comment: "需求已明确"             # 可选
```

**Reject 判定**：choice 值为 `"reject"` / `"no"` / `"deny"` / `"abort"` → status = `"rejected"`

**Mock choice 必须匹配节点 `options[].value`**：
```yaml
# 节点定义
options:
  - { label: "继续", value: "continue" }
  - { label: "完成", value: "proceed" }
# → Mock choice 只能是 "continue" 或 "proceed"
```

### 5.6 Loop 节点

分析 `while` / `break_when` 条件，生成按迭代索引的 mock 数组。`update_vars` 必须最终满足终止条件。

**Mock def 结构**（`LoopMockDef`）：
```yaml
loop-node-id:
  iterations: 2                     # 预期迭代次数（可选）
  nodes:                            # 内部节点 mock
    inner-node-1:                   # 单一 mock → 所有迭代使用相同 mock
      output: "..."
      update_vars:
        counter: 3
    inner-node-2:                   # 数组 mock → 每轮使用不同 mock
      - output: "第一轮"
        update_vars: { status: "pending" }
      - output: "第二轮"
        update_vars: { status: "passed" }
```

**Loop mock 收敛约束**：
- `break_when` 引用的变量必须在某轮迭代后满足条件
- 内部节点的 mock 必须通过 `update_vars` 逐步改变控制变量
- 例：`break_when: '$vars.status == "passed"'` → 最后一轮 mock 必须设 `status: "passed"`

**Per-iteration 数组 mock**：
- 数组索引 = 迭代序号（0-based）
- 超出数组长度时 fallback 到最后一个元素
- 适用于模拟"第一次失败，第二次成功"等场景

### 5.7 Condition 节点

**不需要 mock**。Condition 节点基于 VarPool 当前值实际求值。

要让 condition 匹配特定 case，必须确保 VarPool 中相关变量的值满足该 case 的 `when` 表达式：
- 要让 `$vars.status == "passed"` 匹配 → 上游 mock 必须设置 `status: "passed"`
- 要走 `default` 分支 → 确保所有非 default case 都不匹配

---

## 6. Fixture 生成（`.test.yaml`）

### 6.1 文件结构

```yaml
scenarios:
  - name: "happy path"
    inputs:                         # 工作流输入参数（可选）
      idea: "添加用户认证功能"
    mocks:                          # 副作用节点 mock 定义
      init:
        output: "初始化完成"
        update_vars:
          branch: "feat/auth"
          feature: "auth"
      build:
        output: "构建成功"
        exit_code: 0
    assertions:                     # 断言定义
      status: "completed"
      vars:
        branch: "feat/auth"
      node_trace:
        executed: [init, build, deploy]
        skipped: [rollback]
```

### 6.2 场景生成策略

- **至少 1 个 happy path scenario**：所有节点按预期执行
- **可选 failure path scenario**：如果工作流有条件分支，测试失败路径
- **可选 retry scenario**：如果工作流有 loop + approval，测试重试路径

### 6.3 断言生成

5 种断言类型，按需组合：

```yaml
assertions:
  # 1. 工作流整体状态
  status: "completed"              # completed | failed | completed_with_failures | paused | cancelled

  # 2. VarPool 快照（关键变量值）
  vars:
    branch: "feat/my-feature"
    build_passed: "true"
    deploy_status: "success"

  # 3. 节点执行轨迹
  node_trace:
    executed: [init, build, test]  # 必须执行的节点
    skipped: [rollback, notify-error]  # 必须跳过的节点
    order: [init, build, test, deploy]  # 执行顺序（子序列匹配）

  # 4. 节点输出
  node_outputs:
    build:
      output: "构建成功"           # lastOutput
      outputs:                     # named outputs
        exit_code: 0
      status: "completed"

  # 5. 日志内容
  logs:
    build:
      contains: ["[mock] bash completed"]
      not_contains: ["error"]
```

---

## 7. 执行与迭代（闭环协议）

### 7.1 运行模拟器

```bash
pnpm exec octopus workflow simulate {workflow.yaml} --json
```

- `--json` 输出完整 JSON 结果（便于程序解析）
- 默认自动发现同目录 `{name}.test.yaml`
- 可用 `--test <path>` 指定其他 fixture
- 可用 `--scenario <name>` 运行单个场景

### 7.2 解析 JSON 结果

JSON 输出结构（`TestRunnerResult`）：

```json
{
  "results": [
    {
      "scenarioName": "happy path",
      "passed": true,
      "durationMs": 15,
      "status": "completed",
      "nodeResults": { "init": { "status": "completed", ... } },
      "poolSnapshot": { "branch": "feat/auth", ... },
      "executionTrace": [ { "nodeId": "init", "status": "completed", "mocked": true } ],
      "assertionReport": {
        "passed": true,
        "results": [
          { "name": "status", "passed": true, "message": "status = completed" },
          { "name": "vars.branch", "passed": true, "message": "vars.branch = \"feat/auth\"" }
        ]
      }
    }
  ],
  "totalDurationMs": 20,
  "passed": true,
  "passedCount": 1,
  "failedCount": 0
}
```

### 7.3 迭代修复流程

1. 运行 `octopus workflow simulate {wf.yaml} --json`
2. 如果 `passed: true` → 报告成功，退出
3. 如果 `passed: false` → 分析 `assertionReport.results` 中 `passed: false` 的条目：

| 失败类型 | 诊断方向 | 修复方法 |
|---------|---------|---------|
| `status` 不匹配 | 检查 mock 的 `status` 字段 | 修改导致失败的节点 mock |
| `vars.xxx` 不匹配 | 检查哪个节点的 `update_vars` 未正确设置 | 调整 mock 的 `update_vars` 或 `outputs` |
| `node_trace.executed` 缺失 | Condition 走了错误分支 | 调整上游 mock 让 VarPool 满足正确分支 |
| `node_trace.skipped` 未跳过 | execute_when 条件错误 | 调整控制变量的 mock 值 |
| `node_outputs` 不匹配 | mock output 文本不对 | 调整 mock 的 `output` 字段 |
| `logs` 不匹配 | mock 日志模式错误 | 调整断言中的日志模式或 mock 内容 |

4. 修改 `.test.yaml` → 重新运行（**最多 3 轮**）
5. 3 轮后仍失败 → 输出诊断报告

### 7.4 常见修复模式

**Condition 走错分支**：
```yaml
# 问题：condition 走了 default 而非预期 case
# 原因：VarPool 中变量值不满足 case.when
# 修复：调整上游 agent mock 的 update_vars
init:
  update_vars:
    severity: "critical"    # 确保 condition case when: '$vars.severity == "critical"' 匹配
```

**Loop 不终止**：
```yaml
# 问题：loop 迭代超过 max_iterations
# 原因：break_when 条件始终不满足
# 修复：确保最后一轮 mock 设置满足 break_when 的变量值
nodes:
  verify:
    - update_vars: { status: "pending" }    # 第 1 轮
    - update_vars: { status: "passed" }     # 第 2 轮 → 满足 break_when
```

**Approval reject 导致级联 skip**：
```yaml
# 问题：approval reject 后下游节点全部 skipped
# 修复：happy path 使用 approve choice；reject 用独立 scenario
```

---

## 8. 诊断报告（3 轮后仍失败时）

当 3 轮自动修复后测试仍未通过，输出以下结构化报告：

```markdown
# 测试诊断报告

## 持续失败的断言
- `vars.xxx`: expected "A", got "B" (3 轮均失败)
- `node_trace.executed.deploy`: 节点未执行 (3 轮均失败)

## 尝试过的修复
- Round 1: 修改 init mock 的 update_vars.branch 为 "feat/xxx"
- Round 2: 添加 condition-check 上游 mock 的 score 为 0.9
- Round 3: 调整 loop mock 的 per-iteration 数组

## 可能的根因
- 变量 X 的写入链不完整：init → build → condition，但 build 缺少 update_vars
- condition 的 when 表达式引用了未 mock 的变量

## 建议检查方向
1. 检查 build 节点的 outputs 映射是否正确写入 VarPool
2. 检查 condition 的 when 表达式语法（字符串必须加引号）
3. 考虑添加 --verbose 查看详细执行日志
4. 手动运行 `octopus workflow simulate {wf.yaml} --verbose` 分析
```

---

## 9. Mock 约束求解（生成高质量 mock 的关键）

### 约束 1: outputs 映射 → VarPool 填充

解析每个节点的 `outputs:` 块，确定哪些 VarPool key 会被设置。mock 的 `update_vars` 应覆盖这些 key。

### 约束 2: 下游条件 → 值约束

前向扫描所有引用某变量的 condition 表达式，确保 mock 值让预期路径匹配：

```
$vars.e2e_status 被引用在:
  - e2e-notify.execute_when: '$vars.e2e_status == "failed"'
  - e2e-approval.execute_when: '$vars.e2e_status == "failed"'
  - e2e-verify-loop.break_when: '$vars.e2e_status == "passed" || ...'

→ Happy path mock: e2e_status = "passed" (跳过 e2e-notify + e2e-approval)
→ Failure path mock: e2e_status = "failed" (触发通知 + 审批)
```

### 约束 3: Loop break_when → 迭代收敛

确保 loop 内部节点的 mock 值在某轮满足 break_when：

```yaml
# break_when: '$vars.clarify_decision == "proceed" && $vars.requirements_checklist_status == "COMPLETE"'
# → 最后一轮:
#   approval mock: { choice: "proceed" }
#   agent mock: { update_vars: { requirements_checklist_status: "COMPLETE" } }
```

### 约束 4: Approval options → 合法选择

Mock choice 必须匹配节点定义的 `options[].value`。

### 约束 5: $nodeId.output 引用 → 链式依赖

当节点引用 `$requirements-approval.output.comment` 时，approval mock 必须提供 `comment` 字段。

---

## 10. 严格模式（Strict Mode）

**默认开启**。所有副作用节点必须有 mock 定义，否则模拟器报错：

```
Strict mode: no mock definition found for side-effect node "build" (type: bash).
Add a mock definition in the test fixture or use --no-strict.
```

- `--no-strict` 让无 mock 的节点自动通过（输出空字符串）
- 生成 fixture 时始终为所有副作用节点提供 mock 定义
- Condition 节点永远不需要 mock（它基于 VarPool 实际求值）

---

## 11. 完整示例

### 工作流（simple-deploy.yaml）

```yaml
apiVersion: octopus/v1
kind: Workflow
name: simple-deploy
execution_mode: serial
variables:
  build_status: ""
  deploy_status: ""
nodes:
  - id: build
    type: bash
    bash: "npm run build"
    outputs:
      "$vars.build_status": "$last_output"
  - id: condition-check
    type: condition
    depends_on: [build]
    cases:
      - when: '$vars.build_status == "success"'
        then: deploy
      - when: default
        then: notify-failure
  - id: deploy
    type: agent
    depends_on: [condition-check]
    prompt: "部署到生产环境"
    outputs:
      "$vars.deploy_status": '"deployed"'
  - id: notify-failure
    type: bash
    depends_on: [condition-check]
    bash: "echo 'Build failed, notifying...'"
```

### 生成的 Fixture（simple-deploy.test.yaml）

```yaml
scenarios:
  - name: "happy path — build success"
    mocks:
      build:
        output: "success"
        exit_code: 0
      deploy:
        output: "部署完成"
      notify-failure:
        output: "Build failed, notifying..."
    assertions:
      status: "completed"
      vars:
        build_status: "success"
        deploy_status: "deployed"
      node_trace:
        executed: [build, condition-check, deploy]
        skipped: [notify-failure]
      node_outputs:
        build:
          output: "success"

  - name: "failure path — build fails"
    mocks:
      build:
        output: "error: compilation failed"
        status: "failed"
        exit_code: 1
      deploy:
        output: "部署完成"
      notify-failure:
        output: "Build failed, notifying..."
    assertions:
      status: "failed"
      node_trace:
        executed: [build]
        skipped: [condition-check, deploy, notify-failure]
```

---

## Constraints（硬性纪律）

- 每个副作用节点（agent/swarm/bash/python/approval）都必须有 mock 定义（strict 模式要求）
- Approval mock 的 `choice` 必须匹配节点 `options[].value`
- Loop mock 的 `update_vars` 必须在 N 轮内满足 `break_when` 条件
- 字符串比较必须加引号：`$vars.x == "value"` ✅ / `$vars.x == value` ❌
- Fixture 文件必须通过 `TestFixtureSchema` Zod 验证
- 最多 3 轮自动修复；超出则输出诊断报告，不继续迭代
- Condition 节点不需要 mock — 通过设置 VarPool 值来控制走向
- 每个 scenario 必须有 `assertions`（至少包含 `status`）
