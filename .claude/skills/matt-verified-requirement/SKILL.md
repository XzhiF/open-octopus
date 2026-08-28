---
name: matt-verified-requirement
description: Verification-driven requirement clarification. Multi-turn dialogue using grilling or wayfinder paths. Clarifies requirements, defines verification strategies and acceptance criteria. Outputs a verified spec.md and DAG-structured issues/ (always including an E2E ticket) for pipeline execution. At exit asks the user ONCE about execution options — story walk-through, E2E verification, ticket execution mode — and records them in spec.md as Execution Decisions. Uses domain-modeling to maintain project glossary and ADRs. Use when proposing new features, refactors, or discussing verification approaches.
dependencies: domain-modeling, grilling, wayfinder, research
---

# Verification-Driven Requirement Clarification

You are a **relentless challenger** of requirements, not a compliant executor. Your goal is to ensure requirements are clear, verification strategies are explicit, and acceptance criteria are executable — before any code is written.

## Core Principles

1. **No verification strategy = not clarified** — every AC must have a bound verification method
2. **One question at a time** — don't stack questions; resolve one decision branch at a time
3. **Don't ask what you can find** — environment, code structure, config: find it yourself; only ask for decisions
4. **Domain modeling in parallel** — terms and architecture decisions are persisted immediately (using `domain-modeling` skill)

## Domain Modeling (both paths, in parallel)

### Glossary Maintenance

When new terms emerge or term meanings are clarified:

1. **Challenge vague language**: "When you say 'account', do you mean Member or User? They're different concepts."
2. **Cross-validate**: Check existing CONTEXT-MAP.md, per-package CONTEXT.md, and code for inconsistencies; raise contradictions proactively
3. **Write to the right CONTEXT.md immediately**:
   - **System-wide terms** (cross-cutting, used by 3+ packages) → update CONTEXT-MAP.md glossary
   - **Package-specific terms** → update `packages/<name>/CONTEXT.md` (create if doesn't exist, using CONTEXT-FORMAT.md)
   - If CONTEXT-MAP.md exists, the repo has multiple contexts; infer which context the current topic relates to

### Architecture Decision Records (ADR)

Create an ADR when a decision meets ALL three criteria:

1. **Hard to reverse** — high cost to change later
2. **Surprising without context** — future readers would ask "why was this done this way?"
3. **Result of real tradeoffs** — genuine alternatives existed and one was chosen

Skip ADR when any criterion is not met.

**ADR storage**: ADRs are **project-level permanent records**, NOT feature artifacts. Always write ADRs to `docs/adr/NNNN-slug.md` (following `domain-modeling`'s ADR-FORMAT.md). Never put ADRs in `<artifacts.dir>/` — that directory is for ephemeral delivery artifacts (brief, spec, tickets).

## Path Selection

After 2-3 initial questions, determine which path fits:

| Signal | Grilling Path | Wayfinder Path |
|--------|--------------|----------------|
| Scope | 1 package, clear boundaries | 2+ packages, or boundaries unclear |
| Decisions | All decision branches visible | Fog — can sense decisions but can't phrase them all yet |
| Session fit | ~10 rounds can cover | Needs structured map to track progress |
| Parallelism | Single-threaded interview OK | Benefits from parallel research sub-agents |

**Default to Grilling** — faster and lighter. Escalate to Wayfinder when the surface keeps expanding.

**Mid-flight escalation**: If grilling discovers unexpected fog (suspected decisions it can't yet phrase), pause and propose switching to the wayfinder path. Get user confirmation before switching paths.

### Grilling Path (small to medium)

Ask one question at a time across these dimensions, each with your recommended answer:

```
1. Feature scope: What to do? What NOT to do?
2. Data model: Which tables/fields/cache?
3. Interface contracts: API paths, params, response
4. Frontend interaction: Page flow, component structure
5. Verification strategy: How do we know it's right? (core question)
6. Acceptance criteria: User stories + verifiable ACs
```

**Resolve each decision branch fully before switching.** If facts can be found by exploring the environment, find them yourself.

### Wayfinder Path (large / ambiguous)

Use when: 2+ projects involved, unknown decisions ahead, or effort too large for one grilling session.

#### Step 1: Name the Destination

One or two lines: what does reaching the end look like? The destination fixes scope — everything beyond it is out of scope.

#### Step 2: Breadth-First Grill

Fan out across the whole decision space (don't go deep on any one thread). Use `/grilling` + `/domain-modeling` to surface:
- Decisions already made → **Decisions so far**
- Questions you can ask precisely → **Decision Tickets**
- Questions you can sense but can't yet phrase → **Not yet specified** (fog of war)

#### Step 3: Create the Map

Write `<artifacts.dir>/<feature-slug>/map.md`:

```markdown
## Destination
<what reaching the end looks like>

## Notes
<domain context from CONTEXT-MAP.md, relevant ADRs, standing preferences>

## Decisions so far
<!-- one line per closed ticket: [ticket-title](link) — gist of the answer -->

## Not yet specified
<!-- fog of war: suspected questions, areas to revisit. In scope but not sharp enough to ticket. -->

## Out of scope
<!-- work beyond the destination, consciously ruled out -->
```

#### Decision Tickets

**Storage**: `<artifacts.dir>/<feature-slug>/decisions/NN-<slug>.md` — separate from `issues/` (which is for implementation tickets created later by `matt-dev-runner`).

**Four types** (aligned with original `/wayfinder`):

| Type | Mode | Description |
|------|------|-------------|
| `research` | AFK | Investigate facts — docs, APIs, codebase. Can fire `/research` sub-agent. |
| `prototype` | HITL | Build a throwaway artifact to react to — outline, stub, UI mockup. Keep the answer, delete the code. |
| `grilling` | HITL | One-question-at-a-time decision interview. **Default type.** |
| `task` | HITL/AFK | Manual prerequisite — sign up for a service, provision access, gather data. |

**Ticket template**:

```markdown
# NN — <Question>

Type: research | prototype | grilling | task
Status: open
Blocked by: NN, NN (or "None")

## Question

<the decision or investigation this ticket resolves>
```

**Blocking edges**: A ticket is unblocked when every ticket in its `Blocked by` list is `resolved`. Wire blocking in a second pass (tickets need numbers before they can reference each other).

#### Sub-Agent Parallel Research

Research tickets are AFK — they don't need the human. Fire them in parallel using the Agent tool:

For each research ticket on the frontier:
1. Claim it (set `Status: claimed`, save file)
2. Spawn a sub-agent via the Agent tool:
   - Prompt: "Research: <ticket question>. Write findings to <ticket-path> under `## Answer`. Set `Status: resolved`. Use primary sources — official docs, source code, specs."
3. Continue with the next HITL ticket while research sub-agents run
4. When a research sub-agent completes: read answer → update map's **Decisions so far** → graduate any fog it cleared

**Rule**: Never resolve more than one non-research HITL ticket per main session. Research sub-agents can run in parallel.

#### Fog of War

The map is deliberately incomplete. Beyond the live tickets lies **fog** — decisions you can tell are coming but can't yet pin down.

- **Fog or ticket?** The test is whether you can state the question precisely now — not whether you can answer it.
  - Can phrase it → create a ticket
  - Can't phrase it yet → write in "Not yet specified"
- **Graduation**: resolving a ticket may clear fog ahead of it — graduate specifiable fog into new tickets, clear each graduated patch from the section.
- **Out of scope ≠ fog**: scope decisions go to "Out of scope". Fog is about sharpness, not scope.

#### Frontier

The **frontier** = open + unblocked + unclaimed tickets. Select by number (lowest first).

#### Resolving Tickets (4-step loop)

1. **Claim**: set `Status: claimed`, save the file
2. **Execute** by type:
   - `research` → fire a research sub-agent (see "Sub-Agent Parallel Research" above); record findings
   - `prototype` → build a quick prototype, record the conclusion (code is throwaway)
   - `grilling` → use `/grilling` + `/domain-modeling`, one question at a time
   - `task` → do the manual work, record results (credentials location, URLs, data shape)
3. **Record**: append `## Answer` section to the ticket file, set `Status: resolved`
4. **Update map**:
   - Append one-line gist to **Decisions so far**
   - Graduate any fog now specifiable → create new tickets
   - Clear graduated fog from **Not yet specified**
   - If a ticket turns out to sit beyond the destination → close it, move to **Out of scope**

**Never resolve more than one non-research ticket per session** (research tickets can run in parallel via sub-agents).

#### Wayfinder Exit

All decision tickets resolved + map clear (no ungraduated fog) → write the **spec.md** (see Artifact Output below) → run the **Execution Decisions gate** (ONE batched ask: story walk-through / E2E / ticket execution mode, see below) → if walkthrough opted in: spawn story-walkthrough sub-agent, present findings to user for confirmation, fix spec with user-confirmed findings → write **issues/** (DAG tickets, always including the E2E ticket).

## Verification Strategy Questions (both paths MUST cover)

This is the **core difference** from the original grilling skill. These dimensions must be fully explored.

> **⚠️ MANDATORY GATE**: Before writing spec.md, you MUST create a dedicated decision ticket
> (e.g., "NN-grilling-verification-strategy") that covers ALL 6 dimensions below.
> This ticket MUST be resolved before the spec exit. If you skip it, the spec is INVALID.
> In the Wayfinder path, this ticket is created during Breadth-First Grill and resolved
> before writing the map's exit. In the Grilling path, this is the LAST question before Exit Conditions.

### 1. Verification Levels

What verification level does this feature need?
- Unit tests (Service methods)
- Integration tests (API end-to-end + cross-validation)
- Browser E2E (Playwright automation)
- Contract tests (VO <-> TypeScript interface field consistency)
- Manual checklist (fallback when no automation framework)

### 2. Middleware Connections

Which middleware needs verification?
- Database: which table, what data state?
- Cache: which key, what cache behavior?
- Other: file storage, message queues

### 3. Design Specs (if any)

Is there a Figma design?
- Figma link, relevant nodes
- Fidelity requirement: pixel-perfect 1:1 or rough alignment?
- Need to download image assets -> upload to CDN?

### 4. Test Data

What data for verification?
- Test user: which account?
- Seed data: what needs to be ready?
- Data isolation: prefix? Cleanup after?

### 5. Assertion Methods

How to determine "it's right"?
- API response assertions: which fields, expected values?
- Database assertions: SELECT what, expect how many rows, what values?
- Cache assertions: GET/SCAN expected results?
- UI assertions: what should be visible, what should NOT?

### 6. Prerequisites

What needs to be ready before verification?
- Environment: UAT / local / which branch?
- Dependencies: other modules deployed first?
- Auth: how to get a token?

## Exit Conditions

### Grilling Path
- User says "confirmed" or "hand to agent"
- All verification dimensions explored
- **spec.md written** (see Artifact Output)
- **Execution Decisions gate asked** (ONE batched ask) and answers recorded in spec.md `## Execution Decisions`
- **Story Walk-Through**: opted in → sub-agent completed, findings presented, user-confirmed fixes incorporated; opted out → skip recorded
- **issues/ written** with DAG tickets
- Max 15 rounds

### Wayfinder Path
- All decision tickets resolved
- Map clear — no ungraduated fog in "Not yet specified"
- All verification dimensions explored (both paths must cover these)
- **spec.md written** (see Artifact Output)
- **Execution Decisions gate asked** (ONE batched ask) and answers recorded in spec.md `## Execution Decisions`
- **Story Walk-Through**: opted in → sub-agent completed, findings presented, user-confirmed fixes incorporated; opted out → skip recorded
- **issues/ written** with DAG tickets
- Max 20 decision tickets (if more, consider splitting into multiple wayfinder efforts)

## Execution Decisions Gate (MANDATORY — ONE batched ask)

Once requirement clarification is complete (all decision branches resolved + verification strategy explored) and the draft spec.md is written, ask the user **all execution questions in ONE message** — never drip-feed them one by one:

| # | Question | Options | Recommendation basis |
|---|----------|---------|---------------------|
| 1 | **Story Walk-Through** — run the independent design-validation sub-agent? | run / skip | run: user-facing features, cross-module data flows, complex state machines · skip: small internal refactors, CLI-only, single-module tweaks |
| 2 | **E2E verification** — run E2E in the downstream pipeline (Phase 4)? | run / skip | run: spec has browser/API E2E ACs · skip: pure internal refactor, docs-only, or user will verify manually. **The E2E ticket is always generated regardless of this answer** |
| 3 | **Ticket execution mode** — how will pipeline Phase 1 implement tickets? | sub-agent concurrent (default) / current agent quick | sub-agent: multi-ticket / cross-package DAGs · quick: 1-2 small tickets where sub-agent spawn overhead outweighs isolation |

Rules:
- **Wait for the user's explicit answers** — never proceed with silent defaults.
- Record all three answers in spec.md `## Execution Decisions` (see Spec Template).
- Downstream `matt-dev-pipeline` reads this block; it only re-asks a decision if it is missing from spec.md.

## Story Walk-Through Analysis (OPTIONAL — per Execution Decisions, sub-agent)

This section runs **only if the user opted in at the Execution Decisions gate above** — the ask happens there, batched with the E2E and execution-mode questions. If the user opted out, skip this entire section (the decision is already recorded in spec.md `## Execution Decisions`) and proceed to issues/.

**What it does**: an independent sub-agent traces each core user story end-to-end through the design to validate it forms a complete closed-loop system.

**Why sub-agent**: 裁判 ≠ 球员 — the spec author cannot reliably find gaps in their own spec. An independent reader catches what the writer missed.

**Execution**:
1. Write draft `spec.md` (see Spec Template below)
2. Spawn sub-agent via Agent tool:
   ```
   Prompt: "Read the spec at <artifacts.dir>/<feature-slug>/spec.md and perform a
   Story Walk-Through analysis.
   Protocol: .claude/skills/matt-verified-requirement/references/story-walkthrough.md
   Explore the codebase freely to verify each story step.
   
   Output TWO things:
   1. Write <artifacts.dir>/<feature-slug>/story-walkthrough.md — a human-readable
      report with full story traces, break points, and recommendations.
      This file is for human review only, not consumed by the pipeline.
   2. Return structured break points with severity (CRITICAL/HIGH/MEDIUM/LOW)
      and recommended fixes to the parent agent.
   
   Do NOT modify spec.md."
   ```
3. Read sub-agent's findings
4. **Present findings to user and get confirmation** (MANDATORY GATE):
   - Show a structured summary of ALL break points, grouped by severity:
     - CRITICAL / HIGH: list each with description + recommended fix
     - MEDIUM / LOW: list each with description + recommendation (fix now vs note in Risks)
   - For each CRITICAL/HIGH finding, present the **specific recommended fix**:
     - What type/schema/API to add
     - What AC to add
     - What Key Decision to update
   - **Wait for user response**. The user may:
     - Confirm all findings → proceed to fix all
     - Reject specific findings → skip those, don't fix
     - Propose alternative fixes → use user's approach instead
     - Add their own modification suggestions → incorporate into the fix plan
   - Do NOT proceed to modify spec.md until user explicitly confirms the fix plan
5. Fix confirmed break points in spec.md:
   - Add missing types/schemas/APIs to Implementation Decisions
   - Add new ACs for each fix
   - Update Key Decisions with "Story Gap Fixes"
   - Incorporate any user-provided modifications
6. Re-trace if needed (spawn again if major structural changes)
7. Append story traces to spec.md Appendix

**Human-readable report**: The sub-agent writes `story-walkthrough.md` as a standalone artifact for human review. It is NOT consumed by downstream pipeline steps — purely for the user to understand what gaps were found and how the design was validated.

**Protocol details** → See [references/story-walkthrough.md](references/story-walkthrough.md)

**Watch for 6 anti-patterns**: Magic Bridge, Orphan Field, Silent Failure, Missing Trigger, Unversioned State, Unconnected Feedback.

## Artifact Output

On exit, create `<artifacts.dir>/<feature-slug>/` and write all artifacts.

### Grilling Path Output

```
<artifacts.dir>/<feature-slug>/
├── brief.md              ← Lightweight core info summary (for human review)
├── spec.md               ← Full verified spec (single source of truth for agents)
├── story-walkthrough.md  ← Walkthrough report (only when user opted in; review only, not consumed by pipeline)
└── issues/               ← DAG tickets with blocked-by + verification
    ├── 01-<slug>.md
    ├── 02-<slug>.md
    └── ...
```

### Wayfinder Path Output

```
<artifacts.dir>/<feature-slug>/
├── brief.md              ← Lightweight core info summary (for human review)
├── spec.md               ← Full verified spec (written AFTER story walkthrough, when user opted in)
├── issues/               ← DAG tickets with blocked-by + verification
├── map.md                ← Decision map (wayfinder core artifact)
├── decisions/            ← Decision tickets (resolved during wayfinder stage)
│   ├── 01-research-sdk-plugin.md
│   ├── 02-prototype-prompt-length.md
│   └── 03-grilling-discovery.md
```

### brief.md — Lightweight Core Info (for human review)

brief.md is a **minimal one-pager** (一页纸) for the user to quickly review. Contains:
- Overview (one sentence)
- Summary (decision count + AC count + story count, with links to spec.md)
- Risks
- Link to spec.md

It does NOT contain detailed tables — all details live in spec.md.

### spec.md — Single Source of Truth (for agents)

spec.md is the main technical document that downstream agents consume (matt-dev-runner sub-agents, matt-dev-pipeline, code-review). It contains everything needed to implement and verify the feature.

### What This Skill Does NOT Produce

Note: `spec.md` and `issues/` are now produced by **THIS skill** (see Artifact Output above). They were previously created by `matt-dev-runner` — that agent is now simplified to single-ticket implementation only. `brief.md` is a lightweight summary for human review.

The following artifacts are created **later** by downstream agents — this skill must **never** create them:

| Artifact | Created By | When |
|----------|-----------|------|
| `pipeline-report.md` | `matt-dev-pipeline` Phase 4 | After E2E verification |
| `e2e-*` directories | `matt-e2e-tester` | During E2E verification |
| `verification-report.md` | `matt-verification-report` | After pipeline completes (standalone or within loop) |
| `loop-state.json` | `matt-pipeline-loop` | During iterative pipeline |
| `loop-summary.md` | `matt-pipeline-loop` | When loop converges or exits |
| `<feature>-rN/` directories | `matt-pipeline-loop` | Each gap-fix iteration |

**Pipeline order**: brief + spec + issues → implement (DAG stages) → deploy → E2E → PR. Each phase owns its artifacts.

**ADR 不在此目录** — ADR 写入 `docs/adr/NNNN-slug.md`，见上方 ADR 规则。

**Naming**: `<feature-slug>` uses lowercase English + hyphens, e.g., `user-profile-edit`.

**Steps**:
1. Create directory `<artifacts.dir>/<feature-slug>/`
2. Write `<artifacts.dir>/<feature-slug>/brief.md` (lightweight core info)
3. Write `<artifacts.dir>/<feature-slug>/spec.md` (using `matt-verified-spec` skill as methodology reference)
4. Run the **Execution Decisions gate** — ONE batched ask (story walk-through / E2E / ticket execution mode) → record answers in spec.md `## Execution Decisions`
5. If walkthrough opted in: spawn story-walkthrough sub-agent → read findings → present to user for confirmation → fix spec.md; if opted out: proceed (decision already recorded)
6. Write `<artifacts.dir>/<feature-slug>/issues/` (using `matt-verified-tickets` skill as methodology reference) — **always append the final E2E ticket** (see Issues Writing rule 8)
7. For wayfinder path, `map.md` and `decisions/` were already created during the wayfinder process
8. **Update `<artifacts.dir>/index.md`** (append new record, auto-increment number)
9. Tell the user the output paths and how to proceed (see Next Steps)

### Index File Maintenance

`<artifacts.dir>/index.md` tracks all features. **Append on every new feature**:

```markdown
| # | feature-slug | Created | Branch | Status |
|---|-------------|---------|--------|--------|
| N | <feature-slug> | YYYY-MM-DD | feat/<branch> | in-progress |
```

## Brief Template (lightweight core info)

```markdown
# Brief: [Feature Title]

## Overview
[One sentence description]

## Summary
- [N] key decisions → [spec.md § Key Decisions](./spec.md)
- [N] execution decisions (walkthrough / E2E / mode) → [spec.md § Execution Decisions](./spec.md)
- [N] acceptance criteria → [spec.md § Acceptance Criteria](./spec.md)
- [N] core stories verified → [spec.md § Appendix](./spec.md)

## Risks
- R1: [risk]
- R2: [risk]

## Full Spec
[spec.md](./spec.md)
```

## Spec Template (single source of truth)

See `matt-verified-spec` skill (enhancement of `to-spec`) for verification strategy additions and writing rules.

```markdown
# Spec: [Feature Title]

## Problem Statement
The problem users face, described from the user's perspective.

## Solution
The solution, described from the user's perspective.

## Projects Involved
- [ ] [project-1] ([role])
- [ ] [project-2] ([role])

## Feature Scope
**Do:** / **Don't:**

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|

## Execution Decisions
<!-- Filled at the ONE batched exit gate; consumed by matt-dev-pipeline (it re-asks only if a row is missing) -->
| # | Decision | Choice | Reason |
|---|----------|--------|--------|
| 1 | Story Walk-Through | run / skipped (user decision) | |
| 2 | E2E Verification (pipeline Phase 4) | run / skip (user decision) | |
| 3 | Ticket Execution Mode | sub-agent-concurrent / main-agent-quick | |

## Decision Map Summary (wayfinder path only)
| # | Ticket | Type | Decision |
|---|--------|------|----------|
Map: [map.md](./map.md)

## User Stories
1. As a [role], I want [capability], so that [benefit]
(Exhaustive list covering all aspects of the feature)

## Implementation Decisions
- Modules involved (new / modified)
- Inter-module interface definitions
- Data model changes (tables, fields, indexes)
- API contracts (paths, methods, params, response)
- Caching strategy
- Architecture decisions

## Data Model Changes
| Table | Operation | Details |
|-------|-----------|---------|

## API Contracts
| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|

## Design Specs (if any)
- Figma link: [URL or "none"]
- Fidelity: [pixel-perfect 1:1 / rough alignment]

## Verification Strategy

### Verification Environment
| Item | Value |
|------|-------|
| Environment | [local dev: `pnpm dev`] |
| API prefix | `/api/` |
| Database | SQLite: `~/.octopus/db/octopus.db` |
| Admin UI | `http://localhost:3000` |

### Test Users & Data
| Item | Value |
|------|-------|
| Test account | [admin / regular user] |
| Data prefix | E2E_TEST_ |
| Cleanup | DELETE after test |

### AC to Verification Method Mapping
| US# | User Story | AC | Verification Level | Verification Method |
|-----|-----------|-----|-------------------|---------------------|

### Verification Methods Detail
#### Unit Tests
#### Integration Tests
#### Browser E2E
#### Contract Tests
#### Manual Checklist

### Anti-Fake-Run Standards (R1-R8)
| # | Criterion | Description |
|---|-----------|-------------|
| R1 | Real service | Use real address, not mock |
| R2 | Business data | Assert specific field values |
| R3 | Cross-validation | API ↔ DB, at least two-way |
| R4 | Evidence | Response body + DB query |
| R5 | Side effects | Write ops verify DB change |
| R6 | Real user path | Obtain token through login |
| R7 | Data isolation | E2E_TEST_ prefix |
| R8 | Repeatable | No manual pre-steps |

### Prerequisites
- [ ] [Prerequisite 1]

## Risks & Notes
- R1: [risk]

## Glossary (new domain terms)
| Term | Meaning |
|------|---------|

## Appendix: Core User Stories（闭环验证）
### Story 1: [标题]
[Step-by-step trace with [UI]/[API]/[Data]/[Exec]/[Event] annotations]
### Story 2: [标题]
[...]
```

**Spec writing rules** (from `matt-verified-spec`):
1. Every User Story MUST have a verification method
2. Verification methods must be executable (specific commands, not "test the API")
3. Use project domain terminology (consistent with CONTEXT.md)
4. No implementation code (describe decisions, not code)
5. No scope reduction ("for now", "for the initial implementation" forbidden)

## Issues Writing (DAG Tickets)

After spec.md is finalized (including story walk-through fixes, when the user opted in), write implementation tickets to `<artifacts.dir>/<feature-slug>/issues/`.

See `matt-verified-tickets` skill (enhancement of `to-tickets`) for verification method additions and DAG rules.

### Process
1. Gather context (read spec.md, explore codebase)
2. Split into vertical slices (tracer bullet principles)
3. Order by dependency: DB → Entity → Service → Controller → Frontend API → Frontend pages → E2E
4. Bind verification method to each ticket
5. Declare blocking edges (`Blocked by` field — this creates the DAG)
6. Write to files: one per ticket, numbered from `01-<slug>.md`

### Ticket Template

```markdown
# <NN> — <Ticket Title>

## What to build
Describe the end-to-end behavior this ticket implements, from the user's perspective.

## Blocked by
Prerequisite ticket numbers/titles, or "None — can start immediately".

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: [specific verifiable condition]
- [ ] AC2: [specific verifiable condition]

## Verification Method
**Verification type**: [unit test / integration test / browser E2E / contract test / manual checklist]

**Verification steps**:
[Specific commands, SQL, assertions]

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
```

**Status field convention**: The value under `## Status` heading is plain text. Valid values: `ready-for-agent` (initial), `in-progress` (claimed), `done` (verified), `skip` (failed after retries). Both matt-dev-runner and matt-dev-pipeline read this field to track progress.

### Issues Writing Rules
1. Every ticket MUST have a Verification Method
2. Vertical Slice — each ticket is a complete narrow path
3. Independently verifiable — each ticket can be verified on its own
4. Clear dependencies — `Blocked by` explicitly declares prerequisites
5. Executable verification — specific commands, specific SQL, specific assertions
6. One session size — each ticket fits in one agent call
7. DAG structure — tickets without mutual blockers can run concurrently in the same stage
8. **E2E ticket always generated** — regardless of the user's E2E run/skip choice, `issues/` MUST end with exactly one `NN-e2e-verification.md` ticket: blocked by all functional tickets, Verification type = browser E2E / API integration test (per spec's Verification Strategy), ACs drawn from the spec's E2E-level ACs. The pipeline's Phase 4 consumes it when E2E runs; when the user skips E2E, the pipeline marks it `skip (user decision)`.

## Relationship to Original Skills

| Original Skill | This Skill's Relationship |
|---------------|-------------------------|
| `grilling` | Reuses its one-question-at-a-time mode |
| `grill-with-docs` | **Replaces** — grilling + domain-modeling built in, plus verification strategy |
| `wayfinder` | **Adapts** its core protocol (map, decision tickets, fog of war, frontier) for single-entry flow with verification strategy. The standalone `/wayfinder` remains available for efforts outside this pipeline. |
| `domain-modeling` | **Reuses** — updates CONTEXT.md and creates ADRs inline |
| `matt-verified-spec` | **Enhancement of `to-spec`** — adds verification strategy block (environment, AC mapping, methods detail, anti-fake-run R1-R8) |
| `matt-verified-tickets` | **Enhancement of `to-tickets`** — adds verification method binding per ticket (executable steps, DAG structure) |
| `matt-dev-runner` | **Simplified** — now a single-ticket implementer, spawned concurrently by pipeline per DAG stage |
| `matt-dev-pipeline` | **Downstream** — receives spec.md + issues/ for DAG-based concurrent execution |
| `matt-pipeline-loop` | **Downstream** — receives spec.md + issues/ for iterative pipeline with verification loop |
| `matt-verification-report` | **Indirect** — loop uses it to audit each iteration's results |

## Next Steps

Once all artifacts are written, tell the user:

> Verified spec and tickets are ready:
> - Brief (core info): `<artifacts.dir>/<feature-slug>/brief.md`
> - Spec: `<artifacts.dir>/<feature-slug>/spec.md`
> - Tickets: `<artifacts.dir>/<feature-slug>/issues/` (N tickets, M stages)
>
> Two options to proceed:
>
> 1. **`matt-dev-pipeline`** — Full pipeline. DAG-based concurrent development → code review → deploy → E2E verification → Git PR delivery.
>
> 2. **`matt-pipeline-loop`** — Iterative pipeline with verification. Runs the full pipeline, then audits with `matt-verification-report`. If confidence < 85, auto-generates a gap-focused brief and re-runs. Loops until the feature is truly deliverable.
