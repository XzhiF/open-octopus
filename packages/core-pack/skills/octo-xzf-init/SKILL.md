---
name: octo-xzf-init
description: "Pipeline 环境初始化 — 分支检测、feature slug 生成、目录创建、workspace 拓扑扫描"
category: coding-assistant
tags: [xzf-dev]
version: 1.2.0
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
用 Bash `mkdir -p` 一次性创建所有目录（不依赖 Write 自动创建）:

```bash
BASE=".scratch/{feature}"
mkdir -p "$BASE"/{00-init,01-research,02-clarification,03-specs,04-execution,05-reports/{e2e-scripts,e2e-screenshots,e2e-data},06-ship}
```

目录说明:
- `00-init/` — Idea + workspace 拓扑 + 目录规范
- `01-research/` — 研究简报 + 澄清问题
- `02-clarification/` — 需求澄清 + 验证策略 + 简报 + 审批回复
- `03-specs/` — Spec 文件 + tracer bullets + E2E 测试计划
- `04-execution/` — 执行 checkpoint（按 spec 子目录）
- `05-reports/` — E2E 报告 + 脚本 + 截图 + 临时数据
- `06-ship/` — PR/MR Summary

如目录已存在（同 feature 重跑）→ 复用，不覆盖已有文件。

### Step 4b: 写共享 index.md

向 `.scratch/index.md` 注册当前 feature（与 matt 系统共享同一个 index）:

```
IF .scratch/index.md 不存在 → 创建表头:
  # Features Index
  | # | feature-slug | Created | Branch | Status |
  |---|-------------|---------|--------|--------|

读取现有最大 # → NEXT_NUM = MAX + 1
追加一行: | NEXT_NUM | {feature} | {date} | {branch} | pending |
```

### Step 4c: 写 directory-conventions.md

写入 `00-init/directory-conventions.md`（产物目录规范，供所有下游节点引用）：

```markdown
# 产物目录规范

> ⚠️ 所有工作流产物必须写入以下目录，禁止使用源码目录。

基础路径: `.scratch/{feature}/`

| 阶段 | 目录 | 产物 |
|------|------|------|
| 初始化 | `00-init/` | idea.md, workspace-topology.md, directory-conventions.md |
| 研究 | `01-research/` | research-brief.md, questions.md |
| 澄清 | `02-clarification/` | questions.md, verification.md, brief.md |
| 设计 | `03-specs/` | spec-NNN.md, spec-index.md, e2e-test-plan.md |
| 设计 | `03-specs/spec-NNN-{name}/` | T-N-*.md（tracer bullets） |
| 执行 | `04-execution/spec-{NNN}/` | checkpoint.json |
| 报告 | `05-reports/e2e-scripts/` | 测试脚本（SQL/shell/curl） |
| 报告 | `05-reports/e2e-screenshots/` | 截图 |
| 报告 | `05-reports/e2e-data/` | mock/fixture 数据 |
| 报告 | `05-reports/` | e2e-report.md |
| 交付 | `06-ship/` | PR/MR Summary |
```

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

**默认分支检测（per project）:**
```bash
# 方法 1: 读 remote HEAD（最可靠）
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'
# 方法 2: fallback 检测常见分支
for b in main master develop; do git rev-parse --verify $b >/dev/null 2>&1 && echo $b && break; done
```

### Step 6: 输出 workspace-topology.md

写入: `.scratch/{feature}/00-init/workspace-topology.md`（每个 feature 独立拓扑快照）

⚠️ 行数限制：单项目不超过 80 行，总计不超过 150 行。项目少时可详细，项目多时精简为关键信息。

```markdown
# Workspace 拓扑

> 生成时间: {ISO timestamp}
> 分支: {branch}

## 项目列表
| 项目 | 路径 | 技术栈 | 默认分支 | 主要模块 | 端口 |
|------|------|--------|---------|---------|------|

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
{"vars_update": {"branch": "...", "feature": "...", "remote_type": "..."}}
```
