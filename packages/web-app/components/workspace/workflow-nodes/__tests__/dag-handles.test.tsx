import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"

// Handle 在 xyflow 内部要注册进 node store（NodeId/Store context），jsdom 单测里那套
// 上下文不存在。这里打桩成可断言的 DOM：我们关心「进/出边挂哪条边」，不是 xyflow 怎么注册。
vi.mock("@xyflow/react", () => ({
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  Handle: ({ type, position, id, style, className }: {
    type: string; position: string; id?: string; style?: React.CSSProperties; className?: string
  }) => (
    <div
      data-testid="handle"
      data-type={type}
      data-position={position}
      data-id={id}
      data-class={className ?? ""}
      style={style}
    />
  ),
}))

import { branchCrossAxisStyle, handlePositions } from "../dag-handles"
import { BashNode } from "../bash-node"
import { ConditionNode } from "../condition-node"
import { LoopContainerNode } from "../loop-container-node"
import { SubWorkflowContainerNode } from "../sub-workflow-container-node"
import { SwarmNode } from "@/components/swarm/organisms/swarm-node"

// 2026-10-30：工作流 DAG 改横向主干（阶段从左往右），容器体内仍纵向。
// 流向由 workflow-parser 写进 data.dagOrientation，节点组件从这里取挂点方向。

/** 节点组件只读 data/selected；其余 NodeProps 字段与断言无关，一处收敛掉。 */
const props = (data: Record<string, unknown>) => ({ data, selected: false }) as never

function handles(): HTMLElement[] {
  return Array.from(screen.getAllByTestId("handle"))
}

function byType(type: "target" | "source"): HTMLElement[] {
  return handles().filter((h) => h.dataset.type === type)
}

describe("handlePositions —— 流向到挂点的映射", () => {
  it("LR：左进右出", () => {
    expect(handlePositions("LR")).toEqual({ target: "left", source: "right" })
  })

  it("TB：上进下出", () => {
    expect(handlePositions("TB")).toEqual({ target: "top", source: "bottom" })
  })
})

describe("branchCrossAxisStyle —— 分支口沿垂直于流向的轴等分", () => {
  /** 百分比字符串取数值再比 —— 不断浮点尾巴 */
  const pct = (style: React.CSSProperties) => parseFloat(String(style.top ?? style.left))

  it("LR 铺上下（top%），TB 铺左右（left%）", () => {
    const first = branchCrossAxisStyle("LR", 0, 2)
    const second = branchCrossAxisStyle("LR", 1, 2)
    expect(first.top).toBeDefined()
    expect(pct(first)).toBeCloseTo(100 / 3)
    expect(pct(second)).toBeCloseTo((100 / 3) * 2)
    expect(branchCrossAxisStyle("TB", 0, 2).left).toBeDefined()
    expect(pct(branchCrossAxisStyle("TB", 0, 2))).toBeCloseTo(100 / 3)
  })

  it("单分支落在中点，不会挤在角上", () => {
    expect(pct(branchCrossAxisStyle("LR", 0, 1))).toBeCloseTo(50)
    expect(pct(branchCrossAxisStyle("TB", 0, 1))).toBeCloseTo(50)
  })
})

describe("BashNode 挂点方向", () => {
  it("dagOrientation=LR → 左进右出", () => {
    render(<BashNode {...props({ id: "a", type: "bash", name: "A", dagOrientation: "LR" })} />)
    expect(byType("target")[0].dataset.position).toBe("left")
    expect(byType("source")[0].dataset.position).toBe("right")
  })

  it("不带 dagOrientation（执行树/调试页那种手摆画布）→ 维持上进下出，本次不动", () => {
    render(<BashNode {...props({ id: "a", type: "bash", name: "A" })} />)
    expect(byType("target")[0].dataset.position).toBe("top")
    expect(byType("source")[0].dataset.position).toBe("bottom")
  })
})

describe("ConditionNode 分支口", () => {
  const cases = [
    { when: "exit_code == 0", then: "next" },
    { when: "failed", then: "retry" },
  ]

  it("LR：两条 case 边都从右边出、按高度分开，不叠在同一点", () => {
    render(<ConditionNode {...props({ id: "c", type: "condition", name: "C", cases, dagOrientation: "LR" })} />)
    const branch = byType("source").filter((h) => h.dataset.id?.startsWith("case-"))
    expect(branch).toHaveLength(2)
    expect(branch.map((h) => h.dataset.position)).toEqual(["right", "right"])
    expect(parseFloat(branch[0].style.top)).toBeCloseTo(100 / 3)
    expect(parseFloat(branch[1].style.top)).toBeCloseTo((100 / 3) * 2)
    // 入口只有一个、在左边
    expect(byType("target").map((h) => h.dataset.position)).toEqual(["left"])
  })

  it("TB（容器体内）：分支口仍走底边左右铺开", () => {
    render(<ConditionNode {...props({ id: "c", type: "condition", name: "C", cases, dagOrientation: "TB" })} />)
    const branch = byType("source").filter((h) => h.dataset.id?.startsWith("case-"))
    expect(branch.map((h) => h.dataset.position)).toEqual(["bottom", "bottom"])
    expect(parseFloat(branch[0].style.left)).toBeCloseTo(100 / 3)
  })

  it("分支口保留成功/失败配色（改版只换轴，不换色）", () => {
    render(<ConditionNode {...props({ id: "c", type: "condition", name: "C", cases, dagOrientation: "LR" })} />)
    const branch = byType("source").filter((h) => h.dataset.id?.startsWith("case-"))
    expect(branch[0].style.background).toBe("var(--pop-green)")
    expect(branch[1].style.background).toBe("var(--pop-red)")
  })
})

describe("容器节点挂点", () => {
  it("loop 容器挂在主干（LR）时：左右挂点 + 小一档尺寸类", () => {
    render(<LoopContainerNode {...props({ id: "l", type: "loop-container", name: "L", dagOrientation: "LR" })} />)
    expect(byType("target")[0].dataset.position).toBe("left")
    expect(byType("source")[0].dataset.position).toBe("right")
    expect(byType("target")[0].dataset.class).toContain("!w-3")
  })

  it("子工作流容器作为体内节点（TB）时：仍上进下出", () => {
    render(<SubWorkflowContainerNode {...props({ id: "s", type: "sub-workflow-container", name: "S", dagOrientation: "TB" })} />)
    expect(byType("target")[0].dataset.position).toBe("top")
    expect(byType("source")[0].dataset.position).toBe("bottom")
  })
})

describe("SwarmNode 挂点方向", () => {
  const swarmData = {
    id: "sw", name: "Swarm", mode: "review", status: "pending",
    expertCount: 3, consensusScore: null, workspaceId: "w-1", dagOrientation: "LR",
  }

  it("swarm 节点在主干上：左进右出（原来固定上/下，横向后边会从节点身体穿过）", () => {
    render(<SwarmNode {...props(swarmData)} />)
    expect(byType("target")[0].dataset.position).toBe("left")
    expect(byType("source")[0].dataset.position).toBe("right")
  })
})
