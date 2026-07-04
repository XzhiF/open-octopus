---
name: resource-management
description: Octopus 统一资源管理 — 通过 CLI 发现、安装、卸载 skill/agent/workflow/source 资源，感知依赖关系
category: resource-management
tags: [octopus, 资源管理, skill, agent, workflow, 仓库, 依赖, CLI]
---

# Resource Management Skill

## Overview

本 Skill 教 Octopus Agent 如何使用 `octopus repo` CLI 命令族来发现和管理资源。
Agent 通过 bash 工具执行 `octopus repo --json` 命令，可以智能地为用户推荐和组装资源。

## 能力边界

### 可自主执行（只读操作）
- `octopus repo list` — 列出已注册资源
- `octopus repo search <query>` — 搜索资源
- `octopus repo info <name>` — 查看资源详情
- `octopus repo deps <name>` — 查看依赖树

### 需人类确认（写操作）
- `octopus repo install <names>` — 安装资源到工作空间
- `octopus repo uninstall <name>` — 从工作空间卸载资源

### 不可执行（管理员操作）
- `octopus repo register` — 注册新资源到仓库
- `octopus repo gc` — 缓存垃圾回收

## CLI 命令参考

### 发现资源

```bash
# 列出所有已注册资源
octopus repo list --json

# 按类型过滤
octopus repo list --type skill --json
octopus repo list --type agent --json
octopus repo list --type workflow --json

# 搜索资源
octopus repo search "security" --json
octopus repo search "security" --type skill --json

# 查看详情
octopus repo info brainstorming --json

# 查看依赖树
octopus repo deps security-engineer --type agent --json
octopus repo deps security-engineer --reverse  # 谁依赖了它
```

### 安装资源

```bash
# 安装单个资源
octopus repo install brainstorming --type skill --workspace /path/to/workspace --json

# 安装多个资源（自动解析依赖）
octopus repo install skill-a skill-b --type skill --workspace . --json

# 查看安装计划（不执行）
octopus repo install <name> --dry-run --json

# 强制覆盖已有资源
octopus repo install <name> --force --json

# Agent 模式（需 OCTOPUS_CALLER=agent）
OCTOPUS_CALLER=agent octopus repo install <name> --confirmed --json
```

### 卸载资源

```bash
# 卸载
octopus repo uninstall brainstorming --type skill --workspace . --json

# 强制卸载（忽略反向依赖）
octopus repo uninstall <name> --force --json
```

### 配置同步

```bash
# 检查 declared vs installed 差异
octopus repo sync --workspace . --json

# 查看审计日志
octopus repo audit --last 20 --json
```

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 1 | 部分失败 |
| 2 | 解析/依赖错误 |
| 3 | 网络错误 |
| 4 | 资源不存在 |
| 5 | 权限/安全错误 |

## JSON 输出格式

### list 响应
```json
{
  "entries": [
    { "name": "brainstorming", "type": "skill", "version": "1.0.0", "hash": "a1b2c3...", "tags": ["creative"] }
  ],
  "total": 5
}
```

### search 响应
```json
{
  "results": [...],
  "total": 3,
  "page": 1,
  "per_page": 20
}
```

### install 响应
```json
{
  "installed": [{ "name": "brainstorming", "type": "skill", "target": ".claude/skills/brainstorming", "hash": "a1b2c3" }],
  "failed": [{ "name": "missing", "type": "skill", "reason": "Not found in registry" }],
  "skipped": [],
  "status": "partial"
}
```

### error 响应
```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Resource 'foo' not found",
    "fix": "octopus repo search foo",
    "exitCode": 4
  }
}
```

## Agent 交互序列

### 场景：用户要求创建安全审计环境

```
用户: "帮我配置一个安全审计工作流"

Agent thinking:
  → 搜索安全相关资源

Agent: octopus repo search "security" --json
  → 找到 security-engineer (agent), security-review (skill), security-audit (workflow)

Agent 提出方案:
  "建议安装以下资源:
   - security-review (skill) — 安全审查技能
   - security-engineer (agent) — 安全工程师角色
   - security-audit (workflow) — 安全审计工作流
   依赖关系: security-engineer → security-review
   预计大小: ~250KB
   继续安装吗？"

用户确认: "好的"

Agent: OCTOPUS_CALLER=agent octopus repo install security-review security-engineer security-audit --confirmed --json
  → 安装成功

Agent: "已安装完成！
   ✅ security-review → .claude/skills/security-review/
   ✅ security-engineer → .claude/agents/security-engineer.md
   ✅ security-audit → workflows/security-audit.yaml
   使用方式: octopus workflow run workflows/security-audit.yaml"
```

## 4 种资源类型

| 类型 | 安装目标 | 说明 |
|------|---------|------|
| skill | `.claude/skills/{name}/` | Claude Code 技能目录 |
| agent | `.claude/agents/{name}.md` | Agent 角色定义文件 |
| workflow | `workflows/{name}.yaml` | 工作流 YAML 定义 |
| source | `dependencies/{name}/` | 外部依赖仓库 |

## 来源协议

| 协议 | 示例 | 说明 |
|------|------|------|
| npm | `npm:superpowers-zh` | NPM 包 |
| github | `github:owner/repo` | GitHub 仓库 |
| local | `./path/to/dir` | 本地路径 |
| builtin | `builtin:test-skill` | core-pack 内置资源 |
