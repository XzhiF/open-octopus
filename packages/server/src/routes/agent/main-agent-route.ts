// packages/server/src/routes/agent/main-agent-route.ts
//
// Main Agent unified entry route — POST /api/agent/chat
// LLM routing with tool-based delegation (delegate_to_* tools). The old
// deterministic user-side delegation (body.delegate_to, @@mention handoff)
// was retired in v59 — 分身 now switches identity (chip) or is consulted as a
// one-turn subagent; this endpoint ignores a stray delegate_to field.
//
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { SSEStreamingApi } from 'hono/streaming'
import crypto from 'crypto'
import type { MessageChunk } from '@octopus/providers'
import { getProvider } from '@octopus/providers'
import type { EffortLevel } from '@octopus/shared'
import { parseComposerContext, parseComposerEffort, resolveChatModel } from './composer-options'
import type { AgentSessionDAO } from '../../db/dao'
import { SessionCacheContextDAO } from '../../db/dao/session-cache-context-dao'
import { CloneRuntime } from '../../services/agent/clone-runtime'
import { SystemPromptAssembler } from '../../services/agent/system-prompt-assembler'
import { isResumeFailureMessage, usableResumeId } from '../../services/agent/resume'
import { registerActiveStream, unregisterActiveStream } from '../../services/agent/agent-service'
import { getAgentDir, getBuiltInCloneDir, getCloneDir, getAgentSkillsDir, backupFile } from '../../services/agent/paths'
import { getEvolutionService } from '../../services/agent/evolution-service'
import { getMemoryService } from '../../services/agent/memory-service'
import { resolveCloneInfo } from '../../services/agent/clone-resolver'
import { isBuiltinClone } from '../../services/agent/builtin-clones'
import type { CloneDef } from '@octopus/shared'
import { recordProviderResultUsage } from '../../services/llm-call-ledger'
import type { TokenUsageDAO } from '../../db/dao/token-usage-dao'
import { IngestError } from '../../services/knowledge/raw'
import type { CurationInput, CurationReceipt } from '../../services/knowledge/session-curation'
import fs from 'fs'
import path from 'path'

// ── Route deps ─────────────────────────────────────────────────────

/** 票10 策展执行 seam（生产 = SessionCurationService；测试 = 捕获）。 */
export interface MainAgentCurationSurface {
  curate(input: CurationInput): Promise<CurationReceipt>
}

export interface MainAgentRouteDeps {
  sessionDAO: AgentSessionDAO
  /** billing-coverage-2 票03: 统一入口/委托链入账（共用落账 helper）。
   *  Optional: absent ⇒ skip（纯旁路）。 */
  tokenUsageDao?: TokenUsageDAO
  /** 票10 投喂泛化：知识策展执行面（ingest_to_wiki 工具）。
   *  Optional: absent ⇒ 工具不注册进提示词（不教模型调死工具）。 */
  curation?: MainAgentCurationSurface
}

// ── Delegation tool definitions ────────────────────────────────────

const DELEGATION_TOOLS_PROMPT = `
## Available Delegation Targets

You can delegate tasks to specialized clones using the following tools:

- **delegate_to_workspace**: Delegate a development task to the workspace clone (full-stack dev assistant)
- **delegate_to_scheduler**: Create or manage a scheduled task (cron jobs, periodic tasks)
- **delegate_to_archive**: Analyze a workspace for archival (execution history, knowledge extraction)
- **delegate_to_resource**: Execute a resource operation (install/update skills, agents, workflows)

When a task clearly falls into one of these domains, delegate it. Otherwise, respond directly.
`

// 票10 投喂泛化：策展工具契约段（与 orchestrator SKILL.md「knowledge_curation」分支的
// ingest_to_wiki 同名单源）。仅当 curation 接线时注入——未接线不注册（死工具零教学）。
const CURATION_TOOLS_PROMPT = `
## Knowledge Curation Tool (feed-to-wiki)

- **ingest_to_wiki**: Freeze a URL / pasted long text / local file into the knowledge wiki
  (fetch → raw immutable → compile via the global serial queue — the same pipeline as
  POST /api/knowledge/ingest). Input: { mode: 'url'|'text'|'file', url?, text?, path?, title? }
- Use it ONLY when the user explicitly asks to feed content into the wiki
  (投喂动词 + URL/长文本/路径 伴随——see octo-agent-orchestrator "knowledge_curation" intent).
- After the call, the ingest card and compile-diff cards are automatically appended to this
  session (Lane A) — briefly confirm the receipt to the user; do NOT paste raw JSON or
  re-implement the pipeline yourself.
`

const EVOLUTION_TOOLS_PROMPT = `
## Self-Evolution Tools

You can autonomously improve your skills through these evolution operations:

- **mark_insight**: Record a lightweight "this could be improved" signal during conversation. Use when you notice a skill could be better but don't want to modify it right now. Input: { skill_name: string, insight: string }
- **evolve_skill**: Directly modify a SKILL.md file with an improvement. Use for minor wording/step fixes. Input: { skill_name: string, summary: string, new_content?: string, change_type?: 'minor' | 'major', level?: 'minor' | 'major' }
- **create_experience**: Record a valuable lesson learned from this session. Input: { skill_name: string, content: string }
- **merge_skills**: Combine overlapping or related skills into one. The source skill content is appended to the target, and the source is archived. Input: { source_skill: string, target_skill: string }
- **note_skill_issue**: Record a note or issue about a skill that needs attention later (e.g., outdated content, confusing steps). Input: { skill_name: string, reason: string }

Use mark_insight liberally (it's cheap). Use evolve_skill sparingly (only for clear improvements).
At the end of a productive session, consider using create_experience to capture lessons.
`

const RECORD_DAILY_TOOLS_PROMPT = `
## Memory Recording Tool

You can record valuable insights to your daily working memory using:

- **record_daily**: Record an important insight, decision, or observation to your daily memory. This also creates a searchable session summary. Input: { content: string }

### When to use record_daily (✅ positive examples)
- User reveals a preference or workflow pattern ("User prefers TypeScript strict mode")
- An important architectural decision is made ("Chose SQLite over PostgreSQL for local-first")
- A non-obvious fact is discovered that future sessions would benefit from
- A recurring problem pattern is identified
- A productive workflow or shortcut is established

### When NOT to use record_daily (❌ negative examples)
- Simple greetings or pleasantries ("Hello", "Thanks")
- Factual Q&A with no lasting value ("What's the capital of France?")
- One-time lookups or transient operations
- Routine task execution without novel insights
- Content that duplicates what's already in memory

Write concisely in markdown. Focus on **why** something matters, not just **what** happened.
`

// ── Clone resolution helper ────────────────────────────────────────

function resolveCloneDefFromFs(name: string): CloneDef | null {
  const info = resolveCloneInfo(name)
  if (!info) return null

  const cloneDir = info.type === 'built-in' ? getBuiltInCloneDir(name) : getCloneDir(name)
  let persona = info.persona
  const personaPath = path.join(cloneDir, 'persona.md')
  if (fs.existsSync(personaPath)) {
    try { persona = fs.readFileSync(personaPath, 'utf-8') } catch { /* use info.persona */ }
  }

  return {
    name: info.name,
    displayName: info.display_name,
    type: info.type,
    persona,
    skills: info.skills,
    memoryScope: info.memory_scope,
    config: {},
  }
}

// ── SSE event forwarding filter ─────────────────────────────────────

/**
 * Determine which MessageChunk types should be forwarded to SSE consumers
 * during delegation. Filters out noisy events (thinking, message boundaries)
 * and forwards actionable events (text, tool calls/results, errors).
 */
export function shouldForwardEvent(type: string): boolean {
  return [
    'text_delta',
    'tool_call_start',
    'tool_call',
    'tool_result',
    'context_usage',
    'error',
  ].includes(type)
}

/**
 * Build an SSE event payload for a forwardable delegation chunk.
 * Returns null if the chunk type should not be forwarded.
 * Uses shouldForwardEvent() as the single source of truth for filtering.
 */
function forwardableSSEEvent(chunk: MessageChunk, accumulatedContent: string, source: string): { event: string; data: string } | null {
  if (!shouldForwardEvent(chunk.type)) return null

  switch (chunk.type) {
    case 'text_delta':
      return { event: 'text_delta', data: JSON.stringify({ delta: chunk.content, content: accumulatedContent, source }) }
    case 'tool_call_start':
      return { event: 'tool_call', data: JSON.stringify({ type: 'start', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName }) }
    case 'tool_call':
      return { event: 'tool_call', data: JSON.stringify({ type: 'input', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName, input: chunk.toolInput }) }
    case 'tool_result':
      return { event: 'tool_result', data: JSON.stringify({ tool_call_id: chunk.toolCallId, tool_name: chunk.toolName, content: chunk.content, is_error: chunk.isError }) }
    case 'context_usage':
      return { event: 'context_usage', data: JSON.stringify(chunk.data) }
    case 'error':
      return { event: 'error', data: JSON.stringify({ code: chunk.code, message: chunk.message }) }
    default:
      return null
  }
}

// ── Route factory ──────────────────────────────────────────────────

export function createMainAgentRoute(deps: MainAgentRouteDeps): Hono {
  const { sessionDAO, tokenUsageDao, curation } = deps
  const app = new Hono()

  app.post('/chat', async (c) => {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string) || 'default'
    const turnStartMs = Date.now()

    let body: {
      message?: string
      session_id?: string
      model?: string
      effort?: string
      maxContext?: string
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid JSON body' } }, 400)
    }

    if (!body.message) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'message is required' } }, 400)
    }

    const effort = parseComposerEffort(body.effort)
    const model = resolveChatModel(body.model, parseComposerContext(body.maxContext), org)

    // Resolve or create session
    let sessionId = body.session_id
    let resumeSessionId: string | undefined
    if (!sessionId) {
      sessionId = crypto.randomUUID()
      const now = new Date().toISOString()
      sessionDAO.insertSession({
        id: sessionId,
        org,
        title: 'Main Agent 会话',
        clone_name: null,
        session_type: 'main',
        created_at: now,
        updated_at: now,
      })
    } else {
      const existing = sessionDAO.findById(sessionId)
      if (!existing || existing.is_deleted) {
        return c.json({ error: { code: 'NOT_FOUND', message: `Session ${sessionId} not found` } }, 404)
      }
      resumeSessionId = usableResumeId(getAgentDir(), existing.provider_session_id)
      if (existing.provider_session_id && !resumeSessionId) {
        sessionDAO.clearProviderSession(sessionId)
      }
    }

    // Store user message
    const userMsgId = crypto.randomUUID()
    const now = new Date().toISOString()
    sessionDAO.insertMessage({
      id: userMsgId, session_id: sessionId, role: 'user',
      content: body.message, created_at: now,
    })
    sessionDAO.updateLastMessageAt(sessionId, now)

    // ══════════════════════════════════════════════════════════════
    // Normal LLM routing (with optional tool-based delegation)
    // ══════════════════════════════════════════════════════════════
    const assembler = new SystemPromptAssembler(org)
    // Frozen per session: re-reading persona/memory each turn changes the
    // cached prefix and forces a full transcript recompute. New sessions pick
    // up the latest files; existing ones stay byte-identical.
    // (Test doubles may not expose getDb — they keep the per-turn assembly.)
    const cacheDb = typeof sessionDAO.getDb === 'function' ? sessionDAO.getDb() : null
    const cacheCtx = cacheDb ? new SessionCacheContextDAO(cacheDb) : null
    const baseSystemPrompt = cacheCtx
      ? cacheCtx.getOrCreatePromptSnapshot(sessionId!, () => assembler.assemble()).systemPrompt
      : assembler.assemble()
    const curationSegment = curation ? `\n\n${CURATION_TOOLS_PROMPT}` : ''
    const systemPrompt = `${baseSystemPrompt}\n\n${DELEGATION_TOOLS_PROMPT}${curationSegment}\n\n${EVOLUTION_TOOLS_PROMPT}\n\n${RECORD_DAILY_TOOLS_PROMPT}`

    return streamSSE(c, async (stream) => {
      let aborted = false
      const abortStream = () => { aborted = true }
      const streamId = registerActiveStream(sessionId!, abortStream)

      try {
        const provider = getProvider('claude')
        const cwd = getAgentDir()

        const chunks = provider.sendQuery(body.message!, cwd, resumeSessionId, {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        })

        let fullContent = ''
        let fullThinking = ''
        let delegationDetected: { cloneName: string; task: string } | null = null
        const evolutionToolCalls: Array<{ id: string; name: string; input?: Record<string, unknown> }> = []
        const memoryToolCalls: Array<{ id: string; name: string; input?: Record<string, unknown> }> = []
        // 票10：策展工具调用（与 evolution 同拦截先例——虚拟工具，路由层执行）
        const curationToolCalls: Array<{ id: string; name: string; input?: Record<string, unknown> }> = []
        const toolCalls: Array<{
          id: string; name: string; input?: unknown; result?: unknown; isError?: boolean; status?: string
        }> = []

        for await (const chunk of chunks) {
          if (aborted || (stream as any)._aborted) break

          switch (chunk.type) {
            case 'text_delta':
              fullContent += chunk.content
              await stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ delta: chunk.content, content: fullContent }) })
              break
            case 'thinking_start':
              await stream.writeSSE({ event: 'thinking_start', data: '{}' })
              break
            case 'thinking':
              fullThinking += chunk.content
              await stream.writeSSE({ event: 'thinking', data: JSON.stringify({ delta: chunk.content }) })
              break
            case 'thinking_done':
              await stream.writeSSE({ event: 'thinking_done', data: '{}' })
              break
            case 'context_usage':
              await stream.writeSSE({ event: 'context_usage', data: JSON.stringify(chunk.data) })
              break
            case 'tool_call_start':
              toolCalls.push({ id: chunk.toolCallId, name: chunk.toolName, status: 'start' })
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'start', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName }) })

              // Check for delegation tool calls
              if (chunk.toolName.startsWith('delegate_to_')) {
                const cloneName = chunk.toolName.replace('delegate_to_', '')
                delegationDetected = { cloneName, task: '' }
              }
              break
            case 'tool_call': {
              const tc = toolCalls.find(t => t.id === chunk.toolCallId)
              if (tc) {
                tc.input = chunk.toolInput
                // Extract task from delegation tool input
                if (tc.name.startsWith('delegate_to_') && delegationDetected) {
                  const input = chunk.toolInput as Record<string, unknown>
                  delegationDetected.task = String(input.task || input.prompt || body.message!)
                }
                // Track evolution tool calls
                if (EVOLUTION_TOOL_NAMES.includes(tc.name)) {
                  evolutionToolCalls.push({ id: tc.id, name: tc.name, input: chunk.toolInput as Record<string, unknown> })
                }
                // Track memory tool calls (record_daily)
                if (MEMORY_TOOL_NAMES.includes(tc.name)) {
                  memoryToolCalls.push({ id: tc.id, name: tc.name, input: chunk.toolInput as Record<string, unknown> })
                }
                // Track curation tool calls (ingest_to_wiki — 票10)
                if (CURATION_TOOL_NAMES.includes(tc.name)) {
                  curationToolCalls.push({ id: tc.id, name: tc.name, input: chunk.toolInput as Record<string, unknown> })
                }
              }
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'input', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName, input: chunk.toolInput }) })
              break
            }
            case 'ask_user_question':
              // 与 clone chat 同构（2026-09-09）：interactionSession deny 后的
              // 显式问题标记，前端 ChatArea 兜底补全 AskUserQuestion toolCall。
              await stream.writeSSE({ event: 'ask_user_question', data: JSON.stringify({ tool_call_id: chunk.toolCallId, questions: chunk.questions }) })
              break
            case 'tool_result': {
              const tc = toolCalls.find(t => t.id === chunk.toolCallId)
              if (tc) { tc.result = chunk.content; tc.isError = chunk.isError; tc.status = chunk.isError ? 'fail' : 'result' }
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'result', tool_call_id: chunk.toolCallId, content: chunk.content, is_error: chunk.isError }) })
              break
            }
            case 'status':
              await stream.writeSSE({ event: 'status', data: JSON.stringify({ status: chunk.status }) })
              break
            case 'result':
              // Persist the SDK session id for the next turn's native resume.
              if (chunk.sessionId) sessionDAO.updateProviderSession(sessionId!, chunk.sessionId)
              // billing-coverage-2 票03 (US2)：Main Agent 路由轮自身是一次真实 provider
              // 调用 → 单独入账 global_chat（一 chunk 一行，重试=新调用=新行，KD23）。
              if (tokenUsageDao) {
                recordProviderResultUsage({
                  sourcePath: 'global_chat',
                  nodeExecutionId: null,
                  executionId: null,
                  sessionId: sessionId!,
                  org,
                  startedAtMs: turnStartMs,
                  modelUsages: chunk.modelUsages,
                  usage: chunk.usage,
                }, tokenUsageDao)
              }
              break
            case 'error':
              // Stale resume: drop the pointer so the next turn starts clean
              // instead of failing forever. Only before any output.
              if (resumeSessionId && !fullContent && isResumeFailureMessage(chunk.message)) {
                sessionDAO.clearProviderSession(sessionId!)
              }
              await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: chunk.code, message: chunk.message }) })
              break
          }
        }

        // If delegation was detected, execute via CloneRuntime
        if (delegationDetected && !aborted) {
          await executeDelegation(
            delegationDetected, sessionId!, org, stream, tokenUsageDao, turnStartMs, model, effort,
          )
        }

        // Execute evolution tool calls
        if (evolutionToolCalls.length > 0 && !aborted) {
          await executeEvolutionTools(evolutionToolCalls, org, sessionId!, stream)
        }

        // Execute memory tool calls (record_daily)
        if (memoryToolCalls.length > 0 && !aborted) {
          const cloneName = c.req.header('X-Clone-Name')
          await executeMemoryTools(memoryToolCalls, org, sessionId!, stream, cloneName)
        }

        // Execute curation tool calls (ingest_to_wiki — 票10：复用既有投喂链，零平行机制)
        if (curationToolCalls.length > 0 && !aborted) {
          await executeCurationTools(curationToolCalls, sessionId!, stream, curation)
        }

        // Store assistant message
        if (fullContent) {
          const assistantMsgId = crypto.randomUUID()
          const assistantNow = new Date().toISOString()
          const metadata = JSON.stringify({
            thinking: fullThinking || undefined,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            delegation: delegationDetected,
          })

          sessionDAO.insertMessage({
            id: assistantMsgId, session_id: sessionId!, role: 'assistant',
            content: fullContent, metadata, created_at: assistantNow,
          })
          sessionDAO.updateLastMessageAt(sessionId!, assistantNow)

          // Auto-generate title
          const sessionRow = sessionDAO.findById(sessionId!)
          if (sessionRow && (sessionRow.title === 'Main Agent 会话' || sessionRow.title === '新会话')) {
            const autoTitle = body.message!.slice(0, 40).replace(/\n/g, ' ').trim() || 'Main Agent 会话'
            sessionDAO.updateSession(sessionId!, { title: autoTitle })
          }

          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({
              session_id: sessionId,
              message_id: assistantMsgId,
              session_title: sessionDAO.findById(sessionId!)?.title,
            }),
          })

          // P4: Auto-trigger process-marks after chat response
          try {
            const evolutionService = getEvolutionService()
            evolutionService.processUnprocessedMarks(org, sessionId!)
          } catch {
            // process-marks failure is non-fatal — don't disrupt the response
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'STREAM_ERROR', message: msg }) })
      } finally {
        unregisterActiveStream(sessionId!, streamId)
      }
    })
  })

  return app
}

const EVOLUTION_TOOL_NAMES = ['mark_insight', 'evolve_skill', 'create_experience', 'merge_skills', 'note_skill_issue']
const MEMORY_TOOL_NAMES = ['record_daily']
const CURATION_TOOL_NAMES = ['ingest_to_wiki']

// ── Curation tool execution（票10 投喂泛化）────────────────────────

/**
 * ingest_to_wiki 执行体：sessionId = 服务端解析的**发起会话**（一等参数流入投喂链，
 * 模型无法伪造回流落点）；执行穿打注入的 curation seam（生产 = SessionCurationService
 * → RawIngestService + CuratorTaskService/全局队列 + Lane A 回流——零第二套抓取/编译）。
 * IngestError/CuratorError 原样映射进 tool_result 错误码面（零吞错，ingest.ts 码集同律）。
 */
async function executeCurationTools(
  toolCalls: Array<{ id: string; name: string; input?: Record<string, unknown> }>,
  sessionId: string,
  stream: SSEStreamingApi,
  curation?: MainAgentCurationSurface,
): Promise<void> {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)
  for (const tc of toolCalls) {
    let content = ''
    let isError = false
    if (!curation) {
      content = 'Error: knowledge curation is not wired on this server (ingest_to_wiki unavailable)'
      isError = true
    } else {
      const input = tc.input ?? {}
      const mode = str(input.mode)
      if (mode !== "url" && mode !== "text" && mode !== "file") {
        content = "Error: mode must be one of: \"url\", \"text\", \"file\""
        isError = true
      } else {
        try {
          const receipt = await curation.curate({
            sessionId,
            mode,
            ...(str(input.url) !== undefined ? { url: str(input.url) } : {}),
            ...(str(input.text) !== undefined ? { text: str(input.text) } : {}),
            ...(str(input.path) !== undefined ? { path: str(input.path) } : {}),
            ...(str(input.title) !== undefined ? { title: str(input.title) } : {}),
          })
          content =
            `已投喂入库：${receipt.title}（${receipt.raw.path} · ${receipt.raw.bytes}B · hash ${receipt.raw.hash.slice(0, 7)}${receipt.deduped ? " · 去重命中既有源" : ""}）`
            + (receipt.compileTask
              ? ` · 编译已入全局串行队列 ${receipt.compileTask.taskId}，抓取卡/diff 卡已${receipt.cardsPosted ? "回流" : "尝试回流（降级：" + (receipt.postReason ?? "未落会话") + "）"}本会话，编译落定后终态卡自动追加`
              : "")
        } catch (err) {
          if (err instanceof IngestError) {
            content = `Failed: ${err.code} — ${err.detail}`
          } else {
            content = `Failed: CURATE_ERROR — ${err instanceof Error ? err.message : String(err)}`
          }
          isError = true
        }
      }
    }
    await stream.writeSSE({
      event: 'tool_call',
      data: JSON.stringify({
        type: 'result', tool_call_id: tc.id, tool_name: tc.name,
        content, is_error: isError,
      }),
    })
  }
}

// ── Evolution tool execution ──────────────────────────────────────

async function executeEvolutionTools(
  toolCalls: Array<{ id: string; name: string; input?: Record<string, unknown> }>,
  org: string,
  sessionId: string,
  stream: SSEStreamingApi,
): Promise<void> {
  for (const tc of toolCalls) {
    try {
      const input = tc.input ?? {}
      let resultContent = ''

      switch (tc.name) {
        case 'mark_insight': {
          const skillName = String(input.skill_name ?? '')
          const insight = String(input.insight ?? '')
          if (!skillName || !insight) {
            resultContent = 'Error: skill_name and insight are required'
            break
          }
          try {
            const evolutionService = getEvolutionService()
            const markResult = evolutionService.markInsight(skillName, insight, sessionId, org)
            resultContent = `Insight marked (id: ${markResult.id}) for skill "${skillName}"`
          } catch {
            resultContent = `Failed to mark insight for "${skillName}"`
          }
          break
        }

        case 'evolve_skill': {
          const skillName = String(input.skill_name ?? '')
          const summary = String(input.summary ?? '')
          const newContent = String(input.new_content ?? '')
          const changeType = (input.change_type === 'major' ? 'major' : 'minor') as 'minor' | 'major'
          const level = (input.level === 'major' ? 'major' : 'minor') as 'minor' | 'major'
          if (!skillName || !summary) {
            resultContent = 'Error: skill_name and summary are required'
            break
          }
          try {
            const evolutionService = getEvolutionService()
            const skillPath = path.join(getAgentSkillsDir(), skillName, 'SKILL.md')
            const skillDir = path.dirname(skillPath)
            if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true })
            if (fs.existsSync(skillPath)) {
              backupFile(skillPath)
            }
            if (newContent) {
              fs.writeFileSync(skillPath, newContent, 'utf-8')
            } else {
              const current = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, 'utf-8') : ''
              fs.writeFileSync(skillPath, current + `\n\n> Evolution (${new Date().toISOString().split('T')[0]}): ${summary}`, 'utf-8')
            }
            evolutionService.recordEvolution(org, {
              skill_name: skillName, change_type: changeType, level, summary,
            })
            resultContent = `Skill "${skillName}" evolved (${changeType}): ${summary}`
          } catch (e) {
            resultContent = `Failed to evolve skill "${skillName}": ${e instanceof Error ? e.message : String(e)}`
          }
          break
        }

        case 'create_experience': {
          const skillName = String(input.skill_name ?? '')
          const content = String(input.content ?? '')
          if (!skillName || !content) {
            resultContent = 'Error: skill_name and content are required'
            break
          }
          try {
            const evolutionService = getEvolutionService()
            const result = evolutionService.recordExperience(org, {
              skill_name: skillName, content, session_id: sessionId,
            })
            resultContent = `Experience recorded (id: ${result.id}) for skill "${skillName}"`
          } catch {
            resultContent = `Failed to record experience for "${skillName}"`
          }
          break
        }

        case 'merge_skills': {
          const sourceSkill = String(input.source_skill ?? '')
          const targetSkill = String(input.target_skill ?? '')
          if (!sourceSkill || !targetSkill) {
            resultContent = 'Error: source_skill and target_skill are required'
            break
          }
          if (sourceSkill === targetSkill) {
            resultContent = 'Error: source_skill and target_skill must be different'
            break
          }
          try {
            const evolutionService = getEvolutionService()
            const sourcePath = path.join(getAgentSkillsDir(), sourceSkill, 'SKILL.md')
            const targetPath = path.join(getAgentSkillsDir(), targetSkill, 'SKILL.md')
            const sourceDir = path.join(getAgentSkillsDir(), sourceSkill)
            const archivedDir = path.join(getAgentSkillsDir(), `${sourceSkill}.archived`)

            // Read source content
            const sourceContent = fs.existsSync(sourcePath)
              ? fs.readFileSync(sourcePath, 'utf-8')
              : ''

            // Backup target before modifying
            if (fs.existsSync(targetPath)) {
              backupFile(targetPath)
            } else {
              // Create target dir if missing
              const targetDir = path.dirname(targetPath)
              if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
            }

            // Append source content to target with merge marker
            const targetContent = fs.existsSync(targetPath)
              ? fs.readFileSync(targetPath, 'utf-8')
              : `# ${targetSkill}\n`
            const mergedContent = `${targetContent}\n\n## Merged from ${sourceSkill}\n\n${sourceContent}`
            fs.writeFileSync(targetPath, mergedContent, 'utf-8')

            // Archive source directory
            if (fs.existsSync(sourceDir) && !fs.existsSync(archivedDir)) {
              fs.renameSync(sourceDir, archivedDir)
            }

            // Record evolution log
            evolutionService.recordEvolution(org, {
              skill_name: targetSkill,
              change_type: 'major',
              level: 'major',
              summary: `Merged skill "${sourceSkill}" into "${targetSkill}". Source archived as ${sourceSkill}.archived.`,
            })

            // Record experience
            evolutionService.recordExperience(org, {
              skill_name: targetSkill,
              content: `Skill merge: "${sourceSkill}" merged into "${targetSkill}" — source content integrated, original archived.`,
              session_id: sessionId,
            })

            resultContent = `Skill "${sourceSkill}" merged into "${targetSkill}". Source archived as ${sourceSkill}.archived.`
          } catch (e) {
            resultContent = `Failed to merge skills: ${e instanceof Error ? e.message : String(e)}`
          }
          break
        }

        case 'note_skill_issue': {
          const skillName = String(input.skill_name ?? '')
          const reason = String(input.reason ?? '')
          if (!skillName || !reason) {
            resultContent = 'Error: skill_name and reason are required'
            break
          }
          try {
            const evolutionService = getEvolutionService()
            evolutionService.recordEvolution(org, {
              skill_name: skillName, change_type: 'minor', level: 'minor',
              summary: `Issue noted: ${reason}`,
            })
            evolutionService.recordExperience(org, {
              skill_name: skillName,
              content: `Skill issue flagged: ${reason}`,
              session_id: sessionId,
            })
            resultContent = `Issue noted for skill "${skillName}": ${reason}`
          } catch {
            resultContent = `Failed to note issue for skill "${skillName}"`
          }
          break
        }

        default:
          resultContent = `Unknown evolution tool: ${tc.name}`
      }

      await stream.writeSSE({
        event: 'tool_call',
        data: JSON.stringify({
          type: 'result', tool_call_id: tc.id, tool_name: tc.name,
          content: resultContent, is_error: resultContent.startsWith('Error') || resultContent.startsWith('Failed'),
        }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await stream.writeSSE({
        event: 'tool_call',
        data: JSON.stringify({
          type: 'result', tool_call_id: tc.id, tool_name: tc.name,
          content: `Evolution tool error: ${msg}`, is_error: true,
        }),
      })
    }
  }
}

// ── Memory tool execution ─────────────────────────────────────────

async function executeMemoryTools(
  toolCalls: Array<{ id: string; name: string; input?: Record<string, unknown> }>,
  org: string,
  sessionId: string,
  stream: SSEStreamingApi,
  cloneName?: string,
): Promise<void> {
  for (const tc of toolCalls) {
    try {
      const input = tc.input ?? {}
      let resultContent = ''

      switch (tc.name) {
        case 'record_daily': {
          const content = String(input.content ?? '')
          if (!content) {
            resultContent = 'Error: content is required'
            break
          }
          try {
            const memoryService = getMemoryService()

            // Resolve clone directory if clone context exists
            let cloneDir: string | undefined
            if (cloneName) {
              const cloneDef = resolveCloneDefFromFs(cloneName)
              if (cloneDef) {
                cloneDir = cloneDef.type === 'built-in'
                  ? getBuiltInCloneDir(cloneName)
                  : getCloneDir(cloneName)
              }
            }

            const result = memoryService.recordDaily(org, content, sessionId, cloneDir)
            resultContent = JSON.stringify(result)
          } catch (e) {
            resultContent = `Failed to record daily memory: ${e instanceof Error ? e.message : String(e)}`
          }
          break
        }
        default:
          resultContent = `Unknown memory tool: ${tc.name}`
      }

      await stream.writeSSE({
        event: 'tool_call',
        data: JSON.stringify({
          type: 'result', tool_call_id: tc.id, tool_name: tc.name,
          content: resultContent, is_error: resultContent.startsWith('Error') || resultContent.startsWith('Failed'),
        }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await stream.writeSSE({
        event: 'tool_call',
        data: JSON.stringify({
          type: 'result', tool_call_id: tc.id, tool_name: tc.name,
          content: `Memory tool error: ${msg}`, is_error: true,
        }),
      })
    }
  }
}

// ── Delegation execution ───────────────────────────────────────────

async function executeDelegation(
  delegation: { cloneName: string; task: string },
  sessionId: string,
  org: string,
  stream: SSEStreamingApi,
  tokenUsageDao?: TokenUsageDAO,
  startedAtMs = Date.now(),
  model?: string,
  effort?: EffortLevel,
): Promise<void> {
  const cloneName = delegation.cloneName

  const cloneDef = resolveCloneDefFromFs(cloneName)

  if (!cloneDef) {
    await stream.writeSSE({
      event: 'tool_call',
      data: JSON.stringify({
        type: 'result', tool_name: `delegate_to_${cloneName}`,
        content: `Clone "${cloneName}" not found`,
        is_error: true,
      }),
    })
    return
  }

  // Execute via CloneRuntime
  const runtime = new CloneRuntime(cloneDef, org)
  const cwd = runtime.getDefaultCwd()

  await stream.writeSSE({
    event: 'status',
    data: JSON.stringify({ status: `Delegating to ${cloneName} clone...` }),
  })

  try {
    let delegateContent = ''
    for await (const chunk of runtime.chat(
      delegation.task, sessionId, null, cwd,
      undefined, undefined, undefined, undefined, model, undefined, effort,
    )) {
      if (chunk.type === 'text_delta') delegateContent += chunk.content
      // billing-coverage-2 票03 (KD23)：工具化委托 —— 分身应答轮是另一次真实 provider
      // 调用 → 一行 clone_chat（node_id=分身名）；与路由轮的 global_chat 行各归各的调用。
      if (tokenUsageDao && chunk.type === 'result') {
        recordProviderResultUsage({
          sourcePath: 'clone_chat',
          nodeExecutionId: null,
          executionId: null,
          sessionId,
          org,
          nodeId: cloneName,
          startedAtMs,
          modelUsages: chunk.modelUsages,
          usage: chunk.usage,
        }, tokenUsageDao)
      }
      const sseEvent = forwardableSSEEvent(chunk, delegateContent, cloneName)
      if (sseEvent) await stream.writeSSE(sseEvent)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await stream.writeSSE({
      event: 'error',
      data: JSON.stringify({ code: 'DELEGATION_ERROR', message: `Delegation to ${cloneName} failed: ${msg}` }),
    })
  }
}
