import fs from "fs"
import path from "path"
import { parseWorkflow, isOctopusWorkflow, resolveGlobalDir } from "@octopus/shared"
import type { ResourceManager } from "@octopus/shared"
import type { WorkflowInfo, WorkflowDetail } from "../types/workflow-api"

export class BuiltInWorkflowService {
  private dirs: string[]
  private resourceManager?: ResourceManager

  constructor(dir?: string, resourceManager?: ResourceManager) {
    this.resourceManager = resourceManager
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

    // 优先从 ResourceManager 获取已安装的工作流
    if (this.resourceManager) {
      try {
        const installed = this.resourceManager.list({ type: "workflow", installed: true })
        for (const entry of installed) {
          if (!entry.installPath) continue
          const yamlPath = path.join(entry.installPath, `${entry.name}.yaml`)
          if (!fs.existsSync(yamlPath)) continue
          const content = fs.readFileSync(yamlPath, "utf-8")
          if (!isOctopusWorkflow(content)) continue
          try {
            const parsed = parseWorkflow(content)
            seen.set(entry.name, {
              ref: `${entry.group}/${entry.name}`,
              name: parsed.name,
              inputs: parsed.inputs,
            })
          } catch {
            // 解析失败，跳过
          }
        }
      } catch {
        // ResourceManager 查询失败，继续目录扫描
      }
    }

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
    // 优先从 ResourceManager 获取
    if (this.resourceManager && ref.includes("/")) {
      const [group, name] = ref.split("/")
      try {
        const entry = this.resourceManager.get("workflow", name)
        if (entry && entry.group === group && entry.installPath) {
          const yamlPath = path.join(entry.installPath, `${name}.yaml`)
          if (fs.existsSync(yamlPath)) {
            const content = fs.readFileSync(yamlPath, "utf-8")
            if (isOctopusWorkflow(content)) {
              try {
                const parsed = parseWorkflow(content)
                return { ref, content, parsed }
              } catch {
                // 解析失败，继续目录扫描
              }
            }
          }
        }
      } catch {
        // ResourceManager 查询失败，继续目录扫描
      }
    }

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
