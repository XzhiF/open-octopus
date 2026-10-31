// packages/server/src/services/execution/GitOperations.ts
//
// Thin wrapper around gitOps for execution-specific git workflows:
// fork branches, execution branches, commit recording, and rollback.
//
import { gitOps } from "../git-ops"

export class GitOperations {
  constructor(private workspacePath: string) {}

  async ensureCleanWorkspace(message = "chore: fork前自动提交"): Promise<Record<string, string>> {
    const commits: Record<string, string> = {}
    await gitOps.allProjectsAction(this.workspacePath, async (projectPath, projectName) => {
      const hasChanges = await gitOps.hasUncommittedChanges(projectPath)
      if (hasChanges) {
        const sha = await gitOps.autoCommit(projectPath, message)
        commits[projectName] = sha
      }
    })
    return commits
  }

  async createForkBranch(branchName: string, baseCommit: Record<string, string>): Promise<void> {
    await gitOps.allProjectsAction(this.workspacePath, async (projectPath, projectName) => {
      const base = baseCommit[projectName]
      if (base) await gitOps.createBranch(projectPath, branchName, base)
    })
  }

  async switchToExecutionBranch(branch: string): Promise<void> {
    await gitOps.allProjectsAction(this.workspacePath, async (projectPath) => {
      await gitOps.createOrSwitchBranch(projectPath, branch)
    })
  }

  async recordStartCommits(): Promise<string> {
    const commits: Record<string, string> = {}
    await gitOps.allProjectsAction(this.workspacePath, async (projectPath, projectName) => {
      commits[projectName] = await gitOps.getHeadCommit(projectPath)
    })
    return JSON.stringify(commits)
  }

  /** Snapshot HEAD per repo as the round's end anchor.
   *
   *  `autoCommitDirty` (task rounds) first lands any leftover dirty work in the
   *  repo(s): the acceptance evidence window (`GET /round-diff`) is a START..END
   *  *commit* range, so a tree left dirty at terminal time sits outside it —
   *  「变更」shows nothing and the ledger has no 实物 even though the round did
   *  the work. The workflow's own ship node normally commits; when it refuses
   *  or is absent this is the safety net. Non-task executions keep the old
   *  behaviour (end anchor = whatever git HEAD already is). */
  async recordEndCommits(autoCommitDirty = false): Promise<string> {
    if (autoCommitDirty) {
      try {
        await this.ensureCleanWorkspace("chore(task): 落盘本轮遗留改动（验收证据快照）")
      } catch (err: unknown) {
        console.warn(
          "[execution] 落盘本轮遗留改动失败（非致命，继续取 end 锚）:",
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    return this.recordStartCommits()
  }

  async rollbackToStart(startCommitId: string): Promise<void> {
    const commits: Record<string, string> = JSON.parse(startCommitId)
    await gitOps.allProjectsAction(this.workspacePath, async (projectPath, projectName) => {
      const commit = commits[projectName]
      if (commit) {
        await gitOps.resetHard(projectPath, commit)
        await gitOps.cleanForce(projectPath)
      }
    })
  }
}
