---
name: octo-agent-workspace
description: Workspace creation, CLAUDE.md rules injection, and lifecycle management
category: coding-assistant
tags: [workspace, worktree, lifecycle, rules, claude-md]
---

# Octopus Agent Workspace

## Purpose
Manage workspace creation, CLAUDE.md rules injection, and lifecycle (keep/cleanup/archive) after task completion.

## Trigger Conditions
- Orchestrator creates a workspace for workflow execution
- Clone system creates workspace for clone binding
- Task completion triggers lifecycle decision

## Behavior Instructions

### Workspace Creation
1. Create git worktree from target repository
2. Generate workspace metadata (`.octopus-workspace-meta.json`)
3. Inject workspace_rules into CLAUDE.md (idempotent)

### Workspace Rules Injection (B4)
Inject rules with markers:
```markdown
<!-- workspace_rules:begin -->
## Workspace Rules (Auto-injected by Agent)
### Constraints
- Do not modify workspace configuration files
- All changes must be committed to the current branch
### Branch Policy
- Commit to current branch, create PR for review
<!-- workspace_rules:end -->
```

Rules sources:
- Workflow requirements (target repo, branch policy)
- Repo Knowledge (project-specific constraints)
- Safety defaults (no .env modification, no force push)

### Lifecycle Management (B5)
After task completion:
- **Success + PR merged**: Ask user about cleanup
- **Failure/Cancelled**: Keep workspace for investigation
- **Clone workspace**: Never auto-cleanup (follows clone lifecycle)

### Cleanup Process
1. Remove workspace_rules from CLAUDE.md
2. Mark workspace as completed in metadata
3. Optionally remove git worktree (preserve main branch)
