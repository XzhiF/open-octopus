// Main-agent identity presets (P3-2): persona-source switch.
//
// The contract under test:
//   1. preset detection is content-hash based ('custom' for hand-edited files);
//   2. switching writes persona.md, backing the outgoing file up;
//   3. switching back is one call (no state beyond the file + backups);
//   4. NEW sessions see the switched persona; EXISTING sessions keep their
//      frozen snapshot — the provider prefix cache survives the switch.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { SessionCacheContextDAO } from "../db/dao/session-cache-context-dao"
import { SystemPromptAssembler } from "../services/agent/system-prompt-assembler"
import { getPersonaService } from "../services/agent/persona-service"
import {
  OCTOPUS_DEFAULT_PERSONA,
  getMainAgentPresetState,
  setMainAgentPreset,
} from "../services/agent/main-agent-preset"
import { createPersonaRoutes } from "../routes/agent/persona"

const ORG = "e2e-main-preset"
const ROOT = path.join(os.tmpdir(), `main-agent-preset-${Date.now()}`)
const HOME = path.join(ROOT, "octopus")
const AGENT_DIR = path.join(HOME, "agent")
const CLAUDE_DIR = path.join(ROOT, "claude")

let db: Database.Database
let app: Hono

function request(pathname: string, init?: RequestInit) {
  return app.request(pathname, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG, ...init?.headers },
  })
}

function personaPath(): string {
  return path.join(AGENT_DIR, "persona.md")
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  app = new Hono()
  app.route("/api/agent", createPersonaRoutes())
})

afterAll(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* non-fatal */ }
  db.close()
})

beforeEach(() => {
  fs.mkdirSync(path.join(AGENT_DIR, "memory"), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "skills"), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "experiences"), { recursive: true })
  fs.mkdirSync(path.join(CLAUDE_DIR, "projects"), { recursive: true })
  process.env.OCTOPUS_HOME = HOME
  process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR
  // Reset to the shipped default and clear backups from previous cases.
  fs.writeFileSync(personaPath(), OCTOPUS_DEFAULT_PERSONA + "\n", "utf-8")
  for (const f of fs.readdirSync(AGENT_DIR)) {
    if (f.startsWith("persona.md.bak-")) fs.rmSync(path.join(AGENT_DIR, f))
  }
  db.prepare("DELETE FROM session_prompt_snapshots").run()
})

describe("main-agent preset API", () => {
  it("lists presets and detects the shipped default as 'octopus'", async () => {
    const res = await request("/api/agent/config/main-preset")
    expect(res.status).toBe(200)
    const body = await res.json() as {
      active: string
      appliesTo: string
      options: Array<{ id: string; label: string; chars: number }>
    }
    expect(body.active).toBe("octopus")
    expect(body.appliesTo).toBe("new_sessions")
    expect(body.options.map((o) => o.id)).toEqual(["octopus", "workspace"])
    const workspace = body.options.find((o) => o.id === "workspace")!
    expect(workspace.label).toBe("全栈开发助手")
    expect(workspace.chars).toBeGreaterThan(100)
  })

  it("switches to the workspace preset, backing the outgoing persona up", async () => {
    const res = await request("/api/agent/config/main-preset", {
      method: "PUT",
      body: JSON.stringify({ preset: "workspace" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { active: string; backupPath: string | null }
    expect(body.active).toBe("workspace")
    expect(body.backupPath).toBeTruthy()
    if (!body.backupPath) throw new Error("expected a backup path")
    expect(fs.readFileSync(body.backupPath, "utf-8")).toContain("Octopus Agent")

    const onDisk = fs.readFileSync(personaPath(), "utf-8")
    expect(onDisk).toContain("全栈开发助手")
    expect(onDisk).toContain("## 工作流强制项")

    // Detection follows the content, not any stored flag.
    const state = await (await request("/api/agent/config/main-preset")).json() as { active: string }
    expect(state.active).toBe("workspace")
  })

  it("switches back to octopus in one call", async () => {
    await request("/api/agent/config/main-preset", {
      method: "PUT",
      body: JSON.stringify({ preset: "workspace" }),
    })
    const back = await request("/api/agent/config/main-preset", {
      method: "PUT",
      body: JSON.stringify({ preset: "octopus" }),
    })
    expect(back.status).toBe(200)
    expect(await back.json()).toMatchObject({ active: "octopus" })
    expect(fs.readFileSync(personaPath(), "utf-8")).toContain("Octopus Agent")
  })

  it("reports a hand-edited persona as 'custom'", async () => {
    fs.writeFileSync(personaPath(), "# 我自己的人格\n\n只服务本机。\n", "utf-8")
    const state = await (await request("/api/agent/config/main-preset")).json() as { active: string }
    expect(state.active).toBe("custom")
  })

  it("rejects an unknown preset", async () => {
    const res = await request("/api/agent/config/main-preset", {
      method: "PUT",
      body: JSON.stringify({ preset: "not-a-preset" }),
    })
    expect(res.status).toBe(400)
  })

  it("treats a missing persona.md as the platform default", async () => {
    fs.rmSync(personaPath())
    expect(getMainAgentPresetState().active).toBe("octopus")
  })
})

describe("main-agent preset — cache discipline", () => {
  it("new sessions see the switched persona; frozen snapshots never change", async () => {
    const dao = new SessionCacheContextDAO(db)
    const assembler = new SystemPromptAssembler(ORG)
    const build = () => assembler.assemble()

    // Existing session freezes the octopus persona on its first turn.
    const before = dao.getOrCreatePromptSnapshot("s-old", build).systemPrompt
    expect(before).toContain("Octopus Agent")

    setMainAgentPreset("workspace", ORG)

    // The frozen snapshot is byte-identical (prefix cache survives)…
    expect(dao.getOrCreatePromptSnapshot("s-old", build).systemPrompt).toBe(before)
    // …while a NEW session picks up the 岗位包.
    const fresh = dao.getOrCreatePromptSnapshot("s-new", build).systemPrompt
    expect(fresh).toContain("全栈开发助手")
    expect(fresh).toContain("## 工作流强制项")
    expect(fresh).not.toContain("一个智能编排助手")
  })
})