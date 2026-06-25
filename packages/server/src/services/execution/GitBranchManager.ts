// packages/server/src/services/execution/GitBranchManager.ts
import type { IGitBranchManager } from "./interfaces"
import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

/** Validate branch name: only allow alphanumeric, /, -, _, . */
const SAFE_BRANCH_RE = /^[a-zA-Z0-9/_\-.]+$/

function assertSafeBranch(name: string, label: string): void {
  if (!SAFE_BRANCH_RE.test(name)) {
    throw new Error(`Invalid ${label}: "${name}" contains disallowed characters`)
  }
}

export class GitBranchManager implements IGitBranchManager {
  constructor(private workspacePath: string) {}

  async createExecutionBranch(executionId: string, parentBranch?: string): Promise<string> {
    const branchName = `execution/${executionId.slice(0, 8)}`
    assertSafeBranch(branchName, "branchName")

    try {
      const baseBranch = parentBranch || await this.getCurrentBranch()
      assertSafeBranch(baseBranch, "baseBranch")

      // execFile with array args — no shell interpolation
      await execFileAsync("git", ["checkout", "-b", branchName, baseBranch], {
        cwd: this.workspacePath,
      })

      return branchName
    } catch (error: any) {
      throw new Error(`Failed to create branch: ${error.message}`)
    }
  }

  async switchToBranch(branch: string): Promise<void> {
    assertSafeBranch(branch, "branch")
    try {
      await execFileAsync("git", ["checkout", branch], {
        cwd: this.workspacePath,
      })
    } catch (error: any) {
      throw new Error(`Failed to switch to branch ${branch}: ${error.message}`)
    }
  }

  async getCurrentBranch(): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.workspacePath,
      })
      return stdout.trim()
    } catch (error: any) {
      throw new Error(`Failed to get current branch: ${error.message}`)
    }
  }
}
