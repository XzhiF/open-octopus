# T7: OrchestratorService Decomposition — Redistribute Methods, Delete Class

**Status:** pending
**Depends on:** T5, T6
**Blocks:** T9

## Scope

Decompose OrchestratorService by redistributing its useful methods to clone-specific modules and deleting the class entirely.

## Changes

### 7.1 Methods to Redistribute

| Method | Destination | Rationale |
|--------|-------------|-----------|
| `analyzeWorkspaceForArchive()` | `packages/server/src/services/archive/archive-analysis-service.ts` (NEW) | Archive clone owns analysis pipeline |
| `callArchiveLLM()` | `packages/server/src/services/agent/clone-runtime.ts` as utility | Shared LLM call utility |
| `executeTask()` | `packages/server/src/services/resource/resource-agent-service.ts` (existing, extend) | Resource operations agent |
| `selectAndInstallAgents()` | `packages/server/src/services/resource/resource-agent-service.ts` (existing, extend) | Resource agent selection |

### 7.2 Methods to Delete

All intent classification and workflow selection methods are removed — the LLM replaces them:

- `classifyIntent()`
- `selectWorkflow()`
- `scoreWorkflowMatch()` (private)
- `generateWorkflow()`
- `buildWorkflowNodes()` (private)
- `organizeInputs()`
- `orchestrate()`
- `buildSummary()` (private)

### 7.3 Call Site Updates

1. **`chat-routes.ts`**: Remove `runOrchestration()` call. Replace with CloneRuntime chat flow.
2. **`task-routes.ts`**: Update to use new resource-agent-service methods.
3. **Archive routes**: Update to use new archive-analysis-service.
4. **Swarm executor**: Update `selectAndInstallAgents` import path (engine package may import from server).
5. **Tests**: Update all test files that import OrchestratorService.

### 7.4 Deletion Sequence

1. First: Create new service files with redistributed methods
2. Second: Update all call sites to use new services
3. Third: Delete `orchestrator-service.ts`
4. Fourth: Remove imports from `index.ts` and test files
5. Fifth: Verify no residual references via `grep -r "orchestrator-service" packages/`

### 7.5 Archive Analysis Service

```typescript
// packages/server/src/services/archive/archive-analysis-service.ts
export class ArchiveAnalysisService {
  analyzeWorkspaceForArchive(workspaceId: string, emitter: StepEmitter): Promise<ArchivePreview>
  private callArchiveLLM(prompt: string, systemPrompt: string): Promise<string>
  private emptyPreview(reason: string): ArchivePreview
}
```

### 7.6 Parse Functions

Move archive parsing helpers (`parseReport`, `parseExperiences`, `parseSkills`, `toStringArray`, `normalizeCostEfficiency`) to the archive analysis service.

## Verification

1. `grep -r "OrchestratorService" packages/` returns zero results
2. `grep -r "orchestrator-service" packages/` returns zero results
3. `grep -r "classifyIntent" packages/` returns zero results
4. `grep -r "selectWorkflow" packages/` returns zero results
5. `grep -r "generateWorkflow" packages/` returns zero results
6. Archive analysis still works (existing tests pass)
7. Resource agent still works (existing tests pass)
8. `pnpm build` passes
9. `pnpm test -- packages/server` passes
