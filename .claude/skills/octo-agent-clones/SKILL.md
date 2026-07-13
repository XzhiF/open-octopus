---
name: octo-agent-clones
description: Agent clone lifecycle — create isolated agent clones with dedicated worktrees, merge results, delegate tasks. Use when running parallel agent work.
category: devops
tags: [agent, clones, worktree, parallel, delegate, octopus]
version: 1.0.0
priority: medium
---

# Octo Agent Clones

Manage agent clones — isolated agent instances with dedicated git worktrees for parallel task execution.

## CLI Commands

```bash
# List all clones
octopus agent clones --org <org>
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/agent/clones | Create clone with worktree |
| GET | /api/agent/clones | List all clones |
| DELETE | /api/agent/clones/:name | Delete clone and clean worktree |
| POST | /api/agent/clones/:name/merge | Merge clone branch to parent |
| POST | /api/agent/clones/:name/delegate | Delegate a task to clone |
| POST | /api/agent/clones/:name/delegate/cancel | Cancel running delegation |
| GET | /api/agent/clones/:name/experiences | Get clone-specific experiences |

## Clone Status Lifecycle

```
active → executing → idle → active
                ↘ (merge/delete)
```

- `active` — Ready to accept tasks
- `idle` — No active task
- `executing` — Running a delegated task

## Clone Configuration

```json
{
  "name": "feature-auth",
  "persona": "Backend specialist focused on authentication",
  "skills": ["octo-guide", "octo-dev-copilot"],
  "workspace_config": {
    "projects": ["xzf-octopus"],
    "branch": "feat/auth-module"
  },
  "memory_scope": ["long-term", "session"]
}
```
