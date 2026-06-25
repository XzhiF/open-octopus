import fs from "fs"
import path from "path"
import os from "os"
import { parseWorkflow, isOctopusWorkflow } from "@octopus/shared"
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
          }
        } catch {
          return null
        }
      })
      .filter((item): item is WorkflowInfo => item !== null)
  }

  get(workspacePath: string, ref: string): WorkflowDetail | undefined {
    const filePath = path.join(this.workflowsDir(workspacePath), ref)
    if (!fs.existsSync(filePath)) return undefined
    const content = fs.readFileSync(filePath, "utf-8")
    const parsed = parseWorkflow(content)
    return { ref, content, parsed }
  }

  create(workspacePath: string, ref: string, content: string): WorkflowDetail {
    const dir = this.workflowsDir(workspacePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, ref), content, "utf-8")
    return this.get(workspacePath, ref)!
  }

  update(workspacePath: string, ref: string, content: string): WorkflowDetail | undefined {
    const filePath = path.join(this.workflowsDir(workspacePath), ref)
    if (!fs.existsSync(filePath)) return undefined
    fs.writeFileSync(filePath, content, "utf-8")
    return this.get(workspacePath, ref)
  }

  delete(workspacePath: string, ref: string): boolean {
    const filePath = path.join(this.workflowsDir(workspacePath), ref)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)
    return true
  }
}