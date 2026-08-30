import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, act } from "@testing-library/react"
import type { ReactNode } from "react"

// ── SSE handler 捕获 ──────────────────────────────────────────────
const { sseHandlers, viewerProps } = vi.hoisted(() => ({
  sseHandlers: new Map<string, (e: MessageEvent) => void>(),
  viewerProps: { current: null as Record<string, unknown> | null },
}))

vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: (_url: string, event: string, handler: (e: MessageEvent) => void) => {
    sseHandlers.set(event, handler)
    return () => { sseHandlers.delete(event) }
  },
}))

vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://test-server" }))
vi.mock("@/lib/api-client", () => ({ fetchAgentEvents: vi.fn(async () => ({})) }))
vi.mock("@/hooks/use-live-timer", () => ({ useLiveTimer: () => "0:05" }))
vi.mock("@/hooks/use-agent-traces", () => ({
  useAgentTraces: () => ({ turns: [], loading: false, error: null, isDegraded: false }),
}))
vi.mock("@/hooks/use-llm-calls", () => ({
  useLLMCalls: () => ({ calls: [], aggregates: null, loading: false }),
}))

// ── 重组件 stub ──────────────────────────────────────────────────
vi.mock("../workflow-flow-viewer-with-status", () => ({
  WorkflowFlowViewerWithStatus: (props: Record<string, unknown>) => {
    viewerProps.current = props
    return <div data-testid="viewer" />
  },
}))
vi.mock("../execution-log-viewer", () => ({ ExecutionLogViewer: () => <div /> }))
vi.mock("../intervention-dialog", () => ({ InterventionDialog: () => <div /> }))
vi.mock("../approval-dialog", () => ({ ApprovalDialog: () => <div /> }))
vi.mock("../interaction-modal", () => ({ InteractionModal: () => <div /> }))
vi.mock("../node-info-dialog", () => ({ NodeInfoDialog: () => <div /> }))
vi.mock("@/components/swarm/organisms/swarm-detail-dialog", () => ({ SwarmDetailDialog: () => <div /> }))
vi.mock("@/components/agent/knowledge/archive/ArchiveDialog", () => ({ ArchiveDialog: () => <div /> }))
vi.mock("../harness-floating-panel", () => ({ HarnessFloatingPanel: () => <div /> }))
vi.mock("@/components/agent-timeline/agent-timeline", () => ({ AgentTimeline: () => <div /> }))
vi.mock("@/components/cost-line", () => ({ CostLine: () => <div /> }))
vi.mock("react-resizable-panels", () => ({
  Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PanelGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}))

import { WorkflowDetailPanel } from "../workflow-detail-panel"
import type { Execution } from "@/lib/types"

function makeExecution(): Execution {
  return {
    id: "exec-1",
    status: "running",
    workflowName: "wf",
    steps: [
      { stepId: "n1", stepName: "Node 1", status: "pending" },
      { stepId: "n2", stepName: "Node 2", status: "pending" },
    ],
  } as unknown as Execution
}

function getSteps() {
  return (viewerProps.current?.executionSteps ?? []) as Array<Record<string, unknown>>
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

function fire(event: string, payload: unknown) {
  const handler = sseHandlers.get(event)
  if (!handler) throw new Error(`no handler for ${event}`)
  act(() => { handler({ data: JSON.stringify(payload) } as MessageEvent) })
}

describe("WorkflowDetailPanel SSE 增量更新 liveSteps", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      json: async () => ({
        status: "running",
        steps: [
          { stepId: "n1", stepName: "Node 1", status: "pending" },
          { stepId: "n2", stepName: "Node 2", status: "pending" },
        ],
      }),
    })))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it("node_start 事件立即把对应 step 置为 running", async () => {
    render(<WorkflowDetailPanel execution={makeExecution()} workspaceId="ws-1" />)
    await flush()
    expect(getSteps().find(s => s.stepId === "n1")?.status).toBe("pending")
    fire("node_start", { executionId: "exec-1", nodeId: "n1" })
    expect(getSteps().find(s => s.stepId === "n1")?.status).toBe("running")
    expect(getSteps().find(s => s.stepId === "n2")?.status).toBe("pending")
  })

  it("node_end 事件写入 status/duration/usage/modelUsages", async () => {
    render(<WorkflowDetailPanel execution={makeExecution()} workspaceId="ws-1" />)
    await flush()
    fire("node_end", {
      executionId: "exec-1",
      nodeId: "n1",
      status: "completed",
      durationMs: 12345,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      modelUsages: [{ model: "m1", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 }],
    })
    const n1 = getSteps().find(s => s.stepId === "n1")
    expect(n1?.status).toBe("completed")
    expect(n1?.duration).toBe(12)
    expect(n1?.tokensInput).toBe(100)
    expect(n1?.tokensOutput).toBe(50)
    expect(n1?.tokenUsages).toHaveLength(1)
    expect(n1?.completedAt).toBeTruthy()
  })

  it("其他 execution 的事件被忽略", async () => {
    render(<WorkflowDetailPanel execution={makeExecution()} workspaceId="ws-1" />)
    await flush()
    fire("node_start", { executionId: "other-exec", nodeId: "n1" })
    expect(getSteps().find(s => s.stepId === "n1")?.status).toBe("pending")
  })

  it("execution_status 事件即时更新执行状态", async () => {
    render(<WorkflowDetailPanel execution={makeExecution()} workspaceId="ws-1" />)
    await flush()
    fire("execution_status", { executionId: "exec-1", status: "completed" })
    expect(screen.getByText("已完成")).toBeTruthy()
  })

  it("agent_event(turn_usage) 实时更新运行中节点的 token 与轮次", async () => {
    render(<WorkflowDetailPanel execution={makeExecution()} workspaceId="ws-1" />)
    await flush()
    fire("agent_event", {
      executionId: "exec-1", nodeId: "n1",
      event: { type: "turn_usage", turn: 3, delta: { outputTokens: 57 }, cumulative: { inputTokens: 18, outputTokens: 219, cacheReadTokens: 73054, cacheCreationTokens: 36695 } },
    })
    const n1 = getSteps().find(s => s.stepId === "n1")
    expect(n1?.status).toBe("running")
    expect(n1?.tokensInput).toBe(18)
    expect(n1?.tokensOutput).toBe(219)
    expect(n1?.turns).toBe(3)
    // 其他节点不受影响
    expect(getSteps().find(s => s.stepId === "n2")?.status).toBe("pending")
  })

  it("turn_usage 缺 inputTokens（直连 Anthropic 口径）→ 保留已有 tokensInput 不清零", async () => {
    render(<WorkflowDetailPanel execution={makeExecution()} workspaceId="ws-1" />)
    await flush()
    fire("agent_event", {
      executionId: "exec-1", nodeId: "n1",
      event: { type: "turn_usage", turn: 1, delta: { outputTokens: 42 }, cumulative: { inputTokens: 0, outputTokens: 42, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    })
    const n1 = getSteps().find(s => s.stepId === "n1")
    expect(n1?.tokensOutput).toBe(42)
    expect(n1?.tokensInput ?? undefined).toBeUndefined()
    fire("node_end", { executionId: "exec-1", nodeId: "n1", status: "completed", usage: { inputTokens: 100, outputTokens: 99, cacheReadTokens: 0, cacheCreationTokens: 0 } })
    const done = getSteps().find(s => s.stepId === "n1")
    expect(done?.tokensInput).toBe(100)
    expect(done?.tokensOutput).toBe(99)
  })

  it("非 turn_usage 的 agent_event 不产生补丁", async () => {
    render(<WorkflowDetailPanel execution={makeExecution()} workspaceId="ws-1" />)
    await flush()
    fire("agent_event", { executionId: "exec-1", nodeId: "n1", event: { type: "text_delta", content: "hi" } })
    const n1 = getSteps().find(s => s.stepId === "n1")
    expect(n1?.status).toBe("pending")
  })

  it("晚于 fetch 发出的 SSE 补丁不被旧轮询快照覆盖", async () => {
    let pollSteps: Array<Record<string, unknown>> = [
      { stepId: "n1", stepName: "Node 1", status: "pending" },
      { stepId: "n2", stepName: "Node 2", status: "pending" },
    ]
    let resolveFetch: ((v: unknown) => void) | null = null
    vi.stubGlobal("fetch", vi.fn(() => new Promise(res => {
      resolveFetch = v => res(v)
    })))

    render(<WorkflowDetailPanel execution={makeExecution()} workspaceId="ws-1" />
    )
    // 一次轮询已发出但响应未回（快照里 n1 仍是 pending）
    await act(async () => { /* let effect-triggered fetch start */ })

    fire("node_end", { executionId: "exec-1", nodeId: "n1", status: "completed", usage: { inputTokens: 7, outputTokens: 9, cacheReadTokens: 0, cacheCreationTokens: 0 } })
    // 旧快照迟到返回
    pollSteps = [...pollSteps] // snapshot taken before SSE patch
    await act(async () => { resolveFetch?.({ json: async () => ({ status: "running", steps: pollSteps }) }) })

    expect(getSteps().find(s => s.stepId === "n1")?.status).toBe("completed")
    expect(getSteps().find(s => s.stepId === "n1")?.tokensInput).toBe(7)
  })

  it("运行中 turn_usage 补丁先于轮询发起 → 不被无 token 的运行中快照抹掉", async () => {
    // 回归：旧 `entry.ts >= t0` 规则会丢弃「早于本次 fetch 发起」的实时补丁，
    // 而运行中节点 REST 快照永远不含 token（只在 node_end 落库）→ 每轮抹零，
    // 表现为「只有 node_end 才看得到」。修复后：运行中 + 无 token 的快照必须让实时补丁胜出。
    vi.useFakeTimers()
    try {
      let resolveFetch: ((v: unknown) => void) | null = null
      vi.stubGlobal("fetch", vi.fn(() => new Promise(res => { resolveFetch = v => res(v) })))
      const runningNoToken = {
        status: "running",
        steps: [
          { stepId: "n1", stepName: "Node 1", status: "running" },
          { stepId: "n2", stepName: "Node 2", status: "pending" },
        ],
      }
      render(<WorkflowDetailPanel execution={makeExecution()} workspaceId="ws-1" />)
      await act(async () => {})
      // 初始轮询：n1 运行中、REST 尚无 usage
      await act(async () => { resolveFetch?.({ json: async () => runningNoToken }) })
      expect(getSteps().find(s => s.stepId === "n1")?.tokensInput).toBeUndefined()

      // turn_usage 实时补丁写入（时刻 = 当前假时钟 T）
      fire("agent_event", {
        executionId: "exec-1", nodeId: "n1",
        event: { type: "turn_usage", turn: 3, delta: { outputTokens: 57 }, cumulative: { inputTokens: 18, outputTokens: 219, cacheReadTokens: 0, cacheCreationTokens: 0 } },
      })
      expect(getSteps().find(s => s.stepId === "n1")?.tokensInput).toBe(18)

      // 推进时钟触发下一次轮询：其 t0 (T+3000) 晚于补丁时刻 T
      vi.advanceTimersByTime(3000)
      await act(async () => {})
      await act(async () => { resolveFetch?.({ json: async () => runningNoToken }) })

      // 补丁必须存活，不被运行中无 token 的快照回退
      const n1 = getSteps().find(s => s.stepId === "n1")
      expect(n1?.tokensInput).toBe(18)
      expect(n1?.tokensOutput).toBe(219)
      expect(n1?.turns).toBe(3)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it("node_end 落库后：迟到的旧轮询已带权威 token → 不被更早的 turn_usage 补丁覆盖", async () => {
    // 保护反向竞态：终值落库后，小累计的旧实时补丁不得回退权威值。
    vi.useFakeTimers()
    try {
      let resolveFetch: ((v: unknown) => void) | null = null
      vi.stubGlobal("fetch", vi.fn(() => new Promise(res => { resolveFetch = v => res(v) })))
      render(<WorkflowDetailPanel execution={makeExecution()} workspaceId="ws-1" />)
      await act(async () => {})
      await act(async () => { resolveFetch?.({ json: async () => ({ status: "running", steps: [{ stepId: "n1", stepName: "Node 1", status: "running" }, { stepId: "n2", stepName: "Node 2", status: "pending" }] }) }) })
      // turn_usage 补丁（小累计）
      fire("agent_event", {
        executionId: "exec-1", nodeId: "n1",
        event: { type: "turn_usage", turn: 2, delta: { outputTokens: 20 }, cumulative: { inputTokens: 5, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0 } },
      })
      // 推进时钟：补丁早于下一次 fetch 发起
      vi.advanceTimersByTime(3000)
      await act(async () => {})
      // 迟到快照已带 node_end 权威值
      await act(async () => { resolveFetch?.({ json: async () => ({ status: "completed", steps: [{ stepId: "n1", stepName: "Node 1", status: "completed", usage: { inputTokens: 100, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 } }, { stepId: "n2", stepName: "Node 2", status: "pending" }] }) }) })
      const n1 = getSteps().find(s => s.stepId === "n1")
      expect(n1?.status).toBe("completed")
      expect(n1?.tokensInput).toBe(100)   // 权威终值，未被小累计补丁覆盖
      expect(n1?.tokensOutput).toBe(500)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
