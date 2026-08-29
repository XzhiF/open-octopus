# T6 — web-app: WorkflowBox + binding dialog

## Status: done

## Depends on: T1 (shared types), T3 (preset API)

## Scope

### 6.1 New component: `WorkflowBox`

Location: `packages/web-app/components/tasks/authoring/workflow-box.tsx`

Props:
```ts
interface WorkflowBoxProps {
  task: Task
  onMutated: () => void
}
```

Renders:
- Current bound workflow_ref (or "未绑定" placeholder)
- Input values summary (key chips showing source: goal/ac/manual)
- Button to open binding dialog
- Reads presets via `GET /api/workflow-presets?skills_group=...`

### 6.2 Binding dialog

Opens from WorkflowBox button. Contains:
- **Search**: filter built-in (27+) + task-home workflows by name
- **Preset list**: left panel, presets from API (filtered by task.skill_groups + general fallback)
- **Detail panel**: right panel showing selected workflow/preset
  - YAML preview (read-only, from GET /api/workflows/built-in/:ref)
  - Inputs form: each input field with placeholder hints (${goal}, ${ac}, or manual)
- **Save**: PUT /api/tasks/:id with `{ workflow_ref, task_spec: { ...existing, input_values } }` + If-Match

### 6.3 Placement

- **v3 AuthoringWorkspace**: Insert between `<GoalAcCard>` and `<OutputViewer>` (line 441 of authoring-workspace.tsx)
- **v2 SpecPanel**: Add at the bottom of the spec editing area (before save button)

### 6.4 API client

New file: `packages/web-app/lib/workflow-presets-api.ts`
```ts
export interface WorkflowPreset {
  name: string
  skills_group: string[]
  workflow: string
  inputs: Record<string, string>
}

export async function listWorkflowPresets(skillsGroup?: string[]): Promise<{ presets: WorkflowPreset[] }>

export async function getBuiltInWorkflowDetail(ref: string): Promise<{ ref: string; content: string; parsed: any }>
```

### 6.5 Enqueue checklist update

Add `workflow_ref` status line to the enqueue checklist in AuthoringWorkspace (line 448+):
```tsx
<span className="flex items-center gap-1">
  <span className={workflowRefBound ? "text-emerald-600" : "text-amber-500"}>
    {workflowRefBound ? "✅" : "⏳"}
  </span> workflow
</span>
```

## Tests

- `packages/web-app/components/tasks/authoring/__tests__/workflow-box.test.tsx`:
  - Renders "未绑定" when no workflow_ref
  - Renders bound workflow_ref name
  - Opens binding dialog on button click
  - Saves workflow_ref + input_values via updateTask
- `packages/web-app/lib/__tests__/workflow-presets-api.test.ts`:
  - listWorkflowPresets calls correct URL
  - getBuiltInWorkflowDetail calls correct URL

## Verification

```bash
pnpm --filter @octopus/web-app test -- workflow
pnpm --filter @octopus/web-app exec tsc --noEmit
```
