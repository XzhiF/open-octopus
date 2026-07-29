# Spec: Agent Config Tab Completion

## Overview

Complete the Agent Config tab's half-finished functionality on branch `feat/main-agent-optimization`:
- Add a two-level engine→model selector (default: claude/pro) sourcing data from `GET /api/system/models`
- Add missing config controls: timeout (30–1800s, default 300), max_clones (1–20, default 5), debug.enabled (toggle)
- Fix 7 known bugs in DebugLogViewer and SafetyAudit components
- Wire safety event writes (DAO method exists but has zero callers)
- Refactor misc-routes.ts to use agentService instead of direct JSONL file reading

## Scope

**In scope:**
- Engine→model two-level dropdown in ConfigTab, defaulting to claude/pro, persisted via `PUT /api/agent/config`
- Timeout, max_clones, debug.enabled UI controls with validation
- B1: skill_sources crash guard (frontend `?? {}` + backend field population)
- B2: Empty summary (map `message` → `summary` in backend response)
- B3: Missing budget/degraded in segments (call `truncateToBudget` in `getAssembleDetail`)
- B4: Selection highlight (use `chat_id` for comparison instead of `id`)
- B5: Safety event writes at dangerous-command interception, safe-mode toggle, boundary violations
- B6: Operation text tooltip + expandable detail
- B7: Context field collapsible rendering
- Backend refactor: misc-routes debug/assemble endpoints delegate to agentService methods

**Out of scope:**
- Changes to `/system/models` page itself
- `inactive_days_threshold` control
- Changes to PersonaEditor, NotificationConfig, MemoryStrategyConfig, SafeModePanel
- Model degradation logic

## Architecture Changes

### Backend (packages/server)

**misc-routes.ts refactor:**
- `GET /debug/log` (line 463): Replace direct JSONL reading with `agentService.getDebugLog(org, { limit })`. The agentService already maps `message→summary` and assigns `id` from `chat_id`.
- `GET /debug/assemble/:chat_id` (line 505): Replace direct `SystemPromptAssembler` usage with `agentService.getAssembleDetail(org, chatId)`. Enhance the service method to return `skill_sources`, `decisions`, and `budget`/`degraded` fields per segment.

**agent-service.ts getAssembleDetail enhancement:**
- Call `assembler.truncateToBudget(segments, maxTokens)` to compute `budget` and `degraded` per segment
- Return `skill_sources: {}` (empty default — populated from assembler if available)
- Return `decisions: []` (empty default)

**Safety event writes (B5):**
- `safe-mode.ts`: After `POST /safe-mode/enable` and `POST /safe-mode/disable`, call `safetyDAO.insertSafetyEvent()` with type=`safe_mode_toggle`
- `chat-routes.ts`: Before executing commands, call `safetyInterceptor.checkAndIntercept()`. On `action: 'block'`, call `safetyDAO.insertSafetyEvent()` with type=`dangerous_command`
- Boundary violations: When `isPathOutsideWorkspace()` returns true, write type=`boundary_violation`

**Dependencies for safe-mode.ts:** Add `safetyDAO` to deps.
**Dependencies for chat-routes.ts:** Already has `safetyDAO` in deps; add `getSafetyInterceptor()` import.

### Frontend (packages/web-app)

**ModelSelector component (new):**
- Parse `GET /api/system/models` response (YAML content → `providers` block)
- Two dropdowns: engine (provider key) → model (alias key under provider)
- Default selection: `claude` / `pro`
- On save: write `model: "{engine}/{alias}"` format to config via `PUT /api/agent/config`

**ConfigTab enhancements:**
- Add ModelSelector component
- Add timeout input (number, 30–1800, step 1, default 300)
- Add max_clones input (number, 1–20, step 1, default 5)
- Add debug.enabled toggle (Switch)

**DebugLogViewer fixes:**
- B1 (line 105): `selectedLog.skill_sources` → `(selectedLog.skill_sources ?? {})`
- B2: Already fixed by backend agentService mapping; verify frontend reads `summary` field
- B4 (line 64): `selectedLog?.id === log.id` → `selectedLog?.chat_id === log.chat_id`

**SafetyAudit fixes:**
- B6 (line 46): Add `title={event.operation}` to the truncated span
- B7: Add collapsible `<details>` panel for `event.context`

## Data Model

No database schema changes. Agent config remains in `~/.octopus/agent/config.yaml`.

## API Contract Changes

| Endpoint | Change |
|----------|--------|
| `GET /api/agent/debug/log` | Response items gain `summary` and `id` fields (from agentService) |
| `GET /api/agent/debug/assemble/:chat_id` | Response gains `skill_sources`, `decisions`; segments gain `budget`, `degraded` |
| `PUT /api/agent/config` | Accepts `model` in `engine/alias` format, `timeout`, `max_clones`, `debug.enabled` |
| `GET /api/system/models` | No change — frontend parses YAML content field |

## Acceptance Criteria

| # | AC | Verification |
|---|-----|-------------|
| AC1 | Model selector shows engine→model dropdowns, defaults to claude/pro, saves correctly | E2E |
| AC2 | Timeout input (30–1800) saves and persists | E2E |
| AC3 | max_clones input (1–20) saves and persists | E2E |
| AC4 | debug.enabled toggle saves and persists | E2E |
| AC5 | DebugLogViewer: summaries display, click doesn't crash, selection highlight correct | E2E |
| AC6 | Safety events written on dangerous command, safe mode toggle, boundary violation | API test |
| AC7 | SafetyAudit: operation tooltip, context expandable | E2E |
| AC8 | Segment details show token_count/budget and degraded indicator | E2E |

## Risks

- **R1**: YAML parse failure in frontend ModelSelector → catch and show error state
- **R2**: Safety event writes in chat-routes must not block SSE streaming → fire-and-forget with catch
- **R3**: truncateToBudget needs maxTokens parameter → use config value or default 8000
