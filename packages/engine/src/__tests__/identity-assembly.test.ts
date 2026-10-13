// packages/engine/src/__tests__/identity-assembly.test.ts
//
// LLM-WIKI P1 ticket 10 — agent-node identity assembly (spec §执行身份 P1):
//   as: <clone> (default workflow-operator) → IdentityResolver snapshot →
//   snapshot.persona merged into systemPrompt, snapshot.skills unioned into
//   the Skill Filter whitelist. cwd is NEVER an identity input and must not
//   appear in the assembly surface.
//
// Expected persona text is quoted from the prototype Tab④ persona skeleton
// (same source ticket 09 pinned) — an independent truth source.

import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { NodeDef } from "@octopus/shared"
import { WORKFLOW_OPERATOR_CLONE_NAME } from "@octopus/shared"
import { IdentityResolver, IdentityResolveError } from "../executors/identity-resolver"
import { assembleAgentNodeIdentity, DEFAULT_IDENTITY_REF } from "../executors/identity-assembly"

const OPERATOR_PERSONA = '你是工作流执行工程师，代表 Octopus 在工作流 agent 节点中执行任务。'

const tmpHomes: string[] = []
function makeFakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "identity-assembly-"))
  tmpHomes.push(home)
  return home
}
function writeCloneDir(home: string, kind: "built-in" | "clones", name: string, files: Record<string, string>): void {
  const dir = join(home, ".octopus", "agent", kind, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel)
    mkdirSync(join(target, ".."), { recursive: true })
    writeFileSync(target, content, "utf-8")
  }
}
afterEach(() => {
  while (tmpHomes.length > 0) {
    const home = tmpHomes.pop()
    if (home) rmSync(home, { recursive: true, force: true })
  }
})

function agentNode(extra: Partial<NodeDef> = {}): NodeDef {
  return { id: "implement", type: "agent", prompt: "实现需求...", ...extra }
}

describe("assembleAgentNodeIdentity — explicit as:", () => {
  it("assembles persona into systemPrompt and skills snapshot into the whitelist", () => {
    const home = makeFakeHome()
    writeCloneDir(home, "built-in", "archive", {
      "persona.md": OPERATOR_PERSONA,
      "skills/octo-archive-analyst/SKILL.md": "---\nname: octo-archive-analyst\n---\nbody",
    })
    const resolver = new IdentityResolver({ homeDir: home })

    const { node, systemPrompt } = assembleAgentNodeIdentity(agentNode({ as: "archive" }), resolver)

    // persona → systemPrompt (preset-preserving append, see merge tests below)
    expect(typeof systemPrompt === "object" && systemPrompt !== null && "append" in systemPrompt
      ? systemPrompt.append : systemPrompt).toContain(OPERATOR_PERSONA)
    // snapshot.skills → Skill Filter whitelist (node declared none)
    expect(node.skills).toEqual(["octo-archive-analyst"])
    // prompt identity untouched
    expect(node.prompt).toBe("实现需求...")
    expect(node.as).toBe("archive")
  })

  it("unions node-declared skills with identity-granted skills (dedup, no loss)", () => {
    const home = makeFakeHome()
    writeCloneDir(home, "clones", "task-doer", {
      "persona.md": "doer persona",
      "skills/octo-dev-copilot/SKILL.md": "---\nname: octo-dev-copilot\n---\nbody",
      "skills/shared-skill/SKILL.md": "---\nname: shared-skill\n---\nbody",
    })
    const resolver = new IdentityResolver({ homeDir: home })

    const { node } = assembleAgentNodeIdentity(
      agentNode({ as: "task-doer", skills: ["matt-e2e-test-methodology", "shared-skill"] }),
      resolver,
    )

    expect([...node.skills!].sort()).toEqual(
      ["matt-e2e-test-methodology", "octo-dev-copilot", "shared-skill"].sort(),
    )
  })

  it("an empty skills/ directory does NOT restrict the whitelist (ADR-0006 shared inheritance)", () => {
    const home = makeFakeHome()
    writeCloneDir(home, "built-in", "operator-empty", { "persona.md": "persona only" })
    const resolver = new IdentityResolver({ homeDir: home })

    const { node } = assembleAgentNodeIdentity(agentNode({ as: "operator-empty" }), resolver)
    expect(node.skills).toBeUndefined()

    const declared = assembleAgentNodeIdentity(agentNode({ as: "operator-empty", skills: ["keep-me"] }), resolver)
    expect(declared.node.skills).toEqual(["keep-me"])
  })

  it("throws IdentityResolveError for an unresolvable explicit as: (no silent identity drop)", () => {
    const home = makeFakeHome()
    const resolver = new IdentityResolver({ homeDir: home })
    expect(() => assembleAgentNodeIdentity(agentNode({ as: "ghost-clone" }), resolver)).toThrow(IdentityResolveError)
  })
})

describe("assembleAgentNodeIdentity — default identity", () => {
  it("exports the default ref as shared WORKFLOW_OPERATOR_CLONE_NAME (single source)", () => {
    expect(DEFAULT_IDENTITY_REF).toBe(WORKFLOW_OPERATOR_CLONE_NAME)
    expect(DEFAULT_IDENTITY_REF).toBe("workflow-operator")
  })

  it("no as: assembles workflow-operator persona+skills from the built-in directory", () => {
    const home = makeFakeHome()
    writeCloneDir(home, "built-in", WORKFLOW_OPERATOR_CLONE_NAME, {
      "persona.md": OPERATOR_PERSONA,
      "skills/octo-wiki/SKILL.md": "---\nname: octo-wiki\n---\nbody",
    })
    const resolver = new IdentityResolver({ homeDir: home })

    const { node, systemPrompt } = assembleAgentNodeIdentity(agentNode(), resolver)

    expect(node.skills).toEqual(["octo-wiki"])
    expect(systemPrompt && typeof systemPrompt === "object" ? systemPrompt.append : systemPrompt).toContain(OPERATOR_PERSONA)
  })

  it("no as: + missing default identity degrades to today's behavior (existing flows never break)", () => {
    const home = makeFakeHome() // empty home — workflow-operator absent
    const resolver = new IdentityResolver({ homeDir: home })

    const original = agentNode({ skills: ["keep"] })
    const { node, systemPrompt } = assembleAgentNodeIdentity(original, resolver)

    expect(node).toBe(original)
    expect(systemPrompt).toBeUndefined()
  })
})

describe("assembleAgentNodeIdentity — systemPrompt merge keeps existing base intact", () => {
  const HOST_SAFETY = "## ⛔ CRITICAL HOST PROCESS SAFETY RULES ⛔"

  it("merges persona into the host-safety preset append (safety text preserved)", () => {
    const home = makeFakeHome()
    writeCloneDir(home, "built-in", "archive", { "persona.md": OPERATOR_PERSONA })
    const resolver = new IdentityResolver({ homeDir: home })

    const base = { type: "preset" as const, preset: "claude_code" as const, append: `\n${HOST_SAFETY}\nFORBIDDEN` }
    const { systemPrompt } = assembleAgentNodeIdentity(agentNode({ as: "archive" }), resolver, { systemPrompt: base })

    expect(systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" })
    const append = (systemPrompt as { append?: string }).append!
    expect(append).toContain(HOST_SAFETY) // safety rules survive
    expect(append).toContain(OPERATOR_PERSONA) // persona assembled
    expect(base.append).toContain(HOST_SAFETY) // input object not mutated
  })

  it("string base gets the persona appended after the base text", () => {
    const home = makeFakeHome()
    writeCloneDir(home, "built-in", "archive", { "persona.md": "archive persona" })
    const resolver = new IdentityResolver({ homeDir: home })

    const { systemPrompt } = assembleAgentNodeIdentity(agentNode({ as: "archive" }), resolver, { systemPrompt: "base prompt" })

    expect(typeof systemPrompt).toBe("string")
    expect(systemPrompt as string).toMatch(/^base prompt[\s\S]+archive persona/)
  })

  it("no persona in snapshot → base passes through byte-identical", () => {
    const home = makeFakeHome()
    writeCloneDir(home, "built-in", "nopersona", {}) // persona.md absent → empty persona
    const resolver = new IdentityResolver({ homeDir: home })

    const base = { type: "preset" as const, preset: "claude_code" as const, append: "only safety" }
    const { systemPrompt, node } = assembleAgentNodeIdentity(agentNode({ as: "nopersona" }), resolver, { systemPrompt: base })

    expect(systemPrompt).toEqual(base)
    expect(node.skills).toBeUndefined()
  })

  it("absent base + non-empty persona yields claude_code preset (preset default never lost)", () => {
    const home = makeFakeHome()
    writeCloneDir(home, "built-in", "archive", { "persona.md": "archive persona body" })
    const resolver = new IdentityResolver({ homeDir: home })

    const { systemPrompt } = assembleAgentNodeIdentity(agentNode({ as: "archive" }), resolver)
    expect(systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" })
    expect((systemPrompt as { append?: string }).append).toContain("archive persona body")
  })
})
