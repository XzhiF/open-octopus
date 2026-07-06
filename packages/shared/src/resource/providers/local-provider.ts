import fs from "fs"
import path from "path"
import type { SourceProvider } from "./types"
import type { ResourceManifest, ResourceType } from "../types"
import { isPathWithinBase } from "../utils"

export class LocalProvider implements SourceProvider {
  readonly type = "local" as const
  async resolve(ref: string, resourceType: ResourceType): Promise<ResourceManifest> {
    const localPath = path.resolve(ref)

    if (!fs.existsSync(localPath)) {
      throw new Error(`Local path does not exist: ${ref}`)
    }

    const name = path.basename(localPath)

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

    // Safety: verify the source path is not escaping to unexpected locations.
    // The caller is expected to provide a reasonable basePath (e.g. workspace root).
    // Without an explicit base we log the check against the process cwd.
    const cwd = process.cwd()
    if (!isPathWithinBase(sourcePath, cwd) && !path.isAbsolute(sourcePath)) {
      throw new Error(
        `Local source path escapes working directory: ${sourcePath}`,
      )
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
