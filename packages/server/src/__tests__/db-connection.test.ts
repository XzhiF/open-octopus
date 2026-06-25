import { describe, it, expect, afterEach } from "vitest"
import { getDb, initDb, closeDb } from "../db/connection"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_DB = path.join(os.tmpdir(), `test-octopus-${Date.now()}.db`)

describe("DB Connection", () => {
  afterEach(() => {
    closeDb()
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  })

  it("initializes db at specified path", () => {
    const db = initDb(TEST_DB)
    expect(db).toBeDefined()
    expect(db.open).toBe(true)
    expect(fs.existsSync(TEST_DB)).toBe(true)
  })

  it("getDb returns same instance", () => {
    const db1 = initDb(TEST_DB)
    const db2 = getDb()
    expect(db1).toBe(db2)
  })

  it("throws if getDb called before init", () => {
    closeDb()
    expect(() => getDb()).toThrow("not initialized")
  })

  it("enables WAL mode", () => {
    const db = initDb(TEST_DB)
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
    expect(row.journal_mode).toBe("wal")
  })
})