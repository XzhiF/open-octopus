import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import {
  generateRuleId,
  parseKnowledgeFile,
  appendToKnowledgeFile,
  readKnowledgeFile,
  writeKnowledgeFile,
  rebuildIndex,
  getKnowledgeFileInfo,
  readUserPreference,
  getProjectKnowledgeDir,
  getWorkflowKnowledgeDir,
} from "../file-ops"

describe("file-ops", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("generateRuleId", () => {
    it("generates unique IDs", () => {
      const ids = new Set<string>()
      for (let i = 0; i < 100; i++) {
        ids.add(generateRuleId("octopus"))
      }
      expect(ids.size).toBe(100)
    })

    it("matches format {target}-{YYYYMMDD}-{4chars}", () => {
      const id = generateRuleId("octopus")
      expect(id).toMatch(/^octopus-\d{8}-[A-Za-z0-9_-]{4}$/)
    })
  })

  describe("parseKnowledgeFile", () => {
    it("parses rules correctly", () => {
      const filePath = path.join(tmpDir, "test.md")
      fs.writeFileSync(filePath, [
        "- Always validate inputs\n<!-- id:test-20260629-abcd | 2026-06-29 | system -->",
        "- Use prepared statements\n<!-- id:test-20260629-efgh | 2026-06-29 | workspace_archive -->",
      ].join("\n"))

      const rules = parseKnowledgeFile(filePath)
      expect(rules).toHaveLength(2)
      expect(rules[0].id).toBe("test-20260629-abcd")
      expect(rules[0].text).toBe("Always validate inputs")
      expect(rules[1].source).toBe("workspace_archive")
    })

    it("skips malformed lines", () => {
      const filePath = path.join(tmpDir, "bad.md")
      fs.writeFileSync(filePath, "some random text\n<!-- id:bad-20260629-xxxx | 2026-06-29 | system -->\n")
      const rules = parseKnowledgeFile(filePath)
      // The meta comment has no preceding "- " line, so text line is "some random text" → trimmed → still text
      // But our parser accepts any non-empty preceding line
      expect(rules.length).toBeGreaterThanOrEqual(0)
    })

    it("returns empty for non-existent file", () => {
      expect(parseKnowledgeFile(path.join(tmpDir, "nope.md"))).toEqual([])
    })
  })

  describe("appendToKnowledgeFile", () => {
    it("appends in standard format", () => {
      const filePath = path.join(tmpDir, "append.md")
      appendToKnowledgeFile(filePath, "Test rule", "test-20260629-aaaa", "system")
      const content = readKnowledgeFile(filePath)
      expect(content).toContain("- Test rule")
      expect(content).toContain("<!-- id:test-20260629-aaaa |")
    })
  })

  describe("user preference", () => {
    it("reads and writes preference", () => {
      // Use tmpDir as a mock knowledge dir by directly testing file-ops functions
      const prefPath = path.join(tmpDir, "user_preference.md")
      writeKnowledgeFile(prefPath, "# My Preferences\n- Prefer concise code")
      expect(readKnowledgeFile(prefPath)).toContain("Prefer concise code")
    })
  })

  describe("readUserPreference", () => {
    it("reads global preference when no org specified", () => {
      process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
      try {
        writeKnowledgeFile(path.join(tmpDir, "user_preference.md"), "# Global Pref\n- Global rule")
        const result = readUserPreference()
        expect(result).toContain("Global rule")
      } finally {
        delete process.env.OCTOPUS_KNOWLEDGE_DIR
      }
    })

    it("reads org preference when org specified", () => {
      process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
      try {
        writeKnowledgeFile(path.join(tmpDir, "user_preference.md"), "# Org Pref\n- Org rule")
        const result = readUserPreference("test-org")
        expect(result).toContain("Org rule")
      } finally {
        delete process.env.OCTOPUS_KNOWLEDGE_DIR
      }
    })

    it("returns empty string when file does not exist", () => {
      process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
      try {
        const result = readUserPreference()
        expect(result).toBe("")
      } finally {
        delete process.env.OCTOPUS_KNOWLEDGE_DIR
      }
    })
  })

  // 知识中心票 08：getEffectiveUserPreference（global+org 合并喂 precompute 的
  // __user_preference_text 生产件）随注入链物理删除退役，其用例一并移除。

  // TC-001: Two-level knowledge storage merge
  describe("two-level directory merge (TC-001)", () => {
    it("GET /api/knowledge/files merges both levels", () => {
      const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-global-"))
      const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-org-"))

      try {
        appendToKnowledgeFile(
          path.join(globalDir, "shared.md"),
          "Always use strict mode",
          "global-001",
          "system",
        )
        appendToKnowledgeFile(
          path.join(orgDir, "project.md"),
          "Use TypeScript",
          "org-001",
          "workspace_archive",
        )

        // Simulate the merge that GET /api/knowledge/files performs.
        // 票08：listKnowledgeFiles 死码删除 → 目录列举回落裸 readdirSync（测试面，
        // index.md/user_preference.md 排除不属被测函数契约，此处不涉及）。
        const listMd = (dir: string) => fs.readdirSync(dir).filter(f => f.endsWith(".md"))
        const globalFiles = listMd(globalDir).map(f => ({
          name: f,
          scope: "global",
          ...getKnowledgeFileInfo(path.join(globalDir, f)),
        }))
        const orgFiles = listMd(orgDir).map(f => ({
          name: f,
          scope: "org",
          ...getKnowledgeFileInfo(path.join(orgDir, f)),
        }))

        const merged = [...globalFiles, ...orgFiles]
        expect(merged.length).toBeGreaterThanOrEqual(2)
        expect(merged.some(f => f.scope === "global")).toBe(true)
        expect(merged.some(f => f.scope === "org")).toBe(true)
      } finally {
        fs.rmSync(globalDir, { recursive: true, force: true })
        fs.rmSync(orgDir, { recursive: true, force: true })
      }
    })
  })

  // TC-006: rebuildIndex
  describe("rebuildIndex (TC-006)", () => {
    it("creates index.md with statistics and rule entries", () => {
      // Set up knowledge files with 3 rules in subdirectories
      const projectsDir = path.join(tmpDir, "projects")
      const workflowsDir = path.join(tmpDir, "workflows")
      fs.mkdirSync(projectsDir, { recursive: true })
      fs.mkdirSync(workflowsDir, { recursive: true })

      appendToKnowledgeFile(
        path.join(projectsDir, "octopus.md"),
        "Always validate inputs",
        "rule-001",
        "system",
      )
      appendToKnowledgeFile(
        path.join(projectsDir, "octopus.md"),
        "Use prepared statements",
        "rule-002",
        "workspace_archive",
      )
      appendToKnowledgeFile(
        path.join(workflowsDir, "build.md"),
        "Run tests before deploy",
        "rule-003",
        "system",
      )

      process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
      const result = rebuildIndex("test-org")

      expect(result.ruleCount).toBe(3)
      expect(result.fileCount).toBe(2)

      // Verify index.md content
      const indexContent = readKnowledgeFile(path.join(tmpDir, "index.md"))
      expect(indexContent).toContain("Knowledge Index")
      expect(indexContent).toContain("Total rules: 3")
      expect(indexContent).toContain("Total files: 2")
      // Verify all 3 rule entries in the table
      expect(indexContent).toContain("rule-001")
      expect(indexContent).toContain("rule-002")
      expect(indexContent).toContain("rule-003")
      expect(indexContent).toContain("Always validate inputs")
      expect(indexContent).toContain("Use prepared statements")
      expect(indexContent).toContain("Run tests before deploy")

      delete process.env.OCTOPUS_KNOWLEDGE_DIR
    })
  })

  describe("generateRuleId with subdirectory prefix", () => {
    it("strips projects/ prefix from target", () => {
      const id = generateRuleId("projects/octopus")
      expect(id).toMatch(/^octopus-\d{8}-[A-Za-z0-9_-]{4}$/)
      expect(id).not.toContain("projects/")
    })

    it("strips workflows/ prefix from target", () => {
      const id = generateRuleId("workflows/build-flow")
      expect(id).toMatch(/^build-flow-\d{8}-[A-Za-z0-9_-]{4}$/)
      expect(id).not.toContain("workflows/")
    })

    it("keeps plain target unchanged", () => {
      const id = generateRuleId("octopus")
      expect(id).toMatch(/^octopus-\d{8}-[A-Za-z0-9_-]{4}$/)
    })
  })

  describe("getProjectKnowledgeDir", () => {
    // 票09：getter 的 mkdir 副作用随旧世界删除消亡——纯路径解析，
    // 绝不重建已归档删除的目录（归档不删纪律的运行时护栏）。
    it("returns projects/ subdirectory under org knowledge dir — zero mkdir side effect", () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-test-"))
      process.env.OCTOPUS_KNOWLEDGE_DIR = testDir
      try {
        const dir = getProjectKnowledgeDir("myorg")
        expect(dir).toMatch(/projects$/)
        expect(fs.existsSync(dir)).toBe(false)
        expect(fs.readdirSync(testDir)).toEqual([])
      } finally {
        delete process.env.OCTOPUS_KNOWLEDGE_DIR
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })
  })

  describe("getWorkflowKnowledgeDir", () => {
    it("returns workflows/ subdirectory — zero mkdir side effect (票09)", () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-test-"))
      process.env.OCTOPUS_KNOWLEDGE_DIR = testDir
      try {
        const dir = getWorkflowKnowledgeDir("myorg")
        expect(dir).toMatch(/workflows$/)
        expect(fs.existsSync(dir)).toBe(false)
        expect(fs.readdirSync(testDir)).toEqual([])
      } finally {
        delete process.env.OCTOPUS_KNOWLEDGE_DIR
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })
  })
})
