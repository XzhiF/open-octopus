/**
 * Dependency Scanner — VarPool $deps.* 注入扫描
 *
 * 扫描 workspace 的 dependencies/ 目录，
 * 将每个子目录路径注入为 $deps.{name} 变量。
 *
 * 在 Engine 初始化时调用，使工作流可以引用依赖路径。
 */
import { existsSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * 扫描 workspace 的 dependencies/ 目录
 * 返回可直接注入 VarPool 的变量映射 ($deps.{name} → 路径)
 */
export function scanDependencyVars(workspaceDir: string): Record<string, string> {
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
    // Ignore scan errors
  }
  return vars
}

/**
 * 检查指定依赖是否存在
 */
export function hasDependency(workspaceDir: string, name: string): boolean {
  const depPath = join(workspaceDir, "dependencies", name)
  return existsSync(depPath) && statSync(depPath).isDirectory()
}

/**
 * 获取指定依赖的路径
 */
export function getDependencyPath(workspaceDir: string, name: string): string | null {
  const depPath = join(workspaceDir, "dependencies", name)
  if (existsSync(depPath) && statSync(depPath).isDirectory()) {
    return depPath
  }
  return null
}
