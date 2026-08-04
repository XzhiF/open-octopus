# Requirement Brief: Workflow Requires — Commands, Rules & Clones Support

## Overview
Extend the workflow `requires` system to support 3 new resource types: `commands` (Claude Code commands), `rules` (Claude Code rules), and `clones` (Octopus clone agents), with commands/rules auto-provisioned like skills/agents and clones hard-failing if not installed.

## Projects Involved
- [x] `packages/shared` (schema + preflight + provisioner)
- [x] `packages/engine` (engine-init integration)
- [ ] `packages/server` (no changes — already wires preflight/provisioner)
- [ ] `packages/web-app` (no changes — backend only)

## Feature Scope
**Do:**
- Add `commands`, `rules`, `clones` fields to the `requires` schema
- Check commands at `.claude/commands/{name}.md`
- Check rules at `.claude/rules/{name}.md`
- Check clones at `~/.octopus/agent/clones/{name}/` OR `~/.octopus/agent/built-in/{name}/`
- Auto-provision missing commands and rules from resource registry (same as skills/agents)
- Hard-fail workflow execution if any declared clone is not installed (no provisioning for clones)
- Update `ResourceManifest`, `ResourceCheckResult` types to cover new types
- Update `ResourceProvisioner` to handle command and rule types

**Don't:**
- Add scan-fallback for commands/rules/clones (only requires-first, not node scanning)
- Add web-app workflow editor UI for the new fields
- Auto-provision clones (they must be pre-installed by the user)
- Change existing skills/agent_files behavior

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | YAML fields | Separate fields: `commands`, `rules`, `clones` | Consistent with existing `skills`, `agent_files` |
| D2 | Commands check | `.claude/commands/{name}.md` exists | Standard Claude Code command location |
| D3 | Rules check | `.claude/rules/{name}.md` exists | Standard Claude Code rule location |
| D4 | Clones check | `~/.octopus/agent/clones/{name}/` OR `~/.octopus/agent/built-in/{name}/` | Covers both user and built-in clones |
| D5 | Clone fail mode | Hard fail with clear error, no provisioning | User must explicitly install clones first |
| D6 | Scan-fallback | No changes | Commands/rules/clones not referenced in workflow nodes |
| D7 | UI scope | Backend only | No web-app changes needed |
| D8 | Verification | Unit (schema + preflight + provisioner) + Integration (engine init) | Full coverage of all layers |

## Data Model Changes
| Entity | Operation | Details |
|--------|-----------|---------|
| `WorkflowSchema.requires` | Add fields | `commands?: string[]`, `rules?: string[]`, `clones?: string[]` |
| `ResourceManifest` | Add fields | `commands: string[]`, `rules: string[]`, `clones: string[]` |
| `ResourceCheckResult` | Expand type | `'agent' \| 'skill' \| 'command' \| 'rule' \| 'clone'` |
| `EngineInitResult` | Add counters | `commandsCopied: number`, `rulesCopied: number` |

## API Contracts
No API changes — requires is a workflow YAML field, checked internally during engine init.

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| AC-1 | Workflow author | `requires.commands` accepts string array in YAML | Unit: schema accepts `{commands: ["cmd-review"]}` |
| AC-2 | Workflow author | `requires.rules` accepts string array in YAML | Unit: schema accepts `{rules: ["code-style"]}` |
| AC-3 | Workflow author | `requires.clones` accepts string array in YAML | Unit: schema accepts `{clones: ["workspace"]}` |
| AC-4 | Workflow author | Old workflows without new fields still parse | Unit: schema backward compat (all new fields optional) |
| AC-5 | Engine | Command preflight checks `.claude/commands/{name}.md` | Unit: preflight check returns correct available/missing |
| AC-6 | Engine | Rule preflight checks `.claude/rules/{name}.md` | Unit: preflight check returns correct available/missing |
| AC-7 | Engine | Clone preflight checks both `~/.octopus/agent/clones/` and `~/.octopus/agent/built-in/` | Unit: preflight check returns correct available/missing |
| AC-8 | Engine | Missing commands auto-provisioned from registry | Unit: provisioner copies command .md file |
| AC-9 | Engine | Missing rules auto-provisioned from registry | Unit: provisioner copies rule .md file |
| AC-10 | Engine | Clones are NOT provisioned — missing clone = hard fail | Integration: engine init returns `status: "failed"` |
| AC-11 | Engine | Engine init handles all 5 requires types together | Integration: mixed requires (skills + agents + commands + rules + clones) |
| AC-12 | Engine | Clear error message when clone missing | Integration: log contains clone name and install hint |
| AC-13 | Engine | Scan-fallback unchanged (no command/rule/clone scanning) | Unit: `analyze()` returns same as before |

## Verification Strategy

### Global Config
- Environment: local dev (`pnpm dev`)
- Test framework: Vitest
- Test files: existing test files + new test cases

### Per-layer Methods
#### Unit Tests
- `packages/shared/src/__tests__/requires-schema.test.ts` — add commands/rules/clones validation
- `packages/server/src/services/__tests__/resource-preflight.test.ts` — add check() for new types
- `packages/shared/src/__tests__/resource-provisioner.test.ts` (new) — command/rule provisioning

#### Integration Tests
- `packages/engine/src/__tests__/engine-init.test.ts` — clone hard-fail, mixed requires, counter updates

### Prerequisites
- [ ] Resource registry has test command and rule entries
- [ ] `~/.octopus/agent/built-in/` has at least one clone for testing

## Risks & Notes
- R1: Clone path resolution uses `process.env.HOME` / `USERPROFILE` — must work cross-platform (Windows + Linux)
- R2: Provisioner currently types `missing` as `Array<{ type: 'agent' | 'skill'; name: string }>` — must expand the union type
- R3: `ProvisionContext` tracks `skillsCopied` and `agentsCopied` — must add `commandsCopied` and `rulesCopied`

## Glossary
| Term | Meaning |
|------|---------|
| requires | Workflow YAML field declaring prerequisite resources |
| preflight | Pre-execution check that all required resources are available |
| provision | Copy a missing resource from the global registry to the workspace |
| clone | An Octopus clone agent (built-in or user-installed via resource module) |

## Appendix: Core User Stories (闭环验证)

### Story 1: Workflow with command + rule requires
1. Author writes workflow YAML with `requires.commands: ["cmd-review"]` and `requires.rules: ["code-style"]`
2. User runs workflow via CLI or web-app
3. EngineInitPhase reads requires → builds manifest with commands + rules
4. ResourcePreFlight.check() → finds `.claude/commands/cmd-review.md` missing, `.claude/rules/code-style.md` missing
5. ResourceProvisioner.provision() → copies both from global registry to workspace
6. Workflow execution proceeds normally

### Story 2: Workflow with clone requires — clone installed
1. Author writes workflow with `requires.clones: ["workspace"]`
2. User runs workflow
3. EngineInitPhase reads requires → checks clone at `~/.octopus/agent/built-in/workspace/`
4. Clone found → workflow proceeds normally

### Story 3: Workflow with clone requires — clone NOT installed
1. Author writes workflow with `requires.clones: ["my-custom-clone"]`
2. User runs workflow
3. EngineInitPhase reads requires → checks `~/.octopus/agent/clones/my-custom-clone/` and `~/.octopus/agent/built-in/my-custom-clone/`
4. Clone NOT found → log error: "Clone 'my-custom-clone' is not installed. Install it with: octopus resource install ..."
5. EngineInitPhase returns `status: "failed"` → workflow blocked
6. ExecutionLifecycle sets execution status to "failed"
