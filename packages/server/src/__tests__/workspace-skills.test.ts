// 工作区自带技能枚举：<workspace>/.claude/skills/*/SKILL.md

import { describe, it, expect } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { listWorkspaceSkills } from "../services/workspace-skills"

function makeSkill(root: string, name: string, content = "# skill\n") {
  const dir = path.join(root, ".claude", "skills", name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), content)
}

describe("listWorkspaceSkills", () => {
  it("枚举带 SKILL.md 的技能目录并排序", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octo-ws-skills-"))
    try {
      makeSkill(root, "z-skill", "0123456789")
      makeSkill(root, "a-skill", "# a\n")
      fs.mkdirSync(path.join(root, ".claude", "skills", "empty-dir"), { recursive: true })

      const items = listWorkspaceSkills(root)
      expect(items.map((s) => s.name)).toEqual(["a-skill", "z-skill"])
      expect(items.every((s) => s.source === "workspace")).toBe(true)
      expect(items.find((s) => s.name === "z-skill")?.token_count).toBe(3)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("没有 .claude/skills 时返回空数组", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octo-ws-empty-"))
    try {
      expect(listWorkspaceSkills(root)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
