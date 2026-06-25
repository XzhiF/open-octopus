import { existsSync, readdirSync, statSync } from "fs"
import { join, isAbsolute } from "path"
import { cloneProject } from "./git"
import type { ManifestEntry } from "./manifest"

export function findLocalRepo(group: string, name: string, cloneBase: string): string | null {
  const candidate = join(cloneBase, group, name)
  if (existsSync(candidate) && statSync(candidate).isDirectory() && existsSync(join(candidate, ".git"))) {
    return candidate
  }
  const candidateFlat = join(cloneBase, name)
  if (existsSync(candidateFlat) && statSync(candidateFlat).isDirectory() && existsSync(join(candidateFlat, ".git"))) {
    return candidateFlat
  }
  return null
}

export function scanExternalDirs(
  dirs: string[],
  manifestEntries: Record<string, ManifestEntry[]>
): Record<string, string> {
  const nameToEntry: Record<string, boolean> = {}
  for (const entries of Object.values(manifestEntries)) {
    for (const entry of entries) {
      nameToEntry[entry.name] = true
    }
  }

  const matched: Record<string, string> = {}
  for (const dirPath of dirs) {
    const dirPathAbs = isAbsolute(dirPath) ? dirPath : join(process.cwd(), dirPath)
    if (!existsSync(dirPathAbs) || !statSync(dirPathAbs).isDirectory()) {
      console.warn(`⚠ 目录不存在: ${dirPathAbs}`)
      continue
    }

    console.log(`扫描外部目录: ${dirPathAbs}`)

    try {
      const subdirs = readdirSync(dirPathAbs).sort()
      for (const subdir of subdirs) {
        const fullPath = join(dirPathAbs, subdir)
        if (!statSync(fullPath).isDirectory()) continue

        if (nameToEntry[subdir]) {
          matched[subdir] = fullPath
          console.log(`  ✓ ${subdir} → ${fullPath}`)
        } else {
          console.log(`  — ${subdir} 未在 manifest.md 中`)
        }
      }
    } catch (e: unknown) {
      console.error(`✗ 无法读取目录: ${e}`)
      continue
    }
  }

  if (Object.keys(matched).length > 0) {
    console.log(`匹配 ${Object.keys(matched).length} 个项目`)
  } else {
    console.warn("未匹配任何项目")
  }

  return matched
}

export function cloneMissingProjects(
  manifestEntries: Record<string, ManifestEntry[]>,
  cloneBase: string,
  externalPaths?: Record<string, string>
): { cloned: number; failed: number } {
  let cloned = 0
  let failed = 0

  for (const entries of Object.values(manifestEntries)) {
    for (const entry of entries) {
      if (externalPaths && externalPaths[entry.name]) {
        continue
      }
      const local = findLocalRepo(entry.group, entry.name, cloneBase)
      if (local) continue

      if (!entry.git_url) {
        console.warn(`⚠ ${entry.name} has no git_url in manifest`)
        failed++
        continue
      }

      const result = cloneProject(entry.git_url, entry.group, entry.name, entry.branch, cloneBase)
      if (result.success) {
        cloned++
      } else {
        failed++
      }
    }
  }

  return { cloned, failed }
}