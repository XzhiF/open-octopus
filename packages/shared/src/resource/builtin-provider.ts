import fs from "fs"
import path from "path"
import { ResourceError } from "./errors"
import { copyDirSync, generateFileHash } from "./fs-utils"
import type { ResourceType, BuiltinCatalogEntry } from "./types"

/**
 * BuiltinProvider — install resources from core-pack (bundled skills/agents/workflows).
 *
 * Resource structure:
 * - Skills: directories in skills/ (e.g., skills/octo-skill-creator/SKILL.md)
 * - Agents: .md files in agents/ (e.g., agents/devil-advocate.md)
 * - Workflows: .yaml files in presets/workflows/ (e.g., presets/workflows/prd-impl.yaml)
 */

/** Resolve core-pack base directory */
function getCorePackBase(): string {
  // B7 fix: env override only in development/test — ignore in production
  if (process.env.OCTOPUS_CORE_PACK_PATH && process.env.NODE_ENV !== "production") {
    return process.env.OCTOPUS_CORE_PACK_PATH
  }

  // Walk up from __dirname to find core-pack package
  // In production: packages/server/dist/resource/ → packages/core-pack/
  // In development: packages/shared/src/resource/ → packages/core-pack/
  const candidates = [
    path.resolve(__dirname, "../../core-pack"),
    path.resolve(__dirname, "../../../core-pack"),
    path.resolve(__dirname, "../../../../core-pack"),
    path.resolve(__dirname, "../../../../../packages/core-pack"),
    path.resolve(process.cwd(), "packages/core-pack"),
  ]

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "skills"))) {
      return c
    }
  }

  // Fallback: try to find via require
  try {
    const corePackPkg = require.resolve("@octopus/core-pack/package.json")
    return path.dirname(corePackPkg)
  } catch {
    throw new ResourceError("BUILTIN_NOT_FOUND", "core-pack not found")
  }
}

/** Map resource type to core-pack subdirectory */
function typeToSubdir(type: ResourceType): string {
  switch (type) {
    case "skill": return "skills"
    case "agent": return "agents"
    case "workflow": return "presets/workflows"
  }
}

export interface BuiltinProviderConfig {
  corePackBase?: string
}

export class BuiltinProvider {
  private base: string

  constructor(config?: BuiltinProviderConfig) {
    this.base = config?.corePackBase ?? getCorePackBase()
  }

  /** Check if a builtin resource exists */
  exists(name: string, type: ResourceType): boolean {
    const sourcePath = this.getSourcePath(name, type)
    return sourcePath !== null
  }

  /** Copy builtin resource to install path */
  install(name: string, type: ResourceType, installPath: string): { fileCount: number; hash: string } {
    const sourcePath = this.getSourcePath(name, type)

    if (!sourcePath) {
      throw new ResourceError("BUILTIN_NOT_FOUND", `Builtin ${type} '${name}' not found`)
    }

    fs.mkdirSync(installPath, { recursive: true })

    let fileCount = 0
    try {
      if (type === "skill") {
        // Skills are directories, copy entire directory
        fileCount = copyDirSync(sourcePath, installPath)
      } else {
        // Agents and workflows are single files
        const fileName = path.basename(sourcePath)
        const destPath = path.join(installPath, fileName)
        fs.copyFileSync(sourcePath, destPath)
        fileCount = 1
      }
    } catch (err: any) {
      if (err instanceof ResourceError) throw err
      throw new ResourceError("FILE_COPY_FAILED", `Failed to copy ${name}: ${err.message}`)
    }

    const hash = generateFileHash(installPath)

    return { fileCount, hash }
  }

  /** List all available builtin resources */
  list(): BuiltinCatalogEntry[] {
    const entries: BuiltinCatalogEntry[] = []

    // Skills: scan directories in skills/
    this.scanSkillDirs(entries)

    // Agents: scan .md files in agents/
    this.scanAgentFiles(entries)

    // Workflows: scan .yaml files in presets/workflows/
    this.scanWorkflowFiles(entries)

    return entries
  }

  /** Get source path for a builtin resource */
  getSourcePath(name: string, type: ResourceType): string | null {
    const subdir = typeToSubdir(type)
    const basePath = path.join(this.base, subdir)

    if (type === "skill") {
      // Skills are directories
      const dirPath = path.join(basePath, name)
      return fs.existsSync(dirPath) ? dirPath : null
    } else if (type === "agent") {
      // Agents are .md files
      const filePath = path.join(basePath, `${name}.md`)
      return fs.existsSync(filePath) ? filePath : null
    } else {
      // Workflows are .yaml files
      const yamlPath = path.join(basePath, `${name}.yaml`)
      if (fs.existsSync(yamlPath)) return yamlPath
      const ymlPath = path.join(basePath, `${name}.yml`)
      return fs.existsSync(ymlPath) ? ymlPath : null
    }
  }

  private scanSkillDirs(entries: BuiltinCatalogEntry[]): void {
    const dirPath = path.join(this.base, "skills")
    if (!fs.existsSync(dirPath)) return

    const items = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const item of items) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue
      entries.push({
        name: item.name,
        type: "skill",
        description: "",
        sourcePath: path.join(dirPath, item.name),
      })
    }
  }

  private scanAgentFiles(entries: BuiltinCatalogEntry[]): void {
    const dirPath = path.join(this.base, "agents")
    if (!fs.existsSync(dirPath)) return

    const items = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const item of items) {
      if (!item.isFile()) continue
      if (!item.name.endsWith(".md")) continue
      const name = item.name.replace(/\.md$/, "")
      entries.push({
        name,
        type: "agent",
        description: "",
        sourcePath: path.join(dirPath, item.name),
      })
    }
  }

  private scanWorkflowFiles(entries: BuiltinCatalogEntry[]): void {
    const dirPath = path.join(this.base, "presets", "workflows")
    if (!fs.existsSync(dirPath)) return

    const items = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const item of items) {
      if (!item.isFile()) continue
      if (!item.name.endsWith(".yaml") && !item.name.endsWith(".yml")) continue
      const name = item.name.replace(/\.ya?ml$/, "")
      entries.push({
        name,
        type: "workflow",
        description: "",
        sourcePath: path.join(dirPath, item.name),
      })
    }
  }
}
