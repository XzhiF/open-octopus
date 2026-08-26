// packages/server/src/services/workflow-presets-service.ts
//
// task-workflow-presets (T3): reads the workflow-presets.yaml catalog from the
// task-author clone directory and serves filtered preset lists.
//
// The catalog lives at: {baseDir}/agent/built-in/task-author/workflow-presets.yaml
// Production: ~/.octopus/agent/built-in/task-author/workflow-presets.yaml
// Tests: inject a temp dir via constructor.
//
// Filter logic (GET /api/workflow-presets?skills_group=a,b):
//   - No param → all presets
//   - With param → presets where skills_group intersects the query + general
//     fallback (empty skills_group matches any query)
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

  /** List presets, optionally filtered by skills_group. Returns the catalog
   *  shape `{ presets: [...] }`. Missing/malformed file → empty presets. */
  list(skillsGroup?: string[]): WorkflowPresetsCatalog {
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

    if (!skillsGroup || skillsGroup.length === 0) {
      return result.data
    }

    // Filter: presets whose skills_group intersects the query + general fallback
    const querySet = new Set(skillsGroup)
    const filtered = result.data.presets.filter((preset) => {
      // General fallback: empty skills_group always matches
      if (preset.skills_group.length === 0) return true
      // Intersection: at least one skill group matches the query
      return preset.skills_group.some((sg) => querySet.has(sg))
    })

    return { presets: filtered }
  }
}
