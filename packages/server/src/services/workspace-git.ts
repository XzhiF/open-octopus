// packages/server/src/services/workspace-git.ts
//
// Git worktree initialization for workspaces.
// Extracted from WorkspaceService to reduce god class size.
//
import fs from "fs"
import path from "path"
import os from "os"
import { workspaceGuide } from "./workspace-scaffold"

export class WorkspaceGit {
  /**
   * Initialize git worktrees for repos listed in ~/.octopus/orgs/{org}/repos/index.md.
   * Creates detached worktrees in workspace/projects/ and updates config.json + CLAUDE.md.
   */
  initWorktreesSync(
    workspacePath: string, repoSpecs: string[], org: string, wsName: string, branch?: string,
  ): { created: number; failed: string[] } {
    const failed: string[] = []
    const indexPath = path.join(os.homedir(), ".octopus", "orgs", org, "repos", "index.md")
    if (!fs.existsSync(indexPath)) {
      console.log("[WorkspaceGit] index.md not found, skipping worktree init")
      return { created: 0, failed: repoSpecs.map(spec => `${spec}: index.md not found`) }
    }

    const { spawnSync } = require("child_process") as typeof import("child_process")
    const projectsDir = path.join(workspacePath, "projects")
    const entries: { name: string; group: string; main_path: string; worktree_path: string }[] = []
    const indexContent = fs.readFileSync(indexPath, "utf-8").replace(/\r\n/g, "\n")

    for (const spec of repoSpecs) {
      const parts = spec.includes("/") ? spec.split("/") : [org, spec]
      const [group, name] = parts
      const wtDir = path.join(projectsDir, name)

      const localMatch = new RegExp(`### ${name}\\n[^#]*?- local: (.+?)(?: ✓| —|$)`, "s").exec(indexContent)
      if (!localMatch) {
        const reason = `${spec}: not found in index.md`
        console.log(`[WorkspaceGit] ${reason}`)
        failed.push(reason)
        continue
      }

      let localPath = localMatch[1].trim()
      if (localPath.startsWith("~")) localPath = localPath.replace(/^~/, os.homedir())

      if (!fs.existsSync(localPath) || !fs.existsSync(path.join(localPath, ".git"))) {
        const reason = `${spec}: local path unreachable: ${localPath}`
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
   */
  initWorktreesFromSpec(
    workspacePath: string,
    projects: Array<{ name: string; source_path: string }>,
    branchPrefix: string,
    branchSuffix: string,
    wsName: string,
  ): void {
    const { spawnSync } = require("child_process") as typeof import("child_process")
    const projectsDir = path.join(workspacePath, "projects")
    const entries: { name: string; main_path: string; worktree_path: string; branch: string }[] = []

    for (const proj of projects) {
      const sourcePath = proj.source_path.replace(/^~/, os.homedir())
      const branchName = `${branchPrefix}-${branchSuffix}`
      const wtDir = path.join(projectsDir, proj.name)

      if (!fs.existsSync(sourcePath) || !fs.existsSync(path.join(sourcePath, ".git"))) {
        console.log(`[WorkspaceGit] source path unreachable: ${sourcePath}`)
        continue
      }

      try {
        spawnSync("git", ["worktree", "prune"], { cwd: sourcePath, timeout: 10000 })
        if (fs.existsSync(wtDir)) fs.rmSync(wtDir, { recursive: true, force: true })

        const result = spawnSync("git", ["worktree", "add", "-f", wtDir, "--detach"], {
          cwd: sourcePath, timeout: 60000,
        })
        if (result.status !== 0) {
          console.error(`[WorkspaceGit] worktree add failed for ${proj.name}: ${result.stderr.toString().trim()}`)
          continue
        }

        const coResult = spawnSync("git", ["checkout", "-b", branchName], { cwd: wtDir, timeout: 30000 })
        if (coResult.status !== 0) {
          const switchResult = spawnSync("git", ["checkout", branchName], { cwd: wtDir, timeout: 30000 })
          if (switchResult.status !== 0) {
            console.error(`[WorkspaceGit] branch checkout failed for ${proj.name}`)
            continue
          }
        }

        entries.push({ name: proj.name, main_path: sourcePath, worktree_path: wtDir, branch: branchName })
      } catch (e: any) {
        console.error(`[WorkspaceGit] worktree failed for ${proj.name}:`, e.message)
      }
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
