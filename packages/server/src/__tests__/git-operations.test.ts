// packages/server/src/__tests__/git-operations.test.ts
//
// Task round end-anchor safety net: the acceptance evidence window
// (`GET /round-diff`) is a START..END *commit* range. A task round whose work
// is still uncommitted at terminal time (ship node refused/absent) used to
// snapshot END = START, so 「变更」rendered empty even though the round wrote
// files and a later quick-edit landed them. `recordEndCommits(true)` — the task
// round path — must land those leftovers BEFORE reading HEAD.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { GitOperations } from "../services/execution/GitOperations"

let ws: string
let repo: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim()
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-"))
  repo = path.join(ws, "projects", "app")
  fs.mkdirSync(repo, { recursive: true })
  git(repo, "init", "-b", "main")
  git(repo, "config", "user.email", "t@t.io")
  git(repo, "config", "user.name", "T")
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-m", "base")
})

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

describe("GitOperations.recordEndCommits", () => {
  it("autoCommitDirty=true lands leftover round work BEFORE snapshotting the anchor", async () => {
    const base = git(repo, "rev-parse", "HEAD")
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n")
    expect(git(repo, "status", "--porcelain")).toContain("b.txt")

    const end = JSON.parse(await new GitOperations(ws).recordEndCommits(true)) as Record<string, string>

    expect(end.app).toBeTruthy()
    expect(end.app).not.toBe(base)
    expect(git(repo, "rev-parse", "HEAD")).toBe(end.app)
    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(git(repo, "log", "-1", "--format=%s")).toContain("落盘本轮遗留改动")
    // The evidence window now covers the work: base..end has one commit with the file.
    expect(git(repo, "diff", "--name-only", base!, end.app!)).toBe("b.txt")
  })

  it("autoCommitDirty=false keeps the legacy behaviour (dirty tree stays out of the window)", async () => {
    const base = git(repo, "rev-parse", "HEAD")
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n")

    const end = JSON.parse(await new GitOperations(ws).recordEndCommits()) as Record<string, string>

    expect(end.app).toBe(base)
    expect(git(repo, "status", "--porcelain")).toContain("b.txt")
  })
})
