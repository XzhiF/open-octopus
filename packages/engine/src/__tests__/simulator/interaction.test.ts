import { describe, it, expect } from "vitest"
import { simulateScenario } from "../../simulator/simulator-engine"
import type { WorkflowDef } from "@octopus/shared"
import type { TestScenario } from "../../simulator/types"

// ── Interaction Workflow ──────────────────────────────────────

const interactionWorkflow: WorkflowDef = {
  apiVersion: "octopus/v1",
  kind: "Workflow",
  name: "interaction-test",
  execution_mode: "serial",
  variables: { clarify_status: "PENDING" },
  nodes: [
    {
      id: "bash-init",
      type: "bash",
      bash: "echo 'Initializing...'",
    },
    {
      id: "interact-clarify",
      type: "interaction",
      depends_on: ["bash-init"],
      interaction_max_rounds: 10,
      interaction_exit_when: "$vars.clarify_status == 'COMPLETE'",
      interaction_agent: {
        skills: ["octo-xzf-clarify"],
        prompt: "Clarify requirements for $vars.feature_name",
      },
      outputs: {
        "$vars.clarify_summary": "$last_output",
      },
    },
    {
      id: "bash-report",
      type: "bash",
      bash: "echo 'Summary: $vars.clarify_summary'",
      depends_on: ["interact-clarify"],
    },
  ],
}

describe("Simulator — Interaction Node", () => {
  it("happy path: interaction completes with summary, downstream receives vars", async () => {
    const scenario: TestScenario = {
      name: "happy path",
      inputs: { feature_name: "dark-mode" },
      mocks: {
        "bash-init": { output: "Initializing..." },
        "interact-clarify": {
          summary: "Dark mode requirements clarified",
          rounds: 2,
          vars_update: { clarify_status: "COMPLETE" },
        },
        "bash-report": { output: "Summary: Dark mode requirements clarified" },
      },
      assertions: {
        status: "completed",
        vars: { clarify_status: "COMPLETE", clarify_summary: "Dark mode requirements clarified" },
      },
    }

    const result = await simulateScenario(interactionWorkflow, scenario)
    expect(result.passed).toBe(true)
    expect(result.status).toBe("completed")
    expect(result.poolSnapshot.clarify_status).toBe("COMPLETE")
    expect(result.poolSnapshot.clarify_summary).toBe("Dark mode requirements clarified")
  })

  it("interaction with outputs mapping", async () => {
    const scenario: TestScenario = {
      name: "outputs mapping",
      inputs: { feature_name: "notifications" },
      mocks: {
        "bash-init": { output: "Initializing..." },
        "interact-clarify": {
          summary: "Notification preferences collected",
          vars_update: { notify_pref: "email" },
        },
        "bash-report": { output: "done" },
      },
      assertions: {
        status: "completed",
        vars: { notify_pref: "email" },
      },
    }

    const result = await simulateScenario(interactionWorkflow, scenario)
    expect(result.passed).toBe(true)
    expect(result.poolSnapshot.notify_pref).toBe("email")
  })

  it("interaction node appears in execution trace", async () => {
    const scenario: TestScenario = {
      name: "trace check",
      mocks: {
        "bash-init": { output: "init" },
        "interact-clarify": {
          summary: "done",
        },
        "bash-report": { output: "report" },
      },
      assertions: {
        status: "completed",
      },
    }

    const result = await simulateScenario(interactionWorkflow, scenario)
    expect(result.passed).toBe(true)
    const interactionEntry = result.executionTrace.find(e => e.nodeId === "interact-clarify")
    expect(interactionEntry).toBeDefined()
    expect(interactionEntry?.nodeType).toBe("interaction")
    expect(interactionEntry?.status).toBe("completed")
  })
})

// ── Simple two-node interaction workflow ─────────────────────

const simpleInteractionWorkflow: WorkflowDef = {
  apiVersion: "octopus/v1",
  kind: "Workflow",
  name: "simple-interaction",
  execution_mode: "serial",
  nodes: [
    {
      id: "interact",
      type: "interaction",
      interaction_max_rounds: 5,
    },
    {
      id: "bash-final",
      type: "bash",
      bash: "echo 'Done'",
      depends_on: ["interact"],
    },
  ],
}

describe("Simulator — Simple Interaction", () => {
  it("minimal interaction with no vars_update", async () => {
    const scenario: TestScenario = {
      name: "minimal",
      mocks: {
        interact: {
          summary: "User confirmed the plan",
        },
        "bash-final": { output: "Done" },
      },
      assertions: {
        status: "completed",
      },
    }

    const result = await simulateScenario(simpleInteractionWorkflow, scenario)
    expect(result.passed).toBe(true)
    expect(result.nodeResults.interact.lastOutput).toBe("User confirmed the plan")
  })
})
