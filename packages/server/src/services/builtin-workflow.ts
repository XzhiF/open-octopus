import fs from "fs"
import path from "path"
import { parseWorkflow, isOctopusWorkflow } from "@octopus/shared"
import type { ResourceManager } from "@octopus/shared"
import type { WorkflowInfo, WorkflowDetail } from "../types/workflow-api"

/**
 * BuiltInWorkflowService — queries ResourceManager for installed workflows.
 * Only reads from ~/.octopus/resources/installed/ via ResourceManager.
 * No directory scanning.
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
      const yamlPath = this.findYamlFile(entry.installPath)
      if (!yamlPath) continue

      try {
        const content = fs.readFileSync(yamlPath, "utf-8")
        if (!isOctopusWorkflow(content)) continue
        const parsed = parseWorkflow(content)
        results.push({
          ref: `${entry.group}/${entry.name}`,
          name: parsed.name,
          inputs: parsed.inputs,
          group: entry.group,
        })
      } catch {
        // Parse failure, skip
      }
    }

    return results
  }

  get(ref: string): WorkflowDetail | null {
    // ref format: "group/name" or "name"
    const parts = ref.split("/")
    const name = parts.length > 1 ? parts[1] : parts[0]
    const group = parts.length > 1 ? parts[0] : undefined

    const entry = this.resourceManager.get("workflow", name)
    if (!entry || !entry.installed || !entry.installPath) {
      return null
    }

    // If group specified, must match
    if (group && entry.group !== group) {
      return null
    }

    const yamlPath = this.findYamlFile(entry.installPath)
    if (!yamlPath) return null

    try {
      const content = fs.readFileSync(yamlPath, "utf-8")
      if (!isOctopusWorkflow(content)) return null
      const parsed = parseWorkflow(content)
      return {
        ref: `${entry.group}/${entry.name}`,
        content,
        parsed,
      }
    } catch {
      return null
    }
  }

  /** Find .yaml or .yml file in install directory */
  private findYamlFile(dir: string): string | null {
    if (!fs.existsSync(dir)) return null
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
    if (files.length === 0) return null
    return path.join(dir, files[0])
  }
}
