import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import { OrgDAO } from '../db/dao'
import path from "path"
import os from "os"
import { applySchema } from "../db/schema"
import { syncOrgsFromFilesystem, listOrgs, orgExists } from "../services/org"

let db: Database.Database
let testDir: string
let tmpfiles: string[] = []

beforeEach(() => {
  const dbPath = path.join(os.tmpdir(), `test-org-${Date.now()}.db`)
  tmpfiles.push(dbPath)
  db = new Database(dbPath)
  applySchema(db)

  testDir = path.join(os.tmpdir(), `test-octopus-${Date.now()}`)
  fs.mkdirSync(testDir, { recursive: true })
  tmpfiles.push(testDir)
})

afterEach(() => {
  db.close()
  for (const f of tmpfiles) {
    if (fs.existsSync(f)) fs.rmSync(f, { recursive: true, force: true })
  }
  tmpfiles = []
})

function createOrgDir(name: string, configYaml: string): string {
  const dir = path.join(testDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "config.yaml"), configYaml, "utf-8")
  return dir
}

describe("syncOrgsFromFilesystem", () => {
  it("discovers valid org directories", () => {
    createOrgDir("testorg", "name: TestOrg")
    const count = syncOrgsFromFilesystem(new OrgDAO(db), testDir)
    expect(count).toBe(1)
    const rows = listOrgs(new OrgDAO(db))
    expect(rows.find(r => r.name === "testorg")).toBeDefined()
  })

  it("skips directories without config.yaml", () => {
    fs.mkdirSync(path.join(testDir, "not-an-org"), { recursive: true })
    const count = syncOrgsFromFilesystem(new OrgDAO(db), testDir)
    expect(count).toBe(0)
  })

  it("skips directories with invalid config.yaml", () => {
    createOrgDir("broken", "not valid yaml: :::")
    const count = syncOrgsFromFilesystem(new OrgDAO(db), testDir)
    expect(count).toBe(0)
  })

  it("skips directories with config.yaml missing name field", () => {
    createOrgDir("noname", "description: no name here\nprefix: xx-")
    const count = syncOrgsFromFilesystem(new OrgDAO(db), testDir)
    expect(count).toBe(0)
  })

  it("is idempotent on repeated sync", () => {
    createOrgDir("myorg", "name: MyOrg")
    syncOrgsFromFilesystem(new OrgDAO(db), testDir)
    const count = syncOrgsFromFilesystem(new OrgDAO(db), testDir)
    expect(count).toBe(0)
    expect(listOrgs(new OrgDAO(db)).filter(r => r.name === "myorg").length).toBe(1)
  })

  it("discover multiple orgs while skipping non-org dirs", () => {
    createOrgDir("org-a", "name: OrgA")
    createOrgDir("org-b", "name: OrgB")
    fs.mkdirSync(path.join(testDir, "db"), { recursive: true })
    const count = syncOrgsFromFilesystem(new OrgDAO(db), testDir)
    expect(count).toBe(2)
  })
})

describe("orgExists", () => {
  it("returns true for existing org", () => {
    db.prepare("INSERT INTO orgs (name, path, created_at) VALUES (?, ?, ?)").run("test", "/t", new Date().toISOString())
    expect(orgExists(new OrgDAO(db), "test")).toBe(true)
  })

  it("returns false for nonexistent org", () => {
    expect(orgExists(new OrgDAO(db), "nonexistent")).toBe(false)
  })
})