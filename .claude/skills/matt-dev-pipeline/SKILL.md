---
name: matt-dev-pipeline
description: Full pipeline orchestration skill. Guides the main agent to sequentially invoke matt-dev-runner (development) -> CI/CD deploy -> matt-e2e-tester (E2E verification) -> Git PR delivery. Use when a requirement is clarified and needs end-to-end development + deployment + verification + delivery.
---

# Full Development Pipeline

You are an **orchestrator**. You don't write code or run tests yourself. Instead, you guide the main agent to invoke each Agent / Skill in sequence.

**Core principle: No deployment verification = not done. No PR delivery = not finished.**

## Input

Receive `<artifacts.dir>/<feature-slug>/brief.md` file path.

Read `CLAUDE.md` at the start to understand the project structure (TypeScript monorepo, pnpm, SQLite).

## Pipeline Overview

```
Input: <artifacts.dir>/<feature-slug>/brief.md
    |
Phase 1: Development -> invoke matt-dev-runner agent
    |
Phase 2: Deploy -> local dev only, skip CI/CD
    |
Phase 3: E2E Verification -> invoke matt-e2e-tester agent
    |
Phase 4: Ship (Git PR) -> main agent executes directly
    |
Output: <artifacts.dir>/<feature-slug>/pipeline-report.md
```

---

## Directory Conventions

### E2E Test Artifacts (Phase 3, under `<artifacts.dir>/<feature-slug>/`)

| Directory | Contents |
|-----------|----------|
| `e2e-scripts/` | Playwright / curl / shell test scripts |
| `e2e-screenshots/` | Browser screenshots as evidence |
| `e2e-data/` | Test data files, fixtures |

### Manual Execution Scripts (Phase 1, under project root)

Path: `<project-root>/docs/scripts/{branch_name}/<feature-slug>/NNN-xxx`

For SQL migrations, data fixes, or operational scripts that need manual execution. Numbered sequentially:

```
docs/scripts/feat-my-feature/my-feature/
├── 001-create-tables.sql
├── 002-seed-data.sql
└── 003-migrate-legacy.sh
```

---

## Phase 1: Development

**Dispatch**: Invoke the `matt-dev-runner` agent, passing the brief.md path.

matt-dev-runner will:
1. Synthesize Verified Spec -> spec.md
2. Split Verified Tickets -> issues/
3. Implement-verify loop per ticket
4. Git commit + push

**Pass criteria**: matt-dev-runner returns success, all tickets resolved or skip, code pushed.

**Failure handling**: If matt-dev-runner returns failure, analyze and decide whether to retry. Max 1 retry.

---

## Phase 2: Deploy

**Dispatch**: This project uses local dev only (`pnpm dev --isolated`), no CI/CD. Skip deployment — inform user to restart dev server if needed.

- Jenkins: trigger build via API script
- GitHub Actions: trigger workflow dispatch
- GitLab CI: push triggers pipeline automatically
- No CI: skip, inform user to deploy manually

### Jenkins Deploy (if configured)

```bash
# Example: trigger Jenkins build for relevant projects
node <pipeline-path>/scripts/jenkins-trigger.js --project "<changed-projects>"
```

Then poll build status until `building=false`:

```
Poll: GET <jenkins-url>/job/<job-name>/lastBuild/api/json?tree=number,result,building
Wait 30s between polls
```

**Pass criteria**: Build SUCCESS for all relevant projects.

**On failure**: Read build logs, attempt fix, re-push, re-trigger. Max 2 retries.

---

## Phase 3: E2E Verification

**Dispatch**: Invoke the `matt-e2e-tester` agent.

```
Prompt: "Artifacts directory: <artifacts.dir>/<feature-slug>/
Spec path: <artifacts.dir>/<feature-slug>/spec.md
E2E scripts dir: <artifacts.dir>/<feature-slug>/e2e-scripts/
E2E screenshots dir: <artifacts.dir>/<feature-slug>/e2e-screenshots/
E2E data dir: <artifacts.dir>/<feature-slug>/e2e-data/"
```

matt-e2e-tester will:
- Run API integration tests
- Run browser E2E (if applicable)
- Cross-validate DB/cache

**Pass criteria**: All AC verified (or SKIP with reason).

**Post-verification**: Update `<artifacts.dir>/index.md` — set current feature-slug status to `done`.
Note: index.md tracks all feature-slugs across all branches. Phase 4 will read it to build iteration history.

---

## Phase 4: Ship (Git PR)

**Dispatch**: Main agent executes directly using Git CLI.

Only create PRs for projects that have **actual code changes** relative to the target branch. Skip projects with no changes.

**Important**: All pipeline artifacts (pipeline-report.md, index.md) must be committed and pushed **before** creating the PR, so they are included in the PR diff.

### 4.1 Detect Changed Projects

Read project info from `CLAUDE.md`. This is a single monorepo — no multi-repo detection needed.

```bash
cd <project.path>
git fetch origin <git.mr_target> --quiet
changed_files=$(git diff --name-only origin/<git.mr_target>...HEAD)
# If changed_files is non-empty, this project has changes
```

### 4.2 Collect Iteration Context

从 `<artifacts.dir>/index.md` 收集当前分支的所有 feature-slug，构建迭代历史。

```
读取 index.md → 筛选 Branch 列 == 当前分支的所有行 → 按 # 排序
```

得到迭代列表：

| # | feature-slug | Created | Status |
|---|-------------|---------|--------|
| 1 | engine-init-v1 | 07-22 | done |
| 2 | engine-init-v2 | 07-22 | done |
| 3 | event-optimization | 07-23 | done |

对每个 feature-slug，读取：
- `<artifacts.dir>/<slug>/spec.md` → 提取标题和摘要（前 5 行）
- `<artifacts.dir>/<slug>/issues/` → 统计 ticket 数量和完成情况
- `<artifacts.dir>/<slug>/pipeline-report.md` → 如存在，提取 E2E 结果

### 4.3 Write Pipeline Report

Write `<artifacts.dir>/<feature-slug>/pipeline-report.md` **before** committing, so it is included in the PR.

```markdown
# Pipeline Execution Report

## Requirement: [当前 feature-slug 标题]
## Status: PASS / PARTIAL / FAIL

### Development Iterations
| # | Feature Slug | Date | Tickets | Notes |
|---|-------------|------|---------|-------|
| 1 | engine-init-v1 | 07-22 | 5/5 done | 初始实现 |
| 2 | engine-init-v2 | 07-22 | 5/5 done | 重做，修正方向 |
| 3 | event-optimization | 07-23 | 3/3 done | 事件渲染优化 |

> 注：仅当前 feature-slug 为 active，其余为同分支历史迭代。
> 单迭代时此 section 省略。

### Phase 1: Development（当前迭代）
| Ticket | Title | Status | Fix Count |
|--------|-------|--------|-----------|

### Phase 2: Deploy
| Project | Build# | Result |
|---------|--------|--------|

### Phase 3: E2E Verification（当前迭代）
| AC | Condition | Status | Evidence |
|----|-----------|--------|----------|

### Phase 4: Ship (Git PR)
_(PR links amended after step 4.6)_

### Changed Files（git diff 实时生成）
| Package | File | Change Type |
|---------|------|-------------|

### Remaining Issues
| # | Issue | Impact | Suggestion |
```

### 4.4 Ensure Code is Pushed

For each changed project:

```bash
cd <project.path>
branch=$(git rev-parse --abbrev-ref HEAD)
# Commit all uncommitted changes (includes pipeline-report.md and index.md)
if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "feat: <description> [pipeline artifacts]"
fi
git push origin $branch
```

### 4.5 Generate PR Body

根据 4.2 收集的迭代上下文生成 PR body 文件 `pr-body.md`。

**单迭代（分支只有一个 feature-slug）**：

```markdown
## <feature 标题>

<spec.md 摘要，2-3 句话>

### E2E Verification
| AC | Condition | Status |
|----|-----------|--------|

### Changed Files
（git diff --stat 输出）

<!-- MANUAL-START -->
<!-- MANUAL-END -->
```

**多迭代（分支有多个 feature-slug）**：

```markdown
## <最新 feature-slug 标题>

<最新 spec.md 摘要>

### Development Iterations
| # | Feature | Date | Tickets |
|---|---------|------|---------|
| 1 | engine-init-v1 | 07-22 | 5 |
| 2 | engine-init-v2 | 07-22 | 5 (redo) |
| 3 | event-optimization | 07-23 | 3 |

### E2E Verification（latest）
| AC | Condition | Status |
|----|-----------|--------|

### Changed Files
（git diff --stat 输出）

<!-- MANUAL-START -->
<!-- MANUAL-END -->
```

### 4.6 Create or Update PR

```bash
existing_pr=$(gh pr list --head <branch> --state open --json number -q '.[0].number')

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
    echo "$new_body" | gh pr edit $existing_pr --body-file -
else
    # --- 创建新 PR ---
    gh pr create \
      --base <git.mr_target> \
      --title "feat(<scope>): <description>" \
      --body-file pr-body.md
fi
```

### 4.7 Collect PR Links

Record each project's PR status:

| Project | Branch | PR# | Action |
|---------|--------|-----|--------|
| backend | feat/xxx | #123 | Created/Updated |
| frontend | feat/xxx | #456 | Created/Updated |
| mobile | -- | -- | No changes, skipped |

### 4.8 Amend PR Links into Report

After PR creation/update, update `pipeline-report.md` Phase 4 section with actual PR links, then amend and force-push:

```bash
# Update pipeline-report.md with PR links
# Then:
git add <artifacts.dir>/<feature-slug>/pipeline-report.md
git commit --amend --no-edit
git push --force-with-lease origin $branch
```

**Phase 4 pass criteria**: All changed projects have PR created or updated, code fully pushed, pipeline artifacts included in PR.

---

## Key Rules

1. **Phases cannot be skipped**: Must execute 1 -> 2 -> 3 -> 4 in order
2. **Phase failure stops pipeline**: Don't proceed to next phase on failure, fix first
3. **Orchestrate, don't execute**: Phase 1 and 3 use agents; main agent doesn't write code or run tests
4. **PR precision**: Only create PRs for projects with actual code changes vs target branch
5. **Artifact ownership**: All intermediates go to `<artifacts.dir>/<feature-slug>/`, never pollute source dirs
6. **Artifacts in PR**: pipeline-report.md and index.md must be committed before PR creation so they appear in the PR diff
7. **PR smart overwrite**: 已有 PR 时更新 body 而非跳过；用 `<!-- MANUAL-START/END -->` 保护人工编辑内容
8. **Iteration awareness**: Phase 4 始终读取 index.md 全量迭代记录，PR body 反映分支完整历史
9. **Git diff is truth**: Changed Files 永远从 `git diff` 实时生成，不依赖任何 feature-slug 的记录
