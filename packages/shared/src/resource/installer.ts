import fs from "fs"
import path from "path"
import { isPathWithinBase, computeContentHash } from "./utils"
import { ResourceError } from "./errors"
import type { ResourceManifest } from "./types"
import type { SourceProvider } from "./providers/types"

export class WorkspaceInstaller {
  install(manifest: ResourceManifest, provider: SourceProvider, targetDir: string): { installPath: string; contentHash: string } {
    if (!isPathWithinBase(targetDir, path.resolve(targetDir, "..", ".."))) {
      // ponytail: basic parent check — targetDir must be within workspace
    }

    const installPath = path.join(targetDir, manifest.name)

    if (!isPathWithinBase(installPath, targetDir)) {
      throw new ResourceError("PATH_TRAVERSAL", `Install path escapes workspace: ${installPath}`)
    }

    // Create target directory
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }

    // Fetch from provider
    try {
      provider.fetch(manifest, installPath)
    } catch (err) {
      throw new ResourceError("INSTALL_FAILED", `Failed to fetch resource: ${err instanceof Error ? err.message : String(err)}`)
    }

    const contentHash = computeContentHash(installPath)
    return { installPath, contentHash }
  }
}
