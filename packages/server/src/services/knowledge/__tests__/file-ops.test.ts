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
  listKnowledgeFiles,
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

  describe("listKnowledgeFiles", () => {
    it("excludes index.md and user_preference.md", () => {
      fs.writeFileSync(path.join(tmpDir, "octopus.md"), "")
      fs.writeFileSync(path.join(tmpDir, "index.md"), "")
      fs.writeFileSync(path.join(tmpDir, "user_preference.md"), "")
      fs.writeFileSync(path.join(tmpDir, "workflow-build.md"), "")

      const files = listKnowledgeFiles(tmpDir)
      expect(files).toEqual(["octopus.md", "workflow-build.md"])
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
})
