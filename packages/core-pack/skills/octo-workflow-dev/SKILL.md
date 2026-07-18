---
name: octo-workflow-dev
description: 当用户需要创建、编辑、调试 Octopus YAML 工作流时使用——包括 agent/bash/python/condition/approval/loop/swarm 节点编写、子代理委派、skills 加载、Notify/Hook 配置、变量系统、DAG 编排、Auto Answers 无人值守。
---

# Octopus 工作流开发助手

YAML DSL 工作流引擎：7 种节点类型（agent / bash / python / condition / approval / loop / swarm）+ 子代理（agents）+ Skills 技能加载 + Notify/Hook 生命周期，通过变量池、表达式求值与 DAG 拓扑实现自动化编排。

> **Swarm 专家团节点** (`type: swarm`) 的完整指南见 `octo-swarm-dev` skill。

## 设计哲学（按重要性排序）

1. **Agent 是第一公民** — 优先用 agent 节点；bash/python 仅做确定性辅助。
2. **协调者 + 执行者分离** — 父 agent prompt 负责编排，重活（Write、Bash、Read 大量内容）交给 `agents` 子代理。
3. **复用外部角色** — 不要凭空造角色，先从 `agency-agents-zh`（215 个预定义角色）和 `superpowers-zh`（技能包）找。
4. **生命周期事件用 Notify 子系统** — 不在节点 prompt 里硬编码 hermes 命令；用 `hooks.on_node_success` + `notify` 类型。
5. **工作流不绑定技术栈** — 不写死 npm/mvn/gradle，让 agent 自动适配。

---

## 0. 权威来源 — Schema 与资源发现

### Workflow Schema（结构定义的唯一来源）

每个工作流 YAML 第一行应当声明：

```yaml
# yaml-language-server: $schema=~/.octopus/workflow-schema.json
apiVersion: octopus/v1
kind: Workflow
```

**完整 schema 定义路径**（写工作流 / 排查校验错误时去查）：

| 位置 | 用途 |
|------|------|
| `~/.octopus/workflow-schema.json` | 安装后路径（setup/sync 自动部署） |
| `packages/core-pack/workflows/workflow-schema.json` | 仓内源码（唯一真相） |

任何字段不确定（`hooks` / `agents` / `condition.cases` / `loop.break_when` / `inputs` 校验等）一律先查 schema，不要凭记忆下笔。

### 资源发现 — 写工作流前必须执行

工作流的 agent 节点和子代理应优先使用**本机已安装的资源**（agents / skills），不要凭记忆硬编码角色名。

**第一步：查询已安装资源**

```bash
# 列出已安装 agents 和 skills
node -e "const d=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.octopus/resources/registry.json','utf8'));d.resources.filter(r=>r.installed).forEach(r=>console.log(r.type,r.group+'/'+r.name,r.installPath))"
```

**第二步：根据任务选择角色**

从输出清单中选择与当前工作流任务匹配的 agents/skills。按 group 分类：

| Group | 说明 | 典型用途 |
|-------|------|---------|
| `agency-agents-zh` | 215+ 中文角色卡（产品/设计/工程/数据等） | agent_file 引用 |
| `superpowers-zh` | 中文技能包（脑暴/评审/文档等） | 节点 skills 加载 |
| `mattpocock-skills` | Matt Pocock 工程技能（TDD/调试/架构等） | 节点 skills 加载 |
| `gstack` | YC 工程团队角色（CEO 审查/安全/QA 等） | agent_file 引用 |
| `built-in` | Octopus 内置资源 | 直接引用 |

> **agent_file vs skills**：角色卡（有 system prompt + 人格）用 `agent_file`；技能包（纯能力/规范注入）用 `skills`。两者可组合——子代理同时设 `agent_file` + `skills`。

**第三步：使用 installPath 作为 agent_file**

```yaml
agents:
  product-manager:
    # ✅ 使用 installPath 完整路径
    agent_file: "~/.octopus/resources/installed/agents/agency-agents-zh/product-manager/product-manager.md"
    prompt: "..."
  devil-advocate:
    # ✅ core-pack 内置角色
    agent_file: "~/.octopus/resources/installed/agents/built-in/devil-advocate/devil-advocate.md"
    prompt: "..."
```

> **注意**：`agent_file` 路径 = `{installPath}/{name}.md`（agents）或 `{installPath}/SKILL.md`（skills）。
> 如果查询结果为空或找不到合适角色，再考虑内联 prompt 或 `octopus setup` 安装缺失资源。

---

## 1. Agent-First — 节点选择哲学

| 场景 | 推荐 | 原因 |
|------|------|------|
| 编排 / 决策 / 路由 | **agent** | 需要语义判断 |
| 文件读写 / 多步生成 / 长文档撰写 | **agent + 子代理** | 用 `agents` 委派，主 prompt 只编排 |
| 环境检测 / 构建 / 测试 / 修复 | **agent** | 自动适配项目 |
| 简单文件复制 / 目录创建 / 状态打印 | bash | 确定性，无需判断 |
| 复杂数据解析 / 转换 | python | 重型计算 |
| 通知 | **notify hook**（不是 bash） | 见 §3 |

> 经验法则：**只要需要"判断 + 写文件"，写 agent；只要 prompt 长度超过 80 行或要写多个文件，给它配 `agents` 子代理。**

---

## 2. Agent 节点 — 标准 prompt 模式 与 子代理委派

### 2.1 最小 agent 节点

```yaml
- id: greet
  type: agent
  prompt: |
    检查当前工作目录的 git 状态，列出文件，简要报告。
```

### 2.2 父代理 = 编排者，子代理 = 执行者（核心模式）

**当一个 agent 节点定义了 `agents`，主 prompt 应当只做编排**：拆任务 → 委派子代理 → 收集结论。**真正的 Write、Bash、长文输出都应该交给子代理**，避免污染父代理上下文。

```yaml
- id: design
  type: agent
  model: pro-max
  agents:
    devil-advocate:
      description: "魔鬼代言人 — 审查方案完整性。默认立场 INCOMPLETE。"
      agent_file: "~/.octopus/resources/installed/agents/built-in/devil-advocate/devil-advocate.md"
      model: pro-max
      tools: ["Read", "Grep", "Write"]
      prompt: |
        审查 $vars.solution_file，使用 Write 工具直接写入
        $vars.output_dir/03-solution.challenges.devil.md。
        Write 完成后只返回 1 行确认。
  prompt: |
    你是协调者。子代理直接 Write 报告文件，你只做：
    1. 委派 devil-advocate
    2. 文件就位后生成轻量索引（不复述正文）

    ## 输出 JSON（最后一行）
    {"vars_update":{"challenge_file":"$vars.output_dir/03-solution.challenges.index.md","conclusion":"<2-3 句>"}}
```

**子代理纪律**：

- 父 prompt **不要**逐字复述子代理报告内容；让子代理 `Write` 落盘，父代理只读"摘要 section"。
- 子代理用 `agent_file` 引用已安装资源（通过资源发现查询 registry.json），避免重写 system prompt。
- 子代理 `tools` 白名单收紧到必需项（`Read` / `Write` / `Grep` / `Bash`）。
- 子代理输出协议：返回 1 行确认即可，长文必须 Write 到磁盘。
- 视觉/截图分析必须放子代理（防止图片数据污染主 session）。

### 2.3 标准模式 vs Goal 模式

```yaml
# 标准模式 — 你写 prompt，agent 执行
- id: translate
  type: agent
  prompt: "将 $vars.text 翻译成英文。"

# Goal 模式 — 给目标 + 约束，agent 自己规划
- id: analyze
  type: agent
  goal: "分析 issue #$vars.issue_id 的根因，输出 JSON {root_cause, severity}"
  constraints:
    - "只读 src/ 和 tests/ 目录"
    - "不修改任何文件"
  planning:
    tools: [Read, Grep, Glob, Bash]
    disallowed_tools: [Write, Edit]
    verify: true
  outputs:
    severity: "$last_output.severity"
```

| 字段 | 仅 Goal | 说明 |
|------|---------|------|
| `goal` | ✅ | 高层目标，与 `prompt` 互斥 |
| `constraints` | ✅ | 自然语言软约束，写进 prompt |
| `planning.tools` / `disallowed_tools` | ✅ | 当前是 prompt 层软约束，不是硬过滤 |
| `planning.verify` | ✅ | 在 Instructions 末尾追加"验证结果"步骤 |
| `planning.max_turns` | ⚠️ 未生效 | 用 `timeout` 控制 |
| `agents` 子代理 | ❌ | Goal 模式下不支持，必须用标准 prompt |

**Goal 模式必须在 goal 末尾写明 JSON 输出格式**，否则 `outputs` 映射失败。

### 2.4 Skills — 按需加载技能包

Agent 节点和子代理都支持 `skills` 字段，引擎启动时自动加载 SKILL.md 内容注入上下文。**Prompt 只需声明"用哪个 skill 做什么"，不要重复 skill 里已有的指令和细节。**

```yaml
# agent 节点加载 skills
- id: create-skill
  type: agent
  skills: ["octo-skill-creator"]
  prompt: |
    使用 octo-skill-creator 为用户创建一个新 skill。
    需求：$vars.skill_requirement

# 子代理加载 skills
agents:
  doc-writer:
    description: "文档撰写专家"
    agent_file: "~/.octopus/resources/installed/agents/agency-agents-zh/technical-writer/technical-writer.md"
    skills: ["chinese-documentation"]
    prompt: |
      使用 chinese-documentation skill 的排版规范，
      撰写 $vars.feature_name 的技术文档，Write 到 $vars.output_dir/docs/。
```

**Prompt 与 Skill 分工纪律**：

| 该写 | 不该写 |
|------|--------|
| "使用 {skill-name} 完成 X" | 重复 skill 内的具体步骤、规则、模板 |
| 编排顺序（先 skill A 后 skill B） | skill 里已定义的参数、格式、约束 |
| 业务目标 + 输入/输出约定 | skill SKILL.md 中已有的指令内容 |

> **原则**：Skill 是"能力注入"，prompt 是"任务编排"。Prompt 复述 skill 内容 = token 浪费 + 指令冲突风险。

### 2.5 Agent 输出协议（vars_update / __status）

Agent 在回复**最后一行**输出纯 JSON（不要用代码块包裹）：

```json
{"vars_update":{"build_passed":"true","conclusion":"<2-3 句>"}}
```

`__status` 是控制信号（不写入变量池）：

| 值 | 效果 |
|----|------|
| `"failed"` | 节点标记 failed → 引擎停止后续节点 |
| 不设置 | 节点正常 completed |

`__status` 优先级高于 exit code，bash/agent/python 三种节点通用。**不要用 `exit 1` 标记业务失败**。

### 2.6 model 字段

可用：`pro-max`（最强）/ `pro`（均衡，默认）/ `se`（轻量）。自定义变体：`pro-max-{suffix}` / `pro-{suffix}`。不写继承 `--model` 参数。

---

## 3. Notify 子系统 — 结构化通知

不要在 bash 节点里硬编码 `hermes send`。Octopus 提供 `providers` + `channels` + `notify` hook 三件套。

### 3.1 三段式配置

```yaml
providers:                              # 后端
  hermes-cli:
    type: hermes                        # hermes | webhook
    timeout: 30
    min_severity: info                  # 低于此级别静默丢弃

channels:                               # 通道（绑定 provider + target）
  default:
    provider: hermes-cli
    target: "telegram:xzf_hermes"
  oncall:
    provider: hermes-cli
    target: "telegram:oncall"
    min_severity: error                 # 通道级过滤覆盖 provider 级
```

### 3.2 在 hooks 中使用 notify

```yaml
hooks:
  on_node_success:
    - id: notify-build
      type: notify                      # ⭐ 类型 notify，引擎自动走通知子系统
      nodes: [build]                    # 只对这些节点触发
      channel: default                  # 引用 channels.default
      condition: '$vars.build_passed == "true"'
      template:
        severity: info                  # info | warn | error
        title: "✅ $vars.display_name — 构建通过"
        body: "📦 输出: $vars.artifact\n📊 大小: ${vars.size | default:unknown}\n💡 $vars.conclusion"
      on_failure: log                   # log | retry | abort
      retry:
        max_attempts: 3
```

### 3.3 模板变量与过滤器

模板支持 `$vars.*` / `$inputs.*` / `$hook.*` / `$nodeId.output.*` / `$notify.*`，以及：

- 默认值：`${vars.x | default:unknown}`
- duration 格式化：`${hook.total_duration_ms | duration}`
- 条件块（最多 3 层嵌套）：`{{#if challenge_count}}😈 $vars.challenge_count 条{{/if}}`

> **webhook provider**：`type: webhook` + `url` + `headers`，SSRF 保护默认拒绝私网 IP。

---

## 4. Hook 系统 — 工作流生命周期

`hooks` 顶层字段映射事件类型 → hook 数组。所有 hook 共享类型枚举 `agent | bash | notify`。

| 事件 | 触发时机 | 常见用途 |
|------|---------|---------|
| `on_node_success` | 节点成功完成（含跳过） | 阶段进度通知 |
| `on_node_failure` | 节点失败 | 失败告警 |
| `on_workflow_failure` | 工作流终止 | 总览失败原因 |
| `on_success` | 工作流整体成功 | 庆祝 / 上线 |
| `on_complete` | 无论成功失败完成时 | 计数统计 |
| `on_cancel` | 用户主动取消 | 清理资源 |
| `on_interrupt` | 进程中断（如崩溃） | 标记中断状态 |
| `on_retry` | 节点重试时 | 记录重试次数 |
| `on_swarm_start` | Swarm 节点开始执行 | Swarm 进度通知 |
| `on_expert_spawn` | 专家实例启动 | 追踪专家分配 |
| `on_expert_complete` | 专家执行完成 | 专家输出审计 |
| `on_swarm_round_end` | debate 模式一轮结束 | 轮次进度通知 |
| `on_swarm_consensus` | 共识评估完成 | 共识分数监控 |
| `on_swarm_complete` | Swarm 节点全部完成 | Swarm 结果通知 |

### 4.1 三种 hook 类型

```yaml
hooks:
  on_node_success:
    # ① notify — 推荐用于通知
    - id: notify-stage
      type: notify
      nodes: [setup]
      channel: default
      template: { severity: info, title: "🔨 启动", body: "📂 $vars.output_dir" }

    # ② bash — 副作用脚本
    - id: cleanup-tmp
      type: bash
      nodes: [done]
      timeout: 30
      bash: |
        rm -rf $vars.tmp_dir 2>&1 || true
        echo "cleaned"

    # ③ agent — 智能后处理
    - id: summarize
      type: agent
      nodes: [output]
      timeout: 120
      prompt: |
        阅读 $vars.final_prd_file 的前 200 行，生成一句话发布通告。
```

### 4.2 hook 上下文变量与过滤

hook prompt / template / bash 中可用 `$hook.*`：`failed_node_id` / `error` / `final_status` / `completed_count` / `skipped_count` / `failed_count` / `total_count` / `total_duration_ms` / `interrupt_reason`。另可访问 `$vars.*` / `$inputs.*`。

`on_node_*` 事件支持 `nodes: [id1, id2]` 限定生效节点；不写则对所有节点触发。`condition` 可进一步用表达式过滤。

---

## 5. 节点类型速查

```yaml
# bash — 副作用脚本
- id: cleanup
  type: bash
  bash: rm -rf $vars.tmp_dir
  timeout: 15

# python — inputs 注入为环境变量，stdout 即输出
- id: parse
  type: python
  inputs:
    threshold: "0.8"
  python: |
    import os
    print(float(os.environ["threshold"]))

# condition — 首个匹配 case 跳转
- id: route
  type: condition
  cases:
    - when: '$vars.severity == "critical"'
      then: urgent-fix          # 也可以写 jumpTo
    - when: default              # 必须最后
      then: standard-fix

# approval — 人工审批
- id: deploy-gate
  type: approval
  options:
    - { label: "批准", value: "approved" }
    - { label: "拒绝", value: "rejected" }
  approval_timeout: 3600         # 0 = 无人值守立即超时
  on_reject: rollback            # 拒绝时跳转

# loop — 循环
- id: retry-deploy
  type: loop
  while: '$vars.attempt < 5'
  break_when: '$vars.deploy_status == "success"'
  max_iterations: 5
  nodes:
    - id: try
      type: agent
      prompt: "第 $iteration 次尝试部署..."
```

> **️ Loop 子节点必须显式声明 `depends_on`**
>
> Loop 内的子节点**不会自动按数组顺序执行**。没有 `depends_on` 的节点在 DAG 中无边，会导致：
> - **前端可视化**：所有子节点重叠在同一位置（dagre 无法布局）
> - **执行语义**：节点可能并行执行而非顺序执行（`execution_mode: auto` 时）
>
> ```yaml
> # ❌ 错误 — 没有 depends_on，节点关系不明确
> nodes:
>   - id: step-a
>   - id: step-b
>   - id: step-c
>
> # ✅ 正确 — 显式声明顺序依赖
> nodes:
>   - id: step-a
>   - id: step-b
>     depends_on: [step-a]
>   - id: step-c
>     depends_on: [step-b]
> ```
>
> 即使工作流是 `execution_mode: serial`，loop 子节点仍需要 `depends_on` 来保证前端可视化正确。

### 5.1 Swarm — 多专家协作节点

`type: swarm` 实现多专家协作编排（4 种模式：review / debate / dispatch / swarm）。完整指南见 **`octo-swarm-dev`** skill。

```yaml
# 最小 swarm 节点 — review 模式
- id: review
  type: swarm
  topic: "审查以下代码: $vars.code"
  mode: review
  experts:
    - role: security-engineer
      perspective: "专注于安全漏洞"
      prompt: "审查安全问题"
    - role: code-reviewer
      perspective: "专注于代码质量"
      prompt: "审查质量"

# 自动输出到变量池
# $vars.review_synthesis — Host 综合报告
# $vars.review_expert_count — 专家数
```

| 模式 | 场景 | 特点 |
|------|------|------|
| `review` | 代码审查、安全审计 | 1 轮并行，Host 综合 |
| `debate` | 技术选型、架构决策 | 多轮讨论 + 共识检查 |
| `dispatch` | 全栈开发、多步任务 | DAG 依赖调度 |
| `swarm` | 故障诊断、开放问题 | Router 自动选模式和专家 |
| `moa` | 多模型综合分析 | Fan-out + Aggregator 聚合，支持跨 Provider |

---

## 6. 变量与表达式

### 6.1 引用语法

| 语法 | 含义 | 可用位置 |
|------|------|---------|
| `$vars.xxx` | 全局变量池 | 所有节点 |
| `$node_id.output` | 前序节点 stdout | 后续节点 |
| `$node_id.output.xxx` | 前序节点输出子字段 | 后续节点 |
| `$inputs.xxx` | 工作流输入参数 | 任意节点 |
| `$last_output` | 当前节点自身输出 | outputs 块 |
| `$iteration` | loop 当前迭代（1-based） | loop 子节点 |
| `$ref:flow.yaml.node.key` | 跨执行引用 | 所有节点 |
| `$parent.var_pool.xxx` | 父执行变量池 | 子工作流节点 |
| `$parent.input_values.xxx` | 父执行输入参数 | 子工作流节点 |
| `$parent.$nodeId.outputs.xxx` | 父执行特定节点输出 | 子工作流节点 |
| `$ancestor[N].var_pool.xxx` | N 级祖先变量池 (0=parent) | 嵌套子工作流 |
| `$ancestor[N].$nodeId.outputs.xxx` | N 级祖先节点输出 | 嵌套子工作流 |

### 6.2 outputs — 写入变量池

```yaml
outputs:
  "$vars.result":  "$last_output"           # stdout
  "$vars.status":  '"ok"'                   # 字符串字面量需二次引号
  "$vars.count":   '$vars.count + 1'        # 表达式
```

### 6.3 跨执行引用（$ref:）

```yaml
prompt: "上次扫描结果：$ref:security-scan.yaml.scan.vulnerabilities"
```

语法 `$ref:{workflow}.{node}.{key}`，从后往前解析；查询同 workspace 下该工作流最近一次 `completed` 状态节点的输出；解析失败保持原文不阻断执行。

---

## 7. 执行流程

### 7.1 串行 vs DAG 并行

```yaml
execution_mode: serial          # 强制顺序
# 或
execution_mode: auto            # 默认；按 depends_on 计算 DAG，无依赖的同层节点并行
max_concurrent: 3               # 同层并发上限
```

```yaml
nodes:
  - id: analyze
  - id: review-code
    depends_on: [analyze]
  - id: review-security
    depends_on: [analyze]       # 与 review-code 并行
  - id: summary
    depends_on: [review-code, review-security]
```

> **DAG 完整性纪律 — 不允许断裂链**
>
> `execution_mode: auto`（默认）下引擎按 `depends_on` 构建 DAG。**除入口节点外，每个节点必须显式声明 `depends_on`**。遗漏 = 断裂点，后果：
>
> | 症状 | 原因 |
> |------|------|
> | 节点意外并行 | 无边 → 引擎视为独立根节点，与其他根并行执行 |
> | 前端可视化节点重叠 | dagre 布局算法无法推断层级 |
> | 下游节点拿到空变量 | 上游还没跑完就被调度 |
> | 执行顺序与预期不符 | 数组顺序 ≠ 执行顺序，只有 `depends_on` 才决定顺序 |
>
> ```yaml
> # ❌ 断裂 — setup 和 build 没有依赖关系，会并行跑
> nodes:
>   - id: setup
>   - id: build          # 缺 depends_on: [setup]
>   - id: test
>     depends_on: [build]
>
> # ✅ 完整链 — 每个非入口节点都有明确上游
> nodes:
>   - id: setup
>   - id: build
>     depends_on: [setup]
>   - id: test
>     depends_on: [build]
> ```
>
> **自检方法**：从最后一个节点反向追溯 `depends_on`，每条路径必须能追溯到某个入口节点。任何中间断开的节点 = 断裂点。

### 7.2 execute_when — 跳过节点

```yaml
- id: optional
  type: agent
  execute_when: '$inputs.enable_x == "true"'
  prompt: "..."
```

falsy → 跳过（不计为失败）。可与 `condition` 节点组合，用 `execute_when` 替代显式 condition gate（参考 prd-forge 的 `ui-design` / `ux-flow`）。

---

## 8. Auto Answers — 无人值守

```yaml
auto_answers:                              # 全局兜底
  - pattern: ".*"
    answer: "proceed"

nodes:
  - id: deploy
    type: agent
    auto_answers:                          # 节点级，与全局合并
      - pattern: "是否继续"
        answer: "yes"
```

---

## 9. 常用模式

### 9.1 Agent 驱动验证修复循环

```yaml
- id: fix-loop
  type: loop
  max_iterations: 3
  break_when: '$vars.all_passed == "true"'
  nodes:
    - id: verify-and-fix
      type: agent
      timeout: 3600
      prompt: |
        第 $iteration 轮验证：检测 lint/build/test，失败直接修复并重试。
        最后一行：
        {"vars_update":{"all_passed":"<true|false>","failure_summary":"<摘要>"}}
```

### 9.2 视觉隔离（截图分析必用子代理）

```yaml
- id: e2e-test
  type: agent
  agents:
    vision-analyzer:
      description: "分析截图。需要看图时必须委派此子代理。"
      agent_file: "~/.octopus/resources/installed/agents/built-in/vision-analyzer/vision-analyzer.md"
      model: pro
      tools: ["Bash", "Read"]
  prompt: |
    执行 E2E 测试。需要分析截图时委派 vision-analyzer，**只取它返回的文本结论**。
```

### 9.3 多审查者并行 + 索引收敛（避免 token 冗余）

参考 prd-forge.yaml 的 `challenge-design`：三个子代理各自 `Write` 自己的报告文件，父 agent 只生成一份索引文件。

### 多项目 Workspace Ship 模式

Octopus workspace 可包含多个 git 项目（worktree 开发空间），所有项目共享同一开发分支。Ship 阶段需要遍历所有项目，为每个有变更的项目创建 PR/MR。

```yaml
- id: ship
  type: agent
  depends_on: [execution-loop]
  skills: [octo-xzf-ship]
  tools: [Read, Bash, Grep, Glob]
  prompt: |
    1. 生成统一的 PR/MR Summary → 写入 09-ship/summary.md
    2. 读取 workspace-topology.md 获取项目列表
    3. 遍历每个项目:
       - git diff --quiet main...HEAD → 无变更则跳过
       - 有变更: gh pr create / glab mr create（标题带 [{project}] 前缀）
    4. 汇总所有 PR/MR URL
```

关键点：
- **workspace-topology.md** 在 init 阶段扫描生成，列出所有项目路径和 remote 类型
- 每个项目独立检测变更（`git diff`），只为有改动的项目创建 PR
- PR 标题加 `[{project}]` 前缀区分项目
- 所有项目共用同一份 summary.md 作为 PR body

---

## 10. 验证与运行

```bash
octopus workflow validate ./my-workflow.yaml          # 校验
octopus workflow run ./deploy.yaml --org {org}         # 运行
octopus workflow run ./deploy.yaml --org {org} --model pro-max --engine claude
```

> 校验失败的 YAML 在 Web-App 下拉列表中**不显示**（服务端静默过滤）。线上看不到工作流时先跑 `validate`。常见错误：`apiVersion` 格式错、`inputs` 值非对象、`goal` 与 `prompt` 互斥、`condition` 缺 `default`、节点 `id` 重复。

---

## Constraints（硬性纪律）

- 工作流必须包含 `apiVersion: octopus/v1` 与 `kind: Workflow`，并在文件头部声明 `# yaml-language-server: $schema=...workflow-schema.json`。
- 节点 `id` 在工作流内唯一；`depends_on` 引用必须存在。
- **DAG 链不允许断裂** — `execution_mode: auto` 下，除入口节点外每个节点必须显式声明 `depends_on`。遗漏 = 节点意外并行 + 变量空值 + 可视化重叠。写完从末节点反向追溯到入口，确认无断点。
- **Loop 子节点必须显式声明 `depends_on`** — 即使 `execution_mode: serial`，loop 内节点也需明确依赖关系，否则前端可视化会重叠、执行顺序不确定。
- `condition.cases` 的 `when: default` 必须放最后。
- `agent` 节点必须有 `agent` / `prompt` / `goal` / `agents` 之一；`goal` 与 `prompt` 互斥。
- **当节点定义了 `agents`，主 prompt 只编排不执行重活；Write/Bash 由子代理负责**。
- 子代理优先 `agent_file` 引用已安装资源（通过 §0 资源发现查询 registry.json），避免重写 system prompt。
- 通知一律走 `providers + channels + notify hook`，禁止在 bash 节点里硬编码 `hermes send`。
- 节点失败用 `__status: "failed"` 标记，**不要用 `exit 1`**。
- 字符串字面量在 outputs 中需二次引号：`"$vars.x": '"hello"'`。
- `context: continue` 仅在前一个节点也是 agent 时有效。
- 工作流不绑定技术栈 — 不在 YAML 中硬编码 npm/mvn/gradle，让 agent 自动检测。
- **Prompt 不复述 Skill 内容** — `skills` 字段加载的 SKILL.md 已注入上下文，prompt 只声明"用哪个 skill + 做什么"，不重复 skill 内的步骤/规则/模板。
- 视觉/截图分析必须用子代理隔离，防止图片数据污染主 session。
- 任何字段不确定先查 `~/.octopus/workflow-schema.json`（源码 `packages/core-pack/workflows/workflow-schema.json`），不要凭记忆写。
