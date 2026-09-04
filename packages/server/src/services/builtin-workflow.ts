import fs from "fs"
import path from "path"
import { parseWorkflow, isOctopusWorkflow, WorkflowRef } from "@octopus/shared"
import type { WorkflowDef } from "@octopus/shared"
import type { ResourceManager } from "@octopus/shared"
import type { WorkflowInfo, WorkflowDetail } from "../types/workflow-api"

/**
 * Parsed-yaml cache (ticket 10 — builtin-workflow list/detail caching).
 *
 * Module-level because `BuiltInWorkflowService` is instantiated per-request /
 * per-call-site (routes/builtin-workflow.ts, routes/workflow.ts, execution
 * registry, …) — an instance Map would never survive a second HTTP request.
 *
 * Two-tier, invalidation granularity to a single file:
 *  - `dirScanCache`: install dir → resolved yaml path, validated by the DIRECTORY
 *    mtime (catches yaml add/remove/rename without touching readdir ordering).
 *  - `fileCache`: yaml path → { content, parsed }, validated by the FILE
 *    mtimeMs+size. An in-place content edit changes the file mtime but NOT the
 *    directory mtime, so file-level validation is what makes rewrites visible.
 *
 * `list()` and `get()` read through the same `loadWorkflowFile()` so one parse
 * serves both. `statSync` failure (nonexistent path — e.g. fake paths under test
 * mocks) bypasses the cache and reads directly, preserving pre-cache behavior.
 * A failed skip (non-octopus yaml / broken yaml) is cached too — the skip
 * decision itself is derived from content.
 */

interface CachedWorkflowFile {
  /** file stat at cache time */
  mtimeMs: number
  size: number
  content: string
  /** null → not an octopus workflow OR parse failure (both mean "skip") */
  parsed: WorkflowDef | null
}

const fileCache = new Map<string, CachedWorkflowFile>()
const dirScanCache = new Map<string, { dirMtimeMs: number; yamlPath: string | null }>()

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

/**
 * Read + parse a workflow yaml through the cache.
 * Returns null when the file is missing, is not an octopus workflow, or fails
 * to parse — matching the original per-file `catch { /* skip *\/ }` semantics.
 */
function loadWorkflowFile(yamlPath: string): CachedWorkflowFile | null {
  const st = statOrNull(yamlPath)
  if (st) {
    const hit = fileCache.get(yamlPath)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return hit.parsed ? hit : null
    }
  }

  let content: string
  try {
    content = fs.readFileSync(yamlPath, "utf-8")
  } catch {
    return null
  }

  let parsed: WorkflowDef | null = null
  try {
    if (isOctopusWorkflow(content)) parsed = parseWorkflow(content)
  } catch {
    parsed = null
  }

  const entry: CachedWorkflowFile = {
    mtimeMs: st?.mtimeMs ?? -1,
    size: st?.size ?? -1,
    content,
    parsed,
  }
  if (st) fileCache.set(yamlPath, entry)
  return parsed ? entry : null
}

/**
 * Find the .yaml/.yml file in an install directory (first match, as before),
 * caching the readdir result until the directory mtime changes.
 */
function findYamlFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null

  const st = statOrNull(dir)
  if (st) {
    const hit = dirScanCache.get(dir)
    if (hit && hit.dirMtimeMs === st.mtimeMs) return hit.yamlPath
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
  const yamlPath = files.length === 0 ? null : path.join(dir, files[0])

  if (st) dirScanCache.set(dir, { dirMtimeMs: st.mtimeMs, yamlPath })
  return yamlPath
}

/**
 * BuiltInWorkflowService — queries ResourceManager for installed workflows.
 * Only reads from ~/.octopus/resources/installed/ via ResourceManager.
 * No directory scanning.
 *
 * fs read/parse results are memoized in a module-level mtime-validated cache
 * (see fileCache/dirScanCache) shared by every instance — list()/get() hit it
 * together, so cold requests parse each yaml at most once.
 */
export class BuiltInWorkflowService {
  private resourceManager: ResourceManager

  constructor(resourceManager: ResourceManager) {
    this.resourceManager = resourceManager
  }

  list(): WorkflowInfo[] {
    const results: WorkflowInfo[] = []
    const response = this.resourceManager.list({ type: "workflow", installed: true })
    const installed = response.resources ?? []

    for (const entry of installed) {
      if (!entry.installPath) continue
      const yamlPath = findYamlFile(entry.installPath)
      if (!yamlPath) continue

      const loaded = loadWorkflowFile(yamlPath)
      if (!loaded?.parsed) continue
      results.push({
        ref: `${entry.group}/${entry.name}`,
        name: loaded.parsed.name,
        inputs: loaded.parsed.inputs,
        group: entry.group,
      })
    }

    return results
  }

  get(ref: string): WorkflowDetail | null {
    // ref format: "group/name" or "name"
    const { name, group } = WorkflowRef.parse(ref)

    const entry = this.resourceManager.get("workflow", name)
    if (!entry || !entry.installed || !entry.installPath) {
      return null
    }

    // If group specified, must match
    if (group && entry.group !== group) {
      return null
    }

    const yamlPath = findYamlFile(entry.installPath)
    if (!yamlPath) return null

    const loaded = loadWorkflowFile(yamlPath)
    if (!loaded?.parsed) return null
    return {
      ref: `${entry.group}/${entry.name}`,
      content: loaded.content,
      parsed: loaded.parsed,
    }
  }
}
