import { SourceRef } from "../types/resource-manifest"

export interface ISecurityContext {
  checkSourceTrust(ref: SourceRef): Promise<void>
  checkCallerPermission(operation: string): Promise<void>
  checkPathTraversal(targetPath: string, wsDir: string): void
}
