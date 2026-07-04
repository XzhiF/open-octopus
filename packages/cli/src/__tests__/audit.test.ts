import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest"
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AuditLogger } from "../repository/audit-logger"

const baseTmpDir = mkdtempSync(join(tmpdir(), "octopus-audit-test-"))

describe("AuditLogger", () => {
  let testDir: string
  let logPath: string
  let logger: AuditLogger

  beforeEach(() => {
    testDir = mkdtempSync(join(baseTmpDir, "log-"))
    logPath = join(testDir, "audit.jsonl")
    logger = new AuditLogger(logPath)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(baseTmpDir, { recursive: true, force: true })
  })

  it("creates log directory on construction", () => {
    const deep = join(testDir, "deep", "nested", "audit.jsonl")
    const l = new AuditLogger(deep)
    expect(existsSync(join(testDir, "deep", "nested"))).toBe(true)
  })

  it("getLogPath() returns the path", () => {
    expect(logger.getLogPath()).toBe(logPath)
  })

  it("readLast() returns empty array when no log file", () => {
    expect(logger.readLast()).toEqual([])
  })

  it("log() appends a JSON line", () => {
    logger.log("config.parsed", { name: "test-config" })
    const entries = logger.readLast()
    expect(entries).toHaveLength(1)
    expect(entries[0].action).toBe("config.parsed")
    expect(entries[0].name).toBe("test-config")
    expect(entries[0].status).toBe("success")
    expect(entries[0].timestamp).toBeDefined()
  })

  it("log() records caller from env", () => {
    const prev = process.env.OCTOPUS_CALLER
    process.env.OCTOPUS_CALLER = "agent"
    try {
      logger.log("resource.installed", { name: "x" })
      const entries = logger.readLast()
      expect(entries[0].caller).toBe("agent")
    } finally {
      if (prev === undefined) delete process.env.OCTOPUS_CALLER
      else process.env.OCTOPUS_CALLER = prev
    }
  })

  it("log() defaults caller to human", () => {
    const prev = process.env.OCTOPUS_CALLER
    delete process.env.OCTOPUS_CALLER
    try {
      logger.log("lock.updated", {})
      const entries = logger.readLast()
      expect(entries[0].caller).toBe("human")
    } finally {
      if (prev !== undefined) process.env.OCTOPUS_CALLER = prev
    }
  })

  it("readLast() returns last N entries", () => {
    for (let i = 0; i < 5; i++) {
      logger.log("config.parsed", { detail: { i } })
    }
    expect(logger.readLast()).toHaveLength(5)
    expect(logger.readLast(3)).toHaveLength(3)
    expect(logger.readLast(3)[0].detail).toEqual({ i: 2 })
  })

  it("readLast() skips corrupted lines", () => {
    const { appendFileSync } = require("fs")
    appendFileSync(logPath, '{"action":"ok","timestamp":"x","caller":"human","status":"success"}\n', "utf-8")
    appendFileSync(logPath, 'NOT JSON\n', "utf-8")
    appendFileSync(logPath, '{"action":"ok2","timestamp":"y","caller":"human","status":"success"}\n', "utf-8")
    const entries = logger.readLast()
    expect(entries).toHaveLength(2)
  })

  it("multiple log() calls append sequentially", () => {
    logger.log("config.parsed", { name: "a" })
    logger.log("resource.installed", { name: "b" })
    logger.log("lock.updated", { name: "c" })
    const entries = logger.readLast()
    expect(entries).toHaveLength(3)
    expect(entries.map(e => e.action)).toEqual(["config.parsed", "resource.installed", "lock.updated"])
  })
})
