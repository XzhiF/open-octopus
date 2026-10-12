// packages/engine/src/__tests__/identity-resolver.test.ts
//
// Unit tests for IdentityResolver — the shared execution-identity seam extracted
// from OctopusAgentExecutor (ticket 08). Resolution order under test:
//   agent_versions published snapshot → ~/.octopus/agent/built-in/{name}/
//   → ~/.octopus/agent/clones/{name}/ → readable error naming candidate paths.
//

import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { VersionResolver } from "@octopus/shared"
import type { AgentVersionInfo } from "@octopus/shared"
import { IdentityResolver } from "../executors/identity-resolver"

/** Build a published agent_versions row with the given snapshot (JSON-serialized). */
function publishedRow(agentName: string, version: string, snapshot: unknown): AgentVersionInfo {
  return {
    id: `${agentName}@${version}`,
    agent_name: agentName,
    version,
    stage: "stable",
    status: "published",
    snapshot: JSON.stringify(snapshot),
    created_at: "2026-10-12T00:00:00.000Z",
  }
}

describe("IdentityResolver — published snapshot resolution", () => {
  it("resolves identity from the latest published agent_versions snapshot", () => {
    const versionResolver = new VersionResolver([
      publishedRow("workflow-operator", "1.0.0", { persona: "v1 persona", config: {}, skills: ["v1-skill"] }),
      publishedRow("workflow-operator", "1.1.0", {
        persona: "curator persona",
        config: { model: "opus" },
        skills: ["octo-wiki", "octo-guide"],
      }),
    ])
    const resolver = new IdentityResolver({ versionResolver, homeDir: "/nonexistent-home-t08" })

    const identity = resolver.resolve("workflow-operator")

    expect(identity.version).toBe("1.1.0")
    expect(identity.stage).toBe("stable")
    expect(identity.snapshot.persona).toBe("curator persona")
    expect(identity.snapshot.config).toEqual({ model: "opus" })
    expect(identity.snapshot.skills).toEqual(["octo-wiki", "octo-guide"])
  })
})

/** Write a clone-identity directory under fakeHome: .octopus/agent/{kind}/{name}/ */
function writeCloneDir(fakeHome: string, kind: "built-in" | "clones", name: string, files: Record<string, string>): void {
  const dir = join(fakeHome, ".octopus", "agent", kind, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel)
    mkdirSync(join(target, ".."), { recursive: true })
    writeFileSync(target, content, "utf-8")
  }
}

const tmpHomes: string[] = []
function makeFakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "identity-resolver-"))
  tmpHomes.push(home)
  return home
}
afterEach(() => {
  while (tmpHomes.length > 0) {
    const home = tmpHomes.pop()
    if (home) rmSync(home, { recursive: true, force: true })
  }
})

describe("IdentityResolver — filesystem fallback", () => {
  it("falls back to the built-in directory when no published version exists", () => {
    const fakeHome = makeFakeHome()
    writeCloneDir(fakeHome, "built-in", "archive", {
      "persona.md": "# Archive analyst persona",
      "config.json": JSON.stringify({ name: "archive", config: { model: "haiku" } }),
      "skills/octo-archive-analyst/SKILL.md": "---\nname: octo-archive-analyst\n---\nbody",
      "skills/octo-guide/SKILL.md": "---\nname: octo-guide\n---\nbody",
    })
    const resolver = new IdentityResolver({ versionResolver: new VersionResolver([]), homeDir: fakeHome })

    const identity = resolver.resolve("archive")

    expect(identity.version).toBe("current")
    expect(identity.stage).toBe("stable")
    expect(identity.snapshot.persona).toBe("# Archive analyst persona")
    expect([...identity.snapshot.skills].sort()).toEqual(["octo-archive-analyst", "octo-guide"])
    expect(identity.fsPath).toBe(join(fakeHome, ".octopus", "agent", "built-in", "archive"))
  })

  it("falls back to the user clones directory when no built-in directory exists", () => {
    const fakeHome = makeFakeHome()
    writeCloneDir(fakeHome, "clones", "feat-my-branch", {
      "persona.md": "# My branch clone persona",
      "config.json": JSON.stringify({ name: "feat-my-branch", type: "user" }),
      "skills/my-skill/SKILL.md": "---\nname: my-skill\n---\nbody",
    })
    const resolver = new IdentityResolver({ versionResolver: new VersionResolver([]), homeDir: fakeHome })

    const identity = resolver.resolve("feat-my-branch")

    expect(identity.version).toBe("current")
    expect(identity.snapshot.persona).toBe("# My branch clone persona")
    expect(identity.snapshot.skills).toEqual(["my-skill"])
    expect(identity.snapshot.config).toEqual({ name: "feat-my-branch", type: "user" })
    expect(identity.fsPath).toBe(join(fakeHome, ".octopus", "agent", "clones", "feat-my-branch"))
  })

  it("throws a readable error naming the candidate paths when nothing resolves", () => {
    const fakeHome = makeFakeHome()
    const resolver = new IdentityResolver({ versionResolver: new VersionResolver([]), homeDir: fakeHome })

    expect(() => resolver.resolve("ghost-operator")).toThrowError(
      /ghost-operator[\s\S]*built-in[/\\]ghost-operator[\s\S]*clones[/\\]ghost-operator/,
    )
  })
})

describe("IdentityResolver — @N version pin", () => {
  it("resolves the exact pinned published snapshot instead of latest", () => {
    const versionResolver = new VersionResolver([
      publishedRow("task-doer", "1.0.0", { persona: "doer v1 persona", config: { maxTurns: 10 }, skills: ["octo-dev-copilot"] }),
      publishedRow("task-doer", "2.0.0", { persona: "doer v2 persona", config: { maxTurns: 20 }, skills: ["octo-dev-copilot", "matt-e2e-test-methodology"] }),
    ])
    const resolver = new IdentityResolver({ versionResolver, homeDir: "/nonexistent-home-t08" })

    const identity = resolver.resolve("task-doer@1.0.0")

    expect(identity.version).toBe("1.0.0")
    expect(identity.snapshot.persona).toBe("doer v1 persona")
    expect(identity.snapshot.config).toEqual({ maxTurns: 10 })
  })

  it("honors an explicit versionSpec option (octopus_agent node.version call shape)", () => {
    const versionResolver = new VersionResolver([
      publishedRow("task-doer", "1.0.0", { persona: "doer v1 persona", config: {}, skills: [] }),
      publishedRow("task-doer", "2.0.0", { persona: "doer v2 persona", config: {}, skills: [] }),
    ])
    const resolver = new IdentityResolver({ versionResolver, homeDir: "/nonexistent-home-t08" })

    const identity = resolver.resolve("task-doer", { versionSpec: "1.0.0" })

    expect(identity.version).toBe("1.0.0")
    expect(identity.snapshot.persona).toBe("doer v1 persona")
  })
})
