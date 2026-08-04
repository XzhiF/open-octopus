---
name: matt-verified-requirement
description: Verification-driven requirement clarification. Multi-turn dialogue using grilling or wayfinder paths. Clarifies requirements, defines verification strategies and acceptance criteria. Outputs a verified spec.md and DAG-structured issues/ for pipeline execution. Spawns story-walkthrough sub-agent for design validation. Uses domain-modeling to maintain project glossary and ADRs. Use when proposing new features, refactors, or discussing verification approaches.
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

All decision tickets resolved + map clear (no ungraduated fog) → write the **spec.md** (see Artifact Output below), spawn story-walkthrough sub-agent, fix spec with findings, then write **issues/** (DAG tickets).

## Verification Strategy Questions (both paths MUST cover)

This is the **core difference** from the original grilling skill. These dimensions must be fully explored:

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
- **Story Walk-Through sub-agent completed** and findings incorporated
- **issues/ written** with DAG tickets
- Max 15 rounds

### Wayfinder Path
- All decision tickets resolved
- Map clear — no ungraduated fog in "Not yet specified"
- All verification dimensions explored (both paths must cover these)
- **spec.md written** (see Artifact Output)
- **Story Walk-Through sub-agent completed** and findings incorporated
- **issues/ written** with DAG tickets
- Max 20 decision tickets (if more, consider splitting into multiple wayfinder efforts)

## Story Walk-Through Analysis (MANDATORY, sub-agent)

After the draft spec.md is written (see Artifact Output below), spawn a **Story Walk-Through sub-agent** to validate the design forms a complete closed-loop system.

**Why sub-agent**: 裁判 ≠ 球员 — the spec author cannot reliably find gaps in their own spec. An independent reader catches what the writer missed.

**Execution**:
1. Write draft `spec.md` (see Spec Template below)
2. Spawn sub-agent via Agent tool:
   ```
   Prompt: "Read the spec at <artifacts.dir>/<feature-slug>/spec.md and perform a
   Story Walk-Through analysis.
   Protocol: .claude/skills/matt-verified-requirement/references/story-walkthrough.md
   Explore the codebase freely to verify each story step.
   Return: structured break points with severity (CRITICAL/HIGH/MEDIUM/LOW),
   full story traces, and recommended fixes. Do NOT modify spec.md."
   ```
3. Read sub-agent's findings
4. Fix all CRITICAL and HIGH break points in spec.md:
   - Add missing types/schemas/APIs to Implementation Decisions
   - Add new ACs for each fix
   - Update Key Decisions with "Story Gap Fixes"
5. Re-trace if needed (spawn again if major structural changes)
6. Append story traces to spec.md Appendix

**Protocol details** → See [references/story-walkthrough.md](references/story-walkthrough.md)

**Watch for 6 anti-patterns**: Magic Bridge, Orphan Field, Silent Failure, Missing Trigger, Unversioned State, Unconnected Feedback.

## Artifact Output

On exit, create `<artifacts.dir>/<feature-slug>/` and write all artifacts.

### Grilling Path Output

```
<artifacts.dir>/<feature-slug>/
├── brief.md              ← Lightweight core info summary (for human review)
├── spec.md               ← Full verified spec (single source of truth for agents)
└── issues/               ← DAG tickets with blocked-by + verification
    ├── 01-<slug>.md
    ├── 02-<slug>.md
    └── ...
```

### Wayfinder Path Output

```
<artifacts.dir>/<feature-slug>/
├── brief.md              ← Lightweight core info summary (for human review)
├── spec.md               ← Full verified spec (written AFTER story walkthrough)
├── issues/               ← DAG tickets with blocked-by + verification
├── map.md                ← Decision map (wayfinder core artifact)
├── decisions/            ← Decision tickets (resolved during wayfinder stage)
│   ├── 01-research-sdk-plugin.md
│   ├── 02-prototype-prompt-length.md
│   └── 03-grilling-discovery.md
```

### brief.md — Lightweight Core Info (for human review)

brief.md is a **one-pager** (一页纸) for the user to quickly review. Contains:
- Overview (one sentence)
- Feature Scope (Do/Don't)
- Key Decisions table
- Acceptance Criteria summary (table: # | Story | AC — no verification detail)
- Risks & Notes
- Link: "Full spec: [spec.md](./spec.md)"

It does NOT contain detailed data models, API contracts, or verification methods — those live in spec.md.

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
2. Write `<artifacts.dir>/<feature-slug>/brief.md`
3. For wayfinder path, `map.md` and `decisions/` were already created during the wayfinder process
4. **Update `<artifacts.dir>/index.md`** (append new record, auto-increment number)
5. Tell the user the brief path and how to proceed (see Next Steps)

### Index File Maintenance

`<artifacts.dir>/index.md` tracks all features. **Append on every new feature**:

```markdown
| # | feature-slug | Created | Branch | Status |
|---|-------------|---------|--------|--------|
| N | <feature-slug> | YYYY-MM-DD | feat/<branch> | in-progress |
```

## Brief Template

```markdown
# Requirement Brief

## Overview
[One sentence description]

## Projects Involved
- [ ] [project-1] ([role])
- [ ] [project-2] ([role])

## Feature Scope
**Do:**
- [Feature 1]

**Don't:**
- [Exclusion 1]

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|

## Decision Map Summary (wayfinder path only)
<!-- Only include when wayfinder path was used. Synthesize all resolved decision tickets. -->

| # | Ticket | Type | Decision |
|---|--------|------|----------|

Map: [map.md](./map.md)

## Data Model Changes
| Table | Operation | Details |
|-------|-----------|---------|

## API Contracts
| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|

## Design Specs (if any)
- Figma link: [URL or "none"]
- Fidelity: [pixel-perfect 1:1 / rough alignment]

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|

## Verification Strategy

### Global Config
- Environment: [UAT / local]
- Test user: [account info]
- Data prefix: [e.g., "E2E_TEST_"]

### Per-layer Methods
#### Unit Tests
#### Integration Tests
#### Browser E2E
#### Contract Tests
#### Manual Checklist

### Prerequisites
- [ ] [Prerequisite 1]

## Risks & Notes
- R1: [risk]

## Glossary (new domain terms)
| Term | Meaning |
|------|---------|

## Appendix: Core User Stories（闭环验证）

以下 N 个故事追踪完整用户旅程，验证 UI → API → 数据 → 执行的每一步都连通。

### Story 1: [标题]
[Step-by-step trace with [UI]/[API]/[Data]/[Exec]/[Event] annotations]

### Story 2: [标题]
[...]

### Story 3: [标题]
[...]
```

## Relationship to Original Skills

| Original Skill | This Skill's Relationship |
|---------------|-------------------------|
| `grilling` | Reuses its one-question-at-a-time mode |
| `grill-with-docs` | **Replaces** — grilling + domain-modeling built in, plus verification strategy |
| `wayfinder` | **Adapts** its core protocol (map, decision tickets, fog of war, frontier) for single-entry flow with verification strategy. The standalone `/wayfinder` remains available for efforts outside this pipeline. |
| `domain-modeling` | **Reuses** — updates CONTEXT.md and creates ADRs inline |
| `matt-dev-runner` | **Downstream** — receives the brief for development execution |
| `matt-dev-pipeline` | **Downstream** — receives the brief for full pipeline execution |
| `matt-pipeline-loop` | **Downstream** — receives the brief for iterative pipeline with verification loop |
| `matt-verification-report` | **Indirect** — loop uses it to audit each iteration's results |

## Next Steps

Once the brief is confirmed and written to `<artifacts.dir>/<feature-slug>/brief.md`, tell the user:

> Requirement brief is ready at `<artifacts.dir>/<feature-slug>/brief.md`.
>
> You have three options to proceed:
>
> 1. **`matt-dev-runner`** — Development only. Invoke the agent to synthesize spec, split tickets, and run implement-verify loops. You handle deploy and PR yourself.
>
> 2. **`matt-dev-pipeline`** — Full pipeline. Orchestrate development → CI/CD deploy → E2E verification → Git PR delivery, all in one flow.
>
> 3. **`matt-pipeline-loop`** — Iterative pipeline with verification. Runs the full pipeline, then audits the result with `matt-verification-report`. If confidence < 85, auto-generates a gap-focused brief and re-runs. Loops until the feature is truly deliverable. Best for features with complex UI or high delivery standards.
