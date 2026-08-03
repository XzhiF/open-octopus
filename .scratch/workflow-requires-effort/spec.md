# Verified Spec: Workflow `requires` + `effort` Passthrough

## Overview

This feature adds three capabilities to the Octopus workflow engine:

1. **Top-level `requires` declaration** — Workflows can explicitly declare their skill and agent_file dependencies
2. **`_engine_init_` prioritized provisioning** — Engine init uses declared `requires` first, then scans as fallback
3. **`effort` passthrough** — Agent nodes (top-level and sub-agents) can control LLM reasoning depth, passed to both SDKs

## Changes

### Change 1: WorkflowSchema `requires` Field

**File**: `packages/shared/src/types/workflow.ts`

Add to `WorkflowSchema`:
```typescript
requires: z.object({
  skills: z.array(z.string()).optional(),
  agent_files: z.array(z.string()).optional(),
}).optional(),
```

Add corresponding `WorkflowDef` interface field:
```typescript
requires?: {
  skills?: string[]
  agent_files?: string[]
}
```

**Backward compatibility**: Both fields optional. Existing workflows without `requires` continue to work.

### Change 2: EngineInitPhase Uses `requires` First

**File**: `packages/engine/src/engine-init.ts`

Current flow:
```
ResourcePreFlight.analyze(workflow) → scan nodes for resources
→ check workspace → provision missing
```

New flow:
```
1. If workflow.requires exists:
   - Build manifest from requires.skills + requires.agent_files
   - Log: "Provisioning from requires: X skills, Y agents"
   - Check + provision

2. Then run ResourcePreFlight.analyze(workflow) as fallback scan
   - Log: "Scanning for additional resources..."
   - Merge scanned resources with already-provisioned
   - Check + provision any new missing resources
```

**Key**: The `requires` resources are provisioned first (explicit declaration priority). The scan catches anything missed.

### Change 3: `effort` Passthrough

**Files**:
- `packages/shared/src/types/workflow.ts` — Add `effort` to `NodeDef`
- `packages/providers/src/types.ts` — Add `effort` to `SendQueryOptions` and `OctopusAgentDef`
- `packages/engine/src/executors/agent-runner.ts` — Pass `effort` to `sendQuery`
- `packages/engine/src/executors/agent.ts` — Pass `effort` from `NodeDef` to runner
- `packages/providers/src/claude/provider.ts` — Pass `effort` to Claude SDK `Options`
- `packages/providers/src/claude/provider.ts` — Pass `effort` in `toClaudeAgentDef`
- `packages/providers/src/pi/provider.ts` — Map effort → thinkingLevel for Pi SDK

**effort type**: `"low" | "medium" | "high" | "xhigh" | "max" | number` (same as `SubAgentDef`)

#### effort mapping for Pi SDK

Pi SDK uses `thinkingLevel`. Mapping:
- `"low"` → `"minimal"`
- `"medium"` → `"low"`
- `"high"` → `"medium"`
- `"xhigh"` → `"high"`
- `"max"` → `"maximum"`
- `number` → pass as-is (if Pi SDK supports numeric)

## Acceptance Criteria

| # | Criteria | Test |
|---|---------|------|
| 1 | WorkflowSchema accepts `requires.skills` and `requires.agent_files` | `WorkflowSchema.parse()` unit test |
| 2 | `requires` fields are optional — workflow without `requires` validates | `WorkflowSchema.parse()` backward compat test |
| 3 | `_engine_init_` provisions `requires` resources first, then scans | Log order assertion in `EngineInitPhase.run()` test |
| 4 | Resources not in `requires` are still found by scan | Integration test: workflow with missing resources provisions correctly |
| 5 | `NodeDef.effort` passes to Claude SDK `Options.effort` | Unit test: sendQuery options assertion |
| 6 | `SubAgentDef.effort` maps to `AgentDefinition.effort` in Claude SDK | Unit test: `toClaudeAgentDef` mapping |
| 7 | `effort` maps to Pi SDK `thinkingLevel` | Unit test: Pi session options |

## Data Model Changes

| Schema | Field | Type | Optional |
|--------|-------|------|----------|
| WorkflowSchema | `requires` | `{ skills?: string[], agent_files?: string[] }` | Yes |
| NodeDef | `effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| number` | Yes |
| SendQueryOptions | `effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| number` | Yes |
| OctopusAgentDef | `effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| number` | Yes |

## Risks

- **R1**: Invalid resource names in `requires` cause init failure (acceptable — fail-fast)
- **R2**: effort semantics differ between SDKs (Claude: `effort`, Pi: `thinkingLevel`) — mapping needed
- **R3**: Backward compatibility — all new fields are optional
