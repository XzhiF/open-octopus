# Story Walk-Through Analysis

## Why This Matters

Decision-by-decision grilling produces individually sound choices, but does NOT guarantee they connect end-to-end. A design can have perfect schemas, perfect APIs, and perfect ACs — yet still have stories that break mid-flow because a UI component doesn't exist, a data field is missing, or a package boundary blocks execution.

## Method

### Step 1: Select Core Stories

Choose **1–3 user stories** that cover the feature's primary value. Each story should:
- Represent a different user persona (developer, admin, end-user)
- Span the full stack (UI → API → data → backend execution)
- Include at least one "happy path" and one "intervention path" (manual override, error recovery, rollback)

Example selection:
```
Story 1: [Primary user] creates/uses the feature (happy path)
Story 2: [System] detects a problem → automatic response → human reviews result
Story 3: [Admin] monitors health → intervenes manually → sees outcome
```

### Step 2: Trace Each Story Step-by-Step

For each story, trace the complete user journey in sequential steps. At **every step**, annotate the touchpoint type:

```
[UI]     — What the user sees/interacts with
[API]    — What endpoint is called, what params/response
[Data]   — What table/field is read or written
[Exec]   — What backend logic runs, which package owns it
[Event]  — What SSE/WebSocket event fires
```

Format as a vertical flow with annotations:

```markdown
User opens page
  │
  ├─[UI] Dashboard renders → needs GET /api/feature/dashboard
  │
  ├─[API] GET /api/feature/dashboard → returns DashboardData
  │
  ├─[Data] Query feature_table WHERE ...
  │
  └─[Exec] Engine calls Service.method() ← which package?
```

### Step 3: Identify Break Points

At each step, ask these checkpoint questions:

| Check | Question |
|-------|----------|
| **UI exists?** | Does the UI component/page exist in the current codebase, or does it need to be built? |
| **API exists?** | Is the endpoint already implemented, or is it new? If new, is the response type defined? |
| **Data reachable?** | Can the code at this step actually access the data it needs? Cross-package? Cross-service? |
| **Event connected?** | If this step depends on an async event (SSE, webhook, cron), is the event defined and the handler implemented? |
| **Feedback loop closed?** | If this step produces output that feeds into a later step, is the data format consistent? |
| **Error path defined?** | What happens if this step fails? Is the error propagated to the user? |

Mark every break point:

```markdown
├─[Exec] Engine calls VersionResolver
│         ← [断点A] VersionResolver is in server package,
│            engine cannot access it. SystemAgentContext needed.
```

### Step 4: Classify and Fix

Categorize each break point:

| Severity | Meaning | Action |
|----------|---------|--------|
| **CRITICAL** | Story cannot proceed — execution blocks | Must fix before brief is written |
| **HIGH** | Story proceeds but produces wrong/incomplete results | Must fix before brief is written |
| **MEDIUM** | Story works but UX is degraded (missing feedback, no loading state) | Document in brief, fix during implementation |
| **LOW** | Cosmetic or convenience issue | Note in Risks section |

For each CRITICAL and HIGH break point:
1. Design a specific fix (new type, new field, new callback, new component)
2. Add it to the Key Decisions table
3. Add corresponding ACs
4. Update affected schemas/APIs/data model

### Step 5: Re-trace

After fixes, re-trace the stories to verify all break points are resolved. If new break points emerge from the fixes, iterate until clean.

## Output

Append to the brief:
1. **Core Stories** section (Appendix) with full step-by-step traces
2. Break points discovered → added to Key Decisions as "Story Gap Fixes"
3. New ACs for each fix
4. New types/schemas/APIs needed to close the gaps

## Example (abbreviated)

```
Story: Agent fails → evolution triggers → produces improvement

  Agent execution fails
    │
    ├─[Exec] failureRecorder() writes to evolution_failures
    │         ← [断点] recorder is in server, executor is in engine
    │         FIX: Add failureRecorder callback to SystemAgentContext
    │
    ├─[Data] 5 failures in 24h → trigger evolution
    │
    ├─[Exec] Generator reads feedback by version
    │         ← [断点] feedback table has no version_tag field
    │         FIX: Add version_tag to evolution_feedback table
    │
    ├─[Exec] Generator outputs patch
    │         ← [断点] Output format undefined (full content? diff?)
    │         FIX: Define GeneratorOutput type (full content + rationale)
```

## Anti-Patterns to Watch For

1. **"The magic bridge"** — Two packages need to share data, but no interface connects them. Look for any step where execution crosses a package boundary.
2. **"The orphan field"** — A table column or type field is referenced in one step but never populated in any prior step. Trace every field back to its writer.
3. **"The silent failure"** — A step can fail, but no error event, no user notification, no retry. Every failure path needs a destination.
4. **"The missing trigger"** — An automatic process (auto-promote, auto-rollback, auto-cleanup) has no one to invoke it. Identify the scheduler/cron/event that fires it.
5. **"The unversioned state"** — Data gets overwritten without version tracking. If any artifact evolves, it needs a version chain.
6. **"The unconnected feedback"** — Step A produces output, Step B needs it as input, but the data format or channel doesn't match. Verify the full signal chain.
