---
name: octo-xzf-ship
description: "Ship 交付方法论 — PR/MR Summary 生成 + 提交"
category: coding-assistant
tags: [xzf-pipeline]
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

输出到 `.octopus/xzf/{branch}/09-ship/summary.md`:

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
- 验证详情: `.octopus/xzf/{branch}/07-execution/`
```

## 提交命令

### GitHub

```bash
gh pr create \
  --title "{feature 标题}" \
  --body-file ".octopus/xzf/{branch}/09-ship/summary.md" \
  --base main
```

### GitLab

```bash
glab mr create \
  --title "{feature 标题}" \
  --description "$(cat .octopus/xzf/{branch}/09-ship/summary.md)" \
  --target-branch main
```
