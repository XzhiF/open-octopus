// packages/server/src/services/workflow-presets-service.ts
//
// task-workflow-presets (T3) → binding-catalog redesign (2026-09-06): reads
// the workflow-presets.yaml BINDING CATALOG from the task-author clone
// directory and serves it verbatim (the skills_group query is retired —
// catalog == everything the binding form offers).
//
// The catalog lives at: {baseDir}/agent/built-in/task-author/workflow-presets.yaml
// Production: ~/.octopus/agent/built-in/task-author/workflow-presets.yaml
// Tests: inject a temp dir via constructor.
//
// Error handling: missing file → empty; malformed YAML → empty + warn (never crash).

import fs from "fs"
import path from "path"
import os from "os"
import yaml from "js-yaml"
import {
  workflowPresetsCatalogSchema,
  type WorkflowPresetsCatalog,
} from "@octopus/shared"

const CATALOG_RELATIVE_PATH = path.join(
  "agent", "built-in", "task-author", "workflow-presets.yaml",
)

export class WorkflowPresetsService {
  private readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".octopus")
  }

  /** The binding catalog as authored, `{ presets: [...] }` shape. Missing or
   *  malformed file → empty presets (never a throw — the binding form degrades
   *  to an empty catalog, the enqueue gate is unaffected). */
  list(): WorkflowPresetsCatalog {
    const catalogPath = path.join(this.baseDir, CATALOG_RELATIVE_PATH)
    if (!fs.existsSync(catalogPath)) {
      return { presets: [] }
    }

    let raw: string
    try {
      raw = fs.readFileSync(catalogPath, "utf-8")
    } catch {
      return { presets: [] }
    }

    if (!raw.trim()) return { presets: [] }

    let parsed: unknown
    try {
      parsed = yaml.load(raw)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[workflow-presets] failed to parse catalog YAML (non-fatal):",
        err instanceof Error ? err.message : String(err),
      )
      return { presets: [] }
    }

    const result = workflowPresetsCatalogSchema.safeParse(parsed)
    if (!result.success) {
      // eslint-disable-next-line no-console
      console.warn(
        "[workflow-presets] catalog failed schema validation (non-fatal):",
        result.error.message,
      )
      return { presets: [] }
    }

    return result.data
  }
}
