# ADR-006: Plugin-Based Skill Discovery

## 状态
Accepted

## 背景

Octopus 需要在 AI agent 会话中加载技能（skills）。之前使用两种方式：
1. **Prompt 文本注入**: 在 system prompt 的 append 段中写入技能名称+描述+路径
2. **Pi SDK resourceLoader**: 直接操作 `resourceLoader.skills` 数组注入

Prompt 注入方式导致技能不被 Claude Agent SDK 的原生发现机制识别，agent 只列出 ECC 内置技能而忽略 Octopus 技能。

## 决策

利用 Claude Agent SDK 和 Pi Agent SDK 的**原生 plugin/skill 发现机制**替代 prompt 文本注入。

### Claude Agent SDK 路径
使用 `plugins: [{ type: 'local', path }]` 选项加载 plugin 目录。SDK 自动扫描 `skills/` 子目录，发现技能并注入 system prompt。

### Pi Agent SDK 路径
直接操作 `resourceLoader.skills` 数组，注入 Skill 对象。

### 目录结构
现有 `~/.octopus/agent/` 目录天然兼容 plugin 格式：
- `~/.octopus/agent/` = main plugin（共享技能在 `skills/`）
- `~/.octopus/agent/built-in/{clone}/` = clone plugin（分身技能在各自 `skills/`）

### 嵌套隔离
SDK 只扫描 plugin 根目录的直接 `skills/` 子目录，**不递归**。嵌套的 clone plugin 互不干扰。已通过实测验证（skills + agents + commands 三个 surface 均隔离）。

## 后果

### 正面
- 技能被 SDK 原生发现，agent 能正确列出和调用
- 无 prompt 膨胀（不需要在 system prompt 中列出技能）
- 分身技能天然隔离
- 与 ECC 内置技能并列，不冲突

### 负面
- 技能带命名空间前缀（如 `main-plugin:octo-agent-memory`）
- 需要 `skills: 'all'` 或明确的过滤列表
- 需要修改 provider 层传递 plugins 参数

## 替代方案

### 方案 B: Prompt 文本注入
在 system prompt append 段中写入技能列表。已验证 agent 会忽略这些文本而只列出 ECC 技能。

### 方案 C: 安装到 `~/.claude/skills/`
将技能复制到全局 Claude 配置目录。用户明确拒绝此方案。

### 方案 D: Symlink 到 workspace `.claude/skills/`
在每个 workspace 的 `.claude/skills/` 中创建 symlink。管理复杂度高，每个 workspace 都需要维护。
