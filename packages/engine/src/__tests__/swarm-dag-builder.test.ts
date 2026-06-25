import { describe, it, expect } from "vitest"
import { buildDAG, SwarmDAGCycleError } from "../executors/swarm/dag-builder"
import type { ExpertDef } from "@octopus/shared"

/** Helper: create a minimal ExpertDef with role + optional depends_on */
function expert(role: string, depends_on?: string[]): ExpertDef {
  return {
    role,
    prompt: `Prompt for ${role}`,
    ...(depends_on ? { depends_on } : {}),
  } as ExpertDef
}

describe("buildDAG", () => {
  it("single expert (no dependencies) = single level", () => {
    const result = buildDAG([expert("architect")])
    expect(result.levels).toHaveLength(1)
    expect(result.levels[0]).toEqual(["architect"])
  })

  it("all experts independent = single level", () => {
    const result = buildDAG([
      expert("architect"),
      expert("developer"),
      expert("tester"),
    ])
    expect(result.levels).toHaveLength(1)
    expect(result.levels[0]).toHaveLength(3)
    expect(result.levels[0].sort()).toEqual(["architect", "developer", "tester"])
  })

  it("TC-008: 4-expert DAG: L0 parallel → L1 depends on L0 → L2 depends on all", () => {
    // architect, planner → (no deps, level 0)
    // developer → depends on architect, planner (level 1)
    // reviewer → depends on architect, planner, developer (level 2)
    const experts = [
      expert("architect"),
      expert("planner"),
      expert("developer", ["architect", "planner"]),
      expert("reviewer", ["architect", "planner", "developer"]),
    ]

    const result = buildDAG(experts)

    expect(result.levels).toHaveLength(3)

    // Level 0: architect + planner (parallel)
    expect(result.levels[0].sort()).toEqual(["architect", "planner"])

    // Level 1: developer (depends on both L0 experts)
    expect(result.levels[1]).toEqual(["developer"])

    // Level 2: reviewer (depends on all previous)
    expect(result.levels[2]).toEqual(["reviewer"])
  })

  it("linear chain A → B → C = 3 levels", () => {
    const result = buildDAG([
      expert("A"),
      expert("B", ["A"]),
      expert("C", ["B"]),
    ])

    expect(result.levels).toHaveLength(3)
    expect(result.levels[0]).toEqual(["A"])
    expect(result.levels[1]).toEqual(["B"])
    expect(result.levels[2]).toEqual(["C"])
  })

  it("circular dependency detection: A → B → A throws SwarmDAGCycleError", () => {
    const experts = [
      expert("A", ["B"]),
      expert("B", ["A"]),
    ]

    expect(() => buildDAG(experts)).toThrow(SwarmDAGCycleError)

    try {
      buildDAG(experts)
    } catch (e) {
      expect(e).toBeInstanceOf(SwarmDAGCycleError)
      const cycleError = e as SwarmDAGCycleError
      expect(cycleError.cycle).toContain("A")
      expect(cycleError.cycle).toContain("B")
      expect(cycleError.message).toContain("Circular dependency detected")
    }
  })

  it("circular dependency with 3 nodes: A → B → C → A", () => {
    const experts = [
      expert("A", ["C"]),
      expert("B", ["A"]),
      expert("C", ["B"]),
    ]

    expect(() => buildDAG(experts)).toThrow(SwarmDAGCycleError)

    try {
      buildDAG(experts)
    } catch (e) {
      const cycleError = e as SwarmDAGCycleError
      expect(cycleError.cycle.sort()).toEqual(["A", "B", "C"])
    }
  })

  it("partial cycle: some nodes OK, others in cycle", () => {
    // A is independent (L0), but B ↔ C form a cycle
    const experts = [
      expert("A"),
      expert("B", ["C"]),
      expert("C", ["B"]),
    ]

    expect(() => buildDAG(experts)).toThrow(SwarmDAGCycleError)

    try {
      buildDAG(experts)
    } catch (e) {
      const cycleError = e as SwarmDAGCycleError
      // Only B and C are in the cycle, A was already processed
      expect(cycleError.cycle.sort()).toEqual(["B", "C"])
    }
  })

  it("diamond dependency: A → B, A → C, B+C → D = 3 levels", () => {
    const experts = [
      expert("A"),
      expert("B", ["A"]),
      expert("C", ["A"]),
      expert("D", ["B", "C"]),
    ]

    const result = buildDAG(experts)

    expect(result.levels).toHaveLength(3)
    expect(result.levels[0]).toEqual(["A"])
    expect(result.levels[1].sort()).toEqual(["B", "C"])
    expect(result.levels[2]).toEqual(["D"])
  })

  it("skips unknown dependencies gracefully", () => {
    // "unknown" is not in the expert list — should be skipped
    const experts = [
      expert("A", ["unknown"]),
    ]

    const result = buildDAG(experts)
    expect(result.levels).toHaveLength(1)
    expect(result.levels[0]).toEqual(["A"])
  })

  it("empty experts array returns empty levels", () => {
    const result = buildDAG([])
    expect(result.levels).toHaveLength(0)
  })
})
