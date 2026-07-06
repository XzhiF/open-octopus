import fs from "fs"
import path from "path"
import type { SourceProvider } from "./types"
import type { ResourceManifest, ResourceType } from "../types"
import { ResourceError } from "../errors"

// B5: reject names that could traverse directories
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

// B5: sensitive directories that must never be used as local resource sources
const BLOCKED_PREFIXES = [
  "/etc", "/proc", "/sys", "/dev", "/var/run", "/var/spool",
  "C:\\Windows", "C:\\Program Files",
]

export class LocalProvider implements SourceProvider {
  readonly type = "local" as const
  async resolve(ref: string, resourceType: ResourceType): Promise<ResourceManifest> {
    const localPath = path.resolve(ref)

    if (!fs.existsSync(localPath)) {
      throw new Error(`Local path does not exist: ${ref}`)
    }

    const name = path.basename(localPath)
    // B5 fix: validate extracted name is safe
    if (!SAFE_NAME_RE.test(name)) {
      throw new ResourceError("INVALID_RESOURCE_NAME", `Resource name from path is invalid: '${name}'`)
    }

    // B5 fix: block sensitive system directories
    const normalized = localPath.replace(/\\/g, "/").toLowerCase()
    for (const blocked of BLOCKED_PREFIXES) {
      if (normalized.startsWith(blocked.toLowerCase())) {
        throw new ResourceError("PATH_TRAVERSAL", `Local source path is in a restricted directory: '${ref}'`)
      }
    }

    // Try to read manifest.json for richer metadata
    const manifestPath = path.join(localPath, "manifest.json")
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
        return {
          name: raw.name ?? name,
          type: resourceType,
          version: raw.version ?? "0.0.0",
          description: raw.description,
          source: { type: "local", path: localPath },
          dependencies: raw.dependencies ?? [],
          tags: raw.tags ?? [],
        }
      } catch {
        // Fall through to default manifest when manifest.json is malformed
      }
    }

    return {
      name,
      type: resourceType,
      version: "0.0.0",
      source: { type: "local", path: localPath },
      dependencies: [],
      tags: [],
    }
  }

  async fetch(manifest: ResourceManifest, targetDir: string): Promise<void> {
    if (manifest.source.type !== "local") {
      throw new Error(`LocalProvider cannot fetch non-local source: ${manifest.source.type}`)
    }

    const sourcePath = manifest.source.path

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source path does not exist: ${sourcePath}`)
    }

    // B5 fix: verify source path is not in a restricted system directory
    const normalized = path.resolve(sourcePath).replace(/\\/g, "/").toLowerCase()
    for (const blocked of BLOCKED_PREFIXES) {
      if (normalized.startsWith(blocked.toLowerCase())) {
        throw new ResourceError("PATH_TRAVERSAL", `Local source path is in a restricted directory: '${sourcePath}'`)
      }
    }

    const stat = fs.statSync(sourcePath)
    if (stat.isDirectory()) {
      fs.cpSync(sourcePath, targetDir, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true })
      fs.copyFileSync(sourcePath, targetDir)
    }
  }

  async list(): Promise<ResourceManifest[]> {
    // Local provider does not enumerate — callers supply explicit paths.
    return []
  }
}
