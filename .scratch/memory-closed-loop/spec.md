# Verified Spec — Memory Closed-Loop System

## Overview
Implement a closed-loop memory system where the Main Agent autonomously records valuable daily memories via a `record_daily` tool, linked to session summaries, with automatic archiving and refinement.

## Architecture

### Data Flow
```
User message → Agent reasoning → record_daily tool call
  ↓
daily/YYYY-MM-DD.md (append)
  +
messages table (is_summary=1, session FTS)
  ↓
Scheduler: daily 3AM → POST /memory/archive
  ↓
long-term.md (merge) + archive/YYYY-MM-DD.md
  ↓
Auto-refine: refineLongTerm() → deduplicate + backup
```

### Components

#### 1. `recordDaily()` — MemoryService method
- **File**: `packages/server/src/services/agent/memory-service.ts`
- **Signature**: `recordDaily(org: string, content: string, sessionId: string): { ok: boolean; date: string }`
- **Behavior**:
  1. Compute `today = YYYY-MM-DD` and `time = HH:MM:SS`
  2. Append to `daily/{today}.md`: `\n### {time}\n{content}\n`
  3. Insert a summary message into the `messages` table:
     - `id = crypto.randomUUID()`
     - `session_id = sessionId`
     - `role = 'system'`
     - `content = content`
     - `is_summary = 1`
     - `is_compressed = 0`
  4. Rebuild FTS index (call `dao.rebuildFtsIndex()`)
  5. Return `{ ok: true, date: today }`

#### 2. `record_daily` tool definition in system prompt
- **File**: `packages/server/src/routes/agent/main-agent-route.ts`
- **Location**: New constant `RECORD_DAILY_TOOLS_PROMPT`, appended to system prompt
- **Content**: Tool definition + positive/negative usage examples
  - Positive: discovered user preference, learned a workflow pattern, made an important decision
  - Negative: simple greetings, factual Q&A, one-time lookups

#### 3. `record_daily` tool handler in main-agent-route.ts
- **File**: `packages/server/src/routes/agent/main-agent-route.ts`
- **Behavior**: When Claude SDK emits a `tool_call` for `record_daily`, extract `content` from input, call `memoryService.recordDaily(org, content, sessionId)`, return `{ ok: true, date }` as tool_result

#### 4. Scheduler auto-seed on server startup
- **File**: `packages/server/src/index.ts`
- **Behavior**: After DAO initialization, check if a schedule named `system:daily-archive` exists in the `schedules` table. If not, insert one:
  - `id = 'system:daily-archive'`
  - `name = 'system:daily-archive'`
  - `cron_expression = '0 3 * * *'` (daily at 3 AM)
  - `timezone = 'Asia/Shanghai'`
  - `job_type = 'agent'`
  - `config = JSON.stringify({ prompt: 'Archive yesterday daily memory and refine long-term memory' })`
  - `enabled = 1`
- **Implementation**: Add a `findByName` method to `ScheduleConfigDAO` if it doesn't exist, or use raw query in the seed logic

#### 5. Archive route auto-trigger refine
- **File**: `packages/server/src/routes/agent/memory.ts`
- **Location**: Inside `POST /memory/archive` handler, after successful archive operation
- **Behavior**: After archive succeeds (file moved, long-term merged), call `getMemoryService().refineLongTerm(org)` to auto-deduplicate and compress long-term memory. The refine result is included in the response.

#### 6. Archive reminder in SystemPromptAssembler
- **File**: `packages/server/src/services/agent/system-prompt-assembler.ts`
- **Location**: In `buildDailyMemorySegment()` or a new segment
- **Behavior**: Count daily `.md` files in the daily directory. If count > 3, append reminder text to the daily memory segment: "⚠️ You have {count} unarchived daily memory files. Consider archiving them."

## Constraints
- `record_daily` parameter is `{ content: string }` — minimal, Agent decides format
- Long-term memory is ONLY written through the archive→refine pipeline (no `record_longterm` tool)
- Session compression logic is NOT modified — `record_daily` writes a separate summary message
- Clone memory isolation (read-shared / write-isolated) is preserved
- The scheduler seed uses the existing `schedules` table (not a new table)

## Error Handling
- `recordDaily()` file write failure → return `{ ok: false }`, log warning
- `recordDaily()` DB insert failure → daily file still written, log warning, return `{ ok: true }` (file is primary)
- Archive auto-refine failure → archive still succeeds, refine error logged, response includes `refine_failed: true`
- Scheduler seed failure → log warning, non-fatal (server continues)
- Archive reminder count failure → silently skip (no reminder shown)

## Testing Strategy
- E2E scripts that verify the full pipeline via curl commands
- Unit tests for `recordDaily()` method
- Integration test for scheduler seed (idempotent insert)
