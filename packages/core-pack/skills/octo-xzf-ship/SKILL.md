---
name: octo-xzf-ship
description: "Ship 交付方法论 — 迭代感知 PR 生成 + Smart Overwrite + Feature 归档"
category: coding-assistant
tags: [xzf-dev]
version: 2.0.0
---

# Ship 交付方法论

## 触发条件
Stage 7 agent 节点，所有 spec 执行完毕后生成 PR/MR。

## Remote 检测

```bash
REMOTE_URL=$(git remote get-url origin)

if echo "$REMOTE_URL" | grep -q "github.com"; then
  PLATFORM="github"
elif echo "$REMOTE_URL" | grep -q "gitlab"; then
  PLATFORM="gitlab"
else
  PLATFORM="unknown"
fi
```

---

## Phase A: PR/MR Summary 生成

输出到 `.scratch/{feature}/06-ship/summary.md`:

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

## DB Schema 变更
| 操作 | 表名 | 变更内容 |
|------|------|---------|

## 核心实现
### 技术决策
- {决策 1}: {原因}

### 约定
- {约定 1}

## E2E 验证结果
- ✅ Spec-001: 全部通过
- ✅ Spec-002: 全部通过
- 验证详情: `.scratch/{feature}/04-execution/`
```

---

## Phase B: Collect Iteration Context

从 `.scratch/index.md` 收集当前分支的所有 feature-slug，构建迭代历史。

```
读取 .scratch/index.md → 筛选 Branch 列 == 当前分支的所有行 → 按 # 排序
```

对每个 feature-slug，读取：
- `.scratch/{slug}/02-clarification/brief.md` → 提取需求概述
- `.scratch/{slug}/03-specs/spec-index.md` → 统计 spec 数量
- `.scratch/{slug}/05-reports/e2e-report.md` → 提取 E2E 结果

判断：
- **单迭代**（分支只有 1 个 feature-slug）→ PR body 不含迭代表
- **多迭代**（分支有 2+ 个 feature-slug）→ PR body 含 Development Iterations 表

---

## Phase C: Create or Update PR

Workspace 包含多个 git 项目（worktree 开发空间），所有项目共享同一分支。遍历所有项目，为每个有变更的项目创建或更新 PR/MR。

### C.1 生成 PR Body

根据 Phase B 的迭代数量，生成 `pr-body.md`：

**单迭代**:

```markdown
## {feature 标题}

{summary.md 的核心内容}

### E2E Verification
{从 e2e-report.md 提取}

### Changed Files
（git diff --stat 输出）

<!-- MANUAL-START -->
<!-- MANUAL-END -->
```

**多迭代**:

```markdown
## {最新 feature 标题}

{最新 summary.md 的核心内容}

### Development Iterations
| # | Feature | Date | Specs |
|---|---------|------|-------|
| 1 | add-user-auth-v1 | 07-22 | 3 specs |
| 2 | add-user-auth-v2 | 07-23 | 4 specs (redo) |

### E2E Verification（latest）
{从最新 e2e-report.md 提取}

### Changed Files
（git diff --stat 输出）

<!-- MANUAL-START -->
<!-- MANUAL-END -->
```

### C.2 创建或更新 PR

```bash
# 对 workspace-topology.md 中的每个项目:

cd {project-path}

# 检查是否有变更
if git diff --quiet main...HEAD; then
  echo "[{project}] 无变更，跳过"
  continue
fi

# 检查已有 PR
existing_pr=$(gh pr list --head {branch} --state open --json number -q '.[0].number')

if [ -n "$existing_pr" ]; then
    # --- 更新已有 PR ---
    # 1. 读取现有 body
    current_body=$(gh pr view $existing_pr --json body -q '.body')

    # 2. 提取 MANUAL 区块（如果有内容）
    manual_section=$(echo "$current_body" | sed -n '/<!-- MANUAL-START -->/,/<!-- MANUAL-END -->/p')

    # 3. 生成新 body，插入保留的 manual 区块
    #    如果 manual_section 有实质内容（非空标记），替换新 body 中的空标记
    #    如果 manual_section 为空标记，保持原样

    # 4. 更新 PR
    if [ "$PLATFORM" = "github" ]; then
      echo "$new_body" | gh pr edit $existing_pr --body-file -
    elif [ "$PLATFORM" = "gitlab" ]; then
      echo "$new_body" | glab mr update $existing_pr --description -
    fi
    echo "[{project}] PR 已更新: #$existing_pr"
else
    # --- 创建新 PR ---
    if [ "$PLATFORM" = "github" ]; then
      PR_URL=$(gh pr create \
        --title "[{project}] {feature 标题}" \
        --body-file "{workspace-root}/pr-body.md" \
        --base main)
      echo "[{project}] PR: $PR_URL"
    elif [ "$PLATFORM" = "gitlab" ]; then
      MR_URL=$(glab mr create \
        --title "[{project}] {feature 标题}" \
        --description "$(cat {workspace-root}/pr-body.md)" \
        --target-branch main)
      echo "[{project}] MR: $MR_URL"
    fi
fi
```

### C.3 更新共享 index.md

PR 创建/更新成功后，将 `.scratch/index.md` 中当前 feature-slug 的 Status 从 `pending` 更新为 `done`。

---

## Phase D: Feature 归档（项目级迭代记录）

PR/MR 提交完毕后，将本次迭代的完整产物归档到 workspace 每个项目的 `.octopus/xzf/` 目录下。

目的：每个项目维护自己的永久迭代历史，方便后续回溯需求背景、设计决策和验证结果。

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

# 2. 从 .scratch/ 拷贝到项目归档目录
cp -r ".scratch/$FEATURE_SLUG" "$XZF_DIR/$ARCHIVE_SLUG"

# 3. 维护 per-project index.md
INDEX_FILE="$XZF_DIR/index.md"
if [ ! -f "$INDEX_FILE" ]; then
  cat > "$INDEX_FILE" << 'EOF'
# Iteration Archive

| # | Date | Branch | Feature Slug | Archive |
|---|------|--------|-------------|---------|
EOF
fi

LAST_NUM=$(grep -oP '^\| \K\d+' "$INDEX_FILE" | sort -n | tail -1)
NEXT_NUM=$(( ${LAST_NUM:-0} + 1 ))
TODAY=$(date +%Y-%m-%d)

echo "| $NEXT_NUM | $TODAY | $BRANCH | $FEATURE_SLUG | $ARCHIVE_SLUG |" >> "$INDEX_FILE"

echo "[{project}] 归档完成: .octopus/xzf/$ARCHIVE_SLUG (序号 #$NEXT_NUM)"
```

### Per-project index.md 格式

每个项目的 `.octopus/xzf/index.md` 记录归档历史（与共享 `.scratch/index.md` 不同）：

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
- Archive 列记录实际目录名，Feature Slug 列始终记录原始值

---

## 目录职责分离

| 目录 | 角色 | 生命周期 |
|------|------|---------|
| `.scratch/{feature}/` | 活跃工作区（matt + octo-xzf 共享） | feature 开发期间 |
| `{project}/.octopus/xzf/` | 永久归档区（仅 octo-xzf） | 长期保留 |
| `.scratch/index.md` | 共享 feature 注册表 | 追加式增长 |
| `{project}/.octopus/xzf/index.md` | 项目级归档记录 | 追加式增长 |

## Key Rules

1. **PR smart overwrite**: 已有 PR 时更新 body 而非跳过；用 `<!-- MANUAL-START/END -->` 保护人工编辑
2. **Iteration awareness**: Phase B 始终读取 `.scratch/index.md` 全量迭代记录，PR body 反映分支完整历史
3. **Git diff is truth**: Changed Files 永远从 `git diff` 实时生成，不依赖任何 feature-slug 的记录
4. **归档源 = .scratch/**: Phase D 从 `.scratch/{feature}/` 拷贝，不从 `.octopus/xzf/`
5. **双 index 维护**: `.scratch/index.md`（共享注册）+ `{project}/.octopus/xzf/index.md`（项目归档）

---

## 输出

汇总所有项目的 PR URL 和归档路径：

```
🚀 Ship 完成！

PR/MR:
- [project-a] https://github.com/.../pull/42 (updated)
- [project-b] https://github.com/.../pull/17 (created)

归档:
- [project-a] .octopus/xzf/add-user-auth (#3)
- [project-b] .octopus/xzf/add-user-auth (#1)
```
