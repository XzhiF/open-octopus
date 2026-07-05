/**
 * Activation Hooks — 三种集成 Hook
 *
 * 安装资源后自动执行集成操作：
 * 1. 目录扫描 — 扫描安装目录，注册到 registry
 * 2. 变量注入 — 向 VarPool 注入 $deps.* 变量
 * 3. Prompt 注入 — 向 agent prompt 注入发现信息
 */
import { existsSync, readdirSync, statSync } from "fs"
import { join } from "path"
import type { ResourceManifest } from "./schema"

/**
 * 扫描目录中的资源文件，返回发现的资源列表
 */
export function scanInstalledResources(installDir: string): {
  name: string
  type: "skill" | "agent" | "workflow" | "source"
  path: string
}[] {
  const results: { name: string; type: "skill" | "agent" | "workflow" | "source"; path: string }[] = []

  if (!existsSync(installDir)) return results

  try {
    for (const entry of readdirSync(installDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const fullPath = join(installDir, entry.name)

      // Detect type by structure
      const type = detectResourceType(fullPath)
      if (type) {
        results.push({ name: entry.name, type, path: fullPath })
      }
    }
  } catch {
    // Ignore scan errors
  }

  return results
}

/**
 * 检测目录中的资源类型
 */
function detectResourceType(dir: string): "skill" | "agent" | "workflow" | "source" | null {
  // Skill: contains SKILL.md
  if (existsSync(join(dir, "SKILL.md"))) return "skill"

  // Agent: contains .md files with role definitions
  try {
    const files = readdirSync(dir)
    if (files.some(f => f.endsWith(".md") && !f.startsWith("README"))) return "agent"
  } catch {
    // ignore
  }

  // Workflow: contains .yaml files
  try {
    const files = readdirSync(dir)
    if (files.some(f => f.endsWith(".yaml") || f.endsWith(".yml"))) return "workflow"
  } catch {
    // ignore
  }

  // Source: default for any directory with package.json or meaningful content
  if (existsSync(join(dir, "package.json"))) return "source"

  return null
}

/**
 * 生成 VarPool 注入变量
 * 扫描 dependencies/ 目录，为每个子目录生成 deps.xxx 变量
 */
export function generateDepsVars(workspaceDir: string): Record<string, string> {
  const depsDir = join(workspaceDir, "dependencies")
  if (!existsSync(depsDir)) return {}

  const vars: Record<string, string> = {}
  try {
    for (const entry of readdirSync(depsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        vars[`deps.${entry.name}`] = join(depsDir, entry.name)
      }
    }
  } catch {
    // Ignore
  }
  return vars
}

/**
 * 生成 Prompt 注入片段
 * 列出已安装的资源，供 agent 参考
 */
export function generatePromptSegment(
  manifests: ResourceManifest[],
): string | null {
  if (manifests.length === 0) return null

  const lines = ["## Installed Resources", ""]
  const byType = new Map<string, ResourceManifest[]>()
  for (const m of manifests) {
    if (!byType.has(m.type)) byType.set(m.type, [])
    byType.get(m.type)!.push(m)
  }

  for (const [type, items] of byType) {
    lines.push(`### ${type}s`)
    for (const item of items) {
      lines.push(`- **${item.name}** v${item.version} (from ${item.source.protocol}:${item.source.location})`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
