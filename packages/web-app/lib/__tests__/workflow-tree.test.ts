import { describe, expect, it } from "vitest"
import type { StepExecution } from "@/lib/types"
import { collectSubWorkflowRefs, iterationOf, workflowDisplayName } from "@/lib/workflow-tree"

const step = (overrides: Partial<StepExecution>): StepExecution => ({
  stepId: "s",
  stepName: "s",
  status: "completed",
  ...overrides,
})

const root = (nodes: string) => `apiVersion: octopus/v1
kind: Workflow
name: matt-spec-dev
nodes:
${nodes}`

describe("collectSubWorkflowRefs — 静态子流", () => {
  it("收集 sub_workflow 的 workflow 字段，按 YAML 顺序", () => {
    const yaml = root(`  - id: a
    type: sub_workflow
    workflow: helper.yaml
  - id: b
    type: sub_workflow
    workflow: group/other`)
    expect(collectSubWorkflowRefs(yaml, [], "exec-1").map((ref) => ref.ref)).toEqual([
      "helper.yaml",
      "group/other",
    ])
    expect(collectSubWorkflowRefs(yaml, [], "exec-1")[0]).toMatchObject({
      isDynamic: false,
      nodeId: "a",
      label: "helper",
    })
  })

  it("重复 ref 去重（不同节点引用同一个子流）", () => {
    const yaml = root(`  - id: a
    type: sub_workflow
    workflow: helper
  - id: b
    type: sub_workflow
    workflow: helper`)
    expect(collectSubWorkflowRefs(yaml, [], "exec-1")).toHaveLength(1)
  })
})

describe("collectSubWorkflowRefs — 动态子流", () => {
  it("节点还没跑：静态 workflow 字段先占位（树上显示生成中）", () => {
    const yaml = root(`  - id: ticket-dag
    type: dynamic_sub_workflow
    workflow: ticket-dag`)
    const refs = collectSubWorkflowRefs(yaml, [], "exec-1")
    expect(refs).toEqual([
      {
        ref: "ticket-dag",
        isDynamic: true,
        nodeId: "ticket-dag",
        iteration: null,
        label: "ticket-dag",
      },
    ])
  })

  it("node_end 后 outputs.generated_workflow 优先，且不重复静态 ref", () => {
    const yaml = root(`  - id: plan
    type: dynamic_sub_workflow
    workflow: ticket-dag`)
    const refs = collectSubWorkflowRefs(
      yaml,
      [step({ stepId: "plan", outputs: { generated_workflow: "ticket-dag" } })],
      "exec-1",
    )
    expect(refs.map((ref) => ref.ref)).toEqual(["ticket-dag"])
  })

  it("只有执行输出、没有静态字段：从 generated_workflow 解析", () => {
    const yaml = root(`  - id: plan
    type: dynamic_sub_workflow`)
    const refs = collectSubWorkflowRefs(
      yaml,
      [step({ stepId: "plan", outputs: { generated_workflow: "matt-spec-dev__plan" } })],
      "exec-1",
    )
    expect(refs).toEqual([
      {
        ref: "matt-spec-dev__plan",
        isDynamic: true,
        nodeId: "plan",
        iteration: null,
        label: "plan",
      },
    ])
  })

  it("运行中兜底：从 scoped 子节点 id 反推快照名（含迭代）", () => {
    const yaml = root(`  - id: plan
    type: dynamic_sub_workflow`)
    const steps = [
      step({ stepId: "plan:T-1-iter0" }),
      step({ stepId: "plan:T-2-iter1" }),
    ]
    expect(
      collectSubWorkflowRefs(yaml, steps, "exec-1").map((ref) => ref.ref),
    ).toEqual(["matt-spec-dev__plan-iter0", "matt-spec-dev__plan-iter1"])
  })

  it("运行中兜底：有静态 workflow 时用静态名 + 迭代后缀", () => {
    const yaml = root(`  - id: plan
    type: dynamic_sub_workflow
    workflow: ticket-dag`)
    const refs = collectSubWorkflowRefs(
      yaml,
      [step({ stepId: "plan:T-1-iter0" })],
      "exec-1",
    )
    expect(refs.map((ref) => ref.ref)).toEqual(["ticket-dag", "ticket-dag-iter0"])
    expect(refs[1].label).toBe("ticket-dag · iter0")
  })

  it("没有 executionId 时不推导兜底名（预览态没有执行作用域）", () => {
    const yaml = root(`  - id: plan
    type: dynamic_sub_workflow`)
    expect(collectSubWorkflowRefs(yaml, [step({ stepId: "plan:T-1-iter0" })], null)).toEqual([])
  })
})

describe("collectSubWorkflowRefs — 嵌套", () => {
  it("递归进入 nodes / loop_body", () => {
    const yaml = `apiVersion: octopus/v1
name: root
nodes:
  - id: loop-1
    type: loop
    loop_body:
      - id: inner-static
        type: sub_workflow
        workflow: helper
      - id: inner-dyn
        type: dynamic_sub_workflow
        workflow: dyn-child
`
    const refs = collectSubWorkflowRefs(yaml, [], "exec-1")
    expect(refs.map((ref) => ref.ref)).toEqual(["helper", "dyn-child"])
  })
})

describe("workflowDisplayName / iterationOf", () => {
  it("YAML name 优先，其次 ref 末段（去扩展名）", () => {
    expect(workflowDisplayName("name: matt-spec-dev\nnodes: []", "x/y.yaml")).toBe("matt-spec-dev")
    expect(workflowDisplayName("nodes: []", "built-in/matt-spec-dev")).toBe("matt-spec-dev")
    expect(workflowDisplayName("nodes: []", "matt-spec-dev.yaml")).toBe("matt-spec-dev")
    expect(workflowDisplayName("", null)).toBe("工作流")
  })

  it("识别 -iterN 后缀", () => {
    expect(iterationOf("ticket-dag")).toBeNull()
    expect(iterationOf("ticket-dag-iter2")).toBe(2)
    expect(iterationOf("ticket-dag-iter2.yaml")).toBe(2)
  })
})
