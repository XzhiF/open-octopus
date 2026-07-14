import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { archiveWorkspaceFiles } from "../archive-workspace-files"

function makeTempDirs(): { workspace: string; archive: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"))
  const archive = path.join(os.tmpdir(), `archive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return { workspace, archive }
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
}

describe("archiveWorkspaceFiles", () => {
  let workspace: string
  let archive: string

  beforeEach(() => {
    const tmp = makeTempDirs()
    workspace = tmp.workspace
    archive = tmp.archive
  })

  afterEach(() => {
    cleanup(workspace, archive)
  })

  it("copies all three subdirs preserving structure", () => {
    // Arrange
    fs.mkdirSync(path.join(workspace, "state"))
    fs.mkdirSync(path.join(workspace, "logs"))
    fs.mkdirSync(path.join(workspace, "docs"))
    fs.writeFileSync(path.join(workspace, "state", "executions.json"), '{"a":1}')
    fs.writeFileSync(path.join(workspace, "logs", "node.jsonl"), '{"event":"start"}')
    fs.writeFileSync(path.join(workspace, "docs", "guide.md"), "# Guide")

    // Act
    const result = archiveWorkspaceFiles(workspace, archive)

    // Assert
    expect(result.success).toBe(true)
    expect(result.archivePath).toBe(archive)
    expect(fs.existsSync(path.join(archive, "state", "executions.json"))).toBe(true)
    expect(fs.existsSync(path.join(archive, "logs", "node.jsonl"))).toBe(true)
    expect(fs.existsSync(path.join(archive, "docs", "guide.md"))).toBe(true)
    expect(fs.readFileSync(path.join(archive, "state", "executions.json"), "utf-8")).toBe('{"a":1}')
  })

  it("partial failure: one subdir unreadable, others succeed", () => {
    // Arrange
    fs.mkdirSync(path.join(workspace, "state"))
    fs.mkdirSync(path.join(workspace, "logs"))
    // docs does not exist — should be silently skipped (not a failure)
    fs.writeFileSync(path.join(workspace, "state", "data.json"), "{}")
    fs.writeFileSync(path.join(workspace, "logs", "log.jsonl"), "{}")

    // Create a file where "docs" directory should be — causes copy to fail
    fs.writeFileSync(path.join(workspace, "docs"), "I am a file, not a dir")

    // Act
    const result = archiveWorkspaceFiles(workspace, archive)

    // Assert — state and logs succeed, docs fails
    expect(result.success).toBe(true)
    expect(result.archivePath).toBe(archive)
    expect(fs.existsSync(path.join(archive, "state", "data.json"))).toBe(true)
    expect(fs.existsSync(path.join(archive, "logs", "log.jsonl"))).toBe(true)
  })

  it("empty workspace (no subdirs) returns success with empty archive", () => {
    // Arrange — workspace exists but has no state/logs/docs

    // Act
    const result = archiveWorkspaceFiles(workspace, archive)

    // Assert — no subdirs to copy = success with empty archive
    expect(result.success).toBe(true)
    expect(result.archivePath).toBe(archive)
    expect(fs.existsSync(archive)).toBe(true)
  })

  it("source dir doesn't exist returns failure", () => {
    // Arrange
    const nonExistent = path.join(os.tmpdir(), "no-such-ws-" + Date.now())

    // Act
    const result = archiveWorkspaceFiles(nonExistent, archive)

    // Assert
    expect(result.success).toBe(false)
    expect(result.archivePath).toBeNull()

    // Cleanup
    cleanup(nonExistent)
  })

  it("all subdirs fail returns failure", () => {
    // Arrange — workspace is a file, not a directory (all readdir will fail)
    const fakeWorkspace = path.join(os.tmpdir(), `fake-ws-${Date.now()}`)
    fs.writeFileSync(fakeWorkspace, "I am a file")

    // Act
    const result = archiveWorkspaceFiles(fakeWorkspace, archive)

    // Assert
    expect(result.success).toBe(false)
    expect(result.archivePath).toBeNull()

    // Cleanup
    cleanup(fakeWorkspace)
  })

  it("preserves nested directory structure", () => {
    // Arrange
    fs.mkdirSync(path.join(workspace, "logs", "abc123"), { recursive: true })
    fs.writeFileSync(path.join(workspace, "logs", "abc123", "node.jsonl"), '{"node":"bash"}')

    // Act
    const result = archiveWorkspaceFiles(workspace, archive)

    // Assert
    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(archive, "logs", "abc123", "node.jsonl"))).toBe(true)
  })
})
