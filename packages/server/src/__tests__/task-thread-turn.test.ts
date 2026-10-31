// packages/server/src/__tests__/task-thread-turn.test.ts
//
// M1-2 — the two mechanical halves of a task-thread turn:
//   1. quick-edit auto-commit (one marked commit per dirty repo)
//   2. provider-transcript migration when identity switches cwd
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { commitWorkspaceEdits } from "../services/tasks/quick-edit"
import { QUICK_EDIT_MARKER, TAKEOVER_EDIT_MARKER } from "../services/git-ops"
import { migrateProviderTranscript, projectDirKey } from "../services/agent/resume"

let tmp: string
let wsPath: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim()
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thread-turn-"))
  wsPath = path.join(tmp, "ws")
  const repo = path.join(wsPath, "projects", "app")
  fs.mkdirSync(repo, { recursive: true })
  git(repo, "init", "-b", "main")
  git(repo, "config", "user.email", "t@t.io")
  git(repo, "config", "user.name", "T")
  fs.writeFileSync(path.join(repo, "seed.txt"), "s\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-m", "seed")
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("commitWorkspaceEdits", () => {
  it("lands one [quick-edit] commit when a repo is dirty", async () => {
    const repo = path.join(wsPath, "projects", "app")
    fs.writeFileSync(path.join(repo, "nickname.ts"), "export const x = 1\n")
    const commits = await commitWorkspaceEdits({
      wsPath,
      taskId: "task-1",
      sessionId: "session-1",
      content: "把昵称改成 *",
    })
    expect(commits).toHaveLength(1)
    expect(commits[0].repo).toBe("app")
    const subject = git(repo, "log", "-1", "--pretty=%s")
    expect(subject.startsWith(`${QUICK_EDIT_MARKER} 把昵称改成 *`)).toBe(true)
    const body = git(repo, "log", "-1", "--pretty=%b")
    expect(body).toContain("task: task-1")
    expect(body).toContain("doer_session: session-1")
  })

  it("is a no-op when nothing changed", async () => {
    const commits = await commitWorkspaceEdits({
      wsPath,
      taskId: "task-1",
      sessionId: "session-1",
      content: "noop",
    })
    expect(commits).toEqual([])
  })

  it("honours the takeover marker", async () => {
    const repo = path.join(wsPath, "projects", "app")
    fs.writeFileSync(path.join(repo, "takeover.ts"), "export const y = 2\n")
    const commits = await commitWorkspaceEdits({
      wsPath,
      taskId: "task-1",
      sessionId: "session-1",
      content: "人工接管",
      marker: TAKEOVER_EDIT_MARKER,
    })
    expect(commits).toHaveLength(1)
    expect(git(repo, "log", "-1", "--pretty=%s").startsWith(TAKEOVER_EDIT_MARKER)).toBe(true)
  })
})

describe("migrateProviderTranscript", () => {
  it("copies the provider session files to the new cwd bucket", () => {
    const oldCwd = path.join(tmp, "old-cwd")
    const newCwd = path.join(tmp, "new-cwd")
    const config = path.join(tmp, "claude-config")
    const oldDir = path.join(config, "projects", projectDirKey(oldCwd))
    fs.mkdirSync(oldDir, { recursive: true })
    fs.writeFileSync(path.join(oldDir, "sid-1.jsonl"), '{"x":1}\n')
    fs.writeFileSync(path.join(oldDir, "other.jsonl"), '{}\n')

    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = config
    try {
      expect(migrateProviderTranscript(oldCwd, newCwd, "sid-1")).toBe(true)
      const newDir = path.join(config, "projects", projectDirKey(newCwd))
      expect(fs.existsSync(path.join(newDir, "sid-1.jsonl"))).toBe(true)
      expect(fs.existsSync(path.join(newDir, "other.jsonl"))).toBe(false)
      // idempotent
      expect(migrateProviderTranscript(oldCwd, newCwd, "sid-1")).toBe(false)
      // no source → false, never throws
      expect(migrateProviderTranscript(path.join(tmp, "nope"), newCwd, "sid-1")).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  })
})
