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

**Post-verification**: Update `<artifacts.dir>/index.md` status to `done`.

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

### 4.2 Write Pipeline Report

Write `<artifacts.dir>/<feature-slug>/pipeline-report.md` **before** committing, so it is included in the PR.

```markdown
# Pipeline Execution Report

## Requirement: [title]
## Status: PASS / PARTIAL / FAIL

### Phase 1: Development
| Ticket | Title | Status | Fix Count |
|--------|-------|--------|-----------|

### Phase 2: Deploy
| Project | Build# | Result | Duration |
|---------|--------|--------|----------|

### Phase 3: E2E Verification
| AC | Condition | Status | Evidence |
|----|-----------|--------|----------|

### Phase 4: Ship (Git PR)
_(PR links will be amended after creation in step 4.5)_

### Changed Files
| Project | File | Change Type |
|---------|------|-------------|

### Remaining Issues
| # | Issue | Impact | Suggestion |
```

### 4.3 Ensure Code is Pushed

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

### 4.4 Check Existing PR

```bash
gh pr list --head <branch> --state open
```

- **PR exists** -> confirm code pushed, record PR number, skip creation
- **No PR** -> create new PR

### 4.5 Create PR

```bash
gh pr create \
  --base <git.mr_target> \
  --title "feat(<scope>): <one-line description>" \
  --body "## Changes\n\nRequirement: <feature-slug>\n\n### Changed files\n<file-list>"
```

### 4.6 Collect PR Links

Record each project's PR status:

| Project | Branch | PR# | Action |
|---------|--------|-----|--------|
| backend | feat/xxx | #123 | Created/Existing |
| frontend | feat/xxx | #456 | Created/Existing |
| mobile | -- | -- | No changes, skipped |

### 4.7 Amend PR Links into Report

After PR creation, update `pipeline-report.md` Phase 4 section with actual PR links, then amend and force-push:

```bash
# Update pipeline-report.md with PR links
# Then:
git add <artifacts.dir>/<feature-slug>/pipeline-report.md
git commit --amend --no-edit
git push --force-with-lease origin $branch
```

**Phase 4 pass criteria**: All changed projects have PR created or confirmed open, code fully pushed, pipeline artifacts included in PR.

---

## Key Rules

1. **Phases cannot be skipped**: Must execute 1 -> 2 -> 3 -> 4 in order
2. **Phase failure stops pipeline**: Don't proceed to next phase on failure, fix first
3. **Orchestrate, don't execute**: Phase 1 and 3 use agents; main agent doesn't write code or run tests
4. **PR precision**: Only create PRs for projects with actual code changes vs target branch
5. **Artifact ownership**: All intermediates go to `<artifacts.dir>/<feature-slug>/`, never pollute source dirs
6. **Artifacts in PR**: pipeline-report.md and index.md must be committed before PR creation so they appear in the PR diff
