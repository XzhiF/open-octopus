// packages/server/src/services/tasks/workflow-ref-resolver.ts
//
// task-workflow-handoff (ADR-0013): the workflow_ref resolution set.
//
// A task's workflow_ref is VALID iff it resolves against the RESOLUTION SET:
//   ① installed built-in workflow (BuiltInWorkflowService) — ref format `group/name`
//   ② task home `{home}/workflows/{ref}` (bare filename, `.yaml` or `.yml`)
//
// The global `~/.octopus/workflows/` is **NOT** in the resolution set (ADR-0013).
// `copyBuiltInWorkflows` seeds every execution ws with globals at scaffold time,
// but that's a separate concern (runtime hit) — the resolver's semantic role is
// "agent-authored or explicitly installed", which globals don't qualify for.
//
// Three call sites share this resolver:
//   - `updateSpecField(field=workflow_ref)` — fail-fast pre-check on bind (400).
//   - `readyTask` — gate upgrade: non-empty → resolvable (409 missing).
//   - `GET /:id/workflow-ref` — view endpoint returns content + source.
//
// The resolver returns `{ source, content, ref }` on hit, `null` on miss.
// `source` is `"builtin"` or `"task-home"` so the view endpoint can label.

import type { BuiltInWorkflowService } from "../builtin-workflow"
import type { TaskHomeService } from "./task-home-service"

export type WorkflowRefSource = "builtin" | "task-home"

export interface WorkflowRefResolution {
  ref: string
  source: WorkflowRefSource
  content: string
}

export interface WorkflowResolverDeps {
  builtIn: BuiltInWorkflowService | null
  taskHome: TaskHomeService
  taskId: string
}

/** Resolve a workflow_ref against the resolution set. Returns null on miss.
 *
 *  Resolution order:
 *    ① built-in branch (always tried first — explicit installed win). `ref` may
 *      be `group/name` or bare `name`; BuiltInWorkflowService.get handles both.
 *    ② task-home branch — ref is treated as a filename in `{home}/workflows/`.
 *      If ref already has a `.yaml`/`.yml` extension, try it verbatim.
 *      Otherwise try `ref.yaml` then `ref.yml` (covers the common case where
 *      the author says "my-flow" without the extension).
 *
 *  The first hit wins; misses fall through to null. */
export function resolveWorkflowRef(
  ref: string,
  deps: WorkflowResolverDeps,
): WorkflowRefResolution | null {
  if (typeof ref !== "string" || !ref.trim()) return null
  const trimmed = ref.trim()

  // ① built-in branch
  if (deps.builtIn) {
    const detail = deps.builtIn.get(trimmed)
    if (detail) {
      return { ref: detail.ref, source: "builtin", content: detail.content }
    }
  }

  // ② task-home branch
  if (deps.taskId) {
    // Try verbatim if the ref already carries a YAML extension.
    if (trimmed.endsWith(".yaml") || trimmed.endsWith(".yml")) {
      const content = deps.taskHome.readWorkflowFile(deps.taskId, trimmed)
      if (content !== null) {
        return { ref: trimmed, source: "task-home", content }
      }
      return null // explicit .yaml/.yml but not found — don't double-append
    }
    // Otherwise try common extensions.
    for (const ext of [".yaml", ".yml"]) {
      const candidate = trimmed + ext
      const content = deps.taskHome.readWorkflowFile(deps.taskId, candidate)
      if (content !== null) {
        return { ref: candidate, source: "task-home", content }
      }
    }
  }

  return null
}

/** Quick boolean check: can this ref be resolved? Used by ready-gate where the
 *  content is not needed, only existence. */
export function isWorkflowRefResolvable(
  ref: string,
  deps: WorkflowResolverDeps,
): boolean {
  return resolveWorkflowRef(ref, deps) !== null
}
