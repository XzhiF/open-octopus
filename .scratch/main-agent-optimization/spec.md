# Technical Spec — Main Agent Optimization

## Overview
Transform the Main Agent from a half-finished product into a complete autonomous Agent workstation: manageable Skills, evolution pipeline, and fully functional memory system.

## Architecture Changes

### 1. Remove Tasks Tab (web-app)
- Remove `task` entry from `TAB_CONFIG` in `AgentTabs.tsx`
- Task component files stay orphaned (no deletion needed)

### 2. Fix Diff Text (server)
- `GET /skills/:name/diff-builtin` currently returns `{ has_diff: boolean }` without the actual diff
- Add unified diff computation using `diff` npm package (or `child_process`)
- Response: `{ has_diff, diff: string, builtin_version, local_version }`

### 3. Fix Experience Search (server)
- `GET /evolution/experiences` ignores `q` query parameter
- Wire `q` to `EvolutionDAO.searchExperiences(q)` which already exists with FTS5

### 4. Daily Memory Edit (web-app)
- Add edit button to `DailyBrowser.tsx`
- Textarea editor + save via `addMemory({ layer: 'daily', content })`

### 5. Memory Refine Server (web-app)
- `RefineModal.tsx` currently does client-side dedup
- Replace with `POST /memory/refine` API call (endpoint already exists)

### 6. Insight Marks Table (server + schema)
- New `insight_marks` table in `schema.sql`
- DAO methods: `insertMark`, `listUnprocessedMarks`, `markProcessed`

### 7. Evolution Batch Processor (server)
- `POST /evolution/mark-insight` — insert insight mark
- `POST /evolution/process-marks` — batch process all unprocessed marks

### 8. Agent Evolution Tools (server)
- Register tools in system prompt: `mark_insight`, `evolve_skill`, `create_experience`, `merge_skills`, `archive_skill`
- Detect tool calls in main-agent-route.ts, execute via EvolutionService

### 9. Skill Detail Page (web-app)
- New `SkillDetailView.tsx` — 3-panel resizable layout
- Skill list | Content editor (markdown preview + edit) | Diff viewer
- Wire to existing getSkill API + new PUT /skills/:name endpoint

### 10. Cleanup Dead Code (server)
- Delete `packages/server/src/routes/agent/evolution.ts` (overlaps with evolution-routes.ts)
- No imports reference it (verified: only index.ts imports evolution-routes.ts)

## Data Model

### insight_marks (new table)
```sql
CREATE TABLE IF NOT EXISTS insight_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  insight TEXT NOT NULL,
  session_id TEXT,
  org TEXT NOT NULL,
  marked_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed INTEGER NOT NULL DEFAULT 0
);
```

## API Additions

| Method | Path | Purpose |
|--------|------|---------|
| POST | /evolution/mark-insight | Create insight mark |
| POST | /evolution/process-marks | Batch process marks |
| PUT | /skills/:name | Save skill content |

## File Changes Summary
- Modified: AgentTabs.tsx, skill-routes.ts, evolution-routes.ts, DailyBrowser.tsx, RefineModal.tsx, schema.sql, schema.ts, evolution-dao.ts, types.ts, api.ts, SkillTab.tsx, SkillList.tsx, main-agent-route.ts
- Created: SkillDetailView.tsx
- Deleted: evolution.ts
