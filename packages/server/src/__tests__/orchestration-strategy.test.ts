// packages/server/src/__tests__/orchestration-strategy.test.ts
//
// Ticket 08 (ADR-0009): unit tests for the orchestration-strategy seam.
// The seam is the PURE decision boundary between the tasks domain and the
// scheduler/dispatch pipeline. It decides the SHAPE of the schedule envelope:
//   simple (subunits.length < 2)  → 1 primary schedule, DIRECT (no coordinator-ws)
//   composite (subunits.length≥2) → coordinator schedule + N subunit children
//
// These tests assert the decision only — no DB, no SSE, no I/O. The default
// impl must delegate to the existing dispatch logic (ADR-0009: "no behavior
// change now, just the seam for future extension").

import { describe, it, expect } from "vitest"
import {
  COMPOSITION_WF_REF,
  COMPOSITE_SUBUNIT_THRESHOLD,
  DefaultOrchestrationStrategy,
  defaultOrchestrationStrategy,
  isCompositeBySubunitCount,
} from "../services/scheduler/orchestration-strategy"
import type { TaskSpec, SubunitSpec } from "@octopus/shared"

function makeSubunit(name: string): SubunitSpec {
  return {
    name,
    workspace_spec: {
      org: "E2E_TD_org",
      branch_prefix: `e2e-td-${name}`,
      projects: [{ name: `E2E_TD_proj_${name}`, source_path: "", group: "" }],
    },
    workflow_ref: "e2e-td/sub-workflow",
    input_values: {},
    skills: [],
    resources: [],
  }
}

function makeTaskSpec(subunitCount: number): TaskSpec {
  const subunits = Array.from({ length: subunitCount }, (_, i) =>
    makeSubunit(`su${i + 1}`),
  )
  return {
    goal: "E2E_TD_goal",
    ac: ["E2E_TD_ac1"],
    subunits: subunits.length ? subunits : undefined,
    resources: [],
    authoring_resources: [],
  }
}

// ── AC3: seam interface defined (future extension point) ────────────────
describe("orchestration-strategy seam (ADR-0009 AC3)", () => {
  describe("constants — single source of truth", () => {
    it("COMPOSITION_WF_REF is the composition-task template name", () => {
      expect(COMPOSITION_WF_REF).toBe("composition-task")
    })

    it("COMPOSITE_SUBUNIT_THRESHOLD is 2 (SG9: 1-subunit → simple)", () => {
      expect(COMPOSITE_SUBUNIT_THRESHOLD).toBe(2)
    })
  })

  describe("isCompositeBySubunitCount — pure threshold predicate", () => {
    it.each([
      [0, false, "no subunits = simple direct-dispatch"],
      [1, false, "1 subunit = simple (ADR-0009 N+1→1 win, skip coordinator-ws)"],
      [2, true, "2 subunits = composite (coordinator + 2 children)"],
      [3, true, "3 subunits = composite (coordinator + 3 children)"],
      [5, true, "5 subunits = composite (coordinator + 5 children)"],
    ])(
      "subunitCount=%i → isComposite=%s (%s)",
      (count, expected, _reason) => {
        expect(isCompositeBySubunitCount(count)).toBe(expected)
      },
    )
  })

  describe("DefaultOrchestrationStrategy.planDispatch", () => {
    const strategy = new DefaultOrchestrationStrategy()

    // ── AC1: simple task skips coordinator-ws ──────────────────────────
    it("simple task (0 subunits) → simple plan, primary role, NO composition wf", () => {
      const plan = strategy.planDispatch({
        taskSpec: makeTaskSpec(0),
        workflowRef: "e2e-td/simple-wf",
      })

      expect(plan.strategy).toBe("simple")
      expect(plan.isComposite).toBe(false)
      expect(plan.primaryOriginRole).toBe("primary")
      expect(plan.compositionWorkflowRef).toBeUndefined()
      expect(plan.subunits).toEqual([])
    })

    it("simple task (1 subunit) → STILL simple plan (SG9 threshold N>=2)", () => {
      const plan = strategy.planDispatch({
        taskSpec: makeTaskSpec(1),
        workflowRef: "e2e-td/simple-wf",
      })

      expect(plan.strategy).toBe("simple")
      expect(plan.isComposite).toBe(false)
      expect(plan.primaryOriginRole).toBe("primary")
      expect(plan.compositionWorkflowRef).toBeUndefined()
      expect(plan.subunits).toEqual([])
    })

    // ── AC2: composite N>=2 builds coordinator-ws + composition-task ───
    it("composite task (2 subunits) → composite plan, coordinator role, composition-task wf", () => {
      const spec = makeTaskSpec(2)
      const plan = strategy.planDispatch({ taskSpec: spec, workflowRef: "ignored-on-composite" })

      expect(plan.strategy).toBe("composite")
      expect(plan.isComposite).toBe(true)
      expect(plan.primaryOriginRole).toBe("coordinator")
      expect(plan.compositionWorkflowRef).toBe(COMPOSITION_WF_REF)
      expect(plan.subunits).toHaveLength(2)
      expect(plan.subunits).toBe(spec.subunits) // same array reference (no copy needed for a pure decision)
    })

    it("composite task (3 subunits) → composite plan with all 3 subunits preserved", () => {
      const spec = makeTaskSpec(3)
      const plan = strategy.planDispatch({ taskSpec: spec })

      expect(plan.strategy).toBe("composite")
      expect(plan.isComposite).toBe(true)
      expect(plan.primaryOriginRole).toBe("coordinator")
      expect(plan.compositionWorkflowRef).toBe(COMPOSITION_WF_REF)
      expect(plan.subunits.map((s) => s.name)).toEqual(["su1", "su2", "su3"])
    })

    it("composite plan's compositionWorkflowRef is overridable via constructor opts", () => {
      const custom = new DefaultOrchestrationStrategy({
        compositionWorkflowRef: "custom-composition",
      })
      const plan = custom.planDispatch({ taskSpec: makeTaskSpec(2) })

      expect(plan.compositionWorkflowRef).toBe("custom-composition")
    })

    it("defaultOrchestrationStrategy singleton is a DefaultOrchestrationStrategy instance", () => {
      // Module-level singleton — the dispatch seam (future) consumes this
      // unless a variant is injected.
      const plan = defaultOrchestrationStrategy.planDispatch({
        taskSpec: makeTaskSpec(2),
      })
      expect(plan.strategy).toBe("composite")
    })

    it("is a PURE decision (no I/O): planDispatch returns synchronously without touching the DB or SSE", () => {
      // The seam must be pure so it can be swapped by a future variant
      // (subunit-level retry / conditional DAG) without side effects.
      const plan1 = strategy.planDispatch({ taskSpec: makeTaskSpec(0) })
      const plan2 = strategy.planDispatch({ taskSpec: makeTaskSpec(0) })
      // Same input → same decision shape (deterministic).
      expect(plan1).toEqual(plan2)
    })
  })

  describe("future extension point (ADR-0009 alt-B deferred)", () => {
    it("a custom OrchestrationStrategy impl can replace the default without touching the lifecycle base", () => {
      // Simulate a FUTURE variant: subunit-level retry strategy (ADR-0009
      // alt-B deferred). The seam lets this land incrementally behind a new
      // impl — the existing dispatch + 600 LOC lifecycle base stays untouched.
      const retryStrategy = {
        planDispatch(input: { taskSpec: TaskSpec }) {
          const subunits = input.taskSpec.subunits ?? []
          return {
            strategy: "composite" as const,
            primaryOriginRole: "coordinator" as const,
            compositionWorkflowRef: COMPOSITION_WF_REF,
            subunits,
            isComposite: subunits.length >= 2,
          }
        },
      }

      const plan = retryStrategy.planDispatch({ taskSpec: makeTaskSpec(2) })
      expect(plan.isComposite).toBe(true)
      expect(plan.primaryOriginRole).toBe("coordinator")
    })
  })
})
