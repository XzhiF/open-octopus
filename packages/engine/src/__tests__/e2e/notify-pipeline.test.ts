/**
 * E2E Integration Test: Full Notification Pipeline
 *
 * Exercises the complete path:
 *   workflow YAML with notify hook → engine runHooks → NotifyDispatcher
 *   → WebhookProvider → mock HTTP server → assertion on received payload
 *
 * This catches integration regressions that unit tests miss.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest"
import { createServer, type Server } from "http"
import { WorkflowEngine } from "../../engine"
import { registerBuiltinProviders } from "../../notify/index"
import { ProviderRegistry } from "../../notify/registry"
import type { WorkflowDef, NotifyProviderConfig, ChannelProfile, PipelineConfig } from "@octopus/shared"
import type { NodeExecutionResult } from "../../executors/types"
import type { IAgentProvider } from "@octopus/providers"

// Mock executors (same pattern as hooks.test.ts)
vi.mock("../../executors/bash", () => ({
  BashExecutor: vi.fn(),
}))
vi.mock("../../executors/python", () => ({ PythonExecutor: vi.fn() }))
vi.mock("../../executors/condition", () => ({ ConditionExecutor: vi.fn() }))
vi.mock("../../executors/approval", () => ({ ApprovalExecutor: vi.fn() }))
vi.mock("../../executors/loop", () => ({ LoopExecutor: vi.fn() }))
vi.mock("../../executors/agent", () => ({ AgentExecutor: vi.fn() }))
vi.mock("../../logger", () => ({
  JsonlLogger: vi.fn().mockImplementation(() => ({
    log: vi.fn(),
    getLogDir: vi.fn().mockReturnValue("/tmp/logs"),
  })),
}))

import { BashExecutor } from "../../executors/bash"

function makeCompletedResult(overrides?: Partial<NodeExecutionResult>): NodeExecutionResult {
  return { status: "completed", outputs: {}, durationMs: 10, logLines: [], ...overrides }
}

function makeMockProvider(): IAgentProvider {
  return {
    getType: () => "claude",
    sendQuery: async function* () {
      yield { type: "result", content: "done", sessionId: "s" }
    },
  }
}

interface ReceivedWebhook {
  severity: string
  title: string
  body: string
  timestamp: string
}

describe("E2E: Full Notification Pipeline", () => {
  let server: Server
  let receivedWebhooks: ReceivedWebhook[] = []
  let serverPort: number
  const mockProvider = makeMockProvider()

  beforeAll(async () => {
    // Allow webhook to 127.0.0.1 in tests (SSRF bypass for test environments)
    process.env.OCTOPUS_SKIP_SSRF_CHECK = "1"
    registerBuiltinProviders()

    // Start a mock HTTP server to receive webhook notifications
    server = createServer((req, res) => {
      let body = ""
      req.on("data", (chunk: string) => { body += chunk })
      req.on("end", () => {
        try {
          receivedWebhooks.push(JSON.parse(body))
        } catch {
          // ignore parse errors
        }
        res.writeHead(200)
        res.end("ok")
      })
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    serverPort = (server.address() as any).port
  })

  afterAll(async () => {
    delete process.env.OCTOPUS_SKIP_SSRF_CHECK
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve())
    })
  })

  beforeEach(() => {
    receivedWebhooks = []
    vi.clearAllMocks()
    ProviderRegistry.clearTypes()
    registerBuiltinProviders()
  })

  function makePipelineConfig(): PipelineConfig {
    return {
      apiVersion: "octopus/v2",
      kind: "Pipeline",
      execution: {
        failure_strategy: "fail_fast",
        timeout: 60,
        max_concurrent: 0,
        resume_on_interrupt: "manual",
        auto_resume_max_attempts: 3,
        auto_resume_delay: 10,
        pending_resume_timeout: 600,
      },
      retry: {
        default: {
          max_attempts: 1,
          backoff: { type: "fixed", initial_delay: 1, multiplier: 1, increment: 0, max_delay: 1 },
          max_total_duration: 0,
          retry_on: [],
          never_retry_on: [],
        },
        overrides: {},
      },
      fork: { path_strategy: "all", merge_strategy: "wait_all", failure_handling: "fail_all" },
      checkpoint: { enabled: false, save_on: "per-node", max_checkpoints: 10, ttl: 86400, max_size_bytes: 1048576 },
      providers: {
        "test-webhook": {
          type: "webhook",
          timeout: 5,
          min_severity: "info",
          method: "POST",
          url: `http://127.0.0.1:${serverPort}/webhook`,
        } as NotifyProviderConfig,
      },
      channels: {
        "team-default": {
          provider: "test-webhook",
        } as ChannelProfile,
      },
      runtime_nodes: [],
    } as PipelineConfig
  }

  it("sends webhook notification when node succeeds with notify hook", async () => {
    const executeFn = vi.fn().mockResolvedValue(makeCompletedResult())
    vi.mocked(BashExecutor).mockImplementation(() => ({ execute: executeFn } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "e2e-notify-test",
      execution_mode: "serial",
      hooks: {
        on_node_success: [{
          type: "notify",
          channel: "team-default",
          template: {
            severity: "info",
            title: "✅ $hook.node_id completed",
            body: "Node $hook.node_id finished in ${hook.node_duration_ms | duration}",
          },
        }],
      },
      nodes: [
        { id: "setup", type: "bash", bash: "echo ok" },
        { id: "analyze", type: "bash", bash: "echo done", depends_on: ["setup"] },
      ],
    }

    const engine = new WorkflowEngine(workflow, { claude: mockProvider }, "/tmp/test")
    engine.setPipelineConfig(makePipelineConfig())

    const result = await engine.run()
    expect(result.status).toBe("completed")

    // Verify webhooks were received
    expect(receivedWebhooks.length).toBeGreaterThanOrEqual(2)

    // Verify first notification (setup node)
    const setupNotif = receivedWebhooks.find(n => n.title.includes("setup"))
    expect(setupNotif).toBeDefined()
    expect(setupNotif?.severity).toBe("info")
    expect(setupNotif?.title).toBe("✅ setup completed")

    // Verify second notification (analyze node)
    const analyzeNotif = receivedWebhooks.find(n => n.title.includes("analyze"))
    expect(analyzeNotif).toBeDefined()
    expect(analyzeNotif?.title).toBe("✅ analyze completed")
  })

  it("renders conditional template blocks correctly in webhook payload", async () => {
    const executeFn = vi.fn().mockResolvedValue(makeCompletedResult())
    vi.mocked(BashExecutor).mockImplementation(() => ({ execute: executeFn } as any))

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "e2e-conditional-test",
      execution_mode: "serial",
      variables: { conclusion: "All checks passed" },
      hooks: {
        on_node_success: [{
          type: "notify",
          channel: "team-default",
          template: {
            severity: "info",
            title: "Test",
            body: "before {{#if $vars.conclusion}}💡 $vars.conclusion {{/if}}after",
          },
        }],
      },
      nodes: [{ id: "step1", type: "bash", bash: "echo ok" }],
    }

    const engine = new WorkflowEngine(workflow, { claude: mockProvider }, "/tmp/test")
    engine.setPipelineConfig(makePipelineConfig())

    await engine.run()

    expect(receivedWebhooks.length).toBeGreaterThanOrEqual(1)
    const notif = receivedWebhooks.find(n => n.title === "Test")
    expect(notif).toBeDefined()
    // Conditional block should be rendered with the conclusion value (spaces around variable for proper boundary detection)
    expect(notif?.body).toBe("before 💡 All checks passed after")
  })

  it("fan-out sends to multiple channels", async () => {
    const executeFn = vi.fn().mockResolvedValue(makeCompletedResult())
    vi.mocked(BashExecutor).mockImplementation(() => ({ execute: executeFn } as any))

    const cfg = makePipelineConfig()
    // Add a second channel for fan-out
    const channels = cfg.channels as Record<string, ChannelProfile>
    channels["ops-channel"] = { provider: "test-webhook" }

    const workflow: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "e2e-fanout-test",
      execution_mode: "serial",
      hooks: {
        on_node_success: [{
          type: "notify",
          channel: ["team-default", "ops-channel"],
          template: {
            severity: "info",
            title: "Fan-out: $hook.node_id",
          },
        }],
      },
      nodes: [{ id: "step1", type: "bash", bash: "echo ok" }],
    }

    const engine = new WorkflowEngine(workflow, { claude: mockProvider }, "/tmp/test")
    engine.setPipelineConfig(cfg)

    await engine.run()

    // Fan-out should send 2 notifications for 1 node (one per channel)
    expect(receivedWebhooks.length).toBe(2)
    expect(receivedWebhooks[0].title).toBe("Fan-out: step1")
    expect(receivedWebhooks[1].title).toBe("Fan-out: step1")
  })
})
