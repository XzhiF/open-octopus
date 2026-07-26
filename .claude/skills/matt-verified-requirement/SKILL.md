---
name: matt-verified-requirement
description: Verification-driven requirement clarification. Multi-turn dialogue using grilling or wayfinder paths. Clarifies requirements, defines verification strategies and acceptance criteria. Outputs a structured brief for agent execution. Uses domain-modeling to maintain project glossary and ADRs. Use when proposing new features, refactors, or discussing verification approaches.
dependencies: domain-modeling, grilling, wayfinder
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
2. **Cross-validate code**: Check existing CONTEXT.md and code for inconsistencies; raise contradictions proactively
3. **Write to CONTEXT.md immediately**: Update the relevant project's CONTEXT.md once a term is settled

### Architecture Decision Records (ADR)

Create an ADR when a decision meets ALL three criteria:

1. **Hard to reverse** — high cost to change later
2. **Surprising without context** — future readers would ask "why was this done this way?"
3. **Result of real tradeoffs** — genuine alternatives existed and one was chosen

Skip ADR when any criterion is not met.

**ADR storage**: ADRs are **project-level permanent records**, NOT feature artifacts. Always write ADRs to `docs/adr/NNNN-slug.md` (following `domain-modeling`'s ADR-FORMAT.md). Never put ADRs in `<artifacts.dir>/` — that directory is for ephemeral delivery artifacts (brief, spec, tickets).

## Path Selection

After 2-3 initial questions, determine:

| Characteristics | Path | Expected rounds |
|----------------|------|----------------|
| 1 project, clear scope | **Grilling path** | 5-10 rounds |
| 2+ projects, unknown decisions | **Wayfinder path** | Map first, then resolve |

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

**Storage**: `<artifacts.dir>/<feature-slug>/decisions/NN-<slug>.md` — separate from `issues/` (which is for downstream implementation tickets).

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
   - `research` → fire `/research` sub-agent, or investigate yourself; record findings
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

All decision tickets resolved + map clear (no ungraduated fog) → write the **brief** (see Artifact Output below). The brief synthesizes all decisions + verification strategy.

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
- Max 15 rounds

### Wayfinder Path
- All decision tickets resolved
- Map clear — no ungraduated fog in "Not yet specified"
- All verification dimensions explored (both paths must cover these)
- Max 20 decision tickets (if more, consider splitting into multiple wayfinder efforts)

## Artifact Output

On exit, create `<artifacts.dir>/<feature-slug>/` and write the brief.

### Grilling Path Output

```
<artifacts.dir>/<feature-slug>/
├── brief.md              <- Requirement brief (this skill's output)
├── spec.md               <- Verified Spec (downstream: matt-dev-runner Step 1)
└── issues/               <- Implementation tickets (downstream: matt-dev-runner Step 2)
    ├── 01-xxx.md
    └── ...
```

### Wayfinder Path Output

```
<artifacts.dir>/<feature-slug>/
├── brief.md              <- Requirement brief (written AFTER all decision tickets resolved)
├── map.md                <- Decision map (wayfinder core artifact)
├── decisions/            <- Decision tickets (wayfinder stage only)
│   ├── 01-research-sdk-plugin.md
│   ├── 02-prototype-prompt-length.md
│   └── 03-grilling-discovery.md
├── spec.md               <- Verified Spec (downstream: matt-dev-runner Step 1)
└── issues/               <- Implementation tickets (downstream: matt-dev-runner Step 2)
    ├── 01-schema.md
    └── ...
```

**`decisions/` vs `issues/`**: Decision tickets (what to build and why) live in `decisions/`. Implementation tickets (how to build it) live in `issues/`. They never conflict — `decisions/` is written by this skill during wayfinder, `issues/` is written later by `matt-verified-tickets`.

**ADR 不在此目录** — ADR 写入 `docs/adr/NNNN-slug.md`，见上方 ADR 规则。

**Naming**: `<feature-slug>` uses lowercase English + hyphens, e.g., `user-profile-edit`.

**Steps**:
1. Create directory `<artifacts.dir>/<feature-slug>/`
2. Write `<artifacts.dir>/<feature-slug>/brief.md`
3. For wayfinder path, `map.md` and `decisions/` were already created during the wayfinder process
4. **Update `<artifacts.dir>/index.md`** (append new record, auto-increment number)
5. Tell the user the brief path, as parameter for calling matt-dev-runner

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
```

## Relationship to Original Skills

| Original Skill | This Skill's Relationship |
|---------------|-------------------------|
| `grilling` | Reuses its one-question-at-a-time mode |
| `grill-with-docs` | **Replaces** — grilling + domain-modeling built in, plus verification strategy |
| `wayfinder` | **Implements** its core protocol (map, decision tickets, fog of war, frontier) adapted for single-entry flow. Use original `/wayfinder` for multi-session multi-agent collaboration. |
| `domain-modeling` | **Reuses** — updates CONTEXT.md and creates ADRs inline |

## Next Steps

Once the brief is confirmed and written to `<artifacts.dir>/<feature-slug>/brief.md`, tell the user:

> Requirement brief is ready at `<artifacts.dir>/<feature-slug>/brief.md`.
>
> You have two options to proceed:
>
> 1. **`matt-dev-runner`** — Development only. Invoke the agent to synthesize spec, split tickets, and run implement-verify loops. You handle deploy and PR yourself.
>
> 2. **`matt-dev-pipeline`** — Full pipeline. Orchestrate development → CI/CD deploy → E2E verification → Git PR delivery, all in one flow.
