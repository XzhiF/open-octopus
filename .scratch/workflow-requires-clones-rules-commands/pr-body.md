## Workflow Requires — Commands, Rules & Clones Support

Extend the workflow `requires` system to support 3 new resource types: `commands` (Claude Code commands), `rules` (Claude Code rules), and `clones` (Octopus clone agents). Commands and rules are auto-provisioned like skills/agents. Clones are checked but never provisioned — missing clones hard-fail the workflow with a clear install hint.

### Key Changes
- **Schema**: `requires` now accepts `commands`, `rules`, `clones` string arrays (all optional, backward compatible)
- **Preflight**: Commands checked at `.claude/commands/{name}.md`, rules at `.claude/rules/{name}.md`, clones at `~/.octopus/agent/clones/` + `~/.octopus/agent/built-in/`
- **Provisioner**: Auto-copies command/rule `.md` files from resource registry; exact per-type counts via `byType` return
- **Clone gate**: Step 0 hard-fail before provisioning — missing clone blocks workflow with actionable error
- **SSE enrichment**: Clone install hints propagated to frontend error events

### E2E Verification
| AC | Condition | Status |
|----|-----------|--------|
| AC-1 | Schema accepts commands | PASS |
| AC-2 | Schema accepts rules | PASS |
| AC-3 | Schema accepts clones | PASS |
| AC-4 | Backward compat | PASS |
| AC-5 | Command preflight check | PASS |
| AC-6 | Rule preflight check | PASS |
| AC-7 | Clone preflight (dual path) | PASS |
| AC-8 | Command auto-provisioning | PASS |
| AC-9 | Rule auto-provisioning | PASS |
| AC-10 | Clone hard-fail | PASS |
| AC-11 | Mixed requires (5 types) | PASS |
| AC-12 | Clone error message | PASS |
| AC-13 | Scan-fallback unchanged | PASS |
| AC-14 | byType per-type counts | PASS |
| AC-15 | provisionMissing uses byType | PASS |
| AC-16 | EngineInitResult expanded | PASS |
| AC-17 | Bare catch fixed | PASS |
| AC-18 | cloneErrors in SSE | PASS |

**86 tests, 18/18 ACs PASS**

### Changed Files
```
 packages/cli/src/commands/workflow.ts                             |   8 +-
 packages/engine/src/__tests__/engine-init.test.ts                 | 296 ++++++-
 packages/engine/src/engine-init.ts                                | 101 ++-
 packages/server/src/services/__tests__/resource-preflight.test.ts | 143 +++-
 packages/server/src/services/execution/ExecutionLifecycle.ts      |  10 +-
 packages/shared/src/__tests__/requires-schema.test.ts             | 122 +++
 packages/shared/src/__tests__/resource-provisioner.test.ts        | 319 +++++++
 packages/shared/src/resource/index.ts                             |   3 +-
 packages/shared/src/resource/resource-preflight.ts                |  69 +-
 packages/shared/src/resource/resource-provisioner.ts              |  77 +-
 packages/shared/src/types/workflow.ts                             |   3 +
 11 files changed (workflow-requires specific)
```

<!-- MANUAL-START -->
<!-- MANUAL-END -->
