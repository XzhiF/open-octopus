---
name: matt-dev-pipeline
description: Full pipeline orchestration skill. Guides the main agent to sequentially invoke matt-dev-runner (development) -> independent code review -> CI/CD deploy -> matt-e2e-tester (E2E verification) -> Git MR delivery. Use when a requirement is clarified and needs end-to-end development + deployment + verification + delivery.
---

# Full Development Pipeline

You are an **orchestrator**. You don't write code or run tests yourself. Instead, you guide the main agent to invoke each Agent / Skill in sequence.

**Core principle: No deployment verification = not done. No MR delivery = not finished.**

## Input

Receive `<artifacts.dir>/<feature-slug>/brief.md` file path.

Read `.dev-pipeline/config.yaml` at the start to get project list, CI config, and Git platform info.

## Pipeline Overview

```
Input: <artifacts.dir>/<feature-slug>/brief.md
    |
Phase 1: Development -> invoke matt-dev-runner agent
    |
Phase 2: Code Review -> independent sub-agent reviews diff (referee ≠ player)
    |
Phase 3: Deploy -> use CI/CD (from config.yaml)
    |
Phase 4: E2E Verification (OPTIONAL) -> invoke matt-e2e-tester agent ONLY IF explicitly requested
    |
Phase 5: Ship (Git MR) -> main agent executes directly
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

## Phase 2: Code Review (Independent Review)

**Design principle**: Referee ≠ Player. matt-dev-runner (sub-agent) wrote the code; the main agent has never seen the implementation — it is naturally independent, and reviews directly.

**Dispatch**: Main agent directly invokes the `code-review` skill:

```
/code-review <branch-base>...HEAD
Spec path: <artifacts.dir>/<feature-slug>/spec.md
```

code-review internally spawns two parallel sub-agents:
- **Standards axis**: diff against coding standards + Fowler code smells → report
- **Spec axis**: diff against spec → missing requirements / scope creep / implementation deviations → report

**Evaluate findings**: Main agent reads the report, classifies by severity:

| Severity | Action |
|----------|--------|
| 🔴 Must fix | Main agent directly edits to fix → run test command → re-run `/code-review` to confirm |
| 🟡 Should fix | Main agent directly edits to fix → run test command |
| 🔵 Note | Record in pipeline-report, no fix needed |

**Fix-verify cycle** (if 🔴 or 🟡 findings exist):

1. **Main agent fixes directly**: Use Edit/Write tools for targeted fixes. **Do NOT re-spawn matt-dev-runner** — it would re-run the full spec→tickets→implement flow, not do targeted fixes.
2. **Verify**: Run the project test command, confirm no regressions
3. **Commit + push**: `git add -A && git commit -m "fix: address code review findings" && git push`
4. **Re-review**: Main agent runs `/code-review` again to confirm findings are resolved
5. **Max 2 review-fix cycles** total (prevents infinite loops)

**Pass criteria**: No 🔴 findings remain. 🟡 findings either fixed or explicitly accepted.

**Failure handling**: If after 2 cycles 🔴 findings persist, log them in pipeline-report and present to user. Pipeline continues — don't block on stubborn review issues.

---

## Phase 3: Deploy

**Dispatch**: Use the project's CI/CD configuration (read from `config.yaml`).

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

## Phase 4: E2E Verification (OPTIONAL)

**⚠️ SKIP by default**: This phase is NOT executed unless the user explicitly requests E2E testing (e.g., "run E2E", "execute E2E tests", "启动 E2E 测试"). If the user does not explicitly ask, proceed directly to Phase 5.

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

## Phase 5: Ship (Git MR)

**Dispatch**: Main agent executes directly using Git CLI.

Only create MRs for projects that have **actual code changes** relative to the target branch. Skip projects with no changes.

**Important**: All pipeline artifacts (pipeline-report.md, index.md) must be committed and pushed **before** creating the MR, so they are included in the MR diff.

### 5.1 Detect Changed Projects

Read project list from `.dev-pipeline/config.yaml`. For each project:

```bash
cd <project.path>
git fetch origin <git.mr_target> --quiet
changed_files=$(git diff --name-only origin/<git.mr_target>...HEAD)
# If changed_files is non-empty, this project has changes
```

### 5.2 Collect Iteration Context

From `<artifacts.dir>/index.md`, collect all feature-slugs on the current branch to build iteration history.

```
Read index.md → filter rows where Branch == current branch → sort by #
```

Produces iteration list:

| # | feature-slug | Created | Status |
|---|-------------|---------|--------|
| 1 | engine-init-v1 | 07-22 | done |
| 2 | engine-init-v2 | 07-22 | done |
| 3 | event-optimization | 07-23 | done |

For each feature-slug, read:
- `<artifacts.dir>/<slug>/spec.md` → extract title and summary (first 5 lines)
- `<artifacts.dir>/<slug>/issues/` → count tickets and completion status
- `<artifacts.dir>/<slug>/pipeline-report.md` → if exists, extract E2E results

### 5.3 Write Pipeline Report

Write `<artifacts.dir>/<feature-slug>/pipeline-report.md` **before** committing, so it is included in the MR.

```markdown
# Pipeline Execution Report

## Requirement: [current feature-slug title]
## Status: PASS / PARTIAL / FAIL

### Development Iterations
| # | Feature Slug | Date | Tickets | Notes |
|---|-------------|------|---------|-------|
| 1 | engine-init-v1 | 07-22 | 5/5 done | Initial implementation |
| 2 | engine-init-v2 | 07-22 | 5/5 done | Redo, corrected direction |
| 3 | event-optimization | 07-23 | 3/3 done | Event rendering optimization |

> Note: Only the current feature-slug is active; others are same-branch history.
> This section is omitted for single-iteration branches.

### Phase 1: Development (current iteration)
| Ticket | Title | Status | Fix Count |
|--------|-------|--------|-----------|

### Phase 2: Code Review
| Axis | Findings | Fixed | Noted | Cycles |
|------|----------|-------|-------|--------|

### Phase 3: Deploy
| Project | Build# | Result | Duration |
|---------|--------|--------|----------|

### Phase 4: E2E Verification (current iteration)
| AC | Condition | Status | Evidence |
|----|-----------|--------|----------|

### Phase 5: Ship (Git MR)
_(MR links amended after step 5.7)_

### Changed Files (from git diff)
| Project | File | Change Type |
|---------|------|-------------|

### Remaining Issues
| # | Issue | Impact | Suggestion |
```

### 5.4 Ensure Code is Pushed

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

### 5.5 Generate MR Body

Based on 5.2 iteration context, generate MR body file `mr-body.md`.

**Single iteration** (branch has only one feature-slug):

```markdown
## <feature title>

<spec.md summary, 2-3 sentences>

### E2E Verification
| AC | Condition | Status |
|----|-----------|--------|

### Changed Files
(git diff --stat output)

<!-- MANUAL-START -->
<!-- MANUAL-END -->
```

**Multi-iteration** (branch has multiple feature-slugs):

```markdown
## <latest feature-slug title>

<latest spec.md summary>

### Development Iterations
| # | Feature | Date | Tickets |
|---|---------|------|---------|
| 1 | engine-init-v1 | 07-22 | 5 |
| 2 | engine-init-v2 | 07-22 | 5 (redo) |
| 3 | event-optimization | 07-23 | 3 |

### E2E Verification (latest)
| AC | Condition | Status |
|----|-----------|--------|

### Changed Files
(git diff --stat output)

<!-- MANUAL-START -->
<!-- MANUAL-END -->
```

### 5.6 Create or Update MR

**GitLab** (glab CLI):
```bash
existing_mr=$(glab mr list --source-branch <branch> --state opened --output json | jq '.[0].iid')

if [ -n "$existing_mr" ]; then
    # --- Update existing MR ---
    # 1. Read existing body
    current_body=$(glab mr view $existing_mr --output json | jq -r '.description')

    # 2. Extract MANUAL section (if it has content)
    manual_section=$(echo "$current_body" | sed -n '/<!-- MANUAL-START -->/,/<!-- MANUAL-END -->/p')

    # 3. Generate new body, preserving the manual block
    #    If manual_section has real content (non-empty markers), replace new body's empty markers
    #    If manual_section is empty markers, keep as-is

    # 4. Update MR
    glab mr update $existing_mr --description "$new_body"
else
    # --- Create new MR ---
    glab mr create \
      --source-branch <branch> \
      --target-branch <git.mr_target> \
      --title "feat(<scope>): <description>" \
      --description "$(cat mr-body.md)" \
      --no-editor
fi
```

**GitHub** (gh CLI):
```bash
existing_pr=$(gh pr list --head <branch> --state open --json number -q '.[0].number')

if [ -n "$existing_pr" ]; then
    # --- Update existing PR ---
    # 1. Read existing body
    current_body=$(gh pr view $existing_pr --json body -q '.body')

    # 2. Extract MANUAL section (if it has content)
    manual_section=$(echo "$current_body" | sed -n '/<!-- MANUAL-START -->/,/<!-- MANUAL-END -->/p')

    # 3. Generate new body, preserving the manual block
    #    If manual_section has real content (non-empty markers), replace new body's empty markers
    #    If manual_section is empty markers, keep as-is

    # 4. Update PR
    echo "$new_body" | gh pr edit $existing_pr --body-file -
else
    # --- Create new PR ---
    gh pr create \
      --base <git.mr_target> \
      --title "feat(<scope>): <description>" \
      --body-file mr-body.md
fi
```

### 5.7 Collect MR Links

Record each project's MR status:

| Project | Branch | MR# | Action |
|---------|--------|-----|--------|
| backend | feat/xxx | !123 | Created/Updated |
| frontend | feat/xxx | !456 | Created/Updated |
| mobile | -- | -- | No changes, skipped |

### 5.8 Amend MR Links into Report

After MR creation/update, update `pipeline-report.md` Phase 5 section with actual MR links, then amend and force-push:

```bash
# Update pipeline-report.md with MR links
# Then:
git add <artifacts.dir>/<feature-slug>/pipeline-report.md
git commit --amend --no-edit
git push --force-with-lease origin $branch
```

**Phase 5 pass criteria**: All changed projects have MR created or updated, code fully pushed, pipeline artifacts included in MR.

---

## Key Rules

1. **Phase 4 is optional**: Phase 4 (E2E Verification) is skipped by default — only execute when explicitly requested by the user. All other phases must execute 1 → 2 → 3 → (4) → 5 in order
2. **Phase failure stops pipeline**: Phase 1 (max 1 retry), Phase 2 (max 2 review-fix cycles), Phase 3 (max 2 retries), Phase 4 (matt-e2e-tester handles fix-and-retest internally: Quick Fix → diagnosing-bugs → stop). If exhausted, present to user.
3. **Orchestrate, don't execute**: Phase 1 and 4 use agents; Phase 2 main agent directly invokes code-review skill (main agent is naturally independent of implementation code); main agent doesn't write code or run tests
4. **Referee ≠ Player**: Phase 2 code-review is executed by the main agent (it has never seen the implementation code). Fixes are also done by the main agent directly — **do NOT re-spawn matt-dev-runner** (it would re-run the full spec→tickets→implement flow, not do targeted fixes).
5. **MR precision**: Only create MRs for projects with actual code changes vs target branch
6. **Artifact ownership**: All intermediates go to `<artifacts.dir>/<feature-slug>/`, never pollute source dirs
7. **Artifacts in MR**: pipeline-report.md and index.md must be committed before MR creation so they appear in the MR diff
8. **MR smart overwrite**: When MR already exists, update body instead of skipping; use `<!-- MANUAL-START/END -->` to protect human-edited content
9. **Iteration awareness**: Phase 5 always reads index.md for full iteration records; MR body reflects the branch's complete history
10. **Git diff is truth**: Changed Files are always generated from `git diff` in real-time, never rely on any feature-slug's records
