import fs from "fs"
import path from "path"
import { isPathWithinBase } from "./utils"
import { ResourceError } from "./errors"
import type { ResourceType } from "./types"

export class WorkspaceUninstaller {
  uninstall(name: string, type: ResourceType, installPath: string, workspacePath: string): void {
    if (!isPathWithinBase(installPath, workspacePath)) {
      throw new ResourceError("PATH_TRAVERSAL", `Uninstall path escapes workspace: ${installPath}`)
    }

    if (!fs.existsSync(installPath)) {
      throw new ResourceError("UNINSTALL_FAILED", `Install path does not exist: ${installPath}`)
    }

    try {
      fs.rmSync(installPath, { recursive: true, force: true })
    } catch (err) {
      throw new ResourceError("UNINSTALL_FAILED", `Failed to remove resource: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
