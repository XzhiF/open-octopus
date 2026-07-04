import { existsSync, statSync, cpSync, rmSync, mkdirSync } from "fs"
import path from "path"

export interface SnapshotEntry {
  path: string
  state: "exists" | "absent"
  backupPath?: string
}

export interface InstallSnapshot {
  entries: SnapshotEntry[]
  createdAt: string
}

export interface RollbackReport {
  restored: string[]
  removed: string[]
}

export class SnapshotManager {
  static create(wsDir: string, targets: { targetPath: string }[], backupDir: string): InstallSnapshot {
    const entries: SnapshotEntry[] = []
    for (const t of targets) {
      const fullPath = path.resolve(wsDir, t.targetPath)
      const backupPath = path.join(backupDir, t.targetPath.replace(/\//g, "_"))
      if (existsSync(fullPath)) {
        mkdirSync(path.dirname(backupPath), { recursive: true })
        cpSync(fullPath, backupPath, { recursive: true })
        entries.push({ path: fullPath, state: "exists", backupPath })
      } else {
        entries.push({ path: fullPath, state: "absent" })
      }
    }
    return { entries, createdAt: new Date().toISOString() }
  }

  static rollback(snapshot: InstallSnapshot): RollbackReport {
    const report: RollbackReport = { restored: [], removed: [] }
    for (const entry of snapshot.entries) {
      if (entry.state === "absent" && existsSync(entry.path)) {
        rmSync(entry.path, { recursive: true, force: true })
        report.removed.push(entry.path)
      } else if (entry.state === "exists" && entry.backupPath && existsSync(entry.backupPath)) {
        cpSync(entry.backupPath, entry.path, { recursive: true })
        report.restored.push(entry.path)
      }
    }
    return report
  }
}
