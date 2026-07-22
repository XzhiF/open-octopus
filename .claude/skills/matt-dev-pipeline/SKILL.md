---
name: matt-dev-pipeline
description: Full pipeline orchestration skill. Guides the main agent to sequentially invoke matt-dev-runner (development) -> CI/CD deploy -> matt-e2e-tester (E2E verification) -> Git MR delivery. Use when a requirement is clarified and needs end-to-end development + deployment + verification + delivery.
---

# Full Development Pipeline

You are an **orchestrator**. You don't write code or run tests yourself. Instead, you guide the main agent to invoke each Agent / Skill in sequence.

**Core principle: No deployment verification = not done. No MR delivery = not finished.**

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
Phase 4: Ship (Git MR) -> main agent executes directly
    |
Output: <artifacts.dir>/<feature-slug>/pipeline-report.md
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
Spec path: <artifacts.dir>/<feature-slug>/spec.md"
```

matt-e2e-tester will:
- Run API integration tests
- Run browser E2E (if applicable)
- Cross-validate DB/cache

**Pass criteria**: All AC verified (or SKIP with reason).

---

## Phase 4: Ship (Git MR)

**Dispatch**: Main agent executes directly using Git CLI.

Only create MRs for projects that have **actual code changes** relative to the target branch. Skip projects with no changes.

### 4.1 Detect Changed Projects

Read project info from `CLAUDE.md`. This is a single monorepo — no multi-repo detection needed.

```bash
cd <project.path>
git fetch origin <git.mr_target> --quiet
changed_files=$(git diff --name-only origin/<git.mr_target>...HEAD)
# If changed_files is non-empty, this project has changes
```

### 4.2 Ensure Code is Pushed

For each changed project:

```bash
cd <project.path>
branch=$(git rev-parse --abbrev-ref HEAD)
# Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "feat: <description>"
fi
git push origin $branch
```

### 4.3 Check Existing MR

**GitLab** (glab CLI):
```bash
glab mr list --source-branch <branch> --state opened
```

**GitHub** (gh CLI):
```bash
gh pr list --head <branch> --state open
```

- **MR exists** -> confirm code pushed, record MR number, skip creation
- **No MR** -> create new MR

### 4.4 Create MR

**GitLab**:
```bash
glab mr create \
  --source-branch <branch> \
  --target-branch <git.mr_target> \
  --title "feat(<scope>): <one-line description>" \
  --description "## Changes\n\nRequirement: <feature-slug>\n\n### Changed files\n<file-list>" \
  --no-editor
```

**GitHub**:
```bash
gh pr create \
  --base <git.mr_target> \
  --title "feat(<scope>): <one-line description>" \
  --body "## Changes\n\nRequirement: <feature-slug>\n\n### Changed files\n<file-list>"
```

### 4.5 Collect MR Links

Record each project's MR status:

| Project | Branch | MR# | Action |
|---------|--------|-----|--------|
| backend | feat/xxx | !123 | Created/Existing |
| frontend | feat/xxx | !456 | Created/Existing |
| mobile | -- | -- | No changes, skipped |

**Phase 4 pass criteria**: All changed projects have MR created or confirmed opened, code fully pushed.

---

## Output: Pipeline Report

After all phases complete, write `<artifacts.dir>/<feature-slug>/pipeline-report.md`:

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

### Phase 4: Ship (Git MR)
| Project | MR Link | Status | Notes |
|---------|---------|--------|-------|

### Changed Files
| Project | File | Change Type |
|---------|------|-------------|

### Remaining Issues
| # | Issue | Impact | Suggestion |
```

Also update `<artifacts.dir>/index.md` status to `done`.

---

## Key Rules

1. **Phases cannot be skipped**: Must execute 1 -> 2 -> 3 -> 4 in order
2. **Phase failure stops pipeline**: Don't proceed to next phase on failure, fix first
3. **Orchestrate, don't execute**: Phase 1 and 3 use agents; main agent doesn't write code or run tests
4. **MR precision**: Only create MRs for projects with actual code changes vs target branch
5. **Artifact ownership**: All intermediates go to `<artifacts.dir>/<feature-slug>/`, never pollute source dirs
