/**
 * Scan Path Provider — 统一扫描路径解析
 *
 * 为 CLI / Engine / Server 提供一致的资源扫描路径，
 * 消除各层各自硬编码路径的不一致问题。
 *
 * 优先级（从高到低）:
 *   1. workspace .claude/{typeDir}/
 *   2. org-scoped ~/.octopus/orgs/{org}/{typeDir}/
 *   3. shared ~/.octopus/{typeDir}/
 *   4. dependency bundles (agency-agents-zh, core-pack, etc.)
 */
import { existsSync, readdirSync } from "fs"
import { join } from "path"

// Type → directory name mapping
const TYPE_DIRS: Record<string, string> = {
  skill: "skills",
  agent: "agents",
  workflow: "workflows",
  source: "sources",
}

function typeDir(type: string): string {
  return TYPE_DIRS[type] ?? type + "s"
}

export interface ScanPathOptions {
  /** 资源类型：skill / agent / workflow / source */
  resourceType: "skill" | "agent" | "workflow" | "source"
}

export interface ScanContext {
  /** 当前工作目录（workspace 根） */
  cwd: string
  /** 组织名称（用于 org-scoped 路径） */
  org?: string
  /** 是否包含 dependencies/ 下的第三方资源 */
  includeResources?: boolean
  /** 额外自定义扫描路径 */
  extraPaths?: string[]
}

/**
 * 获取指定资源类型的扫描路径列表（按优先级从高到低排序）
 * 仅返回已存在的目录
 */
export function getScanPaths(
  opts: ScanPathOptions,
  ctx: ScanContext,
): string[] {
  const paths: string[] = []
  const dir = typeDir(opts.resourceType)

  // 1. Workspace level (highest priority): .claude/{typeDir}/
  paths.push(join(ctx.cwd, ".claude", dir))

  // 2. Org level: ~/.octopus/orgs/{org}/{typeDir}/
  const home = process.env.HOME || process.env.USERPROFILE || ""
  if (home && ctx.org) {
    paths.push(join(home, ".octopus", "orgs", ctx.org, dir))
  }

  // 3. Global level: ~/.octopus/{typeDir}/
  if (home) {
    paths.push(join(home, ".octopus", dir))
  }

  // 4. Dependencies directory (agents + includeResources)
  if (ctx.includeResources || opts.resourceType === "agent") {
    const depsDir = join(ctx.cwd, "dependencies")
    if (existsSync(depsDir)) {
      try {
        for (const entry of readdirSync(depsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            // Look for agents/ subdirectory in dependency
            const agentsSub = join(depsDir, entry.name, "agents")
            if (existsSync(agentsSub)) paths.push(agentsSub)
            // agency-agents-zh root is itself an agents directory
            if (entry.name === "agency-agents-zh") {
              paths.push(join(depsDir, entry.name))
            }
          }
        }
      } catch {
        // Ignore readdir errors
      }
    }
  }

  // 5. Extra custom paths
  if (ctx.extraPaths) {
    for (const p of ctx.extraPaths) {
      paths.push(p)
    }
  }

  // Filter: only return existing directories
  return paths.filter(p => existsSync(p))
}

/**
 * Alias for getScanPaths (convenience)
 */
export function getResourceScanPaths(
  type: "skill" | "agent" | "workflow",
  opts: { cwd: string; org?: string; includeResources: boolean },
): string[] {
  return getScanPaths({ resourceType: type }, opts)
}

/**
 * 获取所有资源类型的扫描路径（便捷方法）
 */
export function getAllScanPaths(ctx: ScanContext): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const type of ["skill", "agent", "workflow", "source"] as const) {
    result[type] = getScanPaths({ resourceType: type }, ctx)
  }
  return result
}

/**
 * 从 dependencies/ 目录扫描 $deps.* 变量
 * 用于 VarPool 注入，使工作流可以引用 $deps.xxx 路径
 */
export function getResourceVars(workspaceDir: string): Record<string, string> {
  const depsDir = join(workspaceDir, "dependencies")
  if (!existsSync(depsDir)) return {}
  const result: Record<string, string> = {}
  try {
    for (const entry of readdirSync(depsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        result[`deps.${entry.name}`] = join(depsDir, entry.name)
      }
    }
  } catch {
    // Ignore errors
  }
  return result
}

/**
 * 获取资源类型的 prompt 注入片段
 * Phase 1: 返回 null，完整实现需要 SkillLoader 集成
 */
export function getResourcePromptSegment(
  _type: "skill",
  _workspaceDir: string,
): string | null {
  return null
}
