---
name: octo-xzf-init
description: "Pipeline 环境初始化 — 分支检测、feature slug 生成、目录创建、workspace 拓扑扫描"
category: coding-assistant
tags: [xzf-dev]
version: 1.0.0
---

# Pipeline 环境初始化方法论

## 触发条件
Stage 0 agent 节点，Pipeline 启动时加载此 skill 进行环境初始化。

## 执行步骤

### Step 1: 分支检测
获取当前 git worktree 分支名。
设变量: `branch`

### Step 2: Feature Slug

IF 用户提供了 `feature` input → 直接使用
ELSE → 从 Idea 提取关键词生成 kebab-case slug:
- 格式: `{verb}-{subject}` 或 `{topic}`
- 示例: `add-user-auth`, `fix-cart-total`, `refactor-payment-flow`
- Max 40 chars，仅 `[a-z0-9-]`

设变量: `feature`

同一 branch 可跑多个 feature，每个 feature 独立目录。

### Step 3: Remote 检测
检测 `git remote get-url origin`:
- `github.com` → `github`
- `gitlab` → `gitlab`
- 其他 → `unknown`

设变量: `remote_type`

### Step 4: 目录创建
创建 `.octopus/xzf/{feature}/` 及子目录:

```
02-research/_scan/, 03-clarification/, 04-specs/, 05-execution/, 06-reports/, 07-ship/
```

如目录已存在（同 feature 重跑）→ 复用，不覆盖已有文件。

### Step 5: Workspace 拓扑扫描

**项目发现:**

```bash
find . -maxdepth 3 -name ".git" -type d
# 排除 .worktrees/, node_modules/
```

**技术栈识别（读取 manifest）:**
- `package.json` → Node.js/TypeScript（检查 next/react/vue 等）
- `go.mod` → Go
- `Cargo.toml` → Rust
- `pyproject.toml` → Python

**约定提取:**
- 读取各项目 `CLAUDE.md`（如存在）
- 提取: 框架、代码风格、测试框架、关键目录

**项目间依赖分析:**
- workspace 级 package.json 中的 workspace 引用
- go.mod 中的 replace 指令
- import 路径中的跨项目引用

**端口检测:**
- `.env` / config 文件中的 PORT 设置

### Step 6: 输出 workspace-topology.md

写入: `.octopus/xzf/{feature}/workspace-topology.md`（每个 feature 独立拓扑快照）

```markdown
# Workspace 拓扑

> 生成时间: {ISO timestamp}
> 分支: {branch}

## 项目列表
| 项目 | 路径 | 技术栈 | 主要模块 | 端口 |
|------|------|--------|---------|------|

## 项目间通信
| 源 | 目标 | 方式 | 说明 |
|----|------|------|------|

## 项目约定
### {project-name}
- 框架: ...
- 样式: ...
- 状态管理: ...
- 测试: ...

## 关键入口文件
### {project-name}
- 路由: src/app/
- 组件: src/components/
- API: src/app/api/
```

### Step 7: 设置变量

```json
{"vars_update": {"branch": "...", "feature": "...", "remote_type": "...", "workspace_topology": "已生成"}}
```
