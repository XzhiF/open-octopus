# Swarm Executor vs. octopus_agent Node - Comparative Analysis

> **Research method**: Primary-source code review of packages/engine/src/executors/,
> packages/shared/src/types/, YAML schemas, and template files.
> **Date**: 2026-08-05

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Swarm Executor](#swarm-executor)
3. [octopus_agent Node](#octopus_agent-node)
4. [Shared Infrastructure](#shared-infrastructure)
5. [Comparison Table](#comparison-table)
6. [Interaction Protocol Sequences](#interaction-protocol-sequences)
7. [Applicable Scenarios](#applicable-scenarios)
8. [Strengths and Limitations](#strengths-and-limitations)
9. [Decision Guide](#decision-guide)

---

## Architecture Overview

Both `swarm` and `octopus_agent` are node types within the Octopus workflow DAG engine.
They are created by the `ExecutorFactory` and conform to the `NodeExecutor` interface:

```typescript
// packages/engine/src/executors/types.ts:56-58
export interface NodeExecutor {
  execute(): Promise<NodeExecutionResult>
}
```

The factory dispatches based on `node.type` (executor-factory.ts:83):

| node.type | Executor class |
|-----------|---------------|
| `"bash"` | BashExecutor |
| `"python"` | PythonExecutor |
| `"agent"` | AgentExecutor |
| `"condition"` | ConditionExecutor |
| `"approval"` | ApprovalExecutor |
| `"loop"` | LoopExecutor |
| `"swarm"` | **SwarmExecutor** |
| `"interaction"` | InteractionExecutor |
| `"sub_workflow"` | SubWorkflowExecutor |
| `"dynamic_sub_workflow"` | DynamicSubWorkflowExecutor |
| `"octopus_agent"` | **OctopusAgentExecutor** |

### High-Level DAG Integration

```
+-----------------------------------------------------------+
|                    WorkflowEngine                          |
|  (engine.ts - topological sort, level-based execution)     |
|                                                           |
|  +----------+  +----------+  +------------------------+   |
|  |  bash    |->|  agent   |->|  swarm / octopus_      |   |
|  |  python  |  |  condition|  |  agent / loop / etc   |   |
|  |  approval|  |  interact |  |                        |   |
|  +----------+  +----------+  +------------------------+   |
|                                                           |
|  VarPool ($vars.*, $nodeId.output) shared across all      |
+-----------------------------------------------------------+
```

Both node types sit as **leaves** in the DAG - they do not contain inner nodes (unlike `loop`).
They produce `NodeExecutionResult` and write to the shared `VarPool`.

---

## Swarm Executor

### Source Files

| File | Purpose |
|------|---------|
| `executors/swarm.ts` | Entry point - SwarmExecutor class (684 lines) |
| `executors/swarm/swarm-strategy.ts` | Abstract SwarmStrategy + SwarmServices interface |
| `executors/swarm/discussion-strategy.ts` | Review + Debate mode implementation |
| `executors/swarm/dispatch-strategy.ts` | Dispatch mode with DAG-based expert dependencies |
| `executors/swarm/moa-strategy.ts` | Mixture-of-Agents mode (parallel fan-out + aggregation) |
| `executors/swarm/swarm-coordinator.ts` | Bridges strategies <-> engine (SSE, budget, checkpoints) |
| `executors/swarm/message-bus.ts` | In-memory message bus for inter-expert communication |
| `executors/swarm/shared-memory.ts` | Key-value store for expert data sharing |
| `executors/swarm/host-agent.ts` | Host synthesis with degradation chain |
| `executors/swarm/dag-builder.ts` | Kahn's algorithm for expert dependency resolution |
| `executors/swarm/swarm-router.ts` | Dynamic expert selection via LLM |
| `executors/swarm/role-registry.ts` | Agent file index for dynamic routing |
| `executors/swarm/context-tier-resolver.ts` | Scales context params by model capability (200k/1m) |
| `executors/swarm/budget-tracker.ts` | Token budget + timeout tracking |
| `executors/swarm/agent-file-utils.ts` | Agent .md file loading + frontmatter parsing |
| `shared/src/types/swarm.ts` | Zod schema: SwarmNodeDefSchema, ExpertDefSchema |

### Architecture Diagram

```
+---------------------------------------------------------------------+
|                         SwarmExecutor                                |
|  (swarm.ts:38 - implements NodeExecutor)                            |
|                                                                     |
|  +--------------+  +-------------+  +--------------------------+   |
|  | ExpertDef[]  |  | VarPool     |  | BudgetTracker            |   |
|  | (enriched)   |  | (shared)    |  | (token + timeout limits) |   |
|  +------+-------+  +------+------+  +------------+-------------+   |
|         |                 |                       |                 |
|  +------v-----------------v-----------------------v--------------+  |
|  |                   SwarmCoordinator                             |  |
|  |  (swarm-coordinator.ts:37 - implements SwarmServices)         |  |
|  |                                                               |  |
|  |  runExpert(expert, prompt, round) -> ExpertOutput             |  |
|  |  runHost(expertOutputs, messages) -> HostOutput               |  |
|  |  checkBudget() -> BudgetStatus                                |  |
|  |  emit(SwarmSSEEvent)                                          |  |
|  |  saveCheckpoint()                                             |  |
|  +------+----------------+---------------------------------------+  |
|         |                |                                          |
|  +------v------+  +------v--------------+                          |
|  | MessageBus  |  | SharedMemory        |                          |
|  | (messages)  |  | (key-value store)   |                          |
|  +------+------+  +---------------------+                          |
|         |                                                           |
|  +------v------------------------------------------------------+   |
|  |              Strategy Selection (swarm.ts:546-566)            |   |
|  |                                                              |   |
|  |  mode = "review"|"debate"|"swarm" -> DiscussionStrategy      |   |
|  |  mode = "dispatch"                  -> DispatchStrategy       |   |
|  |  mode = "moa"                       -> MoaStrategy            |   |
|  +--------------------------------------------------------------+   |
|                                                                     |
|  +--------------------------------------------------------------+   |
|  |  Dynamic Routing (optional)                                   |   |
|  |  - expert_pool: LLM selects K from N declared experts        |   |
|  |  - agentResolver: OrchestratorService-based selection         |   |
|  |  - SwarmRouter + RoleRegistry: legacy keyword+LLM routing    |   |
|  +--------------------------------------------------------------+   |
+---------------------------------------------------------------------+
```

### Sub-Modes (5 modes)

| Mode | Strategy | Rounds | Expert Interaction | Consensus Check |
|------|----------|--------|-------------------|-----------------|
| `review` | DiscussionStrategy | 1 (fixed) | Parallel, no inter-round | No |
| `debate` | DiscussionStrategy | Configurable (>=1) | Multi-round with sliding window | Yes (threshold) |
| `swarm` | DiscussionStrategy (after router) | Router decides | Dynamic mode selection | Depends on router |
| `dispatch` | DispatchStrategy | 1 (DAG levels) | DAG-sequential levels, parallel within | No |
| `moa` | MoaStrategy | 0-5 aggregation | Parallel fan-out, then aggregator rounds | No |

### Interaction Protocol - Debate Mode

```
Round 1:
  +----------+  +----------+  +----------+
  | Expert A |  | Expert B |  | Expert C |   <- parallel execution
  +----+-----+  +----+-----+  +----+-----+
       |              |              |
       v              v              v
  +--------------------------------------+
  |          MessageBus (broadcast)       |   <- all outputs stored
  +------------------+-------------------+
                     |
  +------------------v-------------------+
  |    HostAgent (consensus assessment)   |
  |    score=0.4 -> continue             |
  +------------------+-------------------+
                     |
Round 2:             |  (sliding window + compressed summaries)
  +----------+  +----------+  +----------+
  | Expert A |  | Expert B |  | Expert C |   <- see previous round
  +----+-----+  +----+-----+  +----+-----+
       |              |              |
       v              v              v
  +--------------------------------------+
  |    HostAgent: score=0.8 >= 0.75     |   <- threshold met -> stop
  +------------------+-------------------+
                     |
  +------------------v-------------------+
  |  Final Host Synthesis -> SwarmResult |
  +--------------------------------------+
```

### Interaction Protocol - Dispatch Mode

```
  DAG Build (Kahn's algorithm):
    Level 0: [backend-architect]
    Level 1: [frontend-developer]    (depends_on: backend-architect)
    Level 2: [code-reviewer]         (depends_on: backend, frontend)

  Level 0 --> +--------------------+
              | backend-architect   |
              +--------+-----------+
                       | output -> structured summary
  Level 1 --> +--------v-----------+
              | frontend-developer  |  <- receives upstream context
              +--------+-----------+
                       |
  Level 2 --> +--------v-----------+
              | code-reviewer       |  <- receives all upstream outputs
              +--------+-----------+
                       |
              +--------v-----------+
              | Host Synthesis      |
              | + File Conflict Det.|
              +--------------------+
```

### Interaction Protocol - MOA Mode

```
  Phase 1: Parallel Fan-out
    +----------+  +----------+  +----------+
    | Expert A |  | Expert B |  | Expert C |   <- different models
    | (opus)   |  | (sonnet) |  | (haiku)  |
    +----+-----+  +----+-----+  +----+-----+
         |              |              |
         v              v              v
  Phase 2: Aggregation (rounds 1..N)
    +--------------------------------------+
    |    Aggregator (host model)            |
    |    Input: truncated expert outputs    |
    |    Output: synthesis                  |
    +------------------+-------------------+
                       | (if rounds > 1)
                       v
    +--------------------------------------+
    |    Refinement round: feed synthesis   |
    |    back as "__moa_synthesis" expert   |
    +--------------------------------------+
```

### YAML Schema (swarm node)

```yaml
# packages/shared/src/types/swarm.ts:108-138 (SwarmNodeDefSchema)
- id: my-swarm
  type: swarm
  topic: "Analyze this architecture decision"   # required
  mode: debate          # review | debate | dispatch | swarm | moa
  rounds: 3             # debate: >=1, moa: 0-5
  consensus_threshold: 0.75
  budget: 500000        # token limit
  timeout: 300          # seconds
  context_tier: "200k"  # or "1m" for large-context models
  failure_policy: continue_partial
  output_format: full   # summary | full | structured
  dynamic: true         # enable dynamic expert selection
  max_experts: 5        # required when dynamic=true
  expert_pool: [...]    # mutually exclusive with experts
  experts:
    - role: backend-architect
      agent_file: ".claude/agents/backend.md"
      prompt: "Analyze from backend perspective"
      perspective: "Backend scalability focus"
      model: pro-max
      engine: claude
      skills: [octo-workflow-dev]
      task: "Design the API"
      depends_on: []
      tools: [Read, Write, Bash]
  expert_defaults:      # merged into every expert
    model: pro
    skills: [common-skill]
  host:                 # synthesis agent
    role: host
    model: pro-max
    prompt: "Custom synthesis instructions"
  aggregator:           # moa mode only
    role: aggregator
    model: pro-max
  outputs:
    result: "$vars.my-swarm_synthesis"
```

### Auto-Outputs (written to VarPool)

From swarm.ts:568-581:

| Key | Value |
|-----|-------|
| `{id}_synthesis` | host synthesis text |
| `{id}_consensus_score` | consensus score (debate only) |
| `{id}_rounds_used` | actual rounds executed |
| `{id}_expert_count` | number of experts |
| `{id}_experts` | JSON array of expert roles |
| `{id}_history` | JSON of all messages |
| `{id}_task_breakdown` | JSON of task breakdown (dispatch/dynamic) |
| `{id}_budget_exhausted` | boolean |
| `{id}_timeout_exceeded` | boolean |
| `{id}_expert_outputs` | JSON of completed expert outputs |
| `{id}_failed_experts` | JSON of failed expert roles |

---

## octopus_agent Node

### Source Files

| File | Purpose |
|------|---------|
| `executors/octopus-agent.ts` | Entry point - OctopusAgentExecutor (341 lines) |
| `executors/agent.ts` | AgentExecutor - the inner workhorse (474 lines) |
| `executors/agent-runner.ts` | AgentNodeRunner - provider stream management (223 lines) |
| `executors/octopus-agent/task-prompt.ts` | Task Contract prompt builder |
| `executors/octopus-agent/parse-result.ts` | Structured result parser |
| `executors/octopus-agent/heartbeat.ts` | Heartbeat + budget monitoring |
| `executors/octopus-agent/session.ts` | Delegate session creation |
| `executors/agent-types.ts` | AgentEvent discriminated union |
| `executors/executor-config.ts` | OctopusAgentConfig, AgentConfig |
| `shared/src/types/octopus-agent.ts` | Types: TaskContract, StructuredResult, HarnessConfig |

### Architecture Diagram

```
+----------------------------------------------------------------------+
|                    OctopusAgentExecutor                               |
|  (octopus-agent.ts:40 - implements NodeExecutor)                     |
|                                                                      |
|  Step 1: Version Resolution                                          |
|  +------------------------------------------------------------+      |
|  |  VersionResolver.resolve(agent, versionSpec, minStage)     |      |
|  |  -> ResolvedVersion { version, stage, snapshot, fsPath }   |      |
|  |  Fallback: read ~/.octopus/agent/clones/{name}/ directly   |      |
|  +----------------------------+-------------------------------+      |
|                               |                                      |
|  Step 2: Create Delegate Session                                     |
|  +----------------------------v-------------------------------+      |
|  |  createDelegateSession(cloneName, version, execId)         |      |
|  |  -> DelegateSession { id, session_type:"delegate", ... }   |      |
|  +----------------------------+-------------------------------+      |
|                               |                                      |
|  Step 3: Build Task Contract Prompt                                   |
|  +----------------------------v-------------------------------+      |
|  |  buildTaskPrompt(task, pool, nodeOutputs, harness)         |      |
|  |  Sections: Brief -> Context -> Constraints -> Expected Out |      |
|  |           -> SOP -> Budget -> Instructions                 |      |
|  +----------------------------+-------------------------------+      |
|                               |                                      |
|  Step 4: Setup Heartbeat Handler                                     |
|  +----------------------------v-------------------------------+      |
|  |  HeartbeatHandler: count steps, emit heartbeat events      |      |
|  |  Check budget limits -> emit harness_directive: abort      |      |
|  +----------------------------+-------------------------------+      |
|                               |                                      |
|  Step 5: Delegate to inner AgentExecutor                             |
|  +----------------------------v-------------------------------+      |
|  |  AgentExecutor (agent.ts:19)                                |      |
|  |  +------------------------------------------------------+  |      |
|  |  |  AgentNodeRunner.run()                                |  |      |
|  |  |  - provider.sendQuery(prompt, cwd, sessionId, opts)  |  |      |
|  |  |  - Stream: text_delta, tool_call, tool_result, ...   |  |      |
|  |  |  - Idle timeout: 20 min                              |  |      |
|  |  |  - Stream fracture retry (context=continue)          |  |      |
|  |  +------------------------------------------------------+  |      |
|  +----------------------------+-------------------------------+      |
|                               |                                      |
|  Step 6: Parse Structured Result                                     |
|  +----------------------------v-------------------------------+      |
|  |  parseStructuredResult(text)                                |      |
|  |  -> StructuredResult { status, output, artifacts,           |      |
|  |      vars_update, summary, token_usage, duration_ms }      |      |
|  +----------------------------+-------------------------------+      |
|                               |                                      |
|  Step 7: Merge Outputs + Apply Mapping                               |
|  +----------------------------v-------------------------------+      |
|  |  outputs = { last_output, session_id, agent_version,       |      |
|  |              agent_name, task_brief, ...structured }        |      |
|  |  applyOutputsMapping(node.outputs, outputs, pool)          |      |
|  +------------------------------------------------------------+      |
+----------------------------------------------------------------------+
```

### Execution Flow Sequence

```
  YAML Node        OctopusAgentExecutor    AgentExecutor    AgentNodeRunner    IAgentProvider
     |                    |                     |                 |                  |
     |  execute()         |                     |                 |                  |
     |------------------->|                     |                 |                  |
     |                    | 1. resolve version  |                 |                  |
     |                    |-> ResolvedVersion   |                 |                  |
     |                    |                     |                 |                  |
     |                    | 2. create session   |                 |                  |
     |                    |-> DelegateSession   |                 |                  |
     |                    |                     |                 |                  |
     |                    | 3. buildTaskPrompt  |                 |                  |
     |                    |-> taskPrompt string |                 |                  |
     |                    |                     |                 |                  |
     |                    | 4. new AgentExecutor|                 |                  |
     |                    |-------------------->|                 |                  |
     |                    |                     | 5. buildPrompt  |                  |
     |                    |                     |-> final prompt  |                  |
     |                    |                     |                 |                  |
     |                    |                     | 6. runner.run() |                  |
     |                    |                     |---------------->|                  |
     |                    |                     |                 | 7. sendQuery()   |
     |                    |                     |                 |----------------->|
     |                    |                     |                 |                  |
     |                    |                     |                 | async generator  |
     |                    |                     |                 |<-----------------|
     |                    |                     |                 | chunks:          |
     |                    |                     |<----------------| text_delta,      |
     |                    |                     | AgentRunResult  | tool_call,       |
     |                    |<--------------------|                 | result           |
     |                    | NodeExecutionResult |                 |                  |
     |<-------------------|                     |                 |                  |
```

### Task Contract Structure

```typescript
// shared/src/types/octopus-agent.ts:27-34
interface TaskContract {
  brief: string            // Required: task description
  context?: string[]       // Context items (with $var substitution)
  constraints?: string[]   // List of constraints
  expected_output?: {
    type?: string          // e.g., "json", "markdown"
    schema?: Record<string, unknown>  // JSON schema
  }
  sop?: string             // Standard Operating Procedure
  budget?: {
    max_tokens?: number
    max_duration?: number  // seconds
    max_cost_usd?: number
  }
}
```

### YAML Schema (octopus_agent node)

```yaml
- id: my-agent
  type: octopus_agent
  agent: workspace           # required: clone name or "__main__"
  version: "1.2.0"           # optional, defaults to "latest"
  min_stage: beta            # alpha | beta | rc | stable
  task:
    brief: "Implement feature X according to the spec"
    context:
      - "Previous analysis: $vars.analyze_synthesis"
      - "Branch: $vars.branch"
    constraints:
      - "Do not modify test files"
      - "Follow existing code style"
    expected_output:
      type: json
      schema:
        status: string
        files_changed: "string[]"
    sop: |
      1. Read the spec file
      2. Identify files to modify
      3. Make changes
      4. Run tests
    budget:
      max_tokens: 100000
      max_duration: 600
      max_cost_usd: 1.0
  harness:
    heartbeat_interval: 3
    heartbeat_timeout: 300
    auto_abort_on_budget: true
  outputs:
    result: "$last_output"
    files: "$vars.files_changed"
```

### Structured Result Format

```json
{
  "status": "completed",
  "output": { "key": "value" },
  "artifacts": [
    { "type": "code", "path": "src/foo.ts", "description": "New module" }
  ],
  "vars_update": { "feature_status": "done" },
  "summary": "Successfully implemented feature X",
  "token_usage": { "input": 5000, "output": 3000, "total": 8000 },
  "duration_ms": 45000
}
```

---

## Shared Infrastructure

### 1. Provider Layer (IAgentProvider)

Both executors ultimately call `IAgentProvider.sendQuery()` - the async generator
that streams chunks from Claude (or other providers).

| Aspect | Swarm | octopus_agent |
|--------|-------|---------------|
| Provider access | `SwarmExecutor.providers[key]` directly | Via `AgentNodeRunner.provider` |
| Call wrapper | `collectFromProvider()` (swarm.ts:606-684) | `AgentNodeRunner.run()` (agent-runner.ts:27-223) |
| Session management | Host agent continues global session | Delegate session + optional previousSessionId |
| Multi-model | Per-expert `expert.engine` + model alias | Single model per node |
| Skills injection | Per-expert `expert.skills[]` | `resolved.snapshot.skills` from version |

### 2. Variable System

Both executors share the VarPool and support:

| Variable Pattern | Swarm | octopus_agent |
|-----------------|-------|---------------|
| `$vars.key` | Yes (topic substitution) | Yes (task.brief, context[]) |
| `$nodeId.output` | No (not in topic) | Yes via `buildNodeOutputs()` |
| `$nodeId.field` | No | Yes via `substituteVarsFull()` |
| `$last_output` | No | Yes via `applyOutputsMapping()` |
| Auto-outputs | `{id}_synthesis`, `{id}_consensus_score`, etc. | `last_output`, `session_id`, `agent_version` |
| `vars_update` extraction | Yes from host rawResponse | Yes from agent text + structured result |

### 3. Checkpoint / Recovery

| Aspect | Swarm | octopus_agent |
|--------|-------|---------------|
| Checkpoint store | Yes SwarmCheckpointData with messages, round, expert results | No (relies on session resume) |
| Resume from round | Yes `resumeFromRound` skips completed rounds | N/A |
| Stream fracture retry | N/A (uses collectFromProvider) | Yes AgentNodeRunner retries with RESUME_PROMPT |

### 4. SSE Events

| Event Type | Swarm | octopus_agent |
|-----------|-------|---------------|
| `expert_spawn` | Yes | No |
| `expert_message` | Yes | No |
| `expert_complete` | Yes | No |
| `consensus_check` | Yes | No |
| `host_report` | Yes | No |
| `swarm_round_end` | Yes | No |
| `swarm_complete` | Yes | No |
| `moa_expert_complete` | Yes | No |
| `moa_aggregator` | Yes | No |
| `text_delta` | No (experts run headless) | Yes |
| `tool_start/input/result` | No | Yes |
| `thinking` | No | Yes |
| `heartbeat` | No | Yes |
| `harness_directive` | No | Yes |

### 5. Hooks

Swarm has dedicated lifecycle hooks (shared/src/types/workflow.ts:101-107):

- `on_swarm_start`
- `on_expert_spawn`
- `on_expert_complete`
- `on_swarm_round_end`
- `on_swarm_consensus`
- `on_swarm_complete`

octopus_agent uses standard node hooks:

- `on_node_success`
- `on_node_failure`

---

## Comparison Table

| Dimension | Swarm | octopus_agent |
|-----------|-------|---------------|
| **Core pattern** | Multi-expert orchestration with inter-agent communication | Single-agent delegation with version management |
| **Number of LLM calls** | N experts x R rounds + Host synthesis (many) | 1 agent call (possibly with resume retry) |
| **Expert interaction** | MessageBus broadcast, SharedMemory KV store | None - single isolated agent |
| **Modes** | 5: review, debate, dispatch, swarm, moa | 1: task delegation |
| **Dynamic expert selection** | Yes expert_pool, agentResolver, SwarmRouter | No (fixed agent clone) |
| **DAG within node** | Yes dispatch mode (Kahn's algorithm) | No |
| **Consensus mechanism** | Yes debate mode: threshold-based early termination | No |
| **Context optimization** | Sliding window + progressive compression | Session continuation + idle timeout |
| **Budget tracking** | Token-level BudgetTracker across all experts | Task-level budget + heartbeat check |
| **Version management** | No (uses agent files directly) | Yes VersionResolver + stage filtering |
| **Structured Task Contract** | No (free-form topic + expert prompts) | Yes TaskContract: brief, context, constraints, SOP, budget |
| **Structured Result** | HostOutput JSON (synthesis + assessment) | StructuredResult JSON (status, output, artifacts, vars_update) |
| **Heartbeat** | No (expert_spawn/complete SSE events only) | Yes HeartbeatHandler: step counting, stall detection |
| **Harness directives** | No | Yes abort/pause from harness |
| **Persona injection** | No (expert.prompt / agent_file) | Yes resolved.snapshot.persona as system prompt |
| **Skills per expert/agent** | Yes per-expert skills[] | Yes from version snapshot |
| **File conflict detection** | Yes dispatch mode detects same-file modifications | N/A (single agent) |
| **Checkpoint/resume** | Yes SwarmCheckpointData | Session-based resume (stream fracture retry) |
| **Model diversity** | Yes per-expert engine + model (including MOA) | Single model per node |
| **Cost** | High (many LLM calls) | Low (single call) |
| **Latency** | High (rounds, parallel fan-out) | Low (single execution) |
| **Complexity** | High (strategy pattern, coordinator, bus, memory) | Medium (composition over AgentExecutor) |

---

## Interaction Protocol Sequences

### Swarm Debate - Full Sequence

```
1. SwarmExecutor.execute()
2. Enrich experts: merge expert_defaults -> load agent_file -> resolve model aliases
3. Substitute $vars in topic
4. Dynamic routing (if enabled):
   a. expert_pool: LLM selects K from N
   b. OR agentResolver: OrchestratorService selection
   c. OR SwarmRouter: keyword prefilter -> LLM selection -> mode decision
5. Create MessageBus, SharedMemory
6. Load checkpoint (if resuming)
7. Create SwarmCoordinator with closures for SSE, logging, hooks, checkpoint, budget
8. Select strategy: DiscussionStrategy
9. For each round (1..maxRounds):
   a. Check budget -> break if exhausted
   b. For each expert (parallel):
      i.   Build sliding-window context (recent full + old summaries)
      ii.  Build expert prompt (role + perspective + task + topic + context)
      iii. Trigger on_expert_spawn hook
      iv.  coordinator.runExpert() -> llmCall() -> collectFromProvider()
      v.   Write to MessageBus (broadcast)
      vi.  Emit expert_message SSE
      vii. Trigger on_expert_complete hook
   c. Emit swarm_round_end SSE + hook
   d. If debate mode and not last round:
      i.   HostAgent.synthesize() -> assess consensus
      ii.  Emit consensus_check SSE
      iii. Emit host_report SSE
      iv.  Trigger on_swarm_consensus hook
      v.   If score >= threshold -> break
   e. Progressive compression: summarize rounds that slid out of window
   f. Save checkpoint
10. Final HostAgent.synthesize() -> full synthesis
11. Emit swarm_complete SSE + hook
12. Write auto-outputs to VarPool
13. Extract vars_update from host rawResponse
14. Return NodeExecutionResult
```

### octopus_agent - Full Sequence

```
1. OctopusAgentExecutor.execute()
2. VersionResolver.resolve(agent, versionSpec, minStage)
   -> ResolvedVersion { version, stage, snapshot{persona, config, skills}, fsPath }
   (fallback: read ~/.octopus/agent/clones/{name}/)
3. Create DelegateSession (UUID, clone_name, version, parent_execution_id)
4. Build Task Contract prompt:
   a. substituteVarsFull(task.brief, pool, nodeOutputs)
   b. Resolve context[] items with $vars and $nodeId.output
   c. Append constraints, expected_output schema, SOP, budget
   d. Append instructions with heartbeat interval
5. Setup HeartbeatHandler:
   a. Count tool_result events as steps
   b. Emit heartbeat every N steps
   c. Check budget -> emit harness_directive: abort
6. Create modified NodeDef: type="agent", prompt=taskPrompt, skills=resolved.skills
7. Create inner AgentExecutor with:
   a. systemPrompt = resolved.snapshot.persona
   b. resolvedModel, modelAliasConfig, etc.
8. AgentExecutor.execute():
   a. Build prompt (standard or goal mode)
   b. Inject promptInjector + knowledgeInjector prompts
   c. Compile auto_answers
   d. AgentNodeRunner.run():
      i.   provider.sendQuery(prompt, cwd, sessionId, opts)
      ii.  Stream chunks: text_delta, tool_call, tool_result, thinking, result
      iii. Reset idle timeout on each event (20 min)
      iv.  On stream fracture: retry with RESUME_PROMPT
   e. Apply vars_update from text
   f. Apply outputs mapping
9. Process agent events through HeartbeatHandler
10. parseStructuredResult(lastOutput):
    -> Extract JSON: status, output, artifacts, vars_update, summary
11. Merge outputs: { last_output, session_id, agent_version, ...structured }
12. Apply vars_update to pool
13. Check abort flag from harness directive
14. Apply node.outputs mapping
15. Return NodeExecutionResult
```

---

## Applicable Scenarios

### When to Use Swarm

| Scenario | Recommended Mode |
|----------|-----------------|
| **Code review** - multiple perspectives (security, quality, performance) | `review` |
| **Technology decision** - weighing trade-offs between options | `debate` |
| **Architecture design** - need consensus across roles | `debate` with high threshold |
| **Full-stack implementation** - backend -> frontend -> review pipeline | `dispatch` with depends_on |
| **Multi-model comparison** - same prompt, different models, aggregate | `moa` |
| **Unknown scope** - let the system pick experts dynamically | `swarm` (dynamic mode) |
| **Complex analysis** - need expert pool with topic-based selection | Any mode + `expert_pool` |
| **Research with adversarial perspectives** | `debate` |

### When to Use octopus_agent

| Scenario | Why |
|----------|-----|
| **Delegating a well-defined task** to a specialized agent clone | Task Contract provides structure |
| **Versioned agent execution** - need specific agent version/stage | VersionResolver + stage filtering |
| **Long-running autonomous task** - agent uses tools independently | Single session with tool access |
| **Budget-controlled execution** - need heartbeat + abort on overspend | HeartbeatHandler + harness directives |
| **Persona-driven execution** - agent has its own identity/skills | persona.md + skills from snapshot |
| **Structured output expected** - need parseable results | StructuredResult protocol |
| **Simple pipeline step** - one agent, one task | Low overhead, single LLM call |
| **Chaining agent clones** - each step uses a different clone | Each node references a different `agent:` |

---

## Strengths and Limitations

### Swarm Executor

**Strengths:**
1. **Multi-perspective analysis**: Multiple experts provide diverse viewpoints, reducing blind spots
2. **Consensus-driven**: Debate mode converges on high-quality answers via iterative refinement
3. **DAG orchestration**: Dispatch mode enables complex multi-step expert workflows with dependencies
4. **Dynamic expert selection**: Router can adapt expert roster to the topic at hand
5. **Model diversity**: MOA mode leverages different model strengths for the same problem
6. **Checkpoint recovery**: Can resume from the exact round after failures
7. **Context optimization**: Sliding window + progressive compression prevents context overflow
8. **Rich SSE events**: Real-time visibility into expert progress for the UI

**Limitations:**
1. **High cost**: N experts x R rounds = many LLM calls (potentially 10-30+ per node)
2. **High latency**: Parallel execution helps, but rounds are sequential
3. **No structured task contract**: Topic is free-form; no SOP, constraints, or expected_output schema
4. **Complex debugging**: Many moving parts (bus, memory, coordinator, strategies)
5. **No version management**: Expert definitions are inline or agent_file-based, not versioned
6. **Host degradation**: If all host models fail, falls back to raw concatenation

### octopus_agent Node

**Strengths:**
1. **Structured task delegation**: Task Contract provides clear brief, constraints, SOP, expected output
2. **Version management**: Resolves agent versions with stage filtering (alpha -> stable)
3. **Full tool access**: Agent has full Claude SDK tool access (Read, Write, Edit, Bash, etc.)
4. **Budget control**: Heartbeat monitoring + auto-abort on budget exceeded
5. **Persona injection**: Agent persona.md becomes the system prompt
6. **Structured results**: Parseable JSON output with status, artifacts, vars_update
7. **Low overhead**: Single LLM call (with optional resume retry)
8. **Harness directives**: External control (abort/pause) during execution
9. **Delegate sessions**: Clean isolation with session metadata

**Limitations:**
1. **Single perspective**: Only one agent - no multi-expert cross-checking
2. **No consensus mechanism**: Quality depends entirely on the single agent
3. **No inter-agent communication**: Cannot collaborate with other agents during execution
4. **Version dependency**: Requires published agent versions or clone directory
5. **No checkpoint recovery**: Relies on session-level resume, not node-level checkpoint
6. **Less SSE visibility**: No expert-level progress events (only tool-level)

---

## Decision Guide

```
                         Need multi-perspective analysis?
                                    |
                           +--------+--------+
                          Yes                No
                           |                  |
                 Need expert                Need versioned agent
                 dependencies?              with tools + SOP?
                      |                          |
               +------+------+            +------+------+
              Yes            No           Yes           No
               |              |            |             |
          dispatch        debate/      octopus_agent    agent
          mode            review        node           node
               |              |            |             |
          Need model      Need same     Need          Simple
          diversity?      prompt, diff  heartbeat +   prompt +
               |          models?       budget?       skills?
          +----+----+         |            |             |
         Yes        No       Yes        Yes           Yes
          |          |        |          |             |
         moa      swarm    moa      octopus_agent   agent
                  (dynamic)          node           node
```

### Quick Reference

| Question | Answer |
|----------|--------|
| "I need 3+ experts to debate a decision" | **Swarm debate** |
| "I need a pipeline of dependent expert tasks" | **Swarm dispatch** |
| "I want to compare outputs from different models" | **Swarm moa** |
| "I don't know which experts I need" | **Swarm dynamic** |
| "I need one agent to do a well-defined task with tools" | **octopus_agent** |
| "I need versioned agent execution" | **octopus_agent** |
| "I need budget control with heartbeat monitoring" | **octopus_agent** |
| "I need the agent to read/write files and run commands" | **octopus_agent** (or plain `agent`) |
| "I need simple text generation with skills" | **agent** (plain) |
| "I need both multi-expert AND tool-using agents" | **Swarm dispatch** (experts can use tools) |

---

## Code Reference Index

| Concept | File | Line(s) |
|---------|------|---------|
| NodeExecutor interface | executors/types.ts | 56-58 |
| NodeExecutionResult | executors/types.ts | 25-54 |
| ExecutorFactory dispatch | executor-factory.ts | 69-299 |
| SwarmExecutor class | executors/swarm.ts | 38-601 |
| SwarmStrategy abstract | executors/swarm/swarm-strategy.ts | 76-87 |
| SwarmServices interface | executors/swarm/swarm-strategy.ts | 19-54 |
| DiscussionStrategy | executors/swarm/discussion-strategy.ts | 21-413 |
| DispatchStrategy | executors/swarm/dispatch-strategy.ts | 18-347 |
| MoaStrategy | executors/swarm/moa-strategy.ts | 17-294 |
| SwarmCoordinator | executors/swarm/swarm-coordinator.ts | 37-174 |
| MessageBus | executors/swarm/message-bus.ts | 9-51 |
| SharedMemory | executors/swarm/shared-memory.ts | 16-43 |
| HostAgent | executors/swarm/host-agent.ts | 26-242 |
| DAG builder (Kahn's) | executors/swarm/dag-builder.ts | 19-74 |
| SwarmRouter | executors/swarm/swarm-router.ts | 18-130 |
| ContextTierResolver | executors/swarm/context-tier-resolver.ts | 19-111 |
| BudgetTracker | executors/swarm/budget-tracker.ts | 4-76 |
| collectFromProvider | executors/swarm.ts | 606-684 |
| OctopusAgentExecutor | executors/octopus-agent.ts | 40-340 |
| AgentExecutor | executors/agent.ts | 19-474 |
| AgentNodeRunner | executors/agent-runner.ts | 10-223 |
| buildTaskPrompt | executors/octopus-agent/task-prompt.ts | 29-111 |
| parseStructuredResult | executors/octopus-agent/parse-result.ts | 20-47 |
| HeartbeatHandler | executors/octopus-agent/heartbeat.ts | 24-152 |
| DelegateSession | executors/octopus-agent/session.ts | 12-57 |
| SwarmNodeDefSchema | shared/src/types/swarm.ts | 108-138 |
| ExpertDefSchema | shared/src/types/swarm.ts | 4-21 |
| validateSwarmConstraints | shared/src/types/swarm.ts | 40-105 |
| OctopusAgentNodeDef | shared/src/types/octopus-agent.ts | 46-53 |
| TaskContract | shared/src/types/octopus-agent.ts | 27-34 |
| StructuredResult | shared/src/types/octopus-agent.ts | 84-92 |
| NodeDef (unified) | shared/src/types/workflow.ts | 160-274 |
| NodeSchema (Zod) | shared/src/types/workflow.ts | 276-418 |
| applyVarsUpdate | executors/parse-vars-update.ts | 13-61 |
| Swarm YAML (debate) | core-pack/templates/swarm/tech-decision.yaml | 1-32 |
| Swarm YAML (dispatch) | core-pack/templates/swarm/fullstack-dev.yaml | 1-46 |
| octopus_agent YAML | .scratch/octopus-agent-ui-wiring/e2e-octopus-agent-test.yaml | 1-33 |

---

*End of analysis. All references are to primary source code, not documentation.*
