import fs from "fs"
import path from "path"
import os from "os"
import { parseWorkflow, isOctopusWorkflow, WorkflowRef } from "@octopus/shared"
import type { WorkflowInfo, WorkflowDetail } from "../types/workflow-api"

export class WorkflowService {
  private resolve(pathStr: string): string {
    return pathStr.replace(/^~/, os.homedir())
  }

  private workflowsDir(workspacePath: string): string {
    return path.join(this.resolve(workspacePath), "workflows")
  }

  list(workspacePath: string): WorkflowInfo[] {
    const dir = this.workflowsDir(workspacePath)
    if (!fs.existsSync(dir)) return []

    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map(filename => {
        const filePath = path.join(dir, filename)
        const content = fs.readFileSync(filePath, "utf-8")
        if (!isOctopusWorkflow(content)) return null
        try {
          const parsed = parseWorkflow(content)
          return {
            ref: filename,
            name: parsed.name,
            inputs: parsed.inputs,
            group: "project",
          }
        } catch {
          return null
        }
      })
      .filter((item): item is WorkflowInfo => item !== null)
  }

  get(workspacePath: string, ref: string): WorkflowDetail | undefined {
    const dir = this.workflowsDir(workspacePath)
    const filePath = WorkflowRef.toPath(dir, ref)

    // Try exact path first
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8")
      const parsed = parseWorkflow(content)
      return { ref, content, parsed }
    }

    // Extension fallback: "child-basic" → try "child-basic.yaml", then "child-basic.yml"
    const parsed = WorkflowRef.parse(ref)
    if (!parsed.name.endsWith(".yaml") && !parsed.name.endsWith(".yml")) {
      for (const ext of [".yaml", ".yml"]) {
        const fallbackRef = parsed.group
          ? `${parsed.group}/${parsed.name}${ext}`
          : `${parsed.name}${ext}`
        const fallbackPath = WorkflowRef.toPath(dir, fallbackRef)
        if (fs.existsSync(fallbackPath)) {
          const content = fs.readFileSync(fallbackPath, "utf-8")
          const parsedWf = parseWorkflow(content)
          return { ref: fallbackRef, content, parsed: parsedWf }
        }
      }
    }

    return undefined
  }

  create(workspacePath: string, ref: string, content: string): WorkflowDetail {
    const dir = this.workflowsDir(workspacePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const filePath = WorkflowRef.toPath(dir, ref)
    // Ensure parent directory exists for group/name refs
    const parentDir = path.dirname(filePath)
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true })
    fs.writeFileSync(filePath, content, "utf-8")
    return this.get(workspacePath, ref)!
  }

  update(workspacePath: string, ref: string, content: string): WorkflowDetail | undefined {
    const filePath = WorkflowRef.toPath(this.workflowsDir(workspacePath), ref)
    if (!fs.existsSync(filePath)) return undefined
    fs.writeFileSync(filePath, content, "utf-8")
    return this.get(workspacePath, ref)
  }

  delete(workspacePath: string, ref: string): boolean {
    const filePath = WorkflowRef.toPath(this.workflowsDir(workspacePath), ref)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)
    return true
  }
}