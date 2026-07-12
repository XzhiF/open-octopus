---
name: octo-agent-debug
description: Agent debug tools — view debug logs, assemble prompt context for a chat session, inspect system prompt segments and token budgets. Use when troubleshooting agent behavior.
category: troubleshooting
tags: [agent, debug, prompt, tokens, system-prompt, octopus]
version: 1.0.0
priority: medium
---

# Octo Agent Debug

Debug agent behavior: inspect assembled system prompts, view token budget allocation, and analyze decision logs.

## CLI Commands

```bash
# View debug log
octopus agent tasks --org <org>
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/agent/debug/log | List debug log entries |
| GET | /api/agent/debug/assemble/:chat_id | Assemble full prompt context for a chat |

## Debug Log Structure

Each debug entry captures:

- `system_prompt` — Full system prompt sent to the model
- `segments` — Prompt segments with name, token count, budget, and degradation flag
- `skill_sources` — Map of skill name to source (local_evolved, builtin, prod)
- `decisions` — Decision trace log

## Prompt Segments

| Segment | Typical Budget | Description |
|---------|---------------|-------------|
| Base instructions | 2000 | Core agent behavior |
| Skills | 4000 | Loaded skill content |
| Memory | 2000 | Relevant memory context |
| Persona | 1000 | Clone persona or user preferences |
| Context | 3000 | File/project context |

When a segment exceeds its budget, it is marked `degraded: true` and truncated.

## Tasks & Reports

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/agent/tasks | List active tasks |
| POST | /api/agent/tasks/:id/cancel | Cancel a running task |
| GET | /api/agent/tasks/reports | List task reports |
| GET | /api/agent/tasks/reports/:id | Get report detail |
