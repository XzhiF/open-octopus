/**
 * Workflow Discovery — 工作流资源发现
 *
 * 扫描工作流 YAML 文件，提取资源引用（skills/agents 依赖），
 * 用于 install 时自动解析和安装依赖。
 */
import { existsSync, readdirSync, readFileSync } from "fs"
import { join } from "path"

export interface WorkflowResourceRef {
  /** 工作流文件名（不含扩展名） */
  name: string
  /** 工作流文件路径 */
  path: string
  /** 引用的 skill 名称 */
  skills: string[]
  /** 引用的 agent role */
  agents: string[]
}

export interface ResourceReference {
  type: "skill" | "agent" | "workflow" | "source"
  name: string
}

export interface ValidationResult {
  valid: ResourceReference[]
  missing: ResourceReference[]
}

export interface InstalledWorkflow {
  name: string
  path: string
  references: ResourceReference[]
}

/**
 * WorkflowDiscovery — 工作流资源引用解析 + 验证
 */
export class WorkflowDiscovery {
  /**
   * 解析工作流定义中的资源引用
   * 引用格式: "type:name" (如 "skill:brainstorming", "agent:code-reviewer")
   */
  parseReferences(workflowDef: { name: string; references?: string[] }): ResourceReference[] {
    if (!workflowDef.references) return []
    return workflowDef.references.map(ref => {
      const [type, name] = ref.split(":")
      return { type: type as ResourceReference["type"], name }
    })
  }

  /**
   * 验证资源引用是否都已在 registry 中注册
   */
  validateReferences(
    refs: ResourceReference[],
    registry: Record<string, { manifest: { name: string; type: string } }>,
  ): ValidationResult {
    const registryNames = new Set(
      Object.values(registry).map(e => `${e.manifest.type}:${e.manifest.name}`),
    )
    const valid: ResourceReference[] = []
    const missing: ResourceReference[] = []
    for (const ref of refs) {
      if (registryNames.has(`${ref.type}:${ref.name}`)) {
        valid.push(ref)
      } else {
        missing.push(ref)
      }
    }
    return { valid, missing }
  }

  /**
   * 扫描已安装的工作流
   * PRD §6.3: workflow 安装目标为 .octopus/workflows/
   * 同时兼容旧路径 .claude/workflows/（向后兼容）
   */
  discoverInstalled(workspaceDir: string): InstalledWorkflow[] {
    const candidates = [
      join(workspaceDir, ".octopus", "workflows"),
      join(workspaceDir, ".claude", "workflows"),
    ]
    const workflows: InstalledWorkflow[] = []
    for (const dir of candidates) {
      if (!existsSync(dir)) continue
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const yamlPath = join(dir, entry.name, "workflow.yaml")
            if (existsSync(yamlPath)) {
              workflows.push({
                name: entry.name,
                path: yamlPath,
                references: [],
              })
            }
          } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
            // Flat file workflow (e.g. my-flow.yaml)
            workflows.push({
              name: entry.name.replace(/\.(yaml|yml)$/, ""),
              path: join(dir, entry.name),
              references: [],
            })
          }
        }
      } catch {
        // Ignore errors
      }
    }
    return workflows
  }
}

/**
 * 从工作流目录中发现所有工作流及其资源引用
 */
export function discoverWorkflows(workflowDir: string): WorkflowResourceRef[] {
  if (!existsSync(workflowDir)) return []

  const results: WorkflowResourceRef[] = []

  try {
    for (const entry of readdirSync(workflowDir)) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue

      const filePath = join(workflowDir, entry)
      const name = entry.replace(/\.(yaml|yml)$/, "")
      const content = readFileSync(filePath, "utf-8")

      // Extract skill references from skills: field
      const skills = extractFieldValues(content, "skills")
      // Extract agent references from agent_file: and role: fields
      const agents = [
        ...extractFieldValues(content, "agent_file"),
        ...extractFieldValues(content, "role"),
      ]

      results.push({ name, path: filePath, skills, agents })
    }
  } catch {
    // Ignore errors
  }

  return results
}

/**
 * 从 YAML 内容中提取指定字段的值（简单正则匹配，避免完整 YAML 解析开销）
 */
function extractFieldValues(content: string, field: string): string[] {
  const values: string[] = []
  // Match patterns like:
  //   skills: [skill-a, skill-b]
  //   skills:
  //     - skill-a
  //   agent_file: path/to/file.md
  //   role: reviewer

  // Inline array: field: [a, b, c]
  const inlineMatch = content.match(new RegExp(`${field}:\\s*\\[([^\\]]+)\\]`, "g"))
  if (inlineMatch) {
    for (const m of inlineMatch) {
      const arr = m.replace(`${field}:`, "").replace(/[\[\]]/g, "").split(",").map(s => s.trim()).filter(Boolean)
      values.push(...arr)
    }
  }

  // List items: field:\n  - value
  const listRegex = new RegExp(`${field}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "g")
  let listMatch: RegExpExecArray | null
  while ((listMatch = listRegex.exec(content)) !== null) {
    const items = listMatch[1]
      .split("\n")
      .map(line => line.trim().replace(/^-\s+/, ""))
      .filter(Boolean)
    values.push(...items)
  }

  // Scalar: field: value (single line, no array/list)
  const scalarRegex = new RegExp(`${field}:\\s*(.+)$`, "gm")
  let scalarMatch: RegExpExecArray | null
  while ((scalarMatch = scalarRegex.exec(content)) !== null) {
    const val = scalarMatch[1].trim()
    if (val && !val.startsWith("[") && !val.startsWith("{")) {
      values.push(val)
    }
  }

  // Deduplicate
  return [...new Set(values)]
}
