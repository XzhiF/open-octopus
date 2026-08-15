import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { initDb, closeDb } from "../db/connection"
import { applySchema } from "../db/schema"
import path from "path"
import os from "os"
import { ChatDAO, WorkspaceDAO } from '../db/dao'
import fs from "fs"
import { workflowConfigSchema } from "@octopus/shared"
import { taskPoolSystemPrompt } from "../services/scheduler/task-pool-system-prompt"

// T-2: ChatPanel AI 产出 WorkflowConfig
// 验收标准：
//   AC2 - ChatPanel 发送消息 → 后端 chat API 响应含 AI 输出
//   AC9 - AI 输出 JSON 通过 workflowConfigSchema.parse()
//
// 反假跑：
//   AC2 - 不只"后端 200"，必须验证响应含 AI 文本 + workflow_config JSON 片段
//   AC9 - 不只 JSON 可解析，必须 Zod schema 校验真通过（含 workspace_spec + workflow_chain + max_retain 必填字段）

// ── Capture provider opts to verify system prompt wiring ────────────────
let capturedSendQueryOpts: {
  systemPrompt?: { type: string; preset?: string; append?: string }
} | null = null

const sampleWorkflowConfig = {
  schema_version: '2.0',
  type: 'workflow',
  workspace_spec: {
    org: 'xzf',
    branch_prefix: 'log-cleanup',
    projects: [{ name: 'open-octopus', source_path: '', group: '' }],
  },
  workflow_chain: [
    { workflow_ref: 'test-task-workflow.yaml', input_values: {} },
  ],
  max_retain: 10,
}

// AI output wrapping the JSON in a fenced code block — what the system prompt asks for
const sampleAiResponse = '```json\n' + JSON.stringify(sampleWorkflowConfig, null, 2) + '\n```'

// Initialize isolated test database BEFORE importing index.ts
const TEST_DB = path.join(os.tmpdir(), `t2-chatpanel-test-${Date.now()}.db`)
beforeAll(() => {
  const db = initDb(TEST_DB)
  applySchema(db)
})
afterAll(() => {
  closeDb()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

import app from "../index"
import { WorkspaceService } from "../services/workspace"
import { getDb } from "../db/connection"
import { ChatService } from "../services/chat"
import { SSEService } from "../services/sse"

vi.mock("@octopus/providers", async () => {
  const actual = await vi.importActual("@octopus/providers")
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      getType: () => 'claude',
      sendQuery: async function* (_prompt: string, _cwd: string, _resume: string | undefined, opts: any) {
        capturedSendQueryOpts = opts ?? null
        const msgId = 'msg-task-pool-1'
        yield { type: 'message_start', messageId: msgId }
        yield { type: 'text_delta', content: sampleAiResponse, messageId: msgId }
        yield { type: 'text_done', messageId: msgId }
        yield { type: 'message_stop', messageId: msgId }
        yield { type: 'result', sessionId: 'task-pool-session-1', tokens: { input: 100, output: 50 } }
      },
    })),
  }
})

// ── AC9 反假跑 (静态): AI output JSON 真通过 workflowConfigSchema.parse() ──
// 不只 JSON.parse 不抛错，必须 Zod schema 真校验通过

describe('T-2: workflowConfigSchema 对 AI 产出 JSON 的校验', () => {
  it('AC9: AI 输出 JSON 通过 workflowConfigSchema.parse() (含必填字段)', () => {
    // 反假跑 AC9: 不只 JSON.parse 不抛错，必须 Zod schema 真校验通过
    const parsed = workflowConfigSchema.parse(sampleWorkflowConfig)
    expect(parsed.schema_version).toBe('2.0')
    expect(parsed.type).toBe('workflow')
    expect(parsed.workspace_spec.org).toBe('xzf')
    expect(parsed.workspace_spec.branch_prefix).toBe('log-cleanup')
    expect(parsed.workflow_chain).toHaveLength(1)
    expect(parsed.max_retain).toBe(10)
  })

  it('AC9 反假跑: 缺 workspace_spec 时 Zod 拒绝', () => {
    const broken = { ...sampleWorkflowConfig, workspace_spec: undefined }
    expect(() => workflowConfigSchema.parse(broken)).toThrow()
  })

  it('AC9 反假跑: workflow_chain 空数组时 Zod 拒绝 (min(1))', () => {
    const broken = { ...sampleWorkflowConfig, workflow_chain: [] }
    expect(() => workflowConfigSchema.parse(broken)).toThrow()
  })
})

// ── AC2: 系统提示词必须引导 AI 产出 fenced code block JSON ─────────────

describe('T-2: taskPoolSystemPrompt 内容', () => {
  it('AC2: 系统提示词包含 schema 必填字段 + fenced code block 指令', () => {
    // 反假跑 AC2: 不只"有 prompt"，必须验证 prompt 真引导 AI 产出 JSON
    expect(taskPoolSystemPrompt).toMatch(/workspace_spec/)
    expect(taskPoolSystemPrompt).toMatch(/workflow_chain/)
    expect(taskPoolSystemPrompt).toMatch(/max_retain/)
    expect(taskPoolSystemPrompt).toMatch(/schema_version/) // 必须引导字面量
    expect(taskPoolSystemPrompt).toMatch(/```json/) // 必须要求 fenced code block
    expect(taskPoolSystemPrompt.length).toBeGreaterThan(200) // 真有内容，不是占位
  })
})

// ── AC2 集成 (mock provider): POST 消息 with purpose='requirement' ──────

describe('T-2: POST /api/workspaces/:id/chat/sessions/:sid/messages with purpose=requirement', () => {
  let workspaceId: string
  let sessionId: string
  let existingWsIds: Set<string>

  beforeAll(() => {
    const wsService = new WorkspaceService(new WorkspaceDAO(getDb()))
    existingWsIds = new Set(wsService.list().map(ws => ws.id))

    const ws = wsService.create({ name: "t2-chatpanel-test", org: "xzf", path: "/tmp/octopus-t2-test" })
    workspaceId = ws.id

    const chatService = new ChatService(new ChatDAO(getDb()), new SSEService())
    const session = chatService.createSession(workspaceId, "T-2 Hatch")
    sessionId = session.id
  })

  afterAll(async () => {
    const wsService = new WorkspaceService(new WorkspaceDAO(getDb()))
    const currentIds = wsService.list().map(ws => ws.id)
    for (const id of currentIds) {
      if (!existingWsIds.has(id)) {
        await wsService.delete(id)
      }
    }
  })

  it('AC2 反假跑: 响应含 AI 文本 + workflow_config JSON 片段 + 系统提示词真传递', async () => {
    capturedSendQueryOpts = null

    const res = await app.request(
      `/api/workspaces/${workspaceId}/chat/sessions/${sessionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content: "我需要一个每天清理日志的任务", purpose: 'requirement' }),
        headers: { "Content-Type": "application/json" },
      }
    )

    expect(res.status).toBe(200)
    await res.text() // drain SSE

    // 反假跑 AC2: 不只 200，必须验证 AI 文本 + workflow_config JSON 真持久化
    const chatService = new ChatService(new ChatDAO(getDb()), new SSEService())
    const updated = chatService.getSession(sessionId)
    expect(updated).toBeDefined()
    const aiMessages = updated!.messages.filter(m => m.role === 'assistant' && m.type === 'text')
    expect(aiMessages.length, '必须有 assistant text 消息').toBeGreaterThan(0)

    const aiText = aiMessages[0].content
    expect(aiText, 'AI 文本必须非空').toBeTruthy()
    // 反假跑 AC2: 必须含 ```json 围栏 + workflow_config JSON 片段
    expect(aiText).toMatch(/```json/)
    expect(aiText).toMatch(/workspace_spec/)
    expect(aiText).toMatch(/workflow_chain/)

    // 反假跑 AC9: 提取的 JSON 真通过 workflowConfigSchema.parse() (不是 catch 忽略)
    const match = aiText.match(/```json\s*([\s\S]*?)\s*```/)
    expect(match, '必须能从 fenced code block 提取 JSON').not.toBeNull()
    const parsed = workflowConfigSchema.parse(JSON.parse(match![1]))
    expect(parsed.workspace_spec.branch_prefix).toBe('log-cleanup')

    // 反假跑 (system prompt wiring): 验证后端真把 taskPoolSystemPrompt 传给 provider
    expect(capturedSendQueryOpts, 'sendQuery 必须被调用').not.toBeNull()
    expect(capturedSendQueryOpts!.systemPrompt, '必须有 systemPrompt').toBeDefined()
    expect(capturedSendQueryOpts!.systemPrompt!.append).toBe(taskPoolSystemPrompt)
  })
})
