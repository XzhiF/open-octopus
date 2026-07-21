import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import app from "../../index"

describe("GET /api/repos", () => {
  let tmpDir: string
  let origHome: string | undefined
  let origOctopus: string | undefined

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "octopus-repos-api-test-"))
    origHome = process.env.HOME
    origOctopus = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = tmpDir
  })

  afterAll(() => {
    process.env.OCTOPUS_HOME = origOctopus ?? ""
    if (origHome) process.env.HOME = origHome
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    // Clean up any org dirs between tests
    const orgsDir = join(tmpDir, "orgs")
    if (existsSync(orgsDir)) {
      rmSync(orgsDir, { recursive: true, force: true })
    }
  })

  it("returns 400 when org parameter missing", async () => {
    const res = await app.request("/api/repos")
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("MISSING_ORG")
  })

  it("returns empty groups when manifest does not exist", async () => {
    const res = await app.request("/api/repos?org=nonexistent")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.groups).toEqual({})
    expect(body.org).toBe("nonexistent")
  })

  it("reads manifest.json when it exists", async () => {
    const org = "test-org-json"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })

    const manifest = {
      groups: {
        xzf: [
          { name: "proj-a", git_url: "https://github.com/xzf/a.git", branch: "main", manual_tags: [], group: "xzf" },
          { name: "proj-b", git_url: "https://github.com/xzf/b.git", branch: "develop", manual_tags: ["api"], group: "xzf" },
        ],
      },
    }
    writeFileSync(join(reposDir, "manifest.json"), JSON.stringify(manifest), "utf-8")

    const res = await app.request(`/api/repos?org=${org}`)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.org).toBe(org)
    expect(body.groups.xzf).toHaveLength(2)
    expect(body.groups.xzf[0].name).toBe("proj-a")
    expect(body.groups.xzf[1].manual_tags).toEqual(["api"])
  })

  it("falls back to manifest.md when json does not exist", async () => {
    const org = "test-org-md"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })

    const mdContent = `## mygroup

- my-project [main] https://github.com/org/my-project.git
`
    writeFileSync(join(reposDir, "manifest.md"), mdContent, "utf-8")

    const res = await app.request(`/api/repos?org=${org}`)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.org).toBe(org)
    expect(body.groups.mygroup).toHaveLength(1)
    expect(body.groups.mygroup[0].name).toBe("my-project")
  })

  it("prefers manifest.json over manifest.md", async () => {
    const org = "test-org-both"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })

    // Write both files with different content
    writeFileSync(join(reposDir, "manifest.md"), `## md-group\n- md-proj https://github.com/md.git\n`, "utf-8")
    writeFileSync(
      join(reposDir, "manifest.json"),
      JSON.stringify({ groups: { "json-group": [{ name: "json-proj", git_url: "https://github.com/json.git", branch: "main", manual_tags: [], group: "json-group" }] } }),
      "utf-8"
    )

    const res = await app.request(`/api/repos?org=${org}`)
    expect(res.status).toBe(200)

    const body = await res.json()
    // Should read from JSON, not MD
    expect(body.groups["json-group"]).toBeDefined()
    expect(body.groups["md-group"]).toBeUndefined()
  })

  it("returns 500 for malformed JSON", async () => {
    const org = "test-org-corrupt"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })

    writeFileSync(join(reposDir, "manifest.json"), "{invalid json content", "utf-8")

    const res = await app.request(`/api/repos?org=${org}`)
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body.error.code).toBe("PARSE_ERROR")
  })
})

describe("POST /api/repos", () => {
  let tmpDir: string
  let origOctopus: string | undefined

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "octopus-repos-post-test-"))
    origOctopus = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = tmpDir
  })

  afterAll(() => {
    process.env.OCTOPUS_HOME = origOctopus ?? ""
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    const orgsDir = join(tmpDir, "orgs")
    if (existsSync(orgsDir)) {
      rmSync(orgsDir, { recursive: true, force: true })
    }
  })

  it("creates a new repo and writes manifest.json", async () => {
    const org = "test-org"
    const res = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "my-repo",
        git_url: "git@github.com:xzf/my-repo.git",
        branch: "main",
        group: "Core",
        manual_tags: ["typescript"],
        org,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.entry.name).toBe("my-repo")
    expect(body.entry.group).toBe("Core")

    // Verify file was written
    const manifestPath = join(tmpDir, "orgs", org, "repos", "manifest.json")
    expect(existsSync(manifestPath)).toBe(true)
    const content = JSON.parse(readFileSync(manifestPath, "utf-8"))
    expect(content.groups.Core).toHaveLength(1)
    expect(content.groups.Core[0].name).toBe("my-repo")
    expect(content.groups.Core[0].git_url).toBe("git@github.com:xzf/my-repo.git")
  })

  it("returns 409 for duplicate name", async () => {
    const org = "test-org-dup"
    const payload = {
      name: "dup-repo",
      git_url: "git@github.com:xzf/a.git",
      branch: "main",
      group: "Core",
      manual_tags: [],
      org,
    }

    const res1 = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    expect(res1.status).toBe(200)

    const res2 = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    expect(res2.status).toBe(409)
    const body = await res2.json()
    expect(body.error.code).toBe("DUPLICATE_NAME")
  })

  it("returns 400 for missing required fields", async () => {
    const res = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", git_url: "git@x.git", branch: "main", group: "G", manual_tags: [], org: "o" }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("VALIDATION_ERROR")
  })

  it("returns 400 for invalid JSON body", async () => {
    const res = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("INVALID_PARAM")
  })

  it("defaults branch to main and manual_tags to []", async () => {
    const org = "test-org-defaults"
    const res = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "defaults-repo",
        git_url: "git@github.com:xzf/d.git",
        group: "Utils",
        org,
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entry.branch).toBe("main")
    expect(body.entry.manual_tags).toEqual([])
  })
})

describe("PUT /api/repos/:name", () => {
  let tmpDir: string
  let origOctopus: string | undefined

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "octopus-repos-put-test-"))
    origOctopus = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = tmpDir
  })

  afterAll(() => {
    process.env.OCTOPUS_HOME = origOctopus ?? ""
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    const orgsDir = join(tmpDir, "orgs")
    if (existsSync(orgsDir)) {
      rmSync(orgsDir, { recursive: true, force: true })
    }
  })

  it("updates existing repo fields", async () => {
    const org = "test-org-put"
    // Create first
    await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "update-me",
        git_url: "git@github.com:xzf/old.git",
        branch: "main",
        group: "Core",
        manual_tags: [],
        org,
      }),
    })

    // Update branch
    const res = await app.request("/api/repos/update-me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "develop", org }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.entry.branch).toBe("develop")
    expect(body.entry.git_url).toBe("git@github.com:xzf/old.git") // unchanged

    // Verify file
    const manifestPath = join(tmpDir, "orgs", org, "repos", "manifest.json")
    const content = JSON.parse(readFileSync(manifestPath, "utf-8"))
    expect(content.groups.Core[0].branch).toBe("develop")
  })

  it("returns 404 for nonexistent repo", async () => {
    const org = "test-org-put-404"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })
    writeFileSync(join(reposDir, "manifest.json"), JSON.stringify({ groups: {} }), "utf-8")

    const res = await app.request("/api/repos/ghost", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "main", org }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("NOT_FOUND")
  })

  it("handles group change: moves entry to new group", async () => {
    const org = "test-org-put-group"
    await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "move-me",
        git_url: "git@github.com:xzf/m.git",
        branch: "main",
        group: "OldGroup",
        manual_tags: [],
        org,
      }),
    })

    const res = await app.request("/api/repos/move-me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group: "NewGroup", org }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entry.group).toBe("NewGroup")

    // Verify file: OldGroup should be gone (empty), NewGroup has the entry
    const manifestPath = join(tmpDir, "orgs", org, "repos", "manifest.json")
    const content = JSON.parse(readFileSync(manifestPath, "utf-8"))
    expect(content.groups.OldGroup).toBeUndefined()
    expect(content.groups.NewGroup).toHaveLength(1)
    expect(content.groups.NewGroup[0].name).toBe("move-me")
  })

  it("returns 400 for missing org", async () => {
    const res = await app.request("/api/repos/some-repo", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "main" }),
    })
    expect(res.status).toBe(400)
  })
})

describe("DELETE /api/repos/:name", () => {
  let tmpDir: string
  let origOctopus: string | undefined

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "octopus-repos-del-test-"))
    origOctopus = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = tmpDir
  })

  afterAll(() => {
    process.env.OCTOPUS_HOME = origOctopus ?? ""
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    const orgsDir = join(tmpDir, "orgs")
    if (existsSync(orgsDir)) {
      rmSync(orgsDir, { recursive: true, force: true })
    }
  })

  it("deletes repo and updates manifest.json", async () => {
    const org = "test-org-del"
    // Create first
    await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "delete-me",
        git_url: "git@github.com:xzf/d.git",
        branch: "main",
        group: "Core",
        manual_tags: [],
        org,
      }),
    })

    // Delete
    const res = await app.request(`/api/repos/delete-me?org=${org}`, { method: "DELETE" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    // Verify file: group should be removed (was only entry)
    const manifestPath = join(tmpDir, "orgs", org, "repos", "manifest.json")
    const content = JSON.parse(readFileSync(manifestPath, "utf-8"))
    expect(content.groups.Core).toBeUndefined()
  })

  it("returns 404 for nonexistent repo", async () => {
    const org = "test-org-del-404"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })
    writeFileSync(join(reposDir, "manifest.json"), JSON.stringify({ groups: {} }), "utf-8")

    const res = await app.request(`/api/repos/ghost?org=${org}`, { method: "DELETE" })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("NOT_FOUND")
  })

  it("returns 400 when org missing", async () => {
    const res = await app.request("/api/repos/some-repo", { method: "DELETE" })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("MISSING_ORG")
  })

  it("keeps group when other entries remain", async () => {
    const org = "test-org-del-keep"
    // Create two repos in same group
    for (const name of ["keep-me", "delete-me"]) {
      await app.request("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          git_url: `git@github.com:xzf/${name}.git`,
          branch: "main",
          group: "Shared",
          manual_tags: [],
          org,
        }),
      })
    }

    // Delete one
    const res = await app.request(`/api/repos/delete-me?org=${org}`, { method: "DELETE" })
    expect(res.status).toBe(200)

    // Verify: Shared group still exists with keep-me
    const manifestPath = join(tmpDir, "orgs", org, "repos", "manifest.json")
    const content = JSON.parse(readFileSync(manifestPath, "utf-8"))
    expect(content.groups.Shared).toHaveLength(1)
    expect(content.groups.Shared[0].name).toBe("keep-me")
  })

  it("POST then DELETE roundtrip: file reflects removal", async () => {
    const org = "test-org-roundtrip"

    // POST
    const postRes = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "roundtrip",
        git_url: "git@github.com:xzf/rt.git",
        branch: "main",
        group: "Test",
        manual_tags: ["e2e"],
        org,
      }),
    })
    expect(postRes.status).toBe(200)

    // Verify POST wrote to file
    const manifestPath = join(tmpDir, "orgs", org, "repos", "manifest.json")
    let content = JSON.parse(readFileSync(manifestPath, "utf-8"))
    expect(content.groups.Test).toHaveLength(1)

    // DELETE
    const delRes = await app.request(`/api/repos/roundtrip?org=${org}`, { method: "DELETE" })
    expect(delRes.status).toBe(200)

    // Verify DELETE removed from file
    content = JSON.parse(readFileSync(manifestPath, "utf-8"))
    expect(content.groups.Test).toBeUndefined()

    // GET confirms empty
    const getRes = await app.request(`/api/repos?org=${org}`)
    const getBody = await getRes.json()
    expect(getBody.groups).toEqual({})
  })
})

describe("POST /api/repos/:name/clone", () => {
  let tmpDir: string
  let origOctopus: string | undefined

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "octopus-repos-clone-test-"))
    origOctopus = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = tmpDir
  })

  afterAll(() => {
    process.env.OCTOPUS_HOME = origOctopus ?? ""
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    const orgsDir = join(tmpDir, "orgs")
    if (existsSync(orgsDir)) {
      rmSync(orgsDir, { recursive: true, force: true })
    }
  })

  it("returns 400 when org missing", async () => {
    const res = await app.request("/api/repos/some-repo/clone", { method: "POST" })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("MISSING_ORG")
  })

  it("returns 404 for nonexistent repo", async () => {
    const org = "test-org-clone-404"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })
    writeFileSync(join(reposDir, "manifest.json"), JSON.stringify({ groups: {} }), "utf-8")

    const res = await app.request(`/api/repos/ghost/clone?org=${org}`, { method: "POST" })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("NOT_FOUND")
  })

  it("clones a repo from a real local git source", async () => {
    const org = "test-org-clone-real"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })

    // Create a real local git repo to clone from
    const sourceRepo = join(tmpDir, "source-repo")
    mkdirSync(sourceRepo, { recursive: true })
    const { execSync } = await import("child_process")
    execSync("git init", { cwd: sourceRepo, stdio: "pipe" })
    execSync("git config user.email test@test.com", { cwd: sourceRepo, stdio: "pipe" })
    execSync("git config user.name test", { cwd: sourceRepo, stdio: "pipe" })
    writeFileSync(join(sourceRepo, "README.md"), "# test", "utf-8")
    execSync("git add . && git commit -m init", { cwd: sourceRepo, stdio: "pipe" })

    // Register in manifest
    const manifest = {
      groups: {
        core: [
          { name: "my-proj", git_url: sourceRepo, branch: "master", manual_tags: [], group: "core" },
        ],
      },
    }
    writeFileSync(join(reposDir, "manifest.json"), JSON.stringify(manifest), "utf-8")

    const res = await app.request(`/api/repos/my-proj/clone?org=${org}`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    // Verify .git directory exists at clone destination
    const cloneBase = join(tmpDir, "orgs", org, "repos", "projects")
    const clonedDir = join(cloneBase, "core", "my-proj")
    expect(existsSync(clonedDir)).toBe(true)
    expect(existsSync(join(clonedDir, ".git"))).toBe(true)
  }, 30000)

  it("returns error when repo already cloned", async () => {
    const org = "test-org-clone-exists"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })

    // Create source and pre-existing clone
    const sourceRepo = join(tmpDir, "source-repo-2")
    mkdirSync(sourceRepo, { recursive: true })
    const { execSync } = await import("child_process")
    execSync("git init", { cwd: sourceRepo, stdio: "pipe" })
    execSync("git config user.email test@test.com", { cwd: sourceRepo, stdio: "pipe" })
    execSync("git config user.name test", { cwd: sourceRepo, stdio: "pipe" })
    writeFileSync(join(sourceRepo, "file.txt"), "hi", "utf-8")
    execSync("git add . && git commit -m init", { cwd: sourceRepo, stdio: "pipe" })

    // Create pre-existing clone directory
    const cloneBase = join(tmpDir, "orgs", org, "repos", "projects")
    const existingClone = join(cloneBase, "core", "dup-proj")
    mkdirSync(existingClone, { recursive: true })
    mkdirSync(join(existingClone, ".git"))

    const manifest = {
      groups: {
        core: [
          { name: "dup-proj", git_url: sourceRepo, branch: "master", manual_tags: [], group: "core" },
        ],
      },
    }
    writeFileSync(join(reposDir, "manifest.json"), JSON.stringify(manifest), "utf-8")

    const res = await app.request(`/api/repos/dup-proj/clone?org=${org}`, { method: "POST" })
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.message).toContain("已存在")
  }, 15000)

  it("returns failure for invalid git URL", async () => {
    const org = "test-org-clone-badurl"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })

    const manifest = {
      groups: {
        core: [
          { name: "bad-url", git_url: "not-a-valid-git-url", branch: "main", manual_tags: [], group: "core" },
        ],
      },
    }
    writeFileSync(join(reposDir, "manifest.json"), JSON.stringify(manifest), "utf-8")

    const res = await app.request(`/api/repos/bad-url/clone?org=${org}`, { method: "POST" })
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.message).toBeTruthy()
  }, 30000)
})

describe("POST /api/repos/:name/pull", () => {
  let tmpDir: string
  let origOctopus: string | undefined

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "octopus-repos-pull-test-"))
    origOctopus = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = tmpDir
  })

  afterAll(() => {
    process.env.OCTOPUS_HOME = origOctopus ?? ""
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    const orgsDir = join(tmpDir, "orgs")
    if (existsSync(orgsDir)) {
      rmSync(orgsDir, { recursive: true, force: true })
    }
  })

  it("returns error when repo not cloned", async () => {
    const org = "test-org-pull-noclone"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })

    const manifest = {
      groups: {
        core: [
          { name: "not-cloned", git_url: "git@github.com:xzf/a.git", branch: "main", manual_tags: [], group: "core" },
        ],
      },
    }
    writeFileSync(join(reposDir, "manifest.json"), JSON.stringify(manifest), "utf-8")

    const res = await app.request(`/api/repos/not-cloned/pull?org=${org}`, { method: "POST" })
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.message).toContain("not cloned")
  })

  it("returns 404 for nonexistent repo", async () => {
    const org = "test-org-pull-404"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })
    writeFileSync(join(reposDir, "manifest.json"), JSON.stringify({ groups: {} }), "utf-8")

    const res = await app.request(`/api/repos/ghost/pull?org=${org}`, { method: "POST" })
    expect(res.status).toBe(404)
  })
})

describe("POST /api/repos/pull-all", () => {
  let tmpDir: string
  let origOctopus: string | undefined

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "octopus-repos-pullall-test-"))
    origOctopus = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = tmpDir
  })

  afterAll(() => {
    process.env.OCTOPUS_HOME = origOctopus ?? ""
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    const orgsDir = join(tmpDir, "orgs")
    if (existsSync(orgsDir)) {
      rmSync(orgsDir, { recursive: true, force: true })
    }
  })

  it("returns 400 when org missing", async () => {
    const res = await app.request("/api/repos/pull-all", { method: "POST" })
    expect(res.status).toBe(400)
  })

  it("returns zero results when no repos cloned", async () => {
    const org = "test-org-pullall-empty"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })

    const manifest = {
      groups: {
        core: [
          { name: "proj-a", git_url: "git@github.com:xzf/a.git", branch: "main", manual_tags: [], group: "core" },
        ],
      },
    }
    writeFileSync(join(reposDir, "manifest.json"), JSON.stringify(manifest), "utf-8")

    const res = await app.request(`/api/repos/pull-all?org=${org}`, { method: "POST" })
    const body = await res.json()
    expect(body.success).toBe(0)
    expect(body.failed).toBe(0)
    expect(body.details).toEqual([])
  })
})

describe("POST /api/repos/clone-missing", () => {
  let tmpDir: string
  let origOctopus: string | undefined

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "octopus-repos-clonemissing-test-"))
    origOctopus = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = tmpDir
  })

  afterAll(() => {
    process.env.OCTOPUS_HOME = origOctopus ?? ""
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    const orgsDir = join(tmpDir, "orgs")
    if (existsSync(orgsDir)) {
      rmSync(orgsDir, { recursive: true, force: true })
    }
  })

  it("returns 400 when org missing", async () => {
    const res = await app.request("/api/repos/clone-missing", { method: "POST" })
    expect(res.status).toBe(400)
  })

  it("skips already cloned repos and reports failed for invalid URL", async () => {
    const org = "test-org-clonemissing-mix"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })

    // Create a pre-existing clone
    const cloneBase = join(tmpDir, "orgs", org, "repos", "projects")
    const existingClone = join(cloneBase, "core", "already-here")
    mkdirSync(existingClone, { recursive: true })
    mkdirSync(join(existingClone, ".git"))

    const manifest = {
      groups: {
        core: [
          { name: "already-here", git_url: "git@github.com:xzf/a.git", branch: "main", manual_tags: [], group: "core" },
          { name: "no-url", git_url: "", branch: "main", manual_tags: [], group: "core" },
        ],
      },
    }
    writeFileSync(join(reposDir, "manifest.json"), JSON.stringify(manifest), "utf-8")

    const res = await app.request(`/api/repos/clone-missing?org=${org}`, { method: "POST" })
    const body = await res.json()
    expect(body.cloned).toBe(0)
    expect(body.failed).toBe(1) // no-url should fail
    expect(body.details).toHaveLength(1)
    expect(body.details[0].name).toBe("no-url")
  })
})

describe("POST /api/repos/rebuild-index", () => {
  let tmpDir: string
  let origOctopus: string | undefined

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "octopus-repos-rebuild-test-"))
    origOctopus = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = tmpDir
  })

  afterAll(() => {
    process.env.OCTOPUS_HOME = origOctopus ?? ""
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    const orgsDir = join(tmpDir, "orgs")
    if (existsSync(orgsDir)) {
      rmSync(orgsDir, { recursive: true, force: true })
    }
  })

  it("returns 400 when org missing", async () => {
    const res = await app.request("/api/repos/rebuild-index", { method: "POST" })
    expect(res.status).toBe(400)
  })

  it("rebuilds index.json and does not modify manifest.json", async () => {
    const org = "test-org-rebuild"
    const reposDir = join(tmpDir, "orgs", org, "repos")
    mkdirSync(reposDir, { recursive: true })

    // Write manifest
    const manifest = {
      groups: {
        core: [
          { name: "proj-a", git_url: "git@github.com:xzf/a.git", branch: "main", manual_tags: ["api"], group: "core" },
          { name: "proj-b", git_url: "git@github.com:xzf/b.git", branch: "develop", manual_tags: [], group: "core" },
        ],
      },
    }
    const manifestPath = join(reposDir, "manifest.json")
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8")

    // Write old index.json with stale content
    const indexPath = join(reposDir, "index.json")
    writeFileSync(indexPath, "[]", "utf-8")

    // Record mtimes
    const manifestMtimeBefore = statSync(manifestPath).mtimeMs
    const indexMtimeBefore = statSync(indexPath).mtimeMs

    // Small delay to ensure mtime differs
    await new Promise(r => setTimeout(r, 100))

    const res = await app.request(`/api/repos/rebuild-index?org=${org}`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    // Verify index.json was updated
    const indexMtimeAfter = statSync(indexPath).mtimeMs
    expect(indexMtimeAfter).toBeGreaterThan(indexMtimeBefore)

    // Verify manifest.json mtime unchanged
    const manifestMtimeAfter = statSync(manifestPath).mtimeMs
    expect(manifestMtimeAfter).toBe(manifestMtimeBefore)

    const indexContent = JSON.parse(readFileSync(indexPath, "utf-8"))
    expect(Array.isArray(indexContent)).toBe(true)
    expect(indexContent.length).toBe(2)
    const names = indexContent.map((e: { name: string }) => e.name).sort()
    expect(names).toEqual(["proj-a", "proj-b"])

    // Verify manifest.json was NOT modified
    const manifestContent = JSON.parse(readFileSync(manifestPath, "utf-8"))
    expect(manifestContent.groups.core).toHaveLength(2)
    expect(manifestContent.groups.core[0].name).toBe("proj-a")
  })
})
