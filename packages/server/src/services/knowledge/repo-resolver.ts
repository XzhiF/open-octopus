import { execSync } from "child_process"
import fs from "fs"
import path from "path"

/**
 * Parse repo name from a git remote URL.
 *
 * SSH:   git@github.com:XzhiF/octopus.git → "octopus"
 * HTTPS: https://github.com/XzhiF/my-app.git → "my-app"
 */
export function parseRepoNameFromUrl(remoteUrl: string): string {
  // SSH format: git@host:org/repo.git
  const sshMatch = remoteUrl.match(/:([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch) return sshMatch[2]!

  // HTTPS format: https://host/org/repo.git
  const httpsMatch = remoteUrl.match(/\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (httpsMatch) return httpsMatch[2]!

  throw new Error(`Cannot parse repo name from: ${remoteUrl}`)
}

/**
 * Resolve the current repo name from a working directory.
 *
 * Resolution chain:
 * 1. `git remote get-url origin` → parse repo name from URL
 * 2. `git rev-parse --show-toplevel` → path.basename()
 * 3. path.basename(cwd)
 */
export function resolveRepoName(cwd: string): string {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    return parseRepoNameFromUrl(remote)
  } catch {
    try {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd,
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()
      return path.basename(gitRoot)
    } catch {
      return path.basename(cwd)
    }
  }
}

/**
 * Resolve all project repo names from a workspace's projects/ directory.
 *
 * Scans <workspacePath>/projects/ for subdirectories, each treated as a
 * potential git repo. The repo name is extracted from the git remote URL.
 *
 * Falls back to single-repo resolution if projects/ doesn't exist.
 *
 * Returns deduplicated array of repo names.
 */
export function resolveAllProjectNames(workspacePath: string): string[] {
  const projectsDir = path.join(workspacePath, "projects")

  // If no projects/ subdirectory, fall back to single-repo resolution
  if (!fs.existsSync(projectsDir)) {
    const single = resolveRepoName(workspacePath)
    return [single]
  }

  const names = new Set<string>()

  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const projectPath = path.join(projectsDir, entry.name)
      try {
        const name = resolveRepoName(projectPath)
        names.add(name)
      } catch {
        // Skip non-git directories
      }
    }
  } catch {
    // If projects/ can't be read, fall back to single-repo
    const single = resolveRepoName(workspacePath)
    return [single]
  }

  // If no valid projects found, fall back to workspace root
  if (names.size === 0) {
    const single = resolveRepoName(workspacePath)
    return [single]
  }

  return [...names]
}
