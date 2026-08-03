# T4: Web-App UI + Skills Updates

**Status:** done
**Priority:** P1
**Depends on:** T2

## Scope

Wire the new node type into the web-app UI and update core-pack skills documentation.

## Changes

### web-app

#### workflow-flow-viewer.tsx
- Add `dynamic_sub_workflow: SubWorkflowContainerNode` to the `nodeTypes` map

#### workflow-flow-viewer-with-status.tsx
- Add `dynamic_sub_workflow: SubWorkflowContainerNode` to the `nodeTypes` map
- In sub_workflow ref collection: also scan for `dynamic_sub_workflow` nodes with `workflow` field
- In node data construction: set `is_dynamic: true` for `dynamic_sub_workflow` nodes

#### sub-workflow-container-node.tsx
- Extend `SubWorkflowContainerData` interface:
  - `is_dynamic?: boolean` — true when type is dynamic_sub_workflow
  - `generated_workflow?: string` — name of generated workflow (from outputs)
- Add "Dynamic" badge rendering:
  - When `is_dynamic` is true AND no `childNodeIds` loaded:
    - Show amber Badge: "Dynamic"
    - Show text: "⚡ 运行时生成"
  - When `childNodeIds` are loaded: render normally (same as static sub_workflow)

### core-pack

#### skills/octo-workflow-dev/references/node-schema.md
- Add section `10. dynamic_sub_workflow` with field reference table

#### skills/octo-workflow-dev/references/node-patterns.md
- Add dynamic_sub_workflow pattern example

#### skills/octo-workflow-dev/references/composition-rules.md
- Add constraint: generated DAG nodes must be type `agent` only

## Tests

### web-app
- TypeScript compilation: `pnpm build --filter @octopus/web-app` (no type errors)

### core-pack
- Manual: verify node-schema.md includes dynamic_sub_workflow section
- Manual: verify node-patterns.md includes pattern example

## Verification Method

```bash
pnpm build --filter @octopus/web-app
# Manual: check skill files
```
