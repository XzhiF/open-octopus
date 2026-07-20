---
name: octo-xzf-ship
description: "Ship 交付方法论 — PR/MR Summary 生成 + 提交"
category: coding-assistant
tags: [xzf-dev]
version: 1.0.0
---

# Ship 交付方法论

## 触发条件
Stage 7 agent 节点，所有 spec 执行完毕后生成 PR/MR。

## Remote 检测

```bash
REMOTE_URL=$(git remote get-url origin)

# 判断平台类型
if echo "$REMOTE_URL" | grep -q "github.com"; then
  PLATFORM="github"
elif echo "$REMOTE_URL" | grep -q "gitlab"; then
  PLATFORM="gitlab"
else
  PLATFORM="unknown"
fi
```

## PR/MR Summary 生成

输出到 `.octopus/xzf/{feature}/06-ship/summary.md`:

```markdown
# {Feature 标题}

## 功能概括
[一段话描述核心功能]

## 实现内容

### 模块 A: {模块名}
- {简要描述}
- 涉及文件: {文件列表}

### 模块 B: {模块名}
- {简要描述}
- 涉及文件: {文件列表}

## 用户故事
- ✅ 故事 1: {描述}
- ✅ 故事 2: {描述}
- ✅ 故事 3: {描述}

## DB Schema 变更
| 操作 | 表名 | 变更内容 |
|------|------|---------|
| 新增 | tb_xxx | {字段} |
| 修改 | tb_yyy | {变更} |

## 核心实现
### 技术决策
- {决策 1}: {原因}
- {决策 2}: {原因}

### 约定
- {约定 1}
- {约定 2}

## E2E 验证结果
- ✅ Spec-001: 全部通过
- ✅ Spec-002: 全部通过
- 验证详情: `.octopus/xzf/{feature}/04-execution/`
```

## 提交命令

Workspace 包含多个 git 项目（worktree 开发空间），所有项目共享同一分支。需要遍历所有项目，为每个有变更的项目创建 PR/MR。

### 流程

```bash
# 1. 读取 workspace-topology.md 获取项目列表
# 2. 对每个项目:

cd {project-path}

# 检查是否有变更
if git diff --quiet main...HEAD; then
  echo "[{project}] 无变更，跳过"
  continue
fi

# 3. 创建 PR/MR
if [ "$PLATFORM" = "github" ]; then
  PR_URL=$(gh pr create \
    --title "[{project}] {feature 标题}" \
    --body-file "{workspace-root}/.octopus/xzf/{feature}/06-ship/summary.md" \
    --base main)
  echo "[{project}] PR: $PR_URL"
elif [ "$PLATFORM" = "gitlab" ]; then
  MR_URL=$(glab mr create \
    --title "[{project}] {feature 标题}" \
    --description "$(cat {workspace-root}/.octopus/xzf/{feature}/06-ship/summary.md)" \
    --target-branch main)
  echo "[{project}] MR: $MR_URL"
fi
```

### 输出

汇总所有项目的 PR/MR URL，作为最终输出展示给用户。
