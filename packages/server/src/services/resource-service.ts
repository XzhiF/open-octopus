import {
  ResourceKernel,
  FsResourceStore,
  TrustStore,
  AuditLogger,
} from '@octopus/shared'
import { join } from 'path'

export class ResourceService {
  private kernel: ResourceKernel
  private auditLogger: AuditLogger
  private trustStore: TrustStore

  constructor(workspaceDir: string) {
    const resourceDir = join(workspaceDir, '.octopus', 'resources')
    const store = new FsResourceStore(resourceDir, true) // concurrent mode for server
    this.trustStore = new TrustStore()
    this.auditLogger = new AuditLogger(resourceDir)
    this.kernel = new ResourceKernel({
      store,
      trustStore: this.trustStore,
      auditLogger: this.auditLogger,
      cacheDir: join(resourceDir, 'cache'),
    })
  }

  getKernel(): ResourceKernel { return this.kernel }
  getAuditLogger(): AuditLogger { return this.auditLogger }
  getTrustStore(): TrustStore { return this.trustStore }
}
