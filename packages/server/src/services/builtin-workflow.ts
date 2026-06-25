import fs from "fs"
import path from "path"
import { parseWorkflow, isOctopusWorkflow, resolveGlobalDir } from "@octopus/shared"
import type { WorkflowInfo, WorkflowDetail } from "../types/workflow-api"

export class BuiltInWorkflowService {
  private dirs: string[]

  constructor(dir?: string) {
    const globalDir = dir ?? path.join(resolveGlobalDir(), "workflows")
    this.dirs = []

    // 仅在默认模式（非测试/非自定义 dir）下，额外读取 core-pack 源码目录
    if (!dir) {
      try {
        const corePack = require("@octopus/core-pack")
        const presetsWorkflowsDir = path.join(corePack.presetsDir, "workflows")
        if (
          presetsWorkflowsDir !== globalDir &&
          fs.existsSync(presetsWorkflowsDir)
        ) {
          this.dirs.push(presetsWorkflowsDir)
        }
      } catch {
        // core-pack 不可用（生产环境），跳过
      }
    }

    // 全局目录（或自定义目录）作为兜底
    this.dirs.push(globalDir)
  }

  list(): WorkflowInfo[] {
    const seen = new Map<string, WorkflowInfo>()

    for (const dir of this.dirs) {
      if (!fs.existsSync(dir)) continue

      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))

      for (const filename of files) {
        // 后遍历的目录优先级更高（覆盖同名文件）
        if (seen.has(filename)) continue

        const filePath = path.join(dir, filename)
        const content = fs.readFileSync(filePath, "utf-8")
        if (!isOctopusWorkflow(content)) continue
        try {
          const parsed = parseWorkflow(content)
          seen.set(filename, {
            ref: filename,
            name: parsed.name,
            inputs: parsed.inputs,
          })
        } catch {
          // 解析失败，跳过
        }
      }
    }

    return [...seen.values()]
  }

  get(ref: string): WorkflowDetail | null {
    for (const dir of this.dirs) {
      const filePath = path.join(dir, ref)
      if (!fs.existsSync(filePath)) continue
      const content = fs.readFileSync(filePath, "utf-8")
      if (!isOctopusWorkflow(content)) continue
      try {
        const parsed = parseWorkflow(content)
        return { ref, content, parsed }
      } catch {
        continue
      }
    }
    return null
  }
}
