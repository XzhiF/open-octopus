// packages/server/src/services/workspace-git.ts
//
// Git worktree initialization for workspaces.
// Extracted from WorkspaceService to reduce god class size.
//
import fs from "fs"
import path from "path"
import os from "os"
import { workspaceGuide } from "./workspace-scaffold"
import {
  ensureRootClaudePointer,
  updateWorkspaceConfig,
  upsertManagedBlock,
  WORKSPACE_CLAUDE_BEGIN,
  WORKSPACE_CLAUDE_END,
  workspaceInstructionPath,
} from "./workspace-paths"

/** Escape a literal string for safe interpolation into a RegExp source. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** scheduler-path worktree 落成的元数据条目（config.json.repos 的形状；
 *  archiving-service.resolveWorktree 按 main_path/worktree_path/branch 读取）。 */
export interface SpecWorktreeEntry {
  name: string
  main_path: string
  worktree_path: string
  branch: string
  /** 仓库所属 org（作战舱跨 org 绑定用；老路径不填 = 舱级 org）。 */
  group?: string
  /** 任务分支的 fork 点（分支计划，2026-11-24）。 */
  base_branch?: string
  /** PR 落点分支（分支计划；缺省 = base_branch）。 */
  target_branch?: string
}

/** 仓库默认分支：origin/HEAD → origin/main → origin/master → 本地 main/master
 *  → 当前 HEAD。分支计划在「任务显式 / 舱绑定」都没有时的最后一级。
 *  每次建树 shell 一次即可，不做缓存 —— 远端默认分支可能被改。 */
export function detectDefaultBranch(repoPath: string): string {
  const { spawnSync } = require("child_process") as typeof import("child_process")
  const out = (args: string[]): string | null => {
    const r = spawnSync("git", args, { cwd: repoPath, encoding: "utf-8", timeout: 10000 })
    return r.status === 0 ? (r.stdout as string).trim() : null
  }
  const sym = out(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
  if (sym) return sym.replace(/^origin\//, "")
  for (const cand of ["main", "master"]) {
    if (out(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${cand}`])) return cand
  }
  for (const cand of ["main", "master"]) {
    if (out(["rev-parse", "--verify", "--quiet", `refs/heads/${cand}`])) return cand
  }
  const cur = out(["symbolic-ref", "--short", "-q", "HEAD"])
  if (cur) return cur
  throw new Error(`cannot determine default branch for ${repoPath}`)
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
    plans: Record<string, { base?: string; target?: string }> = {},
  ): void {
    const branchName = `${branchPrefix}-${branchSuffix}`
    const entries = projects.map((proj) => {
      const plan = plans[proj.name]
      return this.initWorktreeOne(workspacePath, proj, branchName, org, {
        ...(plan?.base ? { baseRef: plan.base } : {}),
        ...(plan?.target ? { targetBranch: plan.target } : {}),
      })
    })
    if (entries.length > 0) this.writeSpecWorktreeMeta(workspacePath, entries, wsName)
  }

  /** 单项目 worktree 建立（trigger-prebuild 2026-09-08 抽出）：
   *  resolve → fetch base → worktree add -b <branch> <wt> <base>（已存在则
   *  checkout 回退）。throw 语义与循环体时代逐字一致（G3 loud-fail）。
   *  复用同一函数给 ensureWorktreesForReuse 自愈重建（source 直接来自
   *  config.repos.main_path，explicit source_path 分支跳过 index.md 解析）。
   *
   *  分支计划（2026-11-24）：opts.baseRef 为空时取仓库默认分支（detectDefaultBranch），
   *  不再用主仓当时的 HEAD —— 主仓 clean-main 后恒在默认分支，隐式 HEAD 会把舱
   *  绑定分支的意图吃掉。base 不存在 = 硬失败，绝不静默回退。 */
  initWorktreeOne(
    workspacePath: string,
    proj: { name: string; source_path?: string; group?: string },
    branchName: string,
    org: string,
    opts: { clobber?: boolean; worktreePath?: string; baseRef?: string; targetBranch?: string } = {},
  ): SpecWorktreeEntry {
    const { spawnSync } = require("child_process") as typeof import("child_process")
    const projectsDir = path.join(workspacePath, "projects")

    // Explicit source_path wins; empty → repos/index.md lookup by name (+group).
    const rawSource = proj.source_path ?? ""
    const sourcePath = rawSource.trim() !== ""
      ? rawSource.replace(/^~/, os.homedir())
      : this.resolveRepoPath(org, proj.name, proj.group ?? "")

    // Cabin 并行实例传显式目录（projects/<instance>/<name>）；默认保持老落点。
    const wtDir = opts.worktreePath ?? path.join(projectsDir, proj.name)

    if (!fs.existsSync(sourcePath) || !fs.existsSync(path.join(sourcePath, ".git"))) {
      throw new Error(`source path unreachable for '${proj.name}': ${sourcePath}`)
    }

    // ── 分支计划：fork 点显式化（2026-11-24）─────────────────────────
    const base = (opts.baseRef ?? "").trim() || detectDefaultBranch(sourcePath)
    const revExists = (ref: string): boolean =>
      spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
        cwd: sourcePath, timeout: 10000,
      }).status === 0
    // 显式拉一次 base 的远端跟踪引用：主仓 clean-main 只镜像默认分支，feat/x
    // 的 origin/ 引用可能是旧的；fetch 失败（无 origin / 离线）不致命，下面
    // 会回退本地分支，两者都没有才硬失败。超时压到 30s：这是同步调用，
    // 远端卡住时不能像异步 repo-sync 那样占着事件循环（2026-11-10 事故教训）。
    spawnSync("git", ["fetch", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], {
      cwd: sourcePath, timeout: 30_000,
    })
    const startPoint = revExists(`refs/remotes/origin/${base}`)
      ? `origin/${base}`
      : revExists(`refs/heads/${base}`)
        ? base
        : null
    if (!startPoint) {
      throw new Error(
        `base branch '${base}' not found for '${proj.name}' ` +
          `(origin/refs and local branch both missing): ${sourcePath}`,
      )
    }

    spawnSync("git", ["worktree", "prune"], { cwd: sourcePath, timeout: 10000 })
    if (fs.existsSync(wtDir)) {
      // clobber:false — 活的 worktree 绝不删（同名并行会互删生产物），直接报冲突；
      // 只有「目录在但不是活 worktree」才清理。默认 true 保持任务路径逐字行为。
      const alive = spawnSync("git", ["-C", wtDir, "rev-parse", "--git-dir"], { timeout: 10000 }).status === 0
      if (alive && opts.clobber === false) {
        throw new Error(`worktree_exists: ${wtDir} 已经是活的工作树`)
      }
      fs.rmSync(wtDir, { recursive: true, force: true })
    }

    fs.mkdirSync(path.dirname(wtDir), { recursive: true })
    let result = spawnSync(
      "git",
      ["worktree", "add", "-f", wtDir, "-b", branchName, startPoint],
      { cwd: sourcePath, timeout: 60000 },
    )
    if (result.status !== 0) {
      // 分支已存在（复用/自愈路径）→ 检出既有分支，保留其历史（与改造前一致）。
      if (!revExists(`refs/heads/${branchName}`)) {
        throw new Error(`worktree add failed for '${proj.name}': ${result.stderr.toString().trim()}`)
      }
      result = spawnSync("git", ["worktree", "add", "-f", wtDir, branchName], {
        cwd: sourcePath, timeout: 60000,
      })
      if (result.status !== 0) {
        throw new Error(
          `branch checkout failed for '${proj.name}': ${result.stderr.toString().trim()}`,
        )
      }
    }

    return {
      name: proj.name,
      main_path: sourcePath,
      worktree_path: wtDir,
      branch: branchName,
      base_branch: base,
      target_branch: (opts.targetBranch ?? "").trim() || base,
      ...(proj.group ? { group: proj.group } : {}),
    }
  }

  /** worktree 目录是否仍是活的 git worktree（自愈检测用，trigger-prebuild
   *  2026-09-08）。`-C` 参而非 cwd — 目录不存在时干净返回非 0，不会 ENOENT。 */
  worktreeAlive(worktreePath: string): boolean {
    const { spawnSync } = require("child_process") as typeof import("child_process")
    try {
      const r = spawnSync("git", ["-C", worktreePath, "rev-parse", "--git-dir"], { timeout: 10000 })
      return r.status === 0
    } catch {
      return false
    }
  }

  /** worktree 落成后的元数据写出：config.json.repos + CLAUDE.md（与循环体时代
   *  逐字一致 — config.repos 是 archiving-service resolveWorktree 的读取面）。 */
  writeSpecWorktreeMeta(
    workspacePath: string,
    entries: SpecWorktreeEntry[],
    wsName: string,
  ): void {
    if (entries.length === 0) return
    updateWorkspaceConfig(workspacePath, (config) => {
      config.repos = entries.map(e => ({
        name: e.name, main_path: e.main_path, worktree_path: e.worktree_path, branch: e.branch,
        ...(e.group ? { group: e.group } : {}),
        ...(e.base_branch ? { base_branch: e.base_branch } : {}),
        ...(e.target_branch ? { target_branch: e.target_branch } : {}),
      }))
    })

    const claudeLines = [
      `# 工作空间: ${wsName}`, "",
      "## 涉及项目 (git worktree)", "",
    ]
    for (const e of entries) {
      claudeLines.push(`- **${e.name}**: \`${e.worktree_path}\` [${e.branch}]`)
      claudeLines.push(`  - 主仓库: \`${e.main_path}\``)
      if (e.base_branch || e.target_branch) {
        claudeLines.push(`  - 分支计划: ← \`${e.base_branch ?? "?"}\` → 合入 \`${e.target_branch ?? e.base_branch ?? "?"}\``)
      }
    }
    claudeLines.push("", "## 说明", "- 此工作空间由调度器自动创建")
    upsertManagedBlock(
      workspaceInstructionPath(workspacePath),
      claudeLines.join("\n"),
      WORKSPACE_CLAUDE_BEGIN,
      WORKSPACE_CLAUDE_END,
    )
    ensureRootClaudePointer(workspacePath)
  }

  private writeProjectConfig(
    workspacePath: string,
    entries: { name: string; group: string; main_path: string; worktree_path: string }[],
  ): void {
    updateWorkspaceConfig(workspacePath, (config) => {
      config.repos = entries.map(e => ({ name: e.name, group: e.group, main_path: e.main_path, worktree_path: e.worktree_path }))
    })
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
      "- 修改代码时直接操作各 worktree 目录",
      "- 主仓库保持干净，开发分支仅在 worktree 中",
    )
    claudeLines.push(...workspaceGuide())
    upsertManagedBlock(
      workspaceInstructionPath(workspacePath),
      claudeLines.join("\n"),
      WORKSPACE_CLAUDE_BEGIN,
      WORKSPACE_CLAUDE_END,
    )
    ensureRootClaudePointer(workspacePath)
  }
}
