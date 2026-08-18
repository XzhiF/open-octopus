// packages/engine/src/__tests__/assist-workflows-simulator.test.ts
//
// Ticket 07 — AC1: the 3 built-in assist-workflow YAMLs (in core-pack/workflows/)
// parse as valid workflows + their .test.yaml minimal scenarios pass the
// simulator. This is the "LLM 真跑路径走 .test.yaml simulator 场景" prerequisite
// from the ticket's verification method — the real LLM E2E runs later with a
// minimal config; here we only assert the YAML is well-formed and the mocked
// aggregator scenario reaches `completed`.

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { parseWorkflow, isOctopusWorkflow } from "@octopus/shared"
import { loadTestFixture, runTestSuite, discoverTestFixture } from "../simulator"
import { SwarmNodeDefSchema } from "@octopus/shared"

// Resolve core-pack/workflows/ from the engine package. In dev the vitest cwd
// is packages/engine, so the sibling core-pack is one level up. Also try the
// repo root + require.resolve fallbacks so this works under tsup too.
function workflowsDir(): string {
  const candidates = [
    join(process.cwd(), "..", "core-pack", "workflows"),
    join(process.cwd(), "packages", "core-pack", "workflows"),
    join(__dirname, "..", "..", "..", "core-pack", "workflows"),
    join(__dirname, "..", "..", "..", "..", "packages", "core-pack", "workflows"),
  ]
  for (const c of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      if (readFileSync(join(c, "moa-requirements-review.yaml"), "utf-8")) return c
    } catch {
      // try next
    }
  }
  return candidates[0]
}

const TEMPLATES = ["moa-requirements-review", "spec-review-swarm", "clarify-debate"] as const

describe("07: assist-workflow YAMLs (AC1 — parse + simulator scenarios)", () => {
  for (const tpl of TEMPLATES) {
    describe(`${tpl}`, () => {
      const yamlPath = join(workflowsDir(), `${tpl}.yaml`)
      const testPath = discoverTestFixture(yamlPath)!

      it("parses as an octopus workflow", () => {
        const content = readFileSync(yamlPath, "utf-8")
        expect(isOctopusWorkflow(content)).toBe(true)
        const wf = parseWorkflow(content)
        expect(wf.name).toBe(tpl)
        expect(wf.nodes).toBeDefined()
        // Exactly one swarm node named "panel" (the id AssistWorkflowService reads).
        const swarm = wf.nodes!.find((n) => n.type === "swarm")
        expect(swarm).toBeDefined()
        expect(swarm!.id).toBe("panel")
      })

      it("swarm node satisfies SwarmNodeDefSchema (mode/experts/aggregator)", () => {
        const wf = parseWorkflow(readFileSync(yamlPath, "utf-8"))
        const swarm = wf.nodes!.find((n) => n.type === "swarm") as unknown
        const result = SwarmNodeDefSchema.safeParse(swarm)
        expect(result.success).toBe(true)
        if (result.success) {
          // ≥2 experts (AC1: "≥2 experts + aggregator")
          expect(result.data.experts!.length).toBeGreaterThanOrEqual(2)
        }
      })

      it("has a .test.yaml fixture that discovers alongside", () => {
        expect(testPath).toBeTruthy()
      })

      it("simulator scenario completes (AC1 — `.test.yaml` minimal scenario)", async () => {
        const wf = parseWorkflow(readFileSync(yamlPath, "utf-8"))
        const fixture = loadTestFixture(testPath)
        const result = await runTestSuite(wf, fixture)
        expect(result.passedCount).toBe(fixture.scenarios.length)
        for (const r of result.results) {
          expect(r.status).toBe("completed")
        }
      })
    })
  }
})
