// P1 B1: OrgDAO/syncOrgsFromFilesystem 已 async（postgres.js）——
// 从 new Database(:memory:) 切 PG 随机测试库（README 施工图快路径）；用例语义与条数不变。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import { OrgDAO } from '../db/dao'
import path from "path"
import os from "os"
import { syncOrgsFromFilesystem, listOrgs, orgExists } from "../services/org"
import { describePg, setupPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"

let pg: PgFixture
let testDir: string
let tmpfiles: string[] = []

beforeEach(async () => {
  pg = await setupPgSchema()
  testDir = path.join(os.tmpdir(), `test-octopus-${Date.now()}`)
  fs.mkdirSync(testDir, { recursive: true })
  tmpfiles.push(testDir)
})

afterEach(async () => {
  await pg.close()
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

describePg("syncOrgsFromFilesystem", () => {
  it("discovers valid org directories", async () => {
    createOrgDir("testorg", "name: TestOrg")
    const count = await syncOrgsFromFilesystem(new OrgDAO(pg.sql), testDir)
    expect(count).toBe(1)
    const rows = await listOrgs(new OrgDAO(pg.sql))
    expect(rows.find(r => r.name === "testorg")).toBeDefined()
  })

  it("skips directories without config.yaml", async () => {
    fs.mkdirSync(path.join(testDir, "not-an-org"), { recursive: true })
    const count = await syncOrgsFromFilesystem(new OrgDAO(pg.sql), testDir)
    expect(count).toBe(0)
  })

  it("skips directories with invalid config.yaml", async () => {
    createOrgDir("broken", "not valid yaml: :::")
    const count = await syncOrgsFromFilesystem(new OrgDAO(pg.sql), testDir)
    expect(count).toBe(0)
  })

  it("skips directories with config.yaml missing name field", async () => {
    createOrgDir("noname", "description: no name here\nprefix: xx-")
    const count = await syncOrgsFromFilesystem(new OrgDAO(pg.sql), testDir)
    expect(count).toBe(0)
  })

  it("is idempotent on repeated sync", async () => {
    createOrgDir("myorg", "name: MyOrg")
    await syncOrgsFromFilesystem(new OrgDAO(pg.sql), testDir)
    const count = await syncOrgsFromFilesystem(new OrgDAO(pg.sql), testDir)
    expect(count).toBe(0)
    expect((await listOrgs(new OrgDAO(pg.sql))).filter(r => r.name === "myorg").length).toBe(1)
  })

  it("discover multiple orgs while skipping non-org dirs", async () => {
    createOrgDir("org-a", "name: OrgA")
    createOrgDir("org-b", "name: OrgB")
    fs.mkdirSync(path.join(testDir, "db"), { recursive: true })
    const count = await syncOrgsFromFilesystem(new OrgDAO(pg.sql), testDir)
    expect(count).toBe(2)
  })
})

describePg("orgExists", () => {
  it("returns true for existing org", async () => {
    await pg.sql`INSERT INTO orgs (name, path, created_at) VALUES (${"test"}, ${"/t"}, ${new Date().toISOString()})`
    expect(await orgExists(new OrgDAO(pg.sql), "test")).toBe(true)
  })

  it("returns false for nonexistent org", async () => {
    expect(await orgExists(new OrgDAO(pg.sql), "nonexistent")).toBe(false)
  })
})
