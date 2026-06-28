// Archive service singleton — registered at startup in index.ts
import type { ArchiveService } from "./archive-service"

let archiveServiceInstance: ArchiveService | null = null

export function setArchiveService(service: ArchiveService): void {
  archiveServiceInstance = service
}

export function getArchiveService(): ArchiveService | null {
  return archiveServiceInstance
}
