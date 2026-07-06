import fs from "fs"
import path from "path"
import { ResourceError } from "./errors"
import { copyDirSync, generateFileHash } from "./fs-utils"
import type { ResourceType, BuiltinCatalogEntry } from "./types"

/**
 * BuiltinProvider — install resources from core-pack (bundled skills/agents).
 * Source path: packages/core-pack/{type}s/{name}/
 *
 * Detects resource type from directory structure.
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
    case "workflow": return "workflows"
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
    const sourcePath = path.join(this.base, typeToSubdir(type), name)
    return fs.existsSync(sourcePath)
  }

  /** Copy builtin resource to install path */
  install(name: string, type: ResourceType, installPath: string): { fileCount: number; hash: string } {
    const sourcePath = path.join(this.base, typeToSubdir(type), name)

    if (!fs.existsSync(sourcePath)) {
      throw new ResourceError("BUILTIN_NOT_FOUND", `Builtin ${type} '${name}' not found`)
    }

    fs.mkdirSync(installPath, { recursive: true })

    let fileCount = 0
    try {
      fileCount = copyDirSync(sourcePath, installPath)
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
    const typeDirs: Array<{ subdir: string; type: ResourceType }> = [
      { subdir: "skills", type: "skill" },
      { subdir: "agents", type: "agent" },
    ]

    for (const { subdir, type } of typeDirs) {
      const dirPath = path.join(this.base, subdir)
      if (!fs.existsSync(dirPath)) continue

      const items = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const item of items) {
        if (!item.isDirectory() || item.isSymbolicLink()) continue
        entries.push({
          name: item.name,
          type,
          description: "",
          sourcePath: path.join(dirPath, item.name),
        })
      }
    }

    return entries
  }

  /** Get source path for a builtin resource (for file reading) */
  getSourcePath(name: string, type: ResourceType): string | null {
    const sourcePath = path.join(this.base, typeToSubdir(type), name)
    return fs.existsSync(sourcePath) ? sourcePath : null
  }
}
