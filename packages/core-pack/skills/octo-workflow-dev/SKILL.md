---
name: octo-workflow-dev
description: Octopus 工作流开发助手 — YAML 工作流设计、Agent-First 节点哲学、子代理委派、Notify/Hook 子系统、外部角色复用（superpowers-zh / agency-agents-zh）、变量系统、跨执行引用、无人值守模式
category: coding-assistant
tags: [octopus, workflow, YAML, agent, subagent, notify, hooks, goal, bash, python, condition, approval, loop, swarm, agency-agents-zh, superpowers-zh, schema]
---

# Octopus 工作流开发助手

YAML DSL 工作流引擎：7 种节点类型（agent / bash / python / condition / approval / loop / swarm）+ 子代理（agents）+ Notify/Hook 生命周期，通过变量池、表达式求值与 DAG 拓扑实现自动化编排。

> **Swarm 专家团节点** (`type: swarm`) 的完整指南见 `octo-swarm-dev` skill。

## 设计哲学（按重要性排序）

1. **Agent 是第一公民** — 优先用 agent 节点；bash/python 仅做确定性辅助。
2. **协调者 + 执行者分离** — 父 agent prompt 负责编排，重活（Write、Bash、Read 大量内容）交给 `agents` 子代理。
3. **复用外部角色** — 不要凭空造角色，先从 `agency-agents-zh`（215 个预定义角色）和 `superpowers-zh`（技能包）找。
4. **生命周期事件用 Notify 子系统** — 不在节点 prompt 里硬编码 hermes 命令；用 `hooks.on_node_success` + `notify` 类型。
5. **工作流不绑定技术栈** — 不写死 npm/mvn/gradle，让 agent 自动适配。

---

## 0. 权威来源 — Schema 与外部依赖

### Workflow Schema（结构定义的唯一来源）

每个工作流 YAML 第一行应当声明：

```yaml
# yaml-language-server: $schema=../../workflows/workflow-schema.json
apiVersion: octopus/v1
kind: Workflow
```

**完整 schema 定义路径**（写工作流 / 排查校验错误时去查）：

| 位置 | 用途 |
|------|------|
| `packages/core-pack/workflows/workflow-schema.json` | 仓内权威源（唯一真相） |
| 相对路径 `../../workflows/workflow-schema.json` | 从 workflows/ 子目录引用 |

任何字段不确定（`hooks` / `agents` / `condition.cases` / `loop.break_when` / `inputs` 校验等）一律先查 schema，不要凭记忆下笔。

### 外部角色与技能开源依赖（强烈推荐复用）

工作流的 agent / 子代理优先复用以下两个开源项目，避免重复造轮。

| 项目 | 类型 | 复用方式 | 备注 |
|------|------|---------|------|
| [agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) | 中文 agent 角色卡（产品 / 设计 / 工程 / 数据 等 215 个） | `agents.<name>.agent_file` 引用 `.claude/agents/<name>.md` | 每个 agent 是带 frontmatter 的 markdown，引擎读取后剥离 frontmatter 拼接到 system prompt |
| [superpowers-zh](https://www.npmjs.com/package/superpowers-zh) | 中文技能包（脑暴 / 评审 / 文档 等） | `npx superpowers-zh@latest --tool claude --force` 安装到 `.claude/skills/` | 安装后通过节点的 `skills` 字段加载 |

**典型 Setup 步骤模板**（在工作流第一个 agent 节点中执行）：

````yaml
- id: setup
  type: agent
  timeout: 600
  prompt: |
    ### 1. 安装 superpowers-zh 技能
    ```bash
    npx superpowers-zh@latest --tool claude --force 2>&1 | head -5
    ```

    ### 2. 安装 agency-agents-zh 角色（缺失才克隆）
    ```bash
    AGENTS_TARGET="$(pwd)/.claude/agents"
    mkdir -p "$AGENTS_TARGET"

    NEED_CLONE=false
    for agent in product-manager design-ux-architect engineering-software-architect; do
      [ -f "$AGENTS_TARGET/$agent.md" ] || NEED_CLONE=true
    done

    if [ "$NEED_CLONE" = "true" ]; then
      DEPS_DIR="$(pwd)/dependencies"
      mkdir -p "$DEPS_DIR"
      [ -d "$DEPS_DIR/agency-agents-zh" ] || \
        git clone --depth 1 https://github.com/jnMetaCode/agency-agents-zh.git "$DEPS_DIR/agency-agents-zh"
      REPO="$DEPS_DIR/agency-agents-zh"
      cp "$REPO/product/product-manager.md"                 "$AGENTS_TARGET/" 2>/dev/null || true
      cp "$REPO/design/design-ux-architect.md"              "$AGENTS_TARGET/" 2>/dev/null || true
      cp "$REPO/engineering/engineering-software-architect.md" "$AGENTS_TARGET/" 2>/dev/null || true
    fi
    ```

    ### 3. 安装 core-pack 内置角色（devil-advocate / architecture-explorer / vision-analyzer）
    在以下候选路径里取第一个存在的并复制到 .claude/agents/：
    - $(pwd)/.octopus/core-pack/agents
    - $(pwd)/packages/core-pack/agents
    - $(pwd)/../core-pack/agents
````

> 角色目录约定：所有 agent 角色卡放 `.claude/agents/`；所有技能放 `.claude/skills/`。引擎读取 `agent_file` 时会自动剥离 YAML frontmatter，把正文拼到子代理的 system prompt。

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
  model: pro-max[1m]
  agents:
    devil-advocate:
      description: "魔鬼代言人 — 审查方案完整性。默认立场 INCOMPLETE。"
      agent_file: ".claude/agents/devil-advocate.md"     # ⭐ 引用外部角色
      model: pro-max[1m]
      tools: ["Read", "Grep", "Write"]
      prompt: |
        审查 $vars.solution_file，使用 Write 工具直接写入
        $vars.output_dir/03-solution.challenges.devil.md。
        Write 完成后只返回 1 行确认。
    feasibility-reviewer:
      description: "可行性审查者 — 审查技术可行性。"
      agent_file: ".claude/agents/engineering-software-architect.md"
      model: pro-max[1m]
      tools: ["Read", "Grep", "Write"]
      prompt: |
        审查 $vars.solution_file 的工作量与单点故障，使用 Write 写入
        $vars.output_dir/03-solution.challenges.feasibility.md。
  prompt: |
    你是协调者。**三个子代理各自直接 Write 自己的报告文件**，你只做：
    1. 并行委派 devil-advocate / feasibility-reviewer
    2. 三个文件就位后，**不要重新合并三份内容**（避免冗余 token），只生成一份轻量索引

    ## 输出 JSON（最后一行）
    {"vars_update":{"challenge_file":"$vars.output_dir/03-solution.challenges.index.md","conclusion":"<2-3 句>"}}
```

**子代理纪律**：

- 父 prompt **不要**逐字复述子代理报告内容；让子代理 `Write` 落盘，父代理只读"摘要 section"。
- 子代理用 `agent_file` 引用现成角色卡（如 `agency-agents-zh` 的 product-manager / engineering-software-architect / design-ui-designer / design-ux-architect）。
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

### 2.4 Agent 输出协议（vars_update / __status）

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

### 3.4 webhook provider

```yaml
providers:
  slack-webhook:
    type: webhook
    url: "https://hooks.slack.com/services/XXX"
    method: POST                        # POST | PUT
    headers:
      Authorization: "Bearer $vars.slack_token"
```

> SSRF 保护：webhook URL 默认拒绝私网 IP / localhost / 云元数据端点。

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

### 4.2 hook 上下文变量

hook prompt / template / bash 中可用：

| 变量 | 说明 |
|------|------|
| `$hook.failed_node_id` | on_*_failure 时的失败节点 |
| `$hook.error` | 错误消息 |
| `$hook.final_status` | on_complete 时的最终状态 |
| `$hook.completed_count` / `skipped_count` / `failed_count` / `total_count` | 节点计数 |
| `$hook.total_duration_ms` | 工作流总耗时（毫秒） |
| `$hook.interrupt_reason` | on_interrupt 原因 |
| `$vars.*` / `$inputs.*` | 工作流变量与输入 |

### 4.3 hook 节点过滤

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

### 9.1 父代理编排 + 子代理写文件 + Notify 通知（推荐主架构）

```yaml
hooks:
  on_node_success:
    - id: notify-design
      type: notify
      nodes: [design]
      channel: default
      template:
        severity: info
        title: "🏗️ 设计完成"
        body: "📄 $vars.solution_file\n💡 $vars.conclusion"

nodes:
  - id: design
    type: agent
    agents:
      engineering-software-architect:
        agent_file: ".claude/agents/engineering-software-architect.md"
        tools: [Read, Write, Grep]
        prompt: "Write 技术方案到 $vars.output_dir/03-solution.md"
    prompt: |
      委派 engineering-software-architect 完成方案撰写。
      你不要复述方案正文，仅在最后一行输出：
      {"vars_update":{"solution_file":"$vars.output_dir/03-solution.md","conclusion":"<2-3 句>"}}
```

### 9.2 Agent 驱动验证修复循环

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

### 9.3 视觉隔离（截图分析必用子代理）

```yaml
- id: e2e-test
  type: agent
  agents:
    vision-analyzer:
      description: "分析截图。需要看图时必须委派此子代理。"
      agent_file: ".claude/agents/vision-analyzer.md"
      model: pro
      tools: ["Bash", "Read"]
  prompt: |
    执行 E2E 测试。需要分析截图时委派 vision-analyzer，**只取它返回的文本结论**。
```

### 9.4 多审查者并行 + 索引收敛（避免 token 冗余）

参考 prd-forge.yaml 的 `challenge-design`：三个子代理（devil-advocate / feasibility-reviewer / architecture-explorer）各自 `Write` 自己的报告文件，父 agent 只生成一份指向三份报告的索引文件。

---

## 10. 验证与运行

### 10.1 校验

```bash
# 推荐：内置 CLI（Zod schema + 语义规则）
octopus workflow validate ./my-workflow.yaml

# 备用：独立脚本（不依赖 CLI）
node .claude/skills/octo-workflow-dev/scripts/validate-workflow.bundle.js ./workflows/*.yaml
```

| 错误 | 原因 | 修法 |
|------|------|------|
| `apiVersion must match octopus/v{number}` | 写成了 `octopus/v1.0.0` | `apiVersion: octopus/v1` |
| `inputs.xxx: Expected object` | input 值是裸字符串 | `xxx: { description: "..." }` |
| `agent 节点必须有 agent/prompt/agents/goal` | 缺必需字段 | 至少给一个 |
| `goal 与 prompt 互斥` | 两个都写了 | 删一个 |
| `condition 缺少 default 兜底` | 全部 case 都没匹配时无路径 | 末尾加 `when: default` |
| `duplicate id` | 节点 id 重复 | 改唯一 |

> 校验失败的 YAML 在 Web-App 下拉列表中**不显示**（服务端静默过滤）。线上看不到工作流时一律先跑 `octopus workflow validate`。

### 10.2 运行

```bash
octopus workflow run ./deploy.yaml --org {org}
octopus workflow run ./deploy.yaml --org {org} --model pro-max --engine claude
```

---

## Constraints（硬性纪律）

- 工作流必须包含 `apiVersion: octopus/v1` 与 `kind: Workflow`，并在文件头部声明 `# yaml-language-server: $schema=...workflow-schema.json`。
- 节点 `id` 在工作流内唯一；`depends_on` 引用必须存在。
- `condition.cases` 的 `when: default` 必须放最后。
- `agent` 节点必须有 `agent` / `prompt` / `goal` / `agents` 之一；`goal` 与 `prompt` 互斥。
- **当节点定义了 `agents`，主 prompt 只编排不执行重活；Write/Bash 由子代理负责**。
- 子代理优先 `agent_file` 引用 `agency-agents-zh` / core-pack 现成角色，避免重写 system prompt。
- 通知一律走 `providers + channels + notify hook`，禁止在 bash 节点里硬编码 `hermes send`。
- 节点失败用 `__status: "failed"` 标记，**不要用 `exit 1`**。
- 字符串字面量在 outputs 中需二次引号：`"$vars.x": '"hello"'`。
- `context: continue` 仅在前一个节点也是 agent 时有效。
- 工作流不绑定技术栈 — 不在 YAML 中硬编码 npm/mvn/gradle，让 agent 自动检测。
- 视觉/截图分析必须用子代理隔离，防止图片数据污染主 session。
- 任何字段不确定先查 `packages/core-pack/workflows/workflow-schema.json`，不要凭记忆写。
