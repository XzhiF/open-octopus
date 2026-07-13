---
name: octo-agent-sessions
description: Agent session management — list, create, chat, stop sessions via CLI or API. Use when managing agent conversations or querying session history.
category: devops
tags: [agent, sessions, chat, conversation, octopus]
version: 1.0.0
priority: medium
---

# Octo Agent Sessions

Manage agent sessions: list active sessions, view session details, search session history, and stop running sessions.

## CLI Commands

```bash
# List sessions
octopus agent sessions --org <org> --limit 20

# Check agent health (includes session count)
octopus agent health
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/agent/sessions | List sessions (paginated) |
| POST | /api/agent/sessions | Create new session |
| GET | /api/agent/sessions/:id | Get session detail |
| PATCH | /api/agent/sessions/:id | Update session (title, clone) |
| DELETE | /api/agent/sessions/:id | Delete session |
| POST | /api/agent/sessions/:id/chat | Send chat message |
| POST | /api/agent/sessions/:id/stop | Stop running session |

## Session Types

- `main` — Primary agent session
- `delegate` — Delegated sub-task session
- `clone_direct` — Session tied to a specific clone

## Session Lifecycle

1. Create session with `POST /api/agent/sessions`
2. Send messages via `POST /api/agent/sessions/:id/chat` (SSE stream)
3. Stop with `POST /api/agent/sessions/:id/stop` if needed
4. Delete to archive: `DELETE /api/agent/sessions/:id`
