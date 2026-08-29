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

  it("node_end 事件写入 status/duration/tokens/tokenUsages", async () => {
    render(<WorkflowDetailPanel execution={makeExecution()} workspaceId="ws-1" />)
    await flush()
    fire("node_end", {
      executionId: "exec-1",
      nodeId: "n1",
      status: "completed",
      durationMs: 12345,
      tokens: { input: 100, output: 50 },
      tokenUsages: [{ model: "m1", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 }],
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
      event: { type: "turn_usage", turn: 3, delta: { outputTokens: 57 }, total: { inputTokens: 18, outputTokens: 219, cacheReadTokens: 73054, cacheCreationTokens: 36695 } },
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
      event: { type: "turn_usage", turn: 1, delta: { outputTokens: 42 }, total: { outputTokens: 42 } },
    })
    const n1 = getSteps().find(s => s.stepId === "n1")
    expect(n1?.tokensOutput).toBe(42)
    expect(n1?.tokensInput ?? undefined).toBeUndefined()
    fire("node_end", { executionId: "exec-1", nodeId: "n1", status: "completed", tokens: { input: 100, output: 99 } })
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

    fire("node_end", { executionId: "exec-1", nodeId: "n1", status: "completed", tokens: { input: 7, output: 9 } })
    // 旧快照迟到返回
    pollSteps = [...pollSteps] // snapshot taken before SSE patch
    await act(async () => { resolveFetch?.({ json: async () => ({ status: "running", steps: pollSteps }) }) })

    expect(getSteps().find(s => s.stepId === "n1")?.status).toBe("completed")
    expect(getSteps().find(s => s.stepId === "n1")?.tokensInput).toBe(7)
  })
})
