# Ticket 4: UI — Fix execution-log-viewer grouping for sub-workflow children inside loops

## Status: DONE

## Scope

Fix the `execution-log-viewer.tsx` node grouping logic so sub-workflow child events inside loop iterations are grouped per-iteration instead of merged across all iterations.

## Dependencies

- Ticket 1 (schema — API response carries `parent_node_id` and `iteration_index`)
- Ticket 2 (engine — iteration info propagated through callbacks)

## Files to Change

| File | Change |
|------|--------|
| `packages/web-app/components/workspace/execution-log-viewer.tsx` | Update `nodeGroups` useMemo to include iteration in sub-workflow child group key |

## Implementation Details

### Current logic (lines ~610-620):
```ts
if (e.event === "node_log") {
  const line = e.line ?? e.content ?? ""
  const childNode = extractSubWorkflowChild(line)
  if (childNode) {
    key = `${nodeId}:${childNode}`
    label = `${nodeId}:${childNode}`
  } else {
    key = `${nodeId}:meta`
    label = `${nodeId} (meta)`
  }
}
```

### Updated logic:
```ts
if (e.event === "node_log") {
  const line = e.line ?? e.content ?? ""
  const childNode = extractSubWorkflowChild(line)
  if (childNode) {
    // Include iteration context for sub-workflow children inside loops
    const iterSuffix = e.iteration != null && e.iteration > 0 ? `-iter${e.iteration}` : ""
    key = `${nodeId}:${childNode}${iterSuffix}`
    label = `${nodeId}:${childNode}${iterSuffix}`
  } else {
    key = `${nodeId}:meta`
    label = `${nodeId} (meta)`
  }
}
```

### Also update the `extractSubWorkflowChild` function

Currently only matches `node_start`/`node_end` and `log [id]` patterns. Sub-workflow child events persisted as `bash_log` via SQLite may have different formats. Need to verify the `node_log` event format includes the scoped child node ID.

Actually, looking at the EngineCallbacks.onNodeLog handler (line 158-188), sub-workflow child events are persisted as `agent_events` with `event_type: "bash_log"` and `content: logLine`. The `nodeId` is the scoped ID (e.g., `call-analysis:greet`). When these are returned by the agent-events endpoint, they become events with `event: "bash_log"`, `nodeId: "call-analysis:greet"`.

So the `node_log` events in the UI are actually the parent sub_workflow node's log lines (like `"wf-name:node_start greet (bash)"`), not the child's own events. The child's own events use the scoped nodeId directly.

Wait — re-examining: the `extractSubWorkflowChild` function processes `node_log` events where `nodeId` is the parent sub_workflow node, and the log line contains child info. These are from the parent's `onNodeLog` callbacks that log child activity.

For these parent-level `node_log` events, the `iteration` field may or may not be present depending on whether the parent is inside a loop.

When a sub_workflow node is inside a loop:
- The loop executor calls inner node's `onNodeStart`/`onNodeEnd`/`onNodeLog` with the inner node's ID
- For sub_workflow inner nodes, the sub-workflow executor creates child callbacks that call `this.config.callbacks?.onNodeLog?.(this.node.id, msg)` — where `this.node.id` is the sub_workflow node's ID (which is a loop inner node)
- So the `node_log` event's `nodeId` is the sub_workflow node's ID
- If the sub_workflow is a loop inner node, its JSONL events carry `iteration` info

So the `node_log` events for the parent sub_workflow node (when it's inside a loop) should already carry `iteration` from JSONL. The fix is simply to use `e.iteration` in the grouping key.

## Verification Method

Manual verification:
1. Create a test workflow with loop containing sub-workflow
2. Execute it
3. Open execution detail page
4. Verify sub-workflow children appear in separate iteration groups

## Acceptance Criteria

- [ ] Sub-workflow child events inside a loop are grouped per-iteration (e.g., `call-analysis:prep-iter1`, `call-analysis:prep-iter2`)
- [ ] Sub-workflow child events outside loops remain in a single group (backward compat)
- [ ] Group labels clearly show iteration number when applicable
- [ ] No visual regression for non-nested workflows
