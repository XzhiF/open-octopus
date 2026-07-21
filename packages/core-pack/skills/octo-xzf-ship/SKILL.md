---
name: octo-xzf-ship
description: "Ship 交付方法论 — PR/MR Summary 生成 + 提交 + Feature 归档"
category: coding-assistant
tags: [xzf-dev]
version: 1.1.0
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

## Feature 归档（项目级迭代记录）

PR/MR 提交完毕后，将本次迭代的完整产物归档到 workspace 每个项目的 `.octopus/xzf/` 目录下。

目的：每个项目维护自己的迭代历史，方便后续回溯需求背景、设计决策和验证结果。

### 归档流程

```bash
# 对 workspace-topology.md 中的每个项目:

FEATURE_SLUG="{feature}"
PROJECT_PATH="{project-path}"
XZF_DIR="$PROJECT_PATH/.octopus/xzf"
mkdir -p "$XZF_DIR"

# 1. 解决命名冲突
ARCHIVE_SLUG="$FEATURE_SLUG"
if [ -d "$XZF_DIR/$ARCHIVE_SLUG" ]; then
  SUFFIX=1
  while [ -d "$XZF_DIR/${FEATURE_SLUG}-v${SUFFIX}" ]; do
    SUFFIX=$((SUFFIX + 1))
  done
  ARCHIVE_SLUG="${FEATURE_SLUG}-v${SUFFIX}"
fi

# 2. 拷贝整个 feature 目录
cp -r ".octopus/xzf/$FEATURE_SLUG" "$XZF_DIR/$ARCHIVE_SLUG"

# 3. 维护 index.md
INDEX_FILE="$XZF_DIR/index.md"
if [ ! -f "$INDEX_FILE" ]; then
  cat > "$INDEX_FILE" << 'EOF'
# Iteration Archive

| # | Date | Branch | Feature Slug | Archive |
|---|------|--------|-------------|---------|
EOF
fi

# 解析已有最大序号
LAST_NUM=$(grep -oP '^\| \K\d+' "$INDEX_FILE" | sort -n | tail -1)
NEXT_NUM=$(( ${LAST_NUM:-0} + 1 ))
TODAY=$(date +%Y-%m-%d)

echo "| $NEXT_NUM | $TODAY | $BRANCH | $FEATURE_SLUG | $ARCHIVE_SLUG |" >> "$INDEX_FILE"

echo "[{project}] 归档完成: .octopus/xzf/$ARCHIVE_SLUG (序号 #$NEXT_NUM)"
```

### index.md 格式

每个项目的 `.octopus/xzf/index.md` 记录所有迭代历史：

```markdown
# Iteration Archive

| # | Date | Branch | Feature Slug | Archive |
|---|------|--------|-------------|---------|
| 1 | 2025-01-15 | feat/user-auth | add-user-auth | add-user-auth |
| 2 | 2025-01-20 | feat/cart-v2 | add-cart-discount | add-cart-discount |
| 3 | 2025-01-25 | feat/user-auth | add-user-auth | add-user-auth-v1 |
```

### 命名冲突规则

- 首次归档：使用原始 feature-slug（如 `add-user-auth`）
- 冲突时：追加 `-v1`、`-v2`...（如 `add-user-auth-v1`）
- Archive 列记录实际使用的目录名，Feature Slug 列始终记录原始值

### 输出

汇总所有项目的归档路径，与 PR/MR URL 一起输出：

```
🚀 Ship 完成！

PR/MR:
- [project-a] https://github.com/.../pull/42
- [project-b] https://github.com/.../pull/17

归档:
- [project-a] .octopus/xzf/add-user-auth (#3)
- [project-b] .octopus/xzf/add-user-auth (#1)
```
