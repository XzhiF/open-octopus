import type { ResourceManifest, ResourceType } from "../types"

/**
 * SourceProvider abstracts where resources come from.
 *
 * - builtin: core-pack bundled skills/agents/workflows
 * - local:   arbitrary directory on disk
 * - npm:     tarball download (Phase 4)
 * - git:     shallow clone      (Phase 4)
 */
export interface SourceProvider {
  readonly type: "builtin" | "local"
  /** Resolve a ref string into a full ResourceManifest. */
  resolve(ref: string, resourceType: ResourceType): Promise<ResourceManifest>

  /** Copy the resolved resource into targetDir. */
  fetch(manifest: ResourceManifest, targetDir: string): Promise<void>

  /** Enumerate available resources. Optional type filter. */
  list(resourceType?: ResourceType): Promise<ResourceManifest[]>
}
