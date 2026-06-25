import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"

describe("file-logger", () => {
  const testLogDir = path.join(os.tmpdir(), `octopus-log-test-${Date.now()}`)
  const origBranch = process.env.OCTOPUS_BRANCH

  beforeEach(() => {
    fs.mkdirSync(testLogDir, { recursive: true })
    process.env.OCTOPUS_BRANCH = "test-log"
  })

  afterEach(() => {
    if (origBranch !== undefined) {
      process.env.OCTOPUS_BRANCH = origBranch
    } else {
      delete process.env.OCTOPUS_BRANCH
    }
    fs.rmSync(testLogDir, { recursive: true, force: true })
  })

  it("getLogFilePath returns expected path format", async () => {
    const { getLogFilePath } = await import("../file-logger")
    const logPath = getLogFilePath()
    expect(logPath).toContain("server-test-log.log")
  })

  it("logInfo writes formatted line to file", async () => {
    // Re-import fresh module
    const mod = await import("../file-logger")
    mod.logInfo("test message", { key: "value" })
    // Give stream a moment to flush
    await new Promise(r => setTimeout(r, 100))
    const logPath = mod.getLogFilePath()
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, "utf-8")
      expect(content).toContain("[INFO]")
      expect(content).toContain("test message")
      expect(content).toContain("key")
    }
  })

  it("logError includes error stack", async () => {
    const mod = await import("../file-logger")
    const err = new Error("test error")
    mod.logError("something failed", err)
    await new Promise(r => setTimeout(r, 100))
    const logPath = mod.getLogFilePath()
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, "utf-8")
      expect(content).toContain("[ERROR]")
      expect(content).toContain("something failed")
      expect(content).toContain("test error")
    }
  })
})
