# Ticket 3: `effort` Passthrough to Both SDKs

## Status: Done

## Summary

Add `effort` field to NodeDef, pass it through the execution chain to both Claude SDK and Pi SDK providers.

## Scope

- **Packages**: `@octopus/shared`, `@octopus/providers`, `@octopus/engine`
- **Files**:
  - `packages/shared/src/types/workflow.ts` — NodeDef effort
  - `packages/providers/src/types.ts` — SendQueryOptions + OctopusAgentDef effort
  - `packages/engine/src/executors/agent-runner.ts` — pass effort to sendQuery
  - `packages/engine/src/executors/agent.ts` — pass effort from NodeDef to runner
  - `packages/providers/src/claude/provider.ts` — Claude SDK Options.effort + toClaudeAgentDef
  - `packages/providers/src/pi/provider.ts` — effort → thinkingLevel mapping

## Acceptance Criteria

1. `NodeDef` has optional `effort` field (same type as SubAgentDef)
2. `SendQueryOptions` has optional `effort` field
3. `OctopusAgentDef` has optional `effort` field
4. AgentExecutor passes NodeDef.effort to AgentNodeRunner
5. AgentNodeRunner passes effort to provider.sendQuery options
6. Claude SDK provider sets `effort` on SDK `Options`
7. `toClaudeAgentDef` maps `effort` to `AgentDefinition.effort`
8. Pi SDK provider maps effort to thinkingLevel for Pi session

## Implementation Plan

### Step 1: Schema changes (shared)

Add to `NodeDef` interface and `NodeSchema`:
```typescript
effort?: "low" | "medium" | "high" | "xhigh" | "max" | number
```

### Step 2: Provider types

Add to `SendQueryOptions` and `OctopusAgentDef` in `providers/src/types.ts`:
```typescript
effort?: "low" | "medium" | "high" | "xhigh" | "max" | number
```

### Step 3: Write tests (RED)

Create `packages/providers/__tests__/effort-passthrough.test.ts`:
- Test: Claude SDK provider passes effort to Options
- Test: `toClaudeAgentDef` maps effort to AgentDefinition
- Test: Pi SDK provider maps effort → thinkingLevel

Add to `packages/engine` agent-runner tests:
- Test: runner passes effort from opts to sendQuery

### Step 4: Engine chain (GREEN)

- AgentExecutor: pass `this.node.effort` to `runner.run({ ... effort: this.node.effort })`
- AgentNodeRunner: accept `effort` in opts, pass to `sendQuery` options

### Step 5: Provider implementations (GREEN)

**Claude SDK** (`claude/provider.ts`):
- Add `effort: options?.effort` to `sdkOptions`
- Add `effort: def.effort` to `toClaudeAgentDef` return

**Pi SDK** (`pi/provider.ts`):
- Map effort to thinkingLevel:
  - "low" → "minimal"
  - "medium" → "low"
  - "high" → "medium"
  - "xhigh" → "high"
  - "max" → "maximum"
  - number → as-is
- Pass thinkingLevel to Pi session prompt options

### Step 6: Verify

Run `pnpm test` to ensure all tests pass.

## Verification Method

```bash
pnpm test --filter @octopus/providers -- effort-passthrough
pnpm test --filter @octopus/engine -- agent
```

## Dependencies

- None (independent of tickets 1-2)
