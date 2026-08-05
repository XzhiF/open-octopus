---
name: matt-dev-pipeline
description: Full pipeline orchestration skill. DAG-based concurrent development with matt-dev-runner sub-agents -> independent code review -> deploy -> matt-e2e-tester (E2E verification) -> Git PR delivery. Use when a requirement is clarified and needs end-to-end development + deployment + verification + delivery.
---

# Full Development Pipeline

You are an **orchestrator**. You don't write code or run tests yourself. Instead, you guide the main agent to invoke each Agent / Skill in sequence.

**Core principle: No deployment verification = not done. No PR delivery = not finished.**

## Input

Receive `<artifacts.dir>/<feature-slug>/spec.md` and `<artifacts.dir>/<feature-slug>/issues/` paths.

Read `CLAUDE.md` at the start to understand the project structure (TypeScript monorepo, pnpm, SQLite).

## Pipeline Overview

```
Input: <artifacts.dir>/<feature-slug>/brief.md
    |
Phase 1: DAG Orchestration -> parse issues/, identify stages, spawn concurrent matt-dev-runner sub-agents
    |
Phase 2: Code Review -> independent sub-agent reviews diff (裁判 ≠ 球员)
    |
Phase 3: Deploy -> local dev only, skip CI/CD
    |
Phase 4: E2E Verification -> invoke matt-e2e-tester agent
    |
Phase 5: Ship (Git PR) -> main agent executes directly
    |
Output: <artifacts.dir>/<feature-slug>/pipeline-report.md
```

---

## Directory Conventions

### E2E Test Artifacts (Phase 4, under `<artifacts.dir>/<feature-slug>/`)

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

## Phase 1: DAG Orchestration

**Dispatch**: Main session orchestrates directly — no single matt-dev-runner agent. Instead, parse the DAG and spawn concurrent matt-dev-runner sub-agents per stage.

### 1.1 Parse DAG

Read all ticket files from `<artifacts.dir>/<feature-slug>/issues/`. Extract:
- Ticket number + title
- `Blocked by` field (dependency edges)
- `Status` field

Build a dependency graph:
```
{ 01: [], 02: [01], 03: [01], 04: [02], 05: [04], 06: [] }
```

### 1.2 Identify Stages

Topological sort into stages:
- **Stage 0** = tickets with no blockers (can start immediately)
- **Stage N** = tickets whose blockers are all in stages < N
- Same-stage tickets have NO mutual dependencies → run concurrently

Example:
```
Stage 0: [01, 06]          — no blockers
Stage 1: [02, 03]          — depend on 01
Stage 2: [04]              — depends on 02
Stage 3: [05]              — depends on 04
```

### 1.3 Execute Stages

For each stage in order:

**a) Spawn concurrent matt-dev-runner sub-agents** (one per ticket, parallel Agent tool calls in a single message):
```
Each sub-agent prompt:
"You are matt-dev-runner. Implementing ticket <NN> for <feature-slug>.

Spec: <artifacts.dir>/<feature-slug>/spec.md
Ticket: <artifacts.dir>/<feature-slug>/issues/<NN>-<slug>.md

Follow your standard execution flow (Read Context → Explore → Implement → Verify → Review).
Do NOT commit — the pipeline commits per stage after integration gate.

You are one of potentially several concurrent implementers.
Focus ONLY on your assigned ticket. Do NOT modify files owned by other tickets."
```

**b) Wait for all sub-agents in stage to complete**

**c) Integration gate**: Run `pnpm build && pnpm test`
- PASS → proceed to step (c.5)
- FAIL → diagnose the failure, spawn a fix sub-agent to address build/test errors, max 2 fix attempts

**c.5) Stage commit**: After integration gate passes, commit all changes from this stage:
```bash
git add -A
git commit -m "feat(<feature-slug>): stage <N> — <ticket-numbers>"
```

**d) Confirm ticket status updated** — read each ticket file, verify the value under `## Status` heading is `done` or `skip`

### 1.4 Final push

After all stages complete:
```bash
# Push all stage commits
git push origin $branch
```

**Pass criteria**: All tickets done/skip + build passes + tests pass + code pushed.

**Failure handling**: Stage gate fails after 2 fix attempts → log in pipeline-report, present to user, pipeline stops.

---

## Phase 2: Code Review (独立审查)

**Design principle**: 裁判 ≠ 球员。implementer sub-agents (matt-dev-runner) wrote code，主 Agent 从没看过实现过程 — 主 Agent 天然独立，直接审查。

**Dispatch**: 主 Agent 直接调用 `code-review` skill：

```
/code-review <branch-base>...HEAD
Spec path: <artifacts.dir>/<feature-slug>/spec.md
```

code-review 内部 spawn 三个并行 sub-agent：
- **Standards axis**: diff 对照编码规范 + Fowler code smells → 报告
- **Spec axis**: diff 对照 spec → 遗漏需求 / 范围蔓延 / 实现偏差 → 报告
- **Completeness axis (新增)**: diff 对照同类现有实现 → 遗漏文件 / 数据流断链 / 需求裁剪 → 报告

Completeness axis 审查要点：
1. **同类覆盖**: 读取每个 ticket 的 `## Exploration` 记录。diff 是否修改了同类特性涉及的所有文件？如果同类特性涉及 15 个文件而本次只改了 8 个，剩余的是 intentional skip 还是遗漏？
2. **数据流完整性**: 跨 package 的数据流 (trigger → persist → transport → render)，每一级都有代码改动吗？任何一级无改动 = 潜在断链。
3. **需求裁剪检测**: diff 中是否有 "TODO"、"for now"、空 render body 等暗示 brief 需求被静默跳过的模式？

**Evaluate findings**: 主 Agent 读取报告，按严重度分类：

| Severity | Action |
|----------|--------|
| 🔴 Must fix | 主 Agent 直接 Edit 修复 → `pnpm test` 验证 → 再 `/code-review` 确认 |
| 🟡 Should fix | 主 Agent 直接 Edit 修复 → `pnpm test` 验证 |
| 🔵 Note | 记入 pipeline-report，不修复 |

**Fix-verify cycle** (if 🔴 or 🟡 findings exist):

1. **主 Agent 直接修复**: 用 Edit/Write 工具对具体文件做 targeted fix。**不要重新 spawn implementer sub-agents** — 它会重跑 spec→tickets→implement 全流程，不是 targeted fixer。
2. **验证**: 运行 `pnpm test`，确认修复没有引入回归
3. **Commit + push**: `git add -A && git commit -m "fix: address code review findings" && git push`
4. **再审查**: 主 Agent 再跑一次 `/code-review` 确认 findings 已解决
5. **Max 2 review-fix cycles** total（防止无限循环）

**Pass criteria**: No 🔴 findings remain. 🟡 findings either fixed or explicitly accepted.

**Failure handling**: If after 2 cycles 🔴 findings persist, log them in pipeline-report and present to user. Pipeline continues — don't block on stubborn review issues.

---

## Phase 3: Deploy

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

## Phase 4: E2E Verification

> **⚠️ MANDATORY**: You MUST spawn the `matt-e2e-tester` sub-agent via the Agent tool.
> Do NOT skip this phase. Do NOT substitute with unit tests. Do NOT self-execute E2E tests.
> Running unit tests and calling it "E2E verification" is INVALID.
> If Playwright is not configured, the e2e-tester agent will set it up or report SKIP with reason.
> "Tests written but not executed by matt-e2e-tester = Phase 4 NOT DONE."

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
- If any AC fails: Quick Fix (1 attempt) → diagnosing-bugs (1 attempt) → re-test
- Report final results with fix attempt summary

**Pass criteria**: All AC verified (or SKIP with reason) after fix-and-retest loop.

**Failure handling**: If matt-e2e-tester reports FAIL after exhausting both fix attempts:
- Read the fix attempts summary from E2E report
- Present diagnosis to user: what was tried, root cause analysis, recommended direction
- Pipeline stops — do NOT proceed to Phase 5
- User decides: manual fix + re-run Phase 4, or skip and proceed with known issues

**Post-verification**: Update `<artifacts.dir>/index.md` — set current feature-slug status to `done`.
Note: index.md tracks all feature-slugs across all branches. Phase 5 will read it to build iteration history.

---

## Phase 5: Ship (Git PR)

**Dispatch**: Main agent executes directly using Git CLI.

> **Optional quality gate**: Before creating the PR, the orchestrator MAY invoke `/matt-verification-report <artifacts.dir>/<feature-slug>/` (or `--deep` for high-risk changes) to produce an independent confidence score. If the report returns NO-GO, present findings to the user and let them decide whether to proceed or fix before shipping.

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

### Phase 1: DAG Orchestration
| Stage | Tickets | Status | Integration Gate | Commit |
|-------|---------|--------|-----------------|--------|

### Phase 2: Code Review
| Axis | Findings | Fixed | Noted | Cycles |
|------|----------|-------|-------|--------|

### Phase 3: Deploy
| Project | Build# | Result |
|---------|--------|--------|

### Phase 4: E2E Verification（当前迭代）
| AC | Condition | Status | Evidence |
|----|-----------|--------|----------|

### Phase 5: Ship (Git PR)
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

After PR creation/update, update `pipeline-report.md` Phase 5 section with actual PR links, then amend and force-push:

```bash
# Update pipeline-report.md with PR links
# Then:
git add <artifacts.dir>/<feature-slug>/pipeline-report.md
git commit --amend --no-edit
git push --force-with-lease origin $branch
```

**Phase 5 pass criteria**: All changed projects have PR created or updated, code fully pushed, pipeline artifacts included in PR.

---

## Key Rules

1. **Phases cannot be skipped**: Must execute 1 → 2 → 3 → 4 → 5 in order
2. **Phase failure stops pipeline**: Phase 1 (max 1 retry), Phase 2 (max 2 review-fix cycles), Phase 3 (max 2 retries), Phase 4 (matt-e2e-tester handles fix-and-retest internally: Quick Fix → diagnosing-bugs → stop). If exhausted, present to user.
3. **Orchestrate, don't execute**: Phase 1 spawns concurrent matt-dev-runner sub-agents per DAG stage; Phase 2 主 Agent 直接调用 code-review skill（主 Agent 天然独立于实现代码）; main agent doesn't write code or run tests
4. **裁判 ≠ 球员**: Phase 2 code-review 由主 Agent 直接执行（它从没看过实现代码）。修复也由主 Agent 直接 Edit — **不要重新 spawn Phase 1 implementer sub-agents**（它们会重跑 ticket 全流程，不是 targeted fixer）。
4. **PR precision**: Only create PRs for projects with actual code changes vs target branch
5. **Artifact ownership**: All intermediates go to `<artifacts.dir>/<feature-slug>/`, never pollute source dirs
6. **Artifacts in PR**: pipeline-report.md and index.md must be committed before PR creation so they appear in the PR diff
7. **PR smart overwrite**: 已有 PR 时更新 body 而非跳过；用 `<!-- MANUAL-START/END -->` 保护人工编辑内容
8. **Iteration awareness**: Phase 5 始终读取 index.md 全量迭代记录，PR body 反映分支完整历史
9. **Git diff is truth**: Changed Files 永远从 `git diff` 实时生成，不依赖任何 feature-slug 的记录
