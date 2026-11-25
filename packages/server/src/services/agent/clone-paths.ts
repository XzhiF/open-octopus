// packages/server/src/services/agent/clone-paths.ts
//
// 分身文件的路径守卫与只读判定。从 routes/agent/clone-files.ts 抽出来，
// 供 clone-dev 验证脚本复用同一份实现（不再复制一份判定逻辑）。

import path from "node:path"
import { getAgentDir, getAgentSkillsDir } from "./paths"
import { resolveCloneHomeDir } from "./clone-resolver"

/** 虚拟机继承路径 → 真实路径；越界返回 null。 */
export function resolveCloneFilePath(name: string, filePath: string): string | null {
  if (filePath.startsWith("__inherited__/skills/")) {
    const relative = filePath.replace("__inherited__/skills/", "")
    const skillsDir = getAgentSkillsDir()
    const targetPath = path.join(skillsDir, relative)
    return targetPath.startsWith(skillsDir) ? targetPath : null
  }
  if (filePath.startsWith("__inherited__/memory/")) {
    const relative = filePath.replace("__inherited__/memory/", "")
    const memoryDir = path.join(getAgentDir(), "memory")
    const targetPath = path.join(memoryDir, relative)
    return targetPath.startsWith(memoryDir) ? targetPath : null
  }

  const cloneDir = resolveCloneHomeDir(name)
  if (!cloneDir) return null
  const targetPath = path.join(cloneDir, filePath)
  const rel = path.relative(cloneDir, targetPath)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null
  return targetPath
}

/** skills / 共享 memory 目录只读。 */
export function isReadonlyClonePath(targetPath: string): boolean {
  const agentDir = getAgentDir()
  const skillsDir = getAgentSkillsDir()
  const memoryDir = path.join(agentDir, "memory")
  return targetPath.startsWith(skillsDir) || targetPath.startsWith(memoryDir)
}
