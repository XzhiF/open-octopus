/**
 * Resource Management — Core Schema Types
 */

export interface ResourceSource {
  protocol: string
  location: string
  version: string
}

export interface ResourceManifest {
  name: string
  type: string
  version: string
  source: ResourceSource
  hash: string
  dependencies: string[]
  references: string[]
  install?: {
    target?: string
    post_install?: string
  }
}

export interface InstallPlan {
  id: string
  additions: Array<{
    name: string
    type: string
    version: string
    source: string
  }>
  removals: string[]
  conflicts: Array<{
    name: string
    reason: string
  }>
}
