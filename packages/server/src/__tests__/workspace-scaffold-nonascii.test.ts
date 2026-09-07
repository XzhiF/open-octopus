// Regression for the 2026-09-07 v4 dispatch crash: on Node v24/Windows,
// fs.cpSync({recursive:true}) with a non-ASCII DEST path fastfails the whole
// process (0xC0000409 — no JS exception, no V8 report). v4 task workspaces
// carry the (possibly Chinese) task title in their directory name, so every
// scaffold/provision copy into such a workspace is on the hazard path.
// WorkspaceScaffold.copySkill now recurses with mkdir+copyFileSync
// (copyDirSafe). If cpSync ever re-enters this chain, on Windows this test
// kills the worker instead of failing red — treat a dead run as a crash hit.

import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { WorkspaceScaffold } from "../services/workspace-scaffold"

describe("WorkspaceScaffold.copySkill — non-ASCII workspace path", () => {
  it("copies core-pack skills into a workspace dir named after a Chinese task title", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-nonascii-"))
    try {
      const wsChinese = path.join(tempDir, "task我现在需要一个全局token计费的功能-0907-144121")
      fs.mkdirSync(wsChinese, { recursive: true })

      new WorkspaceScaffold().copySkill(wsChinese)

      // core-pack must be resolvable from the test cwd; if it were not,
      // copySkill returns without even creating the skills dir — assert
      // real content so the test cannot vacuously pass.
      const skillMd = path.join(
        wsChinese, ".claude", "skills", "octo-dev-copilot", "SKILL.md",
      )
      expect(fs.existsSync(skillMd)).toBe(true)
      expect(fs.readFileSync(skillMd, "utf-8")).toContain("octo-dev-copilot")
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
