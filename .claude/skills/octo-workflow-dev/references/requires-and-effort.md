# Requires & Effort Reference

工作流级资源依赖声明和 LLM 推理深度控制。

---

## `requires` — 工作流级资源依赖声明

在工作流 YAML 顶层声明所有依赖的资源。`__engine_init__` 虚拟节点在执行前**优先 provision** 这些资源到 workspace。

```yaml
apiVersion: octopus/v1
kind: Workflow
name: "my-workflow"

requires:
  skills:
    - superpowers-zh/test-driven-development    # group/name 格式
  agent_files:
    - built-in/vision-analyzer.md               # group/name.md 格式
  commands:
    - cmd-review                                # 命令名
  rules:
    - code-style                                # 规则名
  clones:
    - workspace                                 # clone 名（必须预安装）

nodes:
  # ... 工作流节点
```

### 字段格式

| 字段 | 格式 | Provision 目标 | 说明 |
|------|------|---------------|------|
| `requires.skills` | `group/name` | `.claude/skills/` | 技能依赖 |
| `requires.agent_files` | `group/name.md` | `.claude/agents/` | Agent 文件依赖 |
| `requires.commands` | 命令名 | `.claude/commands/` | 命令依赖 |
| `requires.rules` | 规则名 | `.claude/rules/` | 规则依赖 |
| `requires.clones` | clone 名 | ❌ 不自动 provision | **硬失败门控** — 必须预安装 |

> **⚠️ clones 是硬失败门控**: 缺失的 clone 会导致工作流**立即失败**。通过 `octopus resource install` 预先安装。

> **没有指定分组时**，引擎按注册表顺序匹配第一个同名资源。建议始终带分组以避免歧义。

### Provision 流程

1. `__engine_init__` 先处理 `requires` 声明 → 直接 provision
2. 然后扫描所有节点引用 → 兜底 provision 遗漏的资源
3. 已 provision 的资源不会重复安装

### 与节点级引用的区别

| 位置 | 语义 | 格式 | 是否触发 provision |
|------|------|------|-------------------|
| `requires.skills` | **依赖声明** | `group/name` | ✅ `__engine_init__` 优先安装 |
| 节点 `skills` | **运行时过滤** | 纯名称 | ❌ 白名单过滤已加载技能 |
| `requires.agent_files` | **依赖声明** | `group/name.md` | ✅ `__engine_init__` 优先安装 |
| 节点 `agent_file` | **运行时引用** | `group/name.md` | ❌ 引用已安装文件 |

### 不写 requires 也行吗？

可以 — 引擎会扫描所有节点自动发现资源。但显式声明更可靠：
- 资源名在 YAML 顶部一目了然
- 不依赖扫描的完整性（扫描无法覆盖变量引用）
- 多人协作时可读性更高

### 完整示例

```yaml
apiVersion: octopus/v1
kind: Workflow
name: test-requires-effort-combined

requires:
  skills:
    - superpowers-zh/test-driven-development
    - superpowers-zh/systematic-debugging
  agent_files:
    - agency-agents-zh/engineering-code-reviewer.md
    - agency-agents-zh/testing-test-results-analyzer.md

nodes:
  - id: code-review
    type: agent
    prompt: "Review the latest commit for security vulnerabilities"
    effort: high
    skills:
      - systematic-debugging          # 运行时过滤（纯名称）
      - chinese-code-review           # 此 skill 不在 requires 中，由扫描兜底 provision
    agent_file: agency-agents-zh/engineering-code-reviewer.md

  - id: multi-agent-analysis
    type: agent
    prompt: "Coordinate analysis across sub-agents"
    effort: high
    depends_on: [code-review]
    agents:
      security-reviewer:
        description: "Review security test coverage"
        prompt: "Analyze security test coverage"
        effort: high                  # 子代理也支持 effort
      test-analyzer:
        description: "Analyze test quality metrics"
        agent_file: agency-agents-zh/testing-test-results-analyzer.md
        effort: medium

  - id: review-swarm
    type: swarm
    topic: "Analyze test coverage gaps"
    mode: review
    rounds: 1
    depends_on: [multi-agent-analysis]
    experts:
      - role: security-reviewer
        prompt: "Focus on security test coverage"
      - role: test-analyzer
        agent_file: agency-agents-zh/testing-test-results-analyzer.md
```

---

## `effort` — LLM 推理深度控制

控制 agent 节点的推理深度（thinking level），透传到 Claude Agent SDK 和 Pi SDK。

### 字段位置

| 位置 | Schema | 说明 |
|------|--------|------|
| `NodeDef.effort` | 顶层 agent 节点 | 控制该节点的推理深度 |
| `SubAgentDef.effort` | agents 子代理 | 控制子代理的推理深度 |

### 可选值

| 级别 | 类型 | 适用场景 | Claude SDK | Pi SDK 映射 |
|------|------|---------|-----------|------------|
| `low` | string | 简单摘要、格式化 | `effort: "low"` | `thinkingLevel: "minimal"` |
| `medium` | string | 常规代码生成（默认） | `effort: "medium"` | `thinkingLevel: "low"` |
| `high` | string | 代码审查、架构设计 | `effort: "high"` | `thinkingLevel: "medium"` |
| `xhigh` | string | 复杂分析、安全审计 | `effort: "xhigh"` | `thinkingLevel: "high"` |
| `max` | string | 形式化验证、数学证明 | `effort: "max"` | `thinkingLevel: "maximum"` |
| `50` | number | 精细控制 | Claude sub-agent 透传 | Pi SDK 转 string |

### 示例

```yaml
nodes:
  - id: quick-summary
    type: agent
    prompt: "Summarize this file in 3 sentences"
    effort: low

  - id: security-audit
    type: agent
    prompt: "Audit this code for security vulnerabilities"
    effort: xhigh

  - id: coordinator
    type: agent
    prompt: "Delegate tasks to sub-agents"
    effort: high
    agents:
      researcher:
        description: "Deep research"
        prompt: "Research topic X thoroughly"
        effort: max
      writer:
        description: "Quick summary writer"
        prompt: "Write a brief summary"
        effort: low
```

### SDK 透传细节

- **Claude Agent SDK**: `effort` 直接映射到 `Options.effort`（字符串级别）或 `AgentDefinition.effort`（支持数字）
- **Pi SDK**: `effort` 通过 `effortToThinkingLevel()` 映射为 `thinkingLevel`
- 数字 effort 在 Claude SDK 顶层 Options 中静默忽略（Options.effort 只接受字符串）；在 sub-agent AgentDefinition 中透传
