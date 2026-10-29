import { describe, it, expect } from "vitest"
import { yamlToFlowData } from "./workflow-parser"
import type { Node, Edge } from "@xyflow/react"

// ─── Helper: build a WorkflowDefinition with a loop containing inner nodes ──
function buildLoopWorkflow() {
  return {
    name: "loop-test",
    nodes: [
      {
        id: "greet",
        type: "bash",
        command: "echo hello",
        description: "Greet",
      },
      {
        id: "my-loop",
        type: "loop",
        depends_on: ["greet"],
        description: "Loop container",
        max_iterations: 3,
        nodes: [
          {
            id: "inner-a",
            type: "agent",
            prompt: "Do A",
            description: "Inner A",
          },
          {
            id: "inner-b",
            type: "agent",
            prompt: "Do B",
            depends_on: ["inner-a"],
            description: "Inner B",
          },
        ],
      },
      {
        id: "summary",
        type: "agent",
        prompt: "Summarize",
        depends_on: ["my-loop"],
        description: "Summary",
      },
    ],
  }
}

describe("yamlToFlowData — loop container extraction", () => {
  it("produces 5 nodes: greet + loop container + 2 inner + summary", () => {
    const result = yamlToFlowData(buildLoopWorkflow())
    expect(result).not.toBeNull()
    expect(result!.nodes).toHaveLength(5)

    const ids = result!.nodes.map((n) => n.id).sort()
    expect(ids).toEqual([
      "greet",
      "my-loop",
      "my-loop:inner-a",
      "my-loop:inner-b",
      "summary",
    ])
  })

  it("positions inner nodes at absolute coordinates within container area", () => {
    const result = yamlToFlowData(buildLoopWorkflow())!
    const innerA = result.nodes.find((n) => n.id === "my-loop:inner-a")
    const innerB = result.nodes.find((n) => n.id === "my-loop:inner-b")
    const loopContainer = result.nodes.find((n) => n.id === "my-loop")

    // Inner nodes should NOT have parentId (absolute positioning)
    expect(innerA?.parentId).toBeUndefined()
    expect(innerB?.parentId).toBeUndefined()

    // Inner nodes should be positioned below and to the right of container top-left
    expect(innerA!.position.y).toBeGreaterThan(loopContainer!.position.y)
    expect(innerA!.position.x).toBeGreaterThanOrEqual(loopContainer!.position.x)
  })

  it("creates inner dependency edge between inner-a → inner-b", () => {
    const result = yamlToFlowData(buildLoopWorkflow())!
    const innerEdge = result.edges.find(
      (e) => e.source === "my-loop:inner-a" && e.target === "my-loop:inner-b"
    )
    expect(innerEdge).toBeDefined()
  })

  it("creates outer edges pointing to the loop container (not inner nodes)", () => {
    const result = yamlToFlowData(buildLoopWorkflow())!

    // greet → my-loop
    const greetToLoop = result.edges.find(
      (e) => e.source === "greet" && e.target === "my-loop"
    )
    expect(greetToLoop).toBeDefined()

    // my-loop → summary
    const loopToSummary = result.edges.find(
      (e) => e.source === "my-loop" && e.target === "summary"
    )
    expect(loopToSummary).toBeDefined()
  })

  it("changes the loop node type to 'loop-container'", () => {
    const result = yamlToFlowData(buildLoopWorkflow())!
    const container = result.nodes.find((n) => n.id === "my-loop")
    expect(container?.type).toBe("loop-container")
  })

  it("sizes the loop container > 280px to encompass inner nodes", () => {
    const result = yamlToFlowData(buildLoopWorkflow())!
    const container = result.nodes.find((n) => n.id === "my-loop")

    // The container should have style or data indicating width/height
    // React Flow containers use style.width/style.height
    expect(container?.style?.width).toBeDefined()
    expect(container?.style?.height).toBeDefined()

    const width = Number(container!.style!.width)
    const height = Number(container!.style!.height)
    expect(width).toBeGreaterThan(280)
    expect(height).toBeGreaterThan(0)
  })

  it("positions inner nodes relative to container (not global 0,0)", () => {
    const result = yamlToFlowData(buildLoopWorkflow())!
    const innerA = result.nodes.find((n) => n.id === "my-loop:inner-a")
    const innerB = result.nodes.find((n) => n.id === "my-loop:inner-b")

    // Inner nodes should have positions (dagre-computed within the container)
    expect(innerA?.position).toBeDefined()
    expect(innerB?.position).toBeDefined()
    // Positions should be non-negative (relative to container)
    expect(innerA!.position.x).toBeGreaterThanOrEqual(0)
    expect(innerA!.position.y).toBeGreaterThanOrEqual(0)
  })

  it("handles loop without inner nodes (backward compatibility)", () => {
    const workflow = {
      name: "legacy-loop",
      nodes: [
        {
          id: "step1",
          type: "bash",
          command: "echo step1",
        },
        {
          id: "legacy-loop",
          type: "loop",
          depends_on: ["step1"],
          iterations: 3,
          loop_body: [{ type: "agent", prompt: "retry" }],
        },
      ],
    }

    const result = yamlToFlowData(workflow)
    expect(result).not.toBeNull()
    // Legacy loop without nodes field: 2 nodes, no extraction
    expect(result!.nodes).toHaveLength(2)
    const loopNode = result!.nodes.find((n) => n.id === "legacy-loop")
    // Should keep original type "loop" when no inner nodes to extract
    expect(loopNode?.type).toBe("loop")
  })

  it("includes inner edges in the returned edges array", () => {
    const result = yamlToFlowData(buildLoopWorkflow())!

    // Total edges: greet→my-loop, my-loop→summary, my-loop:inner-a→my-loop:inner-b
    expect(result.edges).toHaveLength(3)
  })

  it("preserves inner node data (type, prompt, description)", () => {
    const result = yamlToFlowData(buildLoopWorkflow())!
    const innerA = result.nodes.find((n) => n.id === "my-loop:inner-a")

    expect(innerA?.data.type).toBe("agent")
    expect(innerA?.data.prompt).toBe("Do A")
    expect(innerA?.data.name).toBe("Inner A")
  })
})

describe("yamlToFlowData — goal-mode agent node", () => {
  it("maps node.goal into node data so goal-mode agent nodes render their middle", () => {
    const workflow = {
      name: "goal-test",
      nodes: [
        {
          id: "develop",
          type: "agent",
          description: "Develop",
          goal: "完成下述开发任务\n═══ 目标 (WHAT) ═══\n实现 token 计费",
        },
      ],
    }

    const result = yamlToFlowData(workflow)!
    const devNode = result.nodes.find((n) => n.id === "develop")

    expect(devNode?.data.type).toBe("agent")
    expect(devNode?.data.goal).toContain("实现 token 计费")
  })

  it("keeps prompt mapping untouched for non-goal (prompt-function) agent nodes", () => {
    const workflow = {
      name: "prompt-test",
      nodes: [{ id: "worker", type: "agent", prompt: "Do the thing", description: "Worker" }],
    }

    const result = yamlToFlowData(workflow)!
    const workerNode = result.nodes.find((n) => n.id === "worker")

    expect(workerNode?.data.prompt).toBe("Do the thing")
    expect(workerNode?.data.goal).toBeUndefined()
  })
})

// ─── 横向主干（2026-10-30 用户定稿：阶段从左往右，容器体内仍自上而下）───

function nodeOf(result: { nodes: Node[] }, id: string): Node {
  const n = result.nodes.find((x) => x.id === id)
  if (!n) throw new Error(`节点不存在: ${id}`)
  return n
}

function buildChainWorkflow(extraDeps: Record<string, string[]> = {}) {
  const dep = (id: string, fallback: string[]) => extraDeps[id] ?? fallback
  return {
    name: "chain-test",
    nodes: [
      { id: "a", type: "bash", command: "echo a", description: "A" },
      { id: "b", type: "bash", command: "echo b", depends_on: dep("b", ["a"]), description: "B" },
      { id: "c", type: "bash", command: "echo c", depends_on: dep("c", ["b"]), description: "C" },
    ],
  }
}

describe("yamlToFlowData — 横向主干 LR", () => {
  it("串行阶段从左往右排：x 递增、同一水平线", () => {
    const result = yamlToFlowData(buildChainWorkflow())!
    const [a, b, c] = ["a", "b", "c"].map((id) => nodeOf(result, id))

    expect(b.position.x - a.position.x).toBeGreaterThanOrEqual(280) // 节点宽 280 + 列间距
    expect(c.position.x - b.position.x).toBeGreaterThanOrEqual(280)
    expect(Math.abs(a.position.y - c.position.y)).toBeLessThanOrEqual(1)
  })

  it("同层并行分支落在同一列、按行上下分开", () => {
    const result = yamlToFlowData({
      name: "fan-out",
      nodes: [
        { id: "root", type: "bash", command: "echo root" },
        { id: "left", type: "bash", command: "echo l", depends_on: ["root"] },
        { id: "right", type: "bash", command: "echo r", depends_on: ["root"] },
        { id: "join", type: "bash", command: "echo j", depends_on: ["left", "right"] },
      ],
    })!
    const [left, right] = ["left", "right"].map((id) => nodeOf(result, id))

    expect(Math.abs(left.position.x - right.position.x)).toBeLessThanOrEqual(1)
    // 分开至少一个节点高度（否则两条并行分支叠在一起）
    expect(Math.abs(left.position.y - right.position.y)).toBeGreaterThanOrEqual(160)
    // 汇合点排在两个分支之后
    expect(nodeOf(result, "join").position.x).toBeGreaterThan(left.position.x)
  })

  it("主干节点标 LR，loop 体内节点标 TB（挂点方向由它决定）", () => {
    const result = yamlToFlowData(buildLoopWorkflow())!

    expect(nodeOf(result, "greet").data.dagOrientation).toBe("LR")
    expect(nodeOf(result, "my-loop").data.dagOrientation).toBe("LR") // 容器外壳属于主干
    expect(nodeOf(result, "my-loop:inner-a").data.dagOrientation).toBe("TB")
    expect(nodeOf(result, "my-loop:inner-b").data.dagOrientation).toBe("TB")
  })

  it("体内节点仍自上而下：inner-b 排在 inner-a 下方、同一列", () => {
    const result = yamlToFlowData(buildLoopWorkflow())!
    const a = nodeOf(result, "my-loop:inner-a")
    const b = nodeOf(result, "my-loop:inner-b")

    expect(b.position.y).toBeGreaterThan(a.position.y)
    expect(Math.abs(a.position.x - b.position.x)).toBeLessThanOrEqual(1)
  })

  it("子工作流的孙子节点也标 TB（嵌套走另一条 push 分支）", () => {
    const result = yamlToFlowData(
      {
        name: "nested",
        nodes: [
          {
            id: "outer-loop",
            type: "loop",
            max_iterations: 2,
            description: "Outer",
            nodes: [
              { id: "sw", type: "sub_workflow", workflow: "child-flow", description: "Child" },
            ],
          },
        ],
      },
      { "child-flow": [{ id: "c1", type: "bash", command: "echo c1", description: "C1" }] },
    )!

    expect(nodeOf(result, "outer-loop").data.dagOrientation).toBe("LR")
    expect(nodeOf(result, "outer-loop:sw").data.dagOrientation).toBe("TB")
    expect(nodeOf(result, "outer-loop:sw:c1").data.dagOrientation).toBe("TB")
  })

  it("跳边让开方向沿垂直于流向的轴：LR 下纵向挪，不再横向挪", () => {
    const base = yamlToFlowData(buildChainWorkflow())!
    // c 同时依赖 a 与 b ⇒ a→c 跨两个 rank，中间节点 b 要被挪出这条边的直线路径
    const skip = yamlToFlowData(buildChainWorkflow({ c: ["a", "b"] }))!

    expect(nodeOf(skip, "b").position.x).toBe(nodeOf(base, "b").position.x)
    expect(nodeOf(skip, "b").position.y - nodeOf(skip, "a").position.y).toBeGreaterThanOrEqual(100)
    expect(Math.abs(nodeOf(base, "b").position.y - nodeOf(base, "a").position.y)).toBeLessThanOrEqual(1)
  })

  it("列间距给折线留道：相邻两列的空白 ≥ ranksep 档", () => {
    const result = yamlToFlowData(buildChainWorkflow())!
    const gap = nodeOf(result, "b").position.x - nodeOf(result, "a").position.x - 280

    expect(gap).toBeGreaterThanOrEqual(100)
  })
})

