# Verified Spec: engine_init Virtual Phase + Event Rendering Optimization

## Overview

This feature adds two independent improvements:

1. **engine_init virtual phase**: A runtime-injected initialization phase that runs before workflow execution, handling skills/agents copying and optional git sync
2. **Event rendering truncation**: Frontend optimization to display real event counts while only rendering the latest 100 events per node group

## Feature 1: engine_init Virtual Phase

### Behavior

Before executing any workflow nodes, the server injects a virtual phase with nodeId `__engine_init__` that:

1. **Analyzes workflow YAML** for skills/agents references using `ResourcePreFlight.analyze()`
2. **Copies required resources** from core-pack to workspace using `ResourceProvisioner.provision()`
3. **Optionally syncs git** by pulling latest main branch for all workspace projects with worktrees

### Technical Design

#### Server-side (ExecutionLifecycle.start)

```typescript
// Pseudocode
async start(id: string, inputValues?, syncMainBranch = true) {
  // ... existing setup ...
  
  // NEW: engine_init virtual phase
  const callbacks = this.buildCallbacks(id)
  callbacks.onNodeStart('__engine_init__', 'bash')
  
  try {
    // Step 1: Analyze and copy skills/agents
    const preflight = new ResourcePreFlight()
    const manifest = preflight.analyze(wf.parsed)
    callbacks.onNodeLog('__engine_init__', `Analyzing ${manifest.skills.length} skills, ${manifest.agents.length} agents`)
    
    if (manifest.skills.length > 0 || manifest.agents.length > 0) {
      const check = preflight.check(manifest, this.workspacePath)
      if (check.missing.length > 0) {
        const provisioner = new ResourceProvisioner(getResourceRegistry().get())
        const result = await provisioner.provision(check.missing, this.workspacePath)
        callbacks.onNodeLog('__engine_init__', `Provisioned ${result.provisioned} resources`)
        if (result.failed.length > 0) {
          throw new Error(`Failed to provision: ${result.failed.join(', ')}`)
        }
      }
    }
    
    // Step 2: Optional git sync
    if (syncMainBranch) {
      callbacks.onNodeLog('__engine_init__', 'Syncing main branch for all projects')
      await gitOps.allProjectsAction(this.workspacePath, async (projectPath, projectName) => {
        try {
          const hasWorktree = await gitOps.hasWorktree(projectPath)
          if (hasWorktree) {
            await gitOps.pullMainBranch(projectPath)
            callbacks.onNodeLog('__engine_init__', `✓ ${projectName} synced`)
          }
        } catch (err) {
          // Git sync failure = warn + continue
          callbacks.onNodeLog('__engine_init__', `⚠ ${projectName} sync failed: ${err.message}`)
        }
      })
    }
    
    callbacks.onNodeEnd('__engine_init__', 'completed', durationMs)
  } catch (err) {
    // Skills copy failure = abort workflow
    callbacks.onNodeEnd('__engine_init__', 'failed', durationMs, { error: err.message })
    throw err
  }
  
  // ... existing engine.run() ...
}
```

#### API Contract

**Endpoint**: `POST /api/workspaces/:id/executions/:executionId/start`

**Request body** (extended):
```typescript
{
  inputValues?: Record<string, string>
  syncMainBranch?: boolean  // NEW, default true
}
```

**Response**: Unchanged

#### Frontend UI

**ExecuteNodeDialog** and **CreateNodeDialog** add a Switch control:

```tsx
<div className="flex items-center justify-between rounded-lg border p-3">
  <div className="space-y-0.5">
    <Label htmlFor="sync-main-branch">同步主分支</Label>
    <p className="text-xs text-muted-foreground">
      执行前拉取所有项目的最新主分支代码
    </p>
  </div>
  <Switch
    id="sync-main-branch"
    checked={syncMainBranch}
    onCheckedChange={setChecked}
  />
</div>
```

**Default value**: `true` (checked)

**Form data type** (extended):
```typescript
interface ExecuteNodeFormData {
  inputValues: Record<string, string>
  rollbackOnError: boolean
  syncMainBranch?: boolean  // NEW
}

interface CreateNodeFormData {
  workflowRef: string
  name: string
  rollbackOnError: boolean
  inputValues: Record<string, string>
  syncMainBranch?: boolean  // NEW
}
```

### Failure Handling

| Failure Type | Behavior |
|--------------|----------|
| Skills/agents copy failure | Workflow aborts with `failed` status |
| Git sync failure (single project) | Warning logged, workflow continues |
| Git sync failure (all projects) | Warning logged, workflow continues |

### Event Flow

1. Frontend calls `startExecution(workspaceId, executionId, { inputValues, syncMainBranch })`
2. Server receives request, begins `ExecutionLifecycle.start()`
3. Server fires `onNodeStart('__engine_init__', 'bash')`
4. Server performs skills/agents copy and git sync
5. Server fires `onNodeLog('__engine_init__', ...)` for each step
6. Server fires `onNodeEnd('__engine_init__', status, durationMs)`
7. Server proceeds with normal `engine.run()`
8. Frontend receives SSE events, displays `__engine_init__` as first node in ExecutionLogViewer

### Verification

- [ ] `__engine_init__` node appears in ExecutionLogViewer before workflow nodes
- [ ] Skills/agents are copied to workspace `.claude/skills/` and `.claude/agents/`
- [ ] Git sync logs appear when `syncMainBranch=true`
- [ ] Git sync logs are absent when `syncMainBranch=false`
- [ ] Workflow aborts when skills copy fails
- [ ] Workflow continues when git sync fails (with warning)

## Feature 2: Event Rendering Truncation

### Behavior

In `ExecutionLogViewer`, each node group displays the **real event count** in the header but only renders the **latest 100 events** when expanded.

### Technical Design

#### ExecutionLogViewer Changes

```tsx
// Before
{group.events.map((entry, i) => (
  <ExpandableRow key={`${key}-${i}`} entry={entry} />
))}

// After
const MAX_RENDERED_EVENTS = 100
const eventsToRender = group.events.length > MAX_RENDERED_EVENTS
  ? group.events.slice(-MAX_RENDERED_EVENTS)
  : group.events

{eventsToRender.map((entry, i) => (
  <ExpandableRow key={`${key}-${i}`} entry={entry} />
))}
```

#### Header Display

The header already shows `group.events.length` (real count), so no change needed:

```tsx
<span className="text-muted-foreground/40 ml-auto">
  {group.events.length} events  // Already shows real count
</span>
```

### Constraints

- **Pure frontend**: Server continues to push all events via SSE/polling
- **No virtual list**: Simple `slice(-100)` truncation, not react-virtuoso
- **No "load more"**: Users see only the latest 100 events
- **Backward compatible**: Nodes with ≤100 events render all events

### Verification

- [ ] Node with 200+ events shows real count (e.g., "237 events")
- [ ] Expanded node renders only 100 events
- [ ] Node with 50 events shows "50 events" and renders all 50
- [ ] Oldest events are truncated, newest are shown

## Scope Boundaries

### In Scope

- engine_init virtual phase implementation
- Skills/agents copying using existing ResourcePreFlight + ResourceProvisioner
- Optional git sync using existing gitOps
- UI Switch controls in ExecuteNodeDialog and CreateNodeDialog
- API parameter `syncMainBranch` in start endpoint
- Event rendering truncation in ExecutionLogViewer
- Unit tests for engine_init logic and truncation logic

### Out of Scope

- YAML schema changes (engine_init is NOT a YAML node)
- New SSE event types (reuse existing node_start/node_log/node_end)
- Server-side event truncation
- "Load more" functionality for truncated events
- Virtual list implementation (react-virtuoso)
- Integration tests (SSE testing requires full server environment)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| engine_init completes before frontend polling | Frontend fetches events on status transition to "running", so init events are captured |
| Git sync timeout blocks workflow | Use existing 30s timeout per project, failures are non-blocking |
| ResourceProvisioner fails mid-copy | Treat as fatal error, abort workflow |
| Large event counts (>1000) cause memory issues | Server already streams events; frontend truncation is display-only |

## Dependencies

- `ResourcePreFlight` from `@octopus/shared` (exists)
- `ResourceProvisioner` from `packages/server/src/services/resource-provisioner` (exists)
- `gitOps.allProjectsAction` from `packages/server/src/services/git-ops` (exists)
- `Switch` component from `@/components/ui/switch` (exists)

## Acceptance Criteria

From the brief:

1. ✅ ExecuteNodeDialog and CreateNodeDialog show "同步主分支" Switch, default on
2. ✅ engine_init node appears before workflow nodes in ExecutionLogViewer
3. ✅ engine_init logs show skills copy and git sync steps
4. ✅ Unchecking Switch skips git sync in engine_init
5. ✅ Skills copy failure aborts workflow with error
6. ✅ Git sync failure shows warning, workflow continues
7. ✅ Node with 200+ events shows real count, renders only 100
8. ✅ Node with ≤100 events renders all events
