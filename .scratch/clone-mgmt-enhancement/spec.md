# Verified Spec: Clone Management Enhancement + @@mention

## Summary

Unify the two parallel clone API systems, enhance clone management UI (system/user split, 2-step wizard, file management), and implement @@mention delegation mechanism for deterministic cross-clone communication.

## Background

PR #30 introduced a CloneRuntime infrastructure with 4 built-in clones (workspace, scheduler, archive, resource) and a DB-backed clone session system. However, two parallel API systems emerged:

- **Old system** (`/api/agent/clones`): Filesystem-backed via `meta.json`, used by frontend for CRUD + delegate + merge
- **New system** (`/api/clones`): DB-backed via CloneDAO, used for clone-specific session chat

This feature unifies them into a single filesystem-first API, adds display names, file management, and @@mention delegation.

## Decisions (from brief)

| # | Decision | Conclusion |
|---|---------|-----------|
| D1 | @@mention mechanism | Frontend intercepts `@@clone-id`, sends `delegate_to` field; backend skips LLM routing and calls CloneRuntime directly |
| D2 | @@mention scope | All chat pages; self-reference = no-op; no upward delegation to Main Agent |
| D3 | Creation flow | 2-step wizard: required (name + display_name + persona) + optional (skills + workspace + memory) |
| D4 | File management | All clones (built-in + user) editable — persona.md, config.json, memory/ |
| D5 | UI layout | Split display: system clones (top, 4 fixed) + user clones (bottom, createable/deletable) |
| D6 | Storage strategy | Filesystem is source of truth for clone definitions; DB stores sessions/messages only |
| D7 | API unification | Merge old `/api/agent/clones` + new `/api/clones` into one filesystem-based `/api/clones` |

## Architecture

### Clone Definition Storage

```
~/.octopus/agent/
  built-in/
    workspace/
      persona.md        ← persona content
      config.json       ← { display_name, skills, memoryScope, ... }
      memory/           ← isolated memory
    scheduler/...
    archive/...
    resource/...
  clones/
    my-clone/
      persona.md
      config.json
      memory/
```

### Unified API Surface

All clone management goes through `/api/clones` (filesystem-backed):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/clones` | List all clones (built-in + user) from filesystem |
| POST | `/api/clones` | Create user clone directory + config.json + persona.md |
| GET | `/api/clones/:name` | Get single clone details from filesystem |
| DELETE | `/api/clones/:name` | Delete user clone (built-in returns 403) |
| GET | `/api/clones/:name/files/:path` | Read clone file (whitelist: persona.md, config.json) |
| PUT | `/api/clones/:name/files/:path` | Write clone file (whitelist: persona.md, config.json) |

Session management remains at `/api/clones/:name/sessions/*` (DB-backed, unchanged).

### @@mention Flow

```
User types "@@scheduler help me set up cron"
  → Frontend detects @@scheduler pattern
  → Strips @@scheduler prefix, extracts message
  → POST /api/agent/chat { message: "help me set up cron", delegate_to: "scheduler", session_id }
  → Backend: delegate_to present → skip LLM routing → resolve clone → CloneRuntime.chat()
  → Response streams back with source: "scheduler" metadata
  → Frontend shows response with [scheduler] badge
```

### CloneInfo Response Type

```typescript
interface CloneInfo {
  name: string              // English ID (e.g., "scheduler")
  display_name: string      // Display name (e.g., "定时任务管理")
  type: 'built-in' | 'user'
  persona: string           // Persona excerpt (first 200 chars)
  skills: string[]
  memory_scope: 'shared' | 'isolated'
  workspace?: { name: string; path: string }
  status: 'active' | 'idle' | 'executing'
  created_at?: string
  last_active?: string
}
```

## Scope

### In Scope

- API unification: merge old clone-routes.ts (filesystem) + new clone/index.ts (DB) into single `/api/clones` filesystem-backed routes
- File management: GET/PUT clone files with path whitelist (persona.md, config.json)
- display_name field in config.json for all clones
- @@mention backend: `delegate_to` field in POST `/api/agent/chat`
- Frontend: split clone list (system/user sections), updated CloneInfo type
- Frontend: 2-step creation wizard with dynamic skills loading
- Frontend: file management panel (persona.md + config.json editor)
- Frontend: @@mention autocomplete + message parsing + delegate_to sending + source badge
- Update `clone-init-service.ts` to write display_name in config.json

### Out of Scope

- Playwright browser automation
- Clone permissions/roles
- Multi-clone parallel collaboration
- Workspace/Scheduler page chat behavior changes
- Clone marketplace/sharing
- PerspectiveIndicator activation (deferred)

## Risks

- **R1**: Old `/api/agent/clones` routes are called by frontend `api.ts` — migration must update all call sites
- **R2**: File management needs path traversal protection (`../../` guard)
- **R3**: @@mention in multiline messages or code blocks should not trigger
- **R4**: Frontend `lib/agent/api.ts` clone calls need unified switch
- **R5**: Existing CloneDAO usage in main-agent-route.ts and clone/index.ts needs to fall back to filesystem resolution

## Acceptance Criteria

| # | AC | Verification |
|---|----|----| 
| AC-01 | Clone list shows system section (4 built-in) + user section | Integration test + manual |
| AC-02 | 2-step creation wizard works, skills optional | Integration test |
| AC-03 | Skills loaded dynamically from API | Unit test |
| AC-04 | Built-in clones cannot be deleted (403) | Integration test |
| AC-05 | Clone files editable via API (persona.md, config.json) | Integration test |
| AC-06 | @@mention autocomplete shows clone list | Manual |
| AC-07 | @@mention delegation executes via CloneRuntime | Integration test |
| AC-08 | @@mention self-reference = no-op | Integration test |
| AC-09 | @@mention autocomplete excludes Main Agent | Manual |
| AC-10 | GET /api/clones returns built-in + user with type field | Integration test |
| AC-11 | display_name shown in cards and autocomplete | Manual |
