// packages/server/src/__tests__/task-launch-step.test.ts
//
// resolveTaskLaunchStep 的内置键注入契约（2026-09-21 空台事故 P1）：
// v4 分支恒注入 task_id + octopus_api（ship-pr 的「当场复检」回填步靠它们找到
// server 与任务）。恒注入 = 缺料也必须给空串——缺键会让 `$inputs.X` 以字面量
// 残留在下游 prompt（IS_FINAL_PHASE_KEY 同纪律，这里有注释锁死）。
import { describe, it, expect } from "vitest"
import {
  resolveTaskLaunchStep,
  TASK_ID_KEY,
  OCTOPUS_API_KEY,
  IS_FINAL_PHASE_KEY,
  type TaskV4PhaseConfig,
} from "../services/tasks/task-materialize"
import type { WorkflowConfig } from "@octopus/shared"

const phase = (over: Partial<TaskV4PhaseConfig> = {}): TaskV4PhaseConfig => ({
  index: 1, name: "P1", slug: "auth-flow",
  specPath: "/home/.scratch/auth-flow-1/spec.md", specDir: "/home/.scratch/auth-flow-1",
  workflowRef: "built-in/matt-spec-dev", inputValues: { batch_dir: ".scratch/auth-flow-1" },
  ...over,
})

const v4Plan = (phases: TaskV4PhaseConfig[]): WorkflowConfig =>
  ({
    schema_version: "3.0", type: "workflow",
    workflow_chain: [{ workflow_ref: "built-in/matt-spec-dev", input_values: {} }],
    format: "v4", phases,
  }) as unknown as WorkflowConfig

describe("resolveTaskLaunchStep — 验收台预设回填信道注入", () => {
  it("v4 + taskId/serverUrl 齐 → 两键进 step.inputValues（恒注入，压过作者同名值）", () => {
    const plan = v4Plan([phase({ inputValues: { batch_dir: "b", [TASK_ID_KEY]: "作者乱填" } })])
    const step = resolveTaskLaunchStep({
      plan, phaseIndex: 1, roundIndex: 1,
      taskId: "t-42", serverUrl: "http://127.0.0.1:3123",
    })
    expect(step.inputValues[TASK_ID_KEY]).toBe("t-42")
    expect(step.inputValues[OCTOPUS_API_KEY]).toBe("http://127.0.0.1:3123")
    expect(step.inputValues[IS_FINAL_PHASE_KEY]).toBe("true")
    expect(step.inputValues.batch_dir).toBe("b")
  })

  it("未传 taskId/serverUrl → 注入空串而不是缺键（字面量残留纪律）", () => {
    const step = resolveTaskLaunchStep({ plan: v4Plan([phase()]), phaseIndex: 1, roundIndex: 1 })
    expect(step.inputValues).toHaveProperty(TASK_ID_KEY, "")
    expect(step.inputValues).toHaveProperty(OCTOPUS_API_KEY, "")
  })

  it("打回轮 override（task-fix）同走 v4 分支 → 两键照注", () => {
    const step = resolveTaskLaunchStep({
      plan: v4Plan([phase()]), phaseIndex: 1, roundIndex: 2,
      feedback: "重来", workflowRefOverride: "built-in/task-fix",
      taskId: "t-42", serverUrl: "http://127.0.0.1:3001",
    })
    expect(step.workflowRef).toBe("built-in/task-fix")
    expect(step.inputValues[TASK_ID_KEY]).toBe("t-42")
    expect(step.inputValues.feedback).toBe("重来")
  })
})
