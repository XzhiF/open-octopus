# Spec: Workflow Requires — Commands, Rules & Clones Support

## Problem Statement
The workflow `requires` system currently only supports `skills` and `agent_files`. Workflows that depend on Claude Code commands, rules, or clone agents have no way to declare those dependencies. When a required clone is missing, the workflow runs anyway and fails cryptically at runtime instead of being blocked upfront.

## Solution
Extend the `requires` schema with 3 new resource types: `commands`, `rules`, and `clones`. Commands and rules are auto-provisioned (copied from resource registry) like skills/agents. Clones are checked but never provisioned — if a declared clone is not installed, the workflow is immediately blocked with a clear error message.

## Projects Involved
- [x] `packages/shared` — Schema expansion, preflight check, provisioner
- [x] `packages/engine` — Engine init integration, clone hard-fail gate
- [ ] `packages/server` — No changes (already wires preflight/provisioner)
- [ ] `packages/web-app` — No changes (backend only)

## Feature Scope
**Do:**
- Add `commands`, `rules`, `clones` optional fields to `requires` schema
- Check commands at `.claude/commands/{name}.md`
- Check rules at `.claude/rules/{name}.md`
- Check clones at `~/.octopus/agent/clones/{name}/` OR `~/.octopus/agent/built-in/{name}/`
- Auto-provision missing commands/rules from resource registry
- Hard-fail workflow if any declared clone is not installed
- Track `commandsCopied` and `rulesCopied` counters in init result

**Don't:**
- Add scan-fallback for new types (only requires-first phase)
- Auto-provision clones
- Add web-app UI for editing new requires fields
- Change existing skills/agent_files behavior

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | YAML fields | Separate fields: `commands`, `rules`, `clones` | Consistent with existing `skills`, `agent_files` pattern |
| D2 | Commands check path | `.claude/commands/{name}.md` | Standard Claude Code command location |
| D3 | Rules check path | `.claude/rules/{name}.md` | Standard Claude Code rule location |
| D4 | Clone check path | `~/.octopus/agent/clones/{name}/` OR `~/.octopus/agent/built-in/{name}/` | Covers both user-installed and built-in clones |
| D5 | Clone fail mode | Hard fail + clear error, no provisioning | User must explicitly install clones first |
| D6 | Scan-fallback | No changes to `analyze()` | Commands/rules/clones are not referenced in workflow nodes |
| D7 | Clone error message | "Clone '{name}' is not installed. Install it with: octopus resource install builtin:{name} --type clone" | Actionable error with install command |
| D8 | Provisioner type expansion | `'agent' \| 'skill' \| 'command' \| 'rule'` (no clone) | Clones never provisioned |
| D9 | Per-type provision counts | Provisioner returns `{ provisioned, failed, byType }` with per-type counts | Ratio-based estimation (existing) is fragile with 4+ types |
| D10 | Clone path resolution | Inline `os.homedir()` in `ResourcePreFlight` (shared pkg) | `packages/server` path helpers can't be imported from `packages/shared` (wrong dependency direction) |
| D11 | SSE error detail | Include clone names + install hint in SSE error event data | Generic "engine_init phase failed" is not actionable for users |
| D12 | Error handling | Bare `catch {}` in engine-init must capture and log error | Silent error swallowing hides root cause (permissions, etc.) |

### Story Gap Fixes (from Walk-Through)
| BP | Severity | Gap | Fix |
|----|----------|-----|-----|
| BP-8 | HIGH | Clone path helpers in `packages/server`, not `packages/shared` | D10: inline `os.homedir()` in ResourcePreFlight |
| BP-11 | LOW | SSE error message too generic for clone fail | D11: include clone error details in SSE event |
| BP-12 | MEDIUM | Generic `catch {}` swallows error details | D12: capture and log error in catch block |

## Implementation Decisions

### Modules Modified

| File | Change |
|------|--------|
| `packages/shared/src/types/workflow.ts:382` | Add `commands`, `rules`, `clones` to requires schema |
| `packages/shared/src/resource/resource-preflight.ts` | Expand `ResourceManifest`, `ResourceCheckResult`, add check logic |
| `packages/shared/src/resource/resource-provisioner.ts` | Add command/rule copy logic, expand type union |
| `packages/engine/src/engine-init.ts` | Add clone gate, expand requires manifest, add counters |

### Interface Contracts

#### ResourceManifest (expanded)
```typescript
export interface ResourceManifest {
  agents: string[]
  skills: string[]
  commands: string[]  // NEW
  rules: string[]     // NEW
  // Note: clones NOT included — checked by separate hard-fail gate in engine-init
}
```

#### ResourceCheckResult (expanded)
```typescript
export type ResourceItemType = 'agent' | 'skill' | 'command' | 'rule' | 'clone'

export interface ResourceCheckResult {
  available: Array<{ type: ResourceItemType; name: string }>
  missing: Array<{ type: ResourceItemType; name: string }>
}
```

#### ResourceProvisioner.provision() (expanded)
```typescript
async provision(
  missing: Array<{ type: 'agent' | 'skill' | 'command' | 'rule'; name: string }>,
  workspaceDir: string,
): Promise<{ provisioned: number; failed: string[]; byType: Record<string, number> }>
```
Note: `clone` is excluded from the provisioner type — clones are never provisioned. `byType` returns exact per-type counts (e.g., `{ agent: 1, command: 2 }`) replacing the fragile ratio-based estimation in engine-init.

#### EngineInitResult (expanded)
```typescript
export interface EngineInitResult {
  status: "completed" | "failed"
  durationMs: number
  skillsCopied: number
  agentsCopied: number
  commandsCopied: number  // NEW
  rulesCopied: number     // NEW
  cloneErrors: string[]   // NEW — clone names that failed hard-fail check
  gitSyncResults: GitSyncResult[]
}
```

#### EngineInitPhase clone gate (new logic)
```
In EngineInitPhase.run(), BEFORE provisioning:
1. Read workflow.requires?.clones ?? []
2. If clones declared:
   a. Check each clone at ~/.octopus/agent/clones/{name}/ and ~/.octopus/agent/built-in/{name}/
   b. If ANY clone missing → log error with install hint → collect errors in ctx.cloneErrors
   c. Set ctx.failed = true, return immediately with { status: "failed", cloneErrors: [...] }
   d. If all clones present → continue to provisioning
3. Clone check happens BEFORE command/rule provisioning
   (no point provisioning if the workflow will be blocked anyway)
4. cloneErrors propagated to EngineInitResult for SSE event detail
```

### Provisioner Copy Logic (new types)

```
command type:
  source: registry entry.installPath (e.g., ~/.octopus/resources/commands/cmd-review.md)
  dest:   {workspaceDir}/.claude/commands/{name}.md
  method: fs.copyFileSync (single file, like agent)

rule type:
  source: registry entry.installPath (e.g., ~/.octopus/resources/rules/code-style.md)
  dest:   {workspaceDir}/.claude/rules/{name}.md
  method: fs.copyFileSync (single file, like agent)
```

### ProvisionContext (expanded)
```typescript
interface ProvisionContext {
  skillsCopied: number
  agentsCopied: number
  commandsCopied: number  // NEW
  rulesCopied: number     // NEW
  cloneErrors: string[]   // NEW — clone names that failed hard-fail check
  failed: boolean
}
```

### provisionMissing() counter update (replaces ratio estimation)
```
Existing code uses ratio-based estimation:
  missingSkills * (provisioned / totalMissing) → inaccurate with 4+ types

New code uses byType from provisioner result:
  ctx.skillsCopied += result.byType.skill ?? 0
  ctx.agentsCopied += result.byType.agent ?? 0
  ctx.commandsCopied += result.byType.command ?? 0
  ctx.rulesCopied += result.byType.rule ?? 0
```

### ResourceManifestLike (expanded, engine-init.ts)
```typescript
export interface ResourceManifestLike {
  agents: string[]
  skills: string[]
  commands: string[]  // NEW
  rules: string[]     // NEW
  // Note: clones NOT included — checked by separate hard-fail gate
}
```
Note: clones are NOT in ResourceManifestLike because they are checked separately (hard-fail gate), not through the provision pipeline.

### Clone Path Resolution
```typescript
function getClonePaths(name: string): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return [
    path.join(home, '.octopus', 'agent', 'clones', name),
    path.join(home, '.octopus', 'agent', 'built-in', name),
  ]
}
```

## Data Model Changes
| Table/Schema | Operation | Details |
|-------|-----------|---------|
| `WorkflowSchema.requires` | Add fields | `commands?: string[]`, `rules?: string[]`, `clones?: string[]` (all optional) |
| `ResourceManifest` | Add fields | `commands: string[]`, `rules: string[]` (clones excluded — gate-only) |
| `ResourceCheckResult` | Expand union | type: `'agent' \| 'skill' \| 'command' \| 'rule' \| 'clone'` |
| `ResourceProvisioner` type param | Expand union | `'agent' \| 'skill' \| 'command' \| 'rule'` (no clone) |
| `EngineInitResult` | Add counters | `commandsCopied`, `rulesCopied` |
| `ProvisionContext` | Add counters | `commandsCopied`, `rulesCopied` |

## API Contracts
No REST API changes. The `requires` field is part of the workflow YAML definition, checked internally during engine initialization.

## Verification Strategy

### Verification Environment
| Item | Value |
|------|-------|
| Environment | local dev: `pnpm dev` |
| Test framework | Vitest |
| Database | N/A (filesystem checks only) |

### Test Users & Data
| Item | Value |
|------|-------|
| Test data | Temp directories with fixture files |
| Cleanup | Vitest afterEach teardown |

### AC to Verification Method Mapping
| US# | User Story | AC | Verification Level | Verification Method |
|-----|-----------|-----|-------------------|---------------------|
| AC-1 | Workflow author declares commands | Schema accepts commands field | Unit | `requires-schema.test.ts` |
| AC-2 | Workflow author declares rules | Schema accepts rules field | Unit | `requires-schema.test.ts` |
| AC-3 | Workflow author declares clones | Schema accepts clones field | Unit | `requires-schema.test.ts` |
| AC-4 | Old workflows still work | Backward compat (all optional) | Unit | `requires-schema.test.ts` |
| AC-5 | Command preflight check | `.claude/commands/{name}.md` | Unit | `resource-preflight.test.ts` |
| AC-6 | Rule preflight check | `.claude/rules/{name}.md` | Unit | `resource-preflight.test.ts` |
| AC-7 | Clone preflight check | Both clone paths | Unit | `resource-preflight.test.ts` |
| AC-8 | Command auto-provisioning | Copies from registry | Unit | `resource-provisioner.test.ts` |
| AC-9 | Rule auto-provisioning | Copies from registry | Unit | `resource-provisioner.test.ts` |
| AC-10 | Clone hard-fail | No provisioning, init fails | Integration | `engine-init.test.ts` |
| AC-11 | Mixed requires | All 5 types together | Integration | `engine-init.test.ts` |
| AC-12 | Clone error message | Clear message with install hint | Integration | `engine-init.test.ts` |
| AC-13 | Scan-fallback unchanged | `analyze()` same as before | Unit | `resource-preflight.test.ts` |

### Verification Methods Detail

#### Unit Tests
- **requires-schema.test.ts**: Add tests for commands/rules/clones field validation, type rejection, backward compat
- **resource-preflight.test.ts**: Add tests for check() with command/rule/clone types, path resolution, both clone paths
- **resource-provisioner.test.ts**: Add tests for command/rule copy, clone exclusion from provisioning

#### Integration Tests
- **engine-init.test.ts**: Add tests for clone hard-fail gate, mixed requires flow, counter tracking, error messages

### Anti-Fake-Run Standards (R1-R8)
| # | Criterion | Description |
|---|-----------|-------------|
| R1 | Real filesystem | Tests use real temp directories, not mocked fs |
| R2 | Real paths | Check actual `.claude/commands/`, `.claude/rules/` paths |
| R3 | Cross-validation | Provisioner output verified by filesystem check |
| R4 | Evidence | Test assertions on return values + file existence |
| R5 | Side effects | Write ops verify file created on disk |
| R7 | Data isolation | Temp directories per test |
| R8 | Repeatable | No manual pre-steps needed |

### Prerequisites
- [ ] Existing test infrastructure (temp dir helpers, mock registries)
- [ ] Resource registry with test command/rule entries

## Risks & Notes
- R1: Cross-platform path resolution — `~/.octopus/agent/` uses `HOME` on Linux, `USERPROFILE` on Windows. Must test both.
- R2: `ResourceProvisioner.directCopy()` currently only handles `'agent' | 'skill'` — must add `'command' | 'rule'` cases
- R3: `ProvisionContext` counter update logic in `provisionMissing()` uses ratio calculation — must extend for new counters
- R4: Clone check must happen BEFORE command/rule provisioning (fail-fast: don't waste time provisioning if clone blocks)

## Glossary
| Term | Meaning |
|------|---------|
| requires | Workflow YAML field declaring prerequisite resources |
| preflight | Pre-execution check that all required resources are available |
| provision | Copy a missing resource from the global registry to the workspace |
| clone | An Octopus clone agent (built-in or user-installed via resource module) |
| hard-fail | Immediately block workflow execution with a clear error |

## Appendix: Core User Stories (闭环验证)

### Story 1: Workflow with command + rule requires (happy path)
1. Author writes YAML: `requires: { commands: ["cmd-review"], rules: ["code-style"] }`
2. User runs workflow [Exec]
3. EngineInitPhase.run() reads requires.commands + requires.rules [Exec]
4. Builds requiresManifest: `{ commands: ["cmd-review"], rules: ["code-style"] }` [Exec]
5. ResourcePreFlight.check() checks `.claude/commands/cmd-review.md` → missing [Data]
6. ResourcePreFlight.check() checks `.claude/rules/code-style.md` → missing [Data]
7. ResourceProvisioner.provision() copies `cmd-review.md` from registry → `.claude/commands/` [Data]
8. ResourceProvisioner.provision() copies `code-style.md` from registry → `.claude/rules/` [Data]
9. ctx.commandsCopied = 1, ctx.rulesCopied = 1 [Exec]
10. Workflow proceeds to execution [Exec]

### Story 2: Workflow with clone requires — clone installed
1. Author writes YAML: `requires: { clones: ["workspace"] }`
2. User runs workflow [Exec]
3. EngineInitPhase.run() reads requires.clones = ["workspace"] [Exec]
4. Checks `~/.octopus/agent/built-in/workspace/` → exists [Data]
5. Clone gate passes → continues to command/rule provisioning [Exec]
6. Workflow proceeds normally [Exec]

### Story 3: Workflow with clone requires — clone NOT installed
1. Author writes YAML: `requires: { clones: ["my-custom-clone"] }`
2. User runs workflow [Exec]
3. EngineInitPhase.run() reads requires.clones = ["my-custom-clone"] [Exec]
4. Checks `~/.octopus/agent/clones/my-custom-clone/` → NOT found [Data]
5. Checks `~/.octopus/agent/built-in/my-custom-clone/` → NOT found [Data]
6. Logs: "Clone 'my-custom-clone' is not installed. Install it with: octopus resource install builtin:my-custom-clone --type clone" [Event]
7. Sets ctx.failed = true [Exec]
8. Returns `{ status: "failed", ... }` [Exec]
9. ExecutionLifecycle sets execution status to "failed" [Event]
10. Workflow NEVER runs — blocked at init phase [Exec]

### Story 4: Mixed requires — all 5 types
1. Author writes YAML with skills + agent_files + commands + rules + clones
2. EngineInitPhase.run():
   a. First: clone gate check (fail-fast) [Exec]
   b. If clones OK: build manifest with skills + agents + commands + rules [Exec]
   c. Preflight check all 4 provisionable types [Data]
   d. Provision missing resources [Data]
   e. Update all counters [Exec]
   f. Proceed to scan-fallback (skills + agents only) [Exec]
   g. Git sync [Exec]
3. Workflow runs with all resources available [Exec]
