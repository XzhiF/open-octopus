# Story Walk-Through Analysis: Harness Semantic V2

> **Analyst**: Story Walk-Through Sub-Agent
> **Spec version**: `.scratch/harness-semantic-v2/spec.md` (2026-08-06)
> **Date**: 2026-08-06
> **Method**: Protocol at `.claude/skills/matt-verified-requirement/references/story-walkthrough.md`

---

## Executive Summary

Traced all 4 appendix stories step-by-step against the live codebase.
Discovered **17 break points**: **4 CRITICAL**, **7 HIGH**, **4 MEDIUM**, **2 LOW**.

The two most severe issues are:

1. **Story 3 timing paradox** -- agent_takeover assumes `onBeforeNode` can fire *after* retries are exhausted, but the engine callback ordering makes this impossible.
2. **Agent format mismatch** -- the spec proposes `harness-agent.yaml` but the core-pack agent system exclusively uses `.md` files with YAML frontmatter.

---

## Story 1: Process Conflict -- Block + Dependency Analysis

### Step-by-Step Trace

```
1. User executes test-process-conflict.yaml
  |
  +--[Exec] ExecutionLifecycle.start() -> HarnessController.onExecutionStart()
  |         creates DetectorPipeline + StrategyEngine + AgentDelegationService
  |         wraps engine callbacks via pipeline.wrapCallbacks()
  |         OK Code exists: harness-controller.ts:62-107
  |
2. Engine calls onBeforeNode("kill-host-pid")
  |
  +--[Exec] DetectorPipeline Proxy intercepts onBeforeNode (line 395-421)
  |         routes { type: "beforeNode", nodeId, nodeType, nodeConfig } to detectors
  |         OK Code exists: detector-pipeline.ts:395-421
  |
3. [Layer 1] ProcessConflictDetector detects kill $HOST_PID -> DiagnosisReport
  |
  +--[Exec] ProcessConflictDetector.observe() matches kill pattern
  |         returns DiagnosisReport(severity: "critical")
  |         OK Code exists: detectors/process-conflict.ts (verified import line 17)
  |
4. [Layer 2] StrategyEngine classifies priority -> { delegate: true }
  |
  +--[Exec] synchronouslyStorePendingAction(report) called (line 408-409)
  |         +-- matches strategy via strategyEngine.matchStrategy()
  |         +-- severity === "critical" + hasAbort action -> stores pendingBlockAction
  |         |
  |         |  <-- [BP-A] SPEC DIVERGENCE: Current code does NOT delegate to
  |         |    Harness Agent for process_conflict. It synchronously stores a
  |         |    block action from the STRATEGY DEFINITION (abort action).
  |         |    The spec proposes that ALL reports go to Harness Agent, but
  |         |    the current code path for critical+abort bypasses Agent entirely.
  |         |
  |         +-- updateNodeHarnessStatus(nodeId, "harness_blocked", report)
  |
  +--[Exec] Then onBeforeNode proxy checks pendingBlockActions (line 411-415)
  |         finds blockAction -> returns { action: "skip", overrideResult: { status: "failed" } }
  |         OK Code exists: detector-pipeline.ts:411-415
  |
5. [Layer 3] Harness Agent analyzes (PROPOSED -- not current behavior)
  |
  |  <-- [BP-B] MAGIC BRIDGE: The spec assumes Harness Agent is called and
  |    returns { decision: "block_node", continueSubsequent: false }.
  |    But in the CURRENT code, process_conflict is handled synchronously
  |    by the strategy definition (abort action), NOT by Agent delegation.
  |    The spec must specify HOW the transition from synchronous blocking
  |    to Agent-mediated blocking happens.
  |
  |  <-- [BP-C] MISSING AGENT INVOCATION PATH:
  |    Spec S4 says "StrategyEngine simplified to router -- all DiagnosisReports
  |    uniformly routed to Harness Agent"
  |    But the synchronous path in synchronouslyStorePendingAction() runs BEFORE
  |    the async handleReport() completes. If we remove synchronous blocking,
  |    there is a race: the engine onBeforeNode proxy needs an answer SYNCHRONOUSLY
  |    (it is in the middle of node execution), but Agent delegation takes 2-10s.
  |
6. [Engine] onBeforeNode returns { action: "skip" }
  |
  +--[Exec] engine.ts:854-862 -- creates skippedResult, calls onNodeEnd
  |         OK Code exists and works correctly
  |
7. [Engine] kill-host-pid -> status: failed, harness_status: harness_blocked
  |
  +--[Data] node_executions.harness_status = "harness_blocked"
  |         OK Column exists: schema.sql:87, set by updateNodeHarnessStatus()
  |
  |  <-- [BP-D] ORPHAN STATUS: spec says "harness_status: harness_blocked"
  |    but the skippedResult created by engine has status: "skipped" (line 857),
  |    not "failed". The overrideResult in PendingBlockAction has status: "failed"
  |    but the engine skip path does not use overrideResult.
  |    Need to verify which path actually fires.
  |
8. [Engine] Subsequent nodes -> skipped
  |
  +--[Exec] executeNodesSequential checks depends_on (line 1069-1085)
  |         if kill-host-pid is "skipped" or "failed", dependents are skipped
  |         OK Works automatically for continueSubsequent: false
  |
  |  <-- [BP-E] MISSING FEATURE: continueSubsequent: true is not implementable.
  |    If Harness Agent says continueSubsequent: true, the engine would need to
  |    bypass its dependency-skip logic for the blocked node dependents.
  |    No such bypass exists. The engine unconditionally skips dependents of
  |    failed/skipped nodes (line 1074).
  |
9. [DB] executions.harness_status = "blocked"
  |
  |  <-- [BP-F] ORPHAN FIELD: executions table has NO harness_status column.
  |    schema.sql:29-66 defines executions without harness_status.
  |    schema.ts migration (line 161-163) only adds harness_status to
  |    node_executions, not executions.
  |    The spec proposes ALTER TABLE but provides no migration code path
  |    in schema.ts ensureColumn().
  |
10. [UI] Execution list shows: warning blocked (shield 1 block)
  |
  |  <-- [BP-G] MISSING UI FIELD: web-app Execution interface (types.ts:165-180)
  |    has no harnessStatus or harnessSummary fields. The execution list
  |    component cannot render harness status that does not exist in the type.
  |
11. [UI] Log shows: shield-X Harness block: process_conflict -- ...
  |
  +--[Data] agent_events row with event_type = "harness_process_conflict"
  |         OK Code exists: updateNodeHarnessStatus() inserts agent_event
  |         OK Web-app renders agent_events in log viewer
  |
  |  <-- [BP-H] LOG FORMAT: Current log rendering shows raw JSON content.
  |    The spec proposes formatted emoji+text rendering per decision type,
  |    but no rendering logic for the 5 new decision types exists in web-app.
```

### Story 1 Break Points

| ID | Severity | Description |
|----|----------|-------------|
| A | HIGH | Spec diverges from current code -- process_conflict currently bypasses Agent delegation via synchronous strategy matching |
| B | CRITICAL | Magic Bridge -- no code path connects synchronous onBeforeNode to async Agent delegation |
| C | CRITICAL | Timing paradox -- onBeforeNode needs synchronous answer but Agent takes 2-10s |
| D | MEDIUM | Node status mismatch -- skip path produces "skipped" not "failed" |
| E | HIGH | continueSubsequent: true is not implementable with current engine dependency logic |
| F | CRITICAL | executions.harness_status column does not exist |
| G | HIGH | Web-app Execution type lacks harnessStatus field |
| H | MEDIUM | No rendering logic for 5 new decision types in log viewer |

---

## Story 2: Stupid Retry -- Intelligent Fix

### Step-by-Step Trace

```
1. User executes test-stupid-retry.yaml (bash node missing dependency)
  |
  +--[Exec] Engine starts executing bash node
  |         OK Standard path
  |
2. Engine retries attempt 2 -> onNodeRetry triggers
  |
  +--[Exec] DetectorPipeline Proxy intercepts onNodeRetry (line 457-479)
  |         routes event to StupidRetryDetector
  |         OK Code exists: detector-pipeline.ts:457-479
  |
3. [Layer 1] StupidRetryDetector detects same error hash -> DiagnosisReport
  |
  +--[Exec] StupidRetryDetector.observe() checks error hash repetition
  |         returns DiagnosisReport(severity: "warning")
  |         OK Code exists: detectors/stupid-retry.ts (import line 15)
  |
4. [Layer 2] StrategyEngine classifies -> { delegate: true }
  |
  +--[Exec] synchronouslyStorePendingAction(report)
  |         +-- matchStrategy() finds matching strategy for "stupid_retry"
  |         +-- Extracts retry_with_hint action -> stores pendingAction with harnessHint
  |         |
  |         |  <-- [BP-I] SPEC DIVERGENCE: Current code extracts harnessHint from
  |         |    the STRATEGY DEFINITION (static text in harness.yaml).
  |         |    The spec proposes routing to Harness Agent for DYNAMIC analysis.
  |         |    But the synchronous path reads from strategy config, not Agent output.
  |         |    If we remove the synchronous path and rely on async Agent delegation,
  |         |    the pendingAction may not be populated before onBeforeRetry fires.
  |         |
  |         +-- This is the BP-2 timing fix that currently works
  |
5. [Layer 3] Harness Agent analyzes (PROPOSED)
  |
  |  <-- [BP-J] MAGIC BRIDGE: Spec says Agent returns:
  |    { decision: "fix_and_retry", scriptPatch: "apt-get install..." }
  |    But DelegationResult type (agent-delegation.ts:36-47) has:
  |    { interventionType: "inject"|"varpool"|"definition"|"takeover" }
  |    There is NO "fix_and_retry" or "scriptPatch" in the current type.
  |    The entire type system needs redesign.
  |
  |  <-- [BP-K] UNCONNECTED FEEDBACK: Even if Agent returns scriptPatch,
  |    there is no code path to apply a script patch to a bash node.
  |    The engine onBeforeRetry returns { action, harnessHint, modelOverride }
  |    (engine.ts:81-89). There is no "scriptPatch" field in the callback return type.
  |    The engine does not support modifying a node bash script mid-execution.
  |
6. [Engine] onBeforeRetry returns { action: "retry", harnessHint: "..." }
  |
  +--[Exec] engine.ts:972-993 -- processes retry decision
  |         harnessHint -> pool.set("harness_hint", ...)
  |         modelOverride -> effectiveNode = { ...effectiveNode, model: ... }
  |         OK Code exists for harnessHint and modelOverride
  |
  |  <-- [BP-L] VarPool update not connected: spec says "VarPool update"
  |    but the onBeforeRetry callback does not have a varPoolPatches field.
  |    The spec DelegationResult.varPoolPatches has no consumer in the engine.
  |
7. [Engine] Retry uses fixed script
  |
  |  <-- [BP-M] MISSING MECHANISM: The engine retries the SAME node with
  |    the SAME script (line 948: executeSingleNode). The only modifications
  |    possible are harnessHint (injected as $harness_hint variable) and
  |    modelOverride (for agent nodes). For a bash node missing jq,
  |    injecting a hint variable does NOT install jq.
  |
8. [DB] node.harness_status = harness_modified
  |
  |  <-- [BP-N] ORPHAN FIELD: The spec says set harness_modified, but
  |    no code currently sets this value. updateNodeHarnessStatus() only
  |    sets "harness_intervening" and "harness_blocked". The spec acknowledges
  |    this (Problem #5) but does not specify WHERE to add the setter.
  |
9. [DB] executions.harness_status = "intervened"
  |
  |  <-- Same as BP-F: column does not exist
  |
10. [UI] Log shows: shield-wrench Harness fix+retry: stupid_retry -- install missing jq
  |
  |  <-- Same as BP-H: no rendering logic for new decision types
```

### Story 2 Break Points

| ID | Severity | Description |
|----|----------|-------------|
| I | HIGH | Synchronous strategy extraction conflicts with proposed Agent-first routing |
| J | CRITICAL | DelegationResult type system completely incompatible with proposed 5 decision types |
| K | HIGH | No engine mechanism to apply scriptPatch to bash nodes |
| L | MEDIUM | varPoolPatches has no consumer in the engine callback chain |
| M | HIGH | Engine retries same script -- no way to modify bash content mid-execution |
| N | MEDIUM | harness_modified status never set anywhere in code |

---

## Story 3: Agent Takeover -- Substitute Execution

### Step-by-Step Trace

```
1. Complex bash node with script logic error, retries exhausted
  |
  +--[Exec] executeSingleNodeWithRetry exhausts max_attempts
  |         returns lastResult with status: "failed"
  |         OK Code exists: engine.ts:939-1013
  |
2. Engine retries exhausted -> onFailureDecision triggers
  |
  +--[Exec] executeNodesSequential line 1219-1234
  |         calls callbacks.onFailureDecision(nodeId, error, strategy)
  |         OK Code exists
  |
  |  <-- [BP-O] TIMING PARADOX: The spec says:
  |    Step 2: "Engine retries exhausted -> onFailureDecision triggers"
  |    Step 6: "onBeforeNode returns { action: override }"
  |
  |    This is IMPOSSIBLE. onBeforeNode fires BEFORE node execution (engine.ts:853).
  |    onFailureDecision fires AFTER all retries are exhausted (engine.ts:1220).
  |    You cannot retroactively fire onBeforeNode after the node has already
  |    executed and failed all retries.
  |
  |    The spec step 6 should use onFailureDecision or a NEW callback,
  |    not onBeforeNode.
  |
3. [Layer 1] Detects repeated failure -> DiagnosisReport
  |
  +--[Exec] StupidRetryDetector or another detector generates report
  |         OK Plausible
  |
4. [Layer 2] StrategyEngine -> { delegate: true }
  |
  +--[Exec] handleReport() -> tryDelegate() -> AgentDelegationService.delegate()
  |         OK Code path exists (strategy-engine.ts:140-173)
  |
  |  <-- [BP-P] ASYNC vs SYNC: onFailureDecision handler in engine.ts:1220
  |    is async and awaits the callback result. The DetectorPipeline proxy
  |    for onFailureDecision (line 373-389) checks pendingFailureActions.
  |    But Agent delegation is ASYNC (2-10s). The pending action must be
  |    populated BEFORE onFailureDecision fires.
  |
  |    Current flow: node fails -> DetectorPipeline.handleDiagnosis() fires
  |    async handleReport() -> pendingFailureActions.set(nodeId, { action: "delegate" })
  |    But "delegate" causes engine to PAUSE (line 1229-1232), not to override.
  |
5. [Layer 3] Harness Agent decides agent_takeover
  |
  |  <-- [BP-Q] MAGIC BRIDGE: The spec says "Harness Agent uses bash tool
  |    to complete the node objective." But:
  |    1. AgentDelegationService (agent-delegation.ts) uses a ONE-SHOT LLM call
  |       (line 381: provider.sendQuery) with NO tool access.
  |    2. The spec proposes using agentService.createSession('harness-agent')
  |       but this creates a CHAT SESSION, not a tool-enabled agent run.
  |    3. No code exists to give the Harness Agent bash/read/write tools
  |       within the delegation flow.
  |
6. [Engine] onBeforeNode returns override <-- IMPOSSIBLE (see BP-O)
  |
  |  <-- [BP-R] CALLBACK TYPE MISMATCH: onFailureDecision return type is
  |    { action: "continue" | "abort" | "delegate" } (engine.ts:91-97).
  |    There is NO "override" action in onFailureDecision.
  |    To support takeover at failure time, need either:
  |    a) Add "override" to onFailureDecision return type, OR
  |    b) Use the existing "delegate" -> pause -> manual resume path
  |
7. [DB] node.status = completed, node.harness_status = harness_executed
  |
  |  <-- Same as BP-N: harness_executed never set in code
  |
8. [DB] executions.harness_status = "delegated"
  |
  |  <-- Same as BP-F: column does not exist
```

### Story 3 Break Points

| ID | Severity | Description |
|----|----------|-------------|
| O | CRITICAL | Timing paradox -- onBeforeNode cannot fire after retries exhausted |
| P | HIGH | Async Agent delegation incompatible with synchronous pending action consumption |
| Q | HIGH | No tool-enabled agent execution path in delegation service |
| R | HIGH | onFailureDecision lacks "override" action type |

---

## Story 4: Timeout Cascade -- Actual Handling

### Step-by-Step Trace

```
1. Consecutive 3 nodes timeout
  |
  +--[Exec] Each timeout triggers onNodeEnd with status: "failed"
  |         TimeoutCascadeDetector observes pattern across nodes
  |         OK Code exists: detectors/timeout-cascade.ts (import line 18)
  |
2. [Layer 1] TimeoutCascadeDetector -> DiagnosisReport(severity: critical)
  |
  +--[Exec] Detector fires after threshold (3) consecutive timeouts
  |         OK Configurable threshold: detector-pipeline.ts:160
  |
3. [Layer 2] StrategyEngine -> { delegate: true, priority: "critical" }
  |
  +--[Exec] handleReport() matches timeout_cascade strategy
  |
  |  <-- [BP-S] CURRENT BEHAVIOR: The current harness-defaults.yaml likely
  |    has a strategy for timeout_cascade with advisory actions.
  |    The spec says to change this to delegate: true, but does not specify
  |    the harness-defaults.yaml update needed.
  |
4. [Layer 3] Harness Agent analyzes -> fix_and_retry with varPoolPatches
  |
  |  <-- Same issues as BP-J (type mismatch) and BP-L (no varPoolPatches consumer)
  |
  |  <-- [BP-T] TIMEOUT SEMANTICS: The spec says Agent patches NODE_TIMEOUT
  |    to 600 via varPoolPatches. But:
  |    1. Node timeout is set in NodeDef.timeout (workflow YAML), not VarPool
  |    2. Even if VarPool has NODE_TIMEOUT, the engine uses node.timeout
  |       for actual timeout enforcement
  |    3. The engine has no mechanism to read timeout from VarPool
  |
5. [Engine] onBeforeRetry -> VarPool update -> retry with larger timeout
  |
  |  <-- Same as BP-L: VarPool patches not supported in onBeforeRetry
  |
  |  <-- [BP-U] TIMEOUT APPLICATION: Even if we could patch VarPool,
  |    the retry mechanism uses policy.max_total_duration for timeout
  |    (engine.ts:928-934), not a VarPool variable. Changing VarPool
  |    would not affect the actual timeout behavior.
  |
6. [DB] executions.harness_status = "intervened"
  |  <-- Same as BP-F
  |
7. [UI] Log shows: shield-wrench Harness fix+retry: timeout_cascade -- increase timeout to 600s
  |  <-- Same as BP-H
```

### Story 4 Break Points

| ID | Severity | Description |
|----|----------|-------------|
| S | LOW | harness-defaults.yaml update not specified |
| T | HIGH | Node timeout comes from NodeDef, not VarPool -- patching VarPool has no effect |
| U | HIGH | Retry timeout mechanism uses pipeline config, not VarPool |

---

## Consolidated Break Points

### CRITICAL (Must Fix Before Spec Finalized)

| ID | Story | Anti-Pattern | Description | Recommended Fix |
|----|-------|-------------|-------------|-----------------|
| B | 1 | Magic Bridge | No code path connects synchronous onBeforeNode to async Agent delegation (2-10s) | Add a pre-flight check phase: before executing a node with a risky pattern, do async Agent analysis during onBeforeNode. Accept the latency cost. Alternatively, keep synchronous blocking for process_conflict and only use Agent for retry scenarios. |
| C | 1 | Magic Bridge | StrategyEngine simplification removes synchronous blocking but provides no replacement timing mechanism | Spec must explicitly state: (a) keep synchronous block for critical+abort scenarios, OR (b) accept 2-10s latency on every node with pre-flight Agent check |
| F | 1,2,3,4 | Orphan Field | executions.harness_status and harness_summary columns do not exist; no migration in schema.ts | Add to schema.ts ensureColumn(): ensureColumn(db, executions, harness_status, TEXT) and ensureColumn(db, executions, harness_summary, TEXT). Add to schema.sql CREATE TABLE. |
| J | 2 | Unconnected Feedback | DelegationResult type system (inject/varpool/definition/takeover) completely incompatible with proposed 5 decision types (fix_and_retry/guide_and_retry/...) | Rewrite DelegationResult interface per spec S3. Update parseDelegationResponse() to validate new types. Update VALID_INTERVENTION_TYPES set. |
| O | 3 | Magic Bridge | onBeforeNode cannot fire AFTER retries are exhausted -- engine callback ordering makes Story 3 impossible as written | Redesign Story 3: agent_takeover must trigger from onFailureDecision, not onBeforeNode. Either: (a) add override action to onFailureDecision callback, or (b) use delegate->pause->autoResume path |

### HIGH (Must Fix Before Spec Finalized)

| ID | Story | Anti-Pattern | Description | Recommended Fix |
|----|-------|-------------|-------------|-----------------|
| A | 1 | Unconnected Feedback | Current process_conflict bypasses Agent delegation via synchronous strategy matching | Spec must explicitly address: which scenarios use Agent vs synchronous path? Add a decision matrix. |
| E | 1 | Missing Trigger | continueSubsequent: true requires bypassing engine dependency-skip logic -- no bypass exists | Add a forceExecute set to DetectorPipeline. When onBeforeNode is called, check this set before applying dependency-skip. Requires engine callback enhancement. |
| G | 2 | Orphan Field | Web-app Execution type lacks harnessStatus/harnessSummary fields | Add to web-app/lib/types.ts Execution interface: harnessStatus and harnessSummary optional fields |
| I | 2 | Unconnected Feedback | Synchronous strategy field extraction conflicts with Agent-first routing | Spec must clarify: does synchronouslyStorePendingAction() get removed? If yes, how is the timing gap between async Agent and sync engine callback bridged? |
| K+M | 2 | Missing Trigger | No engine mechanism to apply scriptPatch to bash nodes during retry | Option A: Add scriptOverride to onBeforeRetry return type. Option B: Limit fix_and_retry to varPoolPatches + harnessHint only (no script modification). Option B is simpler. |
| P+R | 3 | Missing Trigger | onFailureDecision lacks override action; async Agent cannot populate pending action in time | Add override action to onFailureDecision return type in engine.ts:91-97. Add pending action population during the delegation async flow with proper await. |
| Q | 3 | Magic Bridge | AgentDelegationService uses one-shot LLM with no tools; spec assumes tool-enabled agent session | Spec must define: does Harness Agent get tools? If yes, need to integrate with AgentNodeRunner or similar tool-enabled execution path, not the current sendQuery() one-shot. |
| T+U | 4 | Unconnected Feedback | Node timeout from NodeDef, not VarPool -- varPoolPatches for timeout have no effect | Option A: Add timeoutOverride to onBeforeRetry return type. Option B: Use modify_definition intervention type to patch node.timeout at runtime. Option B already exists in current code. |

### MEDIUM (Document in Spec, Fix During Implementation)

| ID | Story | Anti-Pattern | Description | Recommended Fix |
|----|-------|-------------|-------------|-----------------|
| D | 1 | Silent Failure | Node skip path produces status "skipped" but spec says "failed" | Clarify in spec: blocked node gets status "failed" via overrideResult, not "skipped" via skip action. Update PendingBlockAction to use skip+overrideResult pattern. |
| H | 1,2,3,4 | Missing Trigger | No rendering logic for 5 new decision types in log viewer | Add decision type rendering map to web-app log viewer component. Map each of the 5 decision types to icon+text format per spec S9. |
| L | 2,4 | Orphan Field | varPoolPatches in DelegationResult has no consumer in engine callbacks | Add varPoolPatches to onBeforeRetry return type in engine.ts. Apply patches via pool.update() in engine retry loop. |
| N | 2,3 | Orphan Field | harness_modified and harness_executed statuses defined but never set | Add setter calls in DetectorPipeline after processing Agent delegation results. Map decision types to node harness statuses. |

### LOW (Note in Risks)

| ID | Story | Anti-Pattern | Description | Recommended Fix |
|----|-------|-------------|-------------|-----------------|
| S | 4 | Missing config | harness-defaults.yaml update not specified for timeout_cascade delegation | Add harness-defaults.yaml diff to spec showing timeout_cascade strategy change |
| -- | -- | Agent format | Spec proposes harness-agent.yaml but all core-pack agents are .md files with YAML frontmatter | Change spec to use harness-agent.md with YAML frontmatter (matching existing format) |

---

## Agent Format Issue (Cross-Cutting)

The spec proposes `packages/core-pack/agents/harness-agent.yaml`:

```yaml
name: harness-agent
description: "..."
model: claude-sonnet-4-20250514
system_prompt: |
  ...
tools:
  - bash
  - read
  - write
  - grep
  - glob
```

**Reality check**: ALL existing core-pack agents use `.md` format with YAML frontmatter:

```
packages/core-pack/agents/devil-advocate.md
packages/core-pack/agents/architecture-explorer.md
packages/core-pack/agents/vision-analyzer.md
...
```

Example format (devil-advocate.md):
```
---
name: Devil's Advocate
description: ...
emoji: (devil)
color: red
---
# System prompt content here...
```

The workspace-scaffold.ts copyAgents() method (line 165) copies `.md` files:
```typescript
const coreAgents = ["devil-advocate.md", "architecture-explorer.md", "vision-analyzer.md"]
```

**Fix**: Change spec to propose `harness-agent.md` with YAML frontmatter format.

---

## Architecture Recommendation

The spec core insight -- unified Agent-mediated decision-making -- is sound, but the implementation needs to account for **two timing domains**:

### Domain 1: Synchronous (Pre-Execution)
- **Process Conflict**: Must block BEFORE node executes (cannot wait 2-10s for Agent)
- **Recommendation**: Keep synchronous block for critical+abort. Fire Agent analysis in parallel for logging/audit only.

### Domain 2: Asynchronous (Post-Failure)
- **Stupid Retry, Timeout Cascade**: Agent analyzes AFTER failure, BEFORE retry
- **Recommendation**: Agent delegation fires asynchronously. Store result in pendingActions. Engine consumes on next onBeforeRetry.

### Domain 3: Paused (Takeover)
- **Agent Takeover**: Too complex for inline handling
- **Recommendation**: Use existing delegate->pause path. HarnessController auto-resumes with takeover result via ExecutionLifecycle.autoResume().

This three-domain model preserves the spec "unified Agent" vision while respecting the engine callback timing constraints.

---

## New Types/Schemas/APIs Needed

### 1. DB Migration (schema.ts)
```typescript
// Add to ensureColumn block:
ensureColumn(db, 'executions', 'harness_status', "TEXT")
ensureColumn(db, 'executions', 'harness_summary', "TEXT")
```

### 2. Engine Callback Enhancement (engine.ts)
```typescript
// onBeforeRetry needs additional return fields:
onBeforeRetry?: (...) => Promise<{
  action: "retry" | "skip" | "abort" | "override"
  overrideResult?: NodeExecutionResult
  harnessHint?: string
  modelOverride?: string
  varPoolPatches?: Record<string, string>  // NEW
  scriptOverride?: string                   // NEW (optional)
  timeoutOverride?: number                  // NEW (optional)
}>

// onFailureDecision needs "override" action:
onFailureDecision?: (...) => Promise<{
  action: "continue" | "abort" | "delegate" | "override"  // ADD override
  overrideResult?: NodeExecutionResult                      // NEW
}>
```

### 3. DelegationResult Rewrite (shared/harness/types.ts)
Per spec S3 -- replace current interventionType with HarnessDecisionType.

### 4. Web-App Type Updates (web-app/lib/types.ts)
```typescript
export interface Execution {
  // ... existing fields ...
  harnessStatus?: "intervened" | "blocked" | "delegated" | null
  harnessSummary?: {
    totalInterventions: number
    decisions: Array<{ node: string; decision: string; reason: string }>
  }
}
```

### 5. Agent Definition Format
```markdown
---
name: harness-agent
description: "Workflow safety guardian Agent"
emoji: (shield)
model: claude-sonnet-4-20250514
---
# System prompt content...
```

---

## New ACs Needed

| AC | Story | Description |
|----|-------|-------------|
| AC-11 | All | schema.ts migration adds harness_status + harness_summary to executions table |
| AC-12 | 1 | process_conflict blocking still works synchronously (no Agent latency) |
| AC-13 | 2 | onBeforeRetry return type supports varPoolPatches |
| AC-14 | 3 | onFailureDecision supports "override" action with overrideResult |
| AC-15 | 3 | agent_takeover uses delegate->pause->autoResume path, not onBeforeNode |
| AC-16 | All | Agent definition uses .md format with YAML frontmatter |
| AC-17 | 2 | parseDelegationResponse() validates 5 new decision types |
| AC-18 | All | Web-app Execution list renders harnessStatus badge |
| AC-19 | All | Log viewer renders 5 decision types with distinct icons |
