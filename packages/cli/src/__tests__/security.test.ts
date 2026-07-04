import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest"
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { TrustStore, SecurityContext } from "../repository/security-context"
import { SecurityError } from "@octopus/shared"
import type { SourceRef } from "@octopus/shared"

const baseTmpDir = mkdtempSync(join(tmpdir(), "octopus-security-test-"))

// Cleanup once after all describes finish
afterAll(() => {
  rmSync(baseTmpDir, { recursive: true, force: true })
})

describe("TrustStore", () => {
  let testDir: string
  let trustPath: string
  let store: TrustStore

  beforeEach(() => {
    testDir = mkdtempSync(join(baseTmpDir, "trust-"))
    trustPath = join(testDir, "trusted-sources.yaml")
    store = new TrustStore(trustPath)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  const npmRef: SourceRef = { protocol: "npm", package: "lodash" }
  const githubRef: SourceRef = { protocol: "github", repo: "org/repo" }
  const localRef: SourceRef = { protocol: "local", path: "/tmp/something" }
  const builtinRef: SourceRef = { protocol: "builtin", id: "my-skill" }

  it("starts empty", () => {
    expect(store.listTrusted()).toEqual([])
    expect(store.listBlocked()).toEqual([])
  })

  it("lookup() returns 'unknown' for unregistered source", () => {
    expect(store.lookup(npmRef)).toBe("unknown")
  })

  it("remember() adds to trusted list", () => {
    store.remember(npmRef, "trusted")
    expect(store.lookup(npmRef)).toBe("trusted")
    expect(store.listTrusted()).toHaveLength(1)
    expect(store.listTrusted()[0].protocol).toBe("npm")
  })

  it("block() adds to blocked list", () => {
    store.block(npmRef, "malicious")
    expect(store.lookup(npmRef)).toBe("blocked")
    expect(store.listBlocked()).toHaveLength(1)
    expect(store.listBlocked()[0].reason).toBe("malicious")
  })

  it("blocked takes precedence over trusted", () => {
    store.remember(npmRef, "trusted")
    store.block(npmRef, "revoked")
    expect(store.lookup(npmRef)).toBe("blocked")
  })

  it("revoke() removes from both lists", () => {
    store.remember(npmRef, "trusted")
    store.block(githubRef, "bad")
    expect(store.revoke(npmRef)).toBe(true)
    expect(store.revoke(githubRef)).toBe(true)
    expect(store.lookup(npmRef)).toBe("unknown")
    expect(store.lookup(githubRef)).toBe("unknown")
  })

  it("revoke() returns false when nothing to remove", () => {
    expect(store.revoke(npmRef)).toBe(false)
  })

  it("distinguishes protocols correctly", () => {
    store.remember(npmRef, "trusted")
    store.remember(githubRef, "trusted")
    store.remember(localRef, "trusted")
    store.remember(builtinRef, "trusted")
    expect(store.listTrusted()).toHaveLength(4)
    expect(store.lookup(npmRef)).toBe("trusted")
    expect(store.lookup(githubRef)).toBe("trusted")
  })

  it("persists to YAML file", () => {
    store.remember(npmRef, "trusted")
    const store2 = new TrustStore(trustPath)
    expect(store2.lookup(npmRef)).toBe("trusted")
  })

  it("handles corrupted YAML gracefully", () => {
    writeFileSync(trustPath, "{{{{not yaml", "utf-8")
    const store2 = new TrustStore(trustPath)
    expect(store2.listTrusted()).toEqual([])
  })
})

describe("SecurityContext", () => {
  let testDir: string
  let trustStore: TrustStore
  let ctx: SecurityContext

  beforeEach(() => {
    testDir = mkdtempSync(join(baseTmpDir, "ctx-"))
    trustStore = new TrustStore(join(testDir, "trusted.yaml"))
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  const ref: SourceRef = { protocol: "npm", package: "lodash" }

  it("checkSourceTrust() passes for trusted source", async () => {
    trustStore.remember(ref, "trusted")
    ctx = new SecurityContext({ trustStore })
    await expect(ctx.checkSourceTrust(ref)).resolves.toBeUndefined()
  })

  it("checkSourceTrust() throws for blocked source", async () => {
    trustStore.block(ref, "bad")
    ctx = new SecurityContext({ trustStore })
    await expect(ctx.checkSourceTrust(ref)).rejects.toThrow(SecurityError)
    await expect(ctx.checkSourceTrust(ref)).rejects.toThrow(/blocked/)
  })

  it("checkSourceTrust() throws for unknown source (interactive)", async () => {
    ctx = new SecurityContext({ trustStore, autoTrust: false })
    await expect(ctx.checkSourceTrust(ref)).rejects.toThrow(SecurityError)
    await expect(ctx.checkSourceTrust(ref)).rejects.toThrow(/Unknown source/)
  })

  it("checkSourceTrust() auto-trusts in non-interactive mode", async () => {
    ctx = new SecurityContext({ trustStore, autoTrust: true })
    await expect(ctx.checkSourceTrust(ref)).resolves.toBeUndefined()
    expect(trustStore.lookup(ref)).toBe("trusted")
  })

  it("checkCallerPermission() blocks agent from admin ops", async () => {
    const prev = process.env.OCTOPUS_CALLER
    process.env.OCTOPUS_CALLER = "agent"
    try {
      ctx = new SecurityContext({ trustStore })
      await expect(ctx.checkCallerPermission("register")).rejects.toThrow(SecurityError)
      await expect(ctx.checkCallerPermission("gc")).rejects.toThrow(SecurityError)
    } finally {
      if (prev === undefined) delete process.env.OCTOPUS_CALLER
      else process.env.OCTOPUS_CALLER = prev
    }
  })

  it("checkCallerPermission() allows human for admin ops", async () => {
    const prev = process.env.OCTOPUS_CALLER
    delete process.env.OCTOPUS_CALLER
    try {
      ctx = new SecurityContext({ trustStore })
      await expect(ctx.checkCallerPermission("register")).resolves.toBeUndefined()
    } finally {
      if (prev !== undefined) process.env.OCTOPUS_CALLER = prev
    }
  })

  it("checkCallerPermission() allows agent for non-admin ops", async () => {
    const prev = process.env.OCTOPUS_CALLER
    process.env.OCTOPUS_CALLER = "agent"
    try {
      ctx = new SecurityContext({ trustStore })
      await expect(ctx.checkCallerPermission("lookup")).resolves.toBeUndefined()
      await expect(ctx.checkCallerPermission("list")).resolves.toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.OCTOPUS_CALLER
      else process.env.OCTOPUS_CALLER = prev
    }
  })

  it("checkAgentConfirmation() rejects --yes for agent", async () => {
    const prev = process.env.OCTOPUS_CALLER
    process.env.OCTOPUS_CALLER = "agent"
    try {
      ctx = new SecurityContext({ trustStore })
      await expect(ctx.checkAgentConfirmation("register", { yes: true })).rejects.toThrow(SecurityError)
    } finally {
      if (prev === undefined) delete process.env.OCTOPUS_CALLER
      else process.env.OCTOPUS_CALLER = prev
    }
  })

  it("checkAgentConfirmation() requires --confirmed for agent", async () => {
    const prev = process.env.OCTOPUS_CALLER
    process.env.OCTOPUS_CALLER = "agent"
    try {
      ctx = new SecurityContext({ trustStore })
      await expect(ctx.checkAgentConfirmation("register", {})).rejects.toThrow(SecurityError)
      await expect(ctx.checkAgentConfirmation("register", { confirmed: true })).resolves.toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.OCTOPUS_CALLER
      else process.env.OCTOPUS_CALLER = prev
    }
  })

  it("checkPathTraversal() detects escape attempts", () => {
    ctx = new SecurityContext({ trustStore })
    expect(() => ctx.checkPathTraversal("/workspace/safe", "/workspace")).not.toThrow()
    expect(() => ctx.checkPathTraversal("/etc/passwd", "/workspace")).toThrow(SecurityError)
    expect(() => ctx.checkPathTraversal("/workspace/../etc", "/workspace")).toThrow(SecurityError)
  })

  it("getTrustStore() returns the trust store", () => {
    ctx = new SecurityContext({ trustStore })
    expect(ctx.getTrustStore()).toBe(trustStore)
  })
})
