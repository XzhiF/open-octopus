---
name: octo-agent-memory
description: Agent memory search and management — FTS search across session summaries, rebuild FTS indexes, archive old sessions. Use when querying agent knowledge base.
category: devops
tags: [agent, memory, search, fts, archive, octopus]
version: 1.0.0
priority: medium
---

# Octo Agent Memory

Search and manage agent memory layers: long-term, daily, and session-scoped memory.

## CLI Commands

```bash
# Search memory
octopus agent memory "search query" --org <org> --layer long-term
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/agent/memory/search?q=query | Full-text search across session summaries |
| GET | /api/agent/memory/:layer | Get memory content for a layer |
| POST | /api/agent/memory | Write to memory |
| POST | /api/agent/memory/rebuild-fts | Rebuild FTS5 indexes |
| POST | /api/agent/memory/archive | Archive old sessions to long-term memory |

## Memory Layers

| Layer | Scope | Retention |
|-------|-------|-----------|
| `session` | Current session context | Session lifetime |
| `daily` | Day-scoped summaries | Configurable days |
| `long-term` | Refined persistent knowledge | Until manually cleared |

## FTS Architecture

Memory search uses SQLite FTS5 virtual tables (`session_memory_fts`). Summary messages are auto-synced via triggers when `is_summary=1`. Use `rebuild-fts` if search results are stale.
