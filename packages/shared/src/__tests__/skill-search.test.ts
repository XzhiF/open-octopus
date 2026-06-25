import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdir, writeFile, rm } from "fs/promises"
import { join } from "path"
import { searchSkills } from "../skill-search/searcher"

const TMP_DIR = join(process.env.TEMP || "/tmp", "skill-search-test")

const SKILL_MD_1 = `---
name: my-code-review
category: coding-assistant
description: 代码审查 Skill，支持中文规范
---
# Code Review Skill`

const SKILL_MD_2 = `---
name: my-devops-helper
category: devops
description: DevOps 自动化辅助工具
---
# DevOps Helper`

const SKILL_MD_3 = `---
name: my-troubleshooting
category: troubleshooting
description: 系统故障排查和诊断
---
# Troubleshooting`

beforeAll(async () => {
  await mkdir(join(TMP_DIR, "my-code-review"), { recursive: true })
  await mkdir(join(TMP_DIR, "my-devops-helper"), { recursive: true })
  await mkdir(join(TMP_DIR, "my-troubleshooting"), { recursive: true })
  await writeFile(join(TMP_DIR, "my-code-review", "SKILL.md"), SKILL_MD_1)
  await writeFile(join(TMP_DIR, "my-devops-helper", "SKILL.md"), SKILL_MD_2)
  await writeFile(join(TMP_DIR, "my-troubleshooting", "SKILL.md"), SKILL_MD_3)
})

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true })
})

describe("searchSkills", () => {
  it("finds skills by name keyword", async () => {
    const results = await searchSkills(TMP_DIR, "code-review")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].name).toBe("my-code-review")
    expect(results[0].category).toBe("coding-assistant")
  })

  it("finds skills by category filter", async () => {
    const results = await searchSkills(TMP_DIR, "devops", "devops")
    expect(results.length).toBe(1)
    expect(results[0].name).toBe("my-devops-helper")
  })

  it("returns empty when no match", async () => {
    const results = await searchSkills(TMP_DIR, "nonexistent-skill")
    expect(results.length).toBe(0)
  })

  it("returns empty when directory does not exist", async () => {
    const results = await searchSkills(join(TMP_DIR, "nonexistent-dir"), "anything")
    expect(results.length).toBe(0)
  })

  it("respects limit parameter", async () => {
    const results = await searchSkills(TMP_DIR, "my", undefined, 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it("sorts results by similarity descending", async () => {
    const results = await searchSkills(TMP_DIR, "my")
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity)
    }
  })
})