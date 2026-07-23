// packages/server/src/services/execution/GitOperations.ts
//
// Thin wrapper around gitOps for execution-specific git workflows:
// fork branches, execution branches, commit recording, and rollback.
//
import { gitOps } from "../git-ops"

export class GitOperations {
  constructor(private workspacePath: string) {}

  async ensureCleanWorkspace(): Promise<Record<string, string>> {
    const commits: Record<string, string> = {}
    await gitOps.allProjectsAction(this.workspacePath, async (projectPath, projectName) => {
      const hasChanges = await gitOps.hasUncommittedChanges(projectPath)
      if (hasChanges) {
        const sha = await gitOps.autoCommit(projectPath, "chore: fork前自动提交")
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

  async recordEndCommits(): Promise<string> {
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
