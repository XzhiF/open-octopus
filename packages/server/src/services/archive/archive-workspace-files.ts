import * as fs from "fs"
import * as path from "path"
import { logError, logInfo } from "../../file-logger"

const ARCHIVE_SUBDIRS = ["state", "logs", "docs"] as const

export interface ArchiveFilesResult {
  success: boolean
  archivePath: string | null
}

function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }

  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

export function archiveWorkspaceFiles(
  workspacePath: string,
  archiveDir: string,
): ArchiveFilesResult {
  if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
    return { success: false, archivePath: null }
  }

  fs.mkdirSync(archiveDir, { recursive: true })

  let successCount = 0
  let attemptedCount = 0

  for (const subdir of ARCHIVE_SUBDIRS) {
    const srcPath = path.join(workspacePath, subdir)
    if (!fs.existsSync(srcPath)) {
      continue
    }

    attemptedCount++
    try {
      const destPath = path.join(archiveDir, subdir)
      copyDirRecursive(srcPath, destPath)
      successCount++
      logInfo(`archived subdir ${subdir}`, { workspacePath, destPath })
    } catch (err) {
      logError(`failed to archive subdir ${subdir}`, err, { workspacePath, subdir })
    }
  }

  if (attemptedCount === 0) {
    // No subdirs found — success with empty archive
    return { success: true, archivePath: archiveDir }
  }

  if (successCount === 0) {
    // All attempted copies failed
    return { success: false, archivePath: null }
  }

  return { success: true, archivePath: archiveDir }
}
