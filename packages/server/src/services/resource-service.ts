import {
  ResourceKernel,
  FsResourceStore,
  TrustStore,
  AuditLogger,
} from '@octopus/shared'
import { join } from 'path'
import { existsSync } from 'fs'

export class ResourceService {
  private kernel: ResourceKernel
  private auditLogger: AuditLogger
  private trustStore: TrustStore
  readonly corePackDir: string
  readonly resourceDir: string

  constructor(workspaceDir: string) {
    this.resourceDir = join(workspaceDir, '.octopus', 'resources')
    const store = new FsResourceStore(this.resourceDir, true) // concurrent mode for server
    this.auditLogger = new AuditLogger(this.resourceDir)
    // B-14 fix: TrustStore now persists to disk
    // cross-errors: Audit callback records security events to audit log
    this.trustStore = new TrustStore(
      { trusted: [], blocked: [] },
      join(this.resourceDir, 'trust.json'),
      (entry) => this.auditLogger.append(entry),
    )
    this.kernel = new ResourceKernel({
      store,
      trustStore: this.trustStore,
      auditLogger: this.auditLogger,
      cacheDir: join(this.resourceDir, 'cache'),
    })

    // Resolve core-pack directory
    // Try common locations: workspace local, ~/.octopus/prod, sibling package
    const candidates = [
      join(workspaceDir, 'packages', 'core-pack'),
      join(workspaceDir, '.octopus', 'prod', 'packages', 'core-pack'),
      join(process.env.HOME ?? '~', '.octopus', 'prod', 'packages', 'core-pack'),
    ]
    this.corePackDir = candidates.find(d => existsSync(d)) ?? candidates[0]
  }

  getKernel(): ResourceKernel { return this.kernel }
  getAuditLogger(): AuditLogger { return this.auditLogger }
  getTrustStore(): TrustStore { return this.trustStore }
  getCorePackDir(): string { return this.corePackDir }
  getResourceDir(): string { return this.resourceDir }
}
