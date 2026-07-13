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

  it("sets parentId on inner nodes pointing to loop container", () => {
    const result = yamlToFlowData(buildLoopWorkflow())!
    const innerA = result.nodes.find((n) => n.id === "my-loop:inner-a")
    const innerB = result.nodes.find((n) => n.id === "my-loop:inner-b")

    expect(innerA?.parentId).toBe("my-loop")
    expect(innerB?.parentId).toBe("my-loop")
  })

  it("sets extent: 'parent' on inner nodes", () => {
    const result = yamlToFlowData(buildLoopWorkflow())!
    const innerA = result.nodes.find((n) => n.id === "my-loop:inner-a")
    const innerB = result.nodes.find((n) => n.id === "my-loop:inner-b")

    expect(innerA?.extent).toBe("parent")
    expect(innerB?.extent).toBe("parent")
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
