// packages/server/src/services/workspace-git.ts
//
// Git worktree initialization for workspaces.
// Extracted from WorkspaceService to reduce god class size.
//
import fs from "fs"
import path from "path"
import os from "os"
import { workspaceGuide } from "./workspace-scaffold"

/** Escape a literal string for safe interpolation into a RegExp source. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export class WorkspaceGit {
  /**
   * Resolve a repo's local filesystem path from `~/.octopus/orgs/{org}/repos/index.md`.
   * Shared by user-workspace init (`initWorktreesSync`) and scheduler-path init
   * (`initWorktreesFromSpec`).
   *
   * Throws a clear error whenever the repo cannot be resolved — index.md missing,
   * group/repo not found, or local path unreachable — so the scheduler path fails
   * loudly instead of silently skipping (G3 fix). The user-workspace path wraps
   * each call in try/catch to preserve its continue-on-failure contract.
   */
  resolveRepoPath(org: string, name: string, group?: string): string {
    const indexPath = path.join(os.homedir(), ".octopus", "orgs", org, "repos", "index.md")
    if (!fs.existsSync(indexPath)) {
      throw new Error(`repos/index.md not found for org '${org}' (looked at ${indexPath})`)
    }
    const indexContent = fs.readFileSync(indexPath, "utf-8").replace(/\r\n/g, "\n")

    // Scope to the group section when a group is provided, so ProjectSpec.group is
    // actually consumed (G8 orphan-field elimination) and resolution is unambiguous.
    let scope = indexContent
    if (group && group.trim() !== "") {
      const sections = indexContent.split(/^## /m)
      const section = sections.find(sec => {
        const firstLine = sec.split("\n")[0]
        return new RegExp(`^${escapeRegex(group)}(\\s|\\(|$)`).test(firstLine)
      })
      if (!section) {
        throw new Error(`group '${group}' not found in index.md for org '${org}'`)
      }
      scope = section
    }

    const localMatch = new RegExp(
      `### ${escapeRegex(name)}\\n[^#]*?- local: (.+?)(?: ✓| —|$)`, "s",
    ).exec(scope)
    if (!localMatch) {
      throw new Error(
        `repo '${name}' not found in index.md${group ? ` under group '${group}'` : ""} for org '${org}'`,
      )
    }

    let localPath = localMatch[1].trim()
    if (localPath.startsWith("~")) localPath = localPath.replace(/^~/, os.homedir())

    if (!fs.existsSync(localPath) || !fs.existsSync(path.join(localPath, ".git"))) {
      throw new Error(`local path for '${name}' unreachable: ${localPath}`)
    }
    return localPath
  }

  /**
   * Initialize git worktrees for repos listed in ~/.octopus/orgs/{org}/repos/index.md.
   * Creates detached worktrees in workspace/projects/ and updates config.json + CLAUDE.md.
   * Per-repo resolution failures are collected into `failed[]` so one missing repo
   * does not abort the whole user-workspace creation.
   */
  initWorktreesSync(
    workspacePath: string, repoSpecs: string[], org: string, wsName: string, branch?: string,
  ): { created: number; failed: string[] } {
    const failed: string[] = []
    const { spawnSync } = require("child_process") as typeof import("child_process")
    const projectsDir = path.join(workspacePath, "projects")
    const entries: { name: string; group: string; main_path: string; worktree_path: string }[] = []

    for (const spec of repoSpecs) {
      const parts = spec.includes("/") ? spec.split("/") : [org, spec]
      const [group, name] = parts
      const wtDir = path.join(projectsDir, name)

      // Resolve local path via the shared helper. User workspaces historically match
      // by name globally (group derived here is for labeling only), so no group is
      // passed — preserving the prior global-match behavior.
      let localPath: string
      try {
        localPath = this.resolveRepoPath(org, name)
      } catch (e: unknown) {
        const reason = `${spec}: ${e instanceof Error ? e.message : String(e)}`
        console.log(`[WorkspaceGit] ${reason}`)
        failed.push(reason)
        continue
      }

      try {
        spawnSync("git", ["worktree", "prune"], { cwd: localPath, timeout: 10000 })
        if (fs.existsSync(wtDir)) fs.rmSync(wtDir, { recursive: true, force: true })
        const result = spawnSync("git", ["worktree", "add", "-f", wtDir, "--detach"], { cwd: localPath, timeout: 60000 })
        if (result.status !== 0) {
          const reason = `${spec}: worktree add failed: ${result.stderr.toString().trim()}`
          console.error(`[WorkspaceGit] ${reason}`)
          failed.push(reason)
          continue
        }
        if (branch) {
          const coResult = spawnSync("git", ["checkout", "-b", branch], { cwd: wtDir, timeout: 30000 })
          if (coResult.status !== 0) {
            const switchResult = spawnSync("git", ["checkout", branch], { cwd: wtDir, timeout: 30000 })
            if (switchResult.status !== 0) {
              const reason = `${spec}: branch checkout failed: ${switchResult.stderr.toString().trim()}`
              console.error(`[WorkspaceGit] ${reason}`)
              failed.push(reason)
              spawnSync("git", ["worktree", "remove", "-f", wtDir], { cwd: localPath, timeout: 10000 })
              continue
            }
          }
        }
        entries.push({ name, group, main_path: localPath, worktree_path: wtDir })
        console.log(`[WorkspaceGit] worktree created: ${name} → ${wtDir}${branch ? ` [${branch}]` : ''}`)
      } catch (e: any) {
        const reason = `${spec}: ${e.message}`
        console.error(`[WorkspaceGit] worktree failed for ${group}/${name}:`, e.message)
        failed.push(reason)
      }
    }

    if (entries.length > 0) {
      this.writeProjectConfig(workspacePath, entries)
      this.writeProjectClaudeMd(workspacePath, entries, wsName)
    } else {
      console.log("[WorkspaceGit] no worktrees created — repos may not be cloned locally")
    }

    return { created: entries.length, failed }
  }

  /**
   * Initialize worktrees from explicit project specs (scheduler path).
   *
   * Empty `source_path` is resolved from `~/.octopus/orgs/{org}/repos/index.md` via
   * the shared `resolveRepoPath` (scoped by `group` when provided). Resolution
   * failures THROW (propagating to createFromSpec → workflow-executor catch →
   * schedule_executions.error_summary), so multi-repo dispatch is never silently
   * broken by an unresolvable project (G3 fix).
   */
  initWorktreesFromSpec(
    workspacePath: string,
    projects: Array<{ name: string; source_path: string; group?: string }>,
    branchPrefix: string,
    branchSuffix: string,
    wsName: string,
    org: string,
  ): void {
    const { spawnSync } = require("child_process") as typeof import("child_process")
    const projectsDir = path.join(workspacePath, "projects")
    const entries: { name: string; main_path: string; worktree_path: string; branch: string }[] = []
    const branchName = `${branchPrefix}-${branchSuffix}`

    for (const proj of projects) {
      // Explicit source_path wins; empty → repos/index.md lookup by name (+group).
      const rawSource = proj.source_path ?? ""
      const sourcePath = rawSource.trim() !== ""
        ? rawSource.replace(/^~/, os.homedir())
        : this.resolveRepoPath(org, proj.name, proj.group ?? "")

      const wtDir = path.join(projectsDir, proj.name)

      if (!fs.existsSync(sourcePath) || !fs.existsSync(path.join(sourcePath, ".git"))) {
        throw new Error(`source path unreachable for '${proj.name}': ${sourcePath}`)
      }

      spawnSync("git", ["worktree", "prune"], { cwd: sourcePath, timeout: 10000 })
      if (fs.existsSync(wtDir)) fs.rmSync(wtDir, { recursive: true, force: true })

      const result = spawnSync("git", ["worktree", "add", "-f", wtDir, "--detach"], {
        cwd: sourcePath, timeout: 60000,
      })
      if (result.status !== 0) {
        throw new Error(`worktree add failed for '${proj.name}': ${result.stderr.toString().trim()}`)
      }

      const coResult = spawnSync("git", ["checkout", "-b", branchName], { cwd: wtDir, timeout: 30000 })
      if (coResult.status !== 0) {
        const switchResult = spawnSync("git", ["checkout", branchName], { cwd: wtDir, timeout: 30000 })
        if (switchResult.status !== 0) {
          throw new Error(`branch checkout failed for '${proj.name}': ${switchResult.stderr.toString().trim()}`)
        }
      }

      entries.push({ name: proj.name, main_path: sourcePath, worktree_path: wtDir, branch: branchName })
    }

    if (entries.length > 0) {
      const configPath = path.join(workspacePath, "config.json")
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
      config.repos = entries.map(e => ({
        name: e.name, main_path: e.main_path, worktree_path: e.worktree_path, branch: e.branch,
      }))
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")

      const claudeLines = [
        `# 工作空间: ${wsName}`, "",
        "## 涉及项目 (git worktree)", "",
      ]
      for (const e of entries) {
        claudeLines.push(`- **${e.name}**: \`${e.worktree_path}\` [${e.branch}]`)
        claudeLines.push(`  - 主仓库: \`${e.main_path}\``)
      }
      claudeLines.push("", "## 说明", "- 此工作空间由调度器自动创建")
      fs.writeFileSync(path.join(workspacePath, "CLAUDE.md"), claudeLines.join("\n"), "utf-8")
    }
  }

  private writeProjectConfig(
    workspacePath: string,
    entries: { name: string; group: string; main_path: string; worktree_path: string }[],
  ): void {
    const configPath = path.join(workspacePath, "config.json")
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
    config.repos = entries.map(e => ({ name: e.name, group: e.group, main_path: e.main_path, worktree_path: e.worktree_path }))
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
  }

  private writeProjectClaudeMd(
    workspacePath: string,
    entries: { name: string; group: string; main_path: string; worktree_path: string }[],
    wsName: string,
  ): void {
    const claudeLines = [
      `# 工作空间: ${wsName}`, "",
      "## 涉及项目 (git worktree)", "",
      "各项目通过 git worktree 链接到主仓库，在此目录内编码，不影响主仓库分支。", "",
    ]
    for (const e of entries) {
      claudeLines.push(`- **${e.group}-${e.name}**: \`${e.worktree_path}\``)
      claudeLines.push(`  - 主仓库: \`${e.main_path}\``)
    }
    claudeLines.push("", "## 说明",
      "- 使用 `octo-dev-copilot` skill 管理此工作空间",
      "- 使用 `octo-workflow-dev` skill 开发与校验工作流",
      "- 使用 `octo-swarm-dev` skill 开发 Swarm 多专家协作节点",
      "- 修改代码时直接操作各 worktree 目录",
      "- 主仓库保持干净，开发分支仅在 worktree 中",
    )
    claudeLines.push(...workspaceGuide())
    fs.writeFileSync(path.join(workspacePath, "CLAUDE.md"), claudeLines.join("\n"), "utf-8")
  }
}
