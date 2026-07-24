# ADR-005: 分身上下文装配架构统一

## 状态
Proposed

## 背景

三个独立问题交织在一起，导致分身系统无法正确加载人格、记忆和技能：

1. **SkillLoader 路径断裂**: 不知道 `~/.octopus/resources/installed/skills/built-in/` 的存在
2. **CWD 设计不统一**: 各上下文使用不同的 CWD 策略，没有上下文感知
3. **技能加载指令缺失**: `assembleContext()` 输出技能摘要但不告诉 agent 去哪里读全文

## 决策

### 决策 1: 两层技能模型

```
共享: ~/.octopus/agent/skills/                          (全局共享, 父级)
分身: ~/.octopus/agent/built-in/{clone}/skills/         (built-in clone)
      ~/.octopus/agent/clones/{clone}/skills/           (user clone)

同名优先级: 分身 > 共享
```

**产出格式** — 基准目录声明 + 分组列表:
```markdown
# 可用技能
当需要使用某个技能时，用 Read 工具读取 {基准目录}/{技能名}/SKILL.md

共享: ~/.octopus/agent/skills
- **octo-agent-memory**: Search and manage agent memory layers.

分身: ~/.octopus/agent/built-in/workspace/skills
- **octo-dev-copilot**: octopus 微服务生态编码助手。
- **octo-workflow-dev**: YAML DSL 工作流引擎。
```

**理由**: 分身独立性 — 可与父级共享技能，也可有专属技能。不依赖 resource 模块的 installed 路径。基准目录声明一次，技能只写名称+描述，agent 自拼路径。

### 决策 2: CWD — 分身自己的目录

```
built-in clone  → ~/.octopus/agent/built-in/{name}/     分身自己的目录
user clone      → ~/.octopus/agent/clones/{name}/       分身自己的目录
Workspace 页面  → workspace.path                        操作项目文件 (调用方覆盖)
```

**理由**: 隔离 + 归属清晰。每个分身的文件操作限定在自己目录内，产出的文件归该分身。共享记忆已通过 `assembleContext()` 注入 prompt，不需要从磁盘读。

### 决策 3: 技能加载指令 — 基准目录声明 + 分组列表

```markdown
# 可用技能

共享: ~/.octopus/agent/skills
- **skill-name**: description

分身: ~/.octopus/agent/built-in/{clone}/skills
- **skill-name**: description
```

**理由**: 基准目录声明一次，每条技能只有名称+描述。agent 自己拼路径 `{base}/{name}/SKILL.md`。prompt 紧凑，无重复路径。

## 后果

### 正面
- 两层技能模型清晰：共享 vs 分身专属，同名分身优先
- 技能加载在任何 CWD 下都能工作（agent 用绝对基准目录拼路径）
- prompt 紧凑：基准目录声明一次，技能只写名称+描述
- CWD 策略有清晰的规则可循
- `assembleContext()` 成为完整的分身身份装配器

### 负面
- 需要为每个 built-in clone 创建 `skills/` 目录并放入所需技能
- workspace 分身的技能列表需要明确定义（不再是空数组）

## 替代方案

### 方案 B: 技能全文嵌入 prompt
- 不依赖路径，零外部依赖
- 但 prompt 膨胀严重（29 个技能 × 平均 200 行 = ~6000 行）
- 不适合 workspace 分身（skills: [] = 全部技能）

### 方案 C: CWD 统一为 monorepo root
- 简单但错误 — workspace chat 需要操作项目文件，不是 monorepo 根
- 破坏了现有 workspace chat 的行为
