import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { EngineInitPhase, ENGINE_INIT_JSONL } from "../services/execution/EngineInitPhase"
import { SSEService } from "../services/sse"

let workspacePath: string
let sse: SSEService
let receivedEvents: { event: string; data: unknown }[]

beforeEach(() => {
  workspacePath = path.join(os.tmpdir(), `test-engine-init-${Date.now()}`)
  fs.mkdirSync(workspacePath, { recursive: true })
  sse = new SSEService()
  receivedEvents = []
  sse.subscribe("test:test-ws", (event) => { receivedEvents.push(event) })
})

afterEach(() => {
  if (fs.existsSync(workspacePath)) {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

describe("EngineInitPhase", () => {
  it("emits engine_init_start, engine_init_skills, engine_init_agents, engine_init_complete sequence", async () => {
    const phase = new EngineInitPhase()
    await phase.run({
      workspacePath,
      workspaceId: "test:test-ws",
      executionId: "exec-1",
      syncMainBranch: false,
      sse,
      skillsSourceOverride: null,
    })

    const eventTypes = receivedEvents.map(e => e.event)
    expect(eventTypes).toContain("engine_init_start")
    expect(eventTypes).toContain("engine_init_skills")
    expect(eventTypes).toContain("engine_init_agents")
    expect(eventTypes).toContain("engine_init_complete")

    // Order: start → skills → agents → complete
    const startIdx = eventTypes.indexOf("engine_init_start")
    const skillsIdx = eventTypes.indexOf("engine_init_skills")
    const agentsIdx = eventTypes.indexOf("engine_init_agents")
    const completeIdx = eventTypes.indexOf("engine_init_complete")
    expect(startIdx).toBeLessThan(skillsIdx)
    expect(skillsIdx).toBeLessThan(agentsIdx)
    expect(agentsIdx).toBeLessThan(completeIdx)
  })

  it("writes __engine_init__.jsonl with one valid JSON per line", async () => {
    const phase = new EngineInitPhase()
    await phase.run({
      workspacePath,
      workspaceId: "test:test-ws",
      executionId: "exec-2",
      syncMainBranch: false,
      sse,
      skillsSourceOverride: null,
    })

    const jsonlPath = path.join(workspacePath, "logs", "exec-2", ENGINE_INIT_JSONL)
    expect(fs.existsSync(jsonlPath)).toBe(true)

    const content = fs.readFileSync(jsonlPath, "utf-8")
    const lines = content.split("\n").filter(l => l.trim())
    expect(lines.length).toBeGreaterThanOrEqual(3) // start, skills, agents, complete

    // Every line must be valid JSON with event + timestamp
    for (const line of lines) {
      const entry = JSON.parse(line)
      expect(entry.event).toMatch(/^engine_init_/)
      expect(typeof entry.timestamp).toBe("string")
    }
  })

  it("copies skills from override path when provided", async () => {
    // Create a fake skills source
    const skillsSource = path.join(workspacePath, "_fake-skills-src")
    fs.mkdirSync(path.join(skillsSource, "my-skill"), { recursive: true })
    fs.writeFileSync(path.join(skillsSource, "my-skill", "skill.md"), "# Skill")

    const phase = new EngineInitPhase()
    await phase.run({
      workspacePath,
      workspaceId: "test:test-ws",
      executionId: "exec-3",
      syncMainBranch: false,
      sse,
      skillsSourceOverride: skillsSource,
    })

    const dest = path.join(workspacePath, ".claude", "skills", "my-skill", "skill.md")
    expect(fs.existsSync(dest)).toBe(true)

    const skillsEvent = receivedEvents.find(e => e.event === "engine_init_skills") as any
    expect(skillsEvent?.data?.status).toBe("success")
    expect(skillsEvent?.data?.fileCount).toBeGreaterThan(0)
  })

  it("emits engine_init_warning when skills copy throws", async () => {
    const phase = new EngineInitPhase()
    // Force a failure by providing an override path that exists but has unreadable content
    // (We can simulate this by overriding copyTree — but simpler: just test that
    // the overall run never throws even when skillsSourceOverride is a non-existent directory)
    // Actually, a non-existent path won't throw because existsSync returns false.
    // To trigger a warning, pass a path that exists but is a file not a directory.
    const badPath = path.join(workspacePath, "bad-skills")
    fs.writeFileSync(badPath, "not-a-dir")

    // The copyTree will fail because badPath is a file, not a directory
    await phase.run({
      workspacePath,
      workspaceId: "test:test-ws",
      executionId: "exec-4",
      syncMainBranch: false,
      sse,
      skillsSourceOverride: badPath,
    })

    const warnings = receivedEvents.filter(e => e.event === "engine_init_warning")
    expect(warnings.length).toBeGreaterThan(0)

    // Complete should still have been emitted
    const complete = receivedEvents.find(e => e.event === "engine_init_complete")
    expect(complete).toBeDefined()
  })

  it("never throws even if SSE emit fails", async () => {
    const brokenSse = {
      emit: () => { throw new Error("SSE broken") },
      subscribe: () => () => {},
      emitToAll: () => {},
      getMissedEvents: () => [],
      clearBuffer: () => {},
    } as unknown as SSEService

    const phase = new EngineInitPhase()
    // Should not throw
    await phase.run({
      workspacePath,
      workspaceId: "test:test-ws",
      executionId: "exec-5",
      syncMainBranch: false,
      sse: brokenSse,
      skillsSourceOverride: null,
    })
  })

  it("engine_init events are NOT in SILENT_EVENTS", async () => {
    // SILENT_EVENTS is a private Set inside sse.ts — we can't import it directly.
    // Instead, verify by checking the log output: when engine_init events are emitted,
    // they should appear in console.log (non-silent).
    // The simpler approach: read the source file to verify the events are absent from the Set.
    const sseSource = fs.readFileSync(
      path.join(__dirname, "..", "services", "sse.ts"),
      "utf-8",
    )
    // Extract the SILENT_EVENTS set content
    const match = sseSource.match(/SILENT_EVENTS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/)
    expect(match).toBeTruthy()
    const silentContent = match![1]
    expect(silentContent).not.toContain("engine_init_start")
    expect(silentContent).not.toContain("engine_init_skills")
    expect(silentContent).not.toContain("engine_init_agents")
    expect(silentContent).not.toContain("engine_init_complete")
    expect(silentContent).not.toContain("engine_init_warning")
    expect(silentContent).not.toContain("engine_init_info")
    expect(silentContent).not.toContain("engine_init_pull")
  })
})
