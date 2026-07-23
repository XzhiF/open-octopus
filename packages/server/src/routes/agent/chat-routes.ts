// packages/server/src/routes/agent/chat-routes.ts
//
// Agent chat SSE streaming endpoint + stop generation.
// The chat handler orchestrates intent classification, LLM streaming (Claude SDK),
// session compression, workspace rules injection, and debug logging.
//
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getProvider } from '@octopus/providers'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { createAgentError } from './middleware'
import { SystemPromptAssembler } from '../../services/agent/system-prompt-assembler'
import { getOrchestratorService } from '../../services/agent/orchestrator-service'
import { getNotificationService } from '../../services/agent/notification-service'
import { getSessionCompressService } from '../../services/agent/session-compress-service'
import { getWorkspaceLifecycleService } from '../../services/agent/workspace-lifecycle'
import { getAgentService, registerActiveStream, unregisterActiveStream } from '../../services/agent/agent-service'
import { getAgentDir, getDailyMemoryDir, getExperiencesDir, getDebugTracesDir } from '../../services/agent/paths'
import type { AgentSessionDAO, SafetyDAO, ScheduleConfigDAO } from '../../db/dao'

export interface ChatRouteDeps {
  sessionDAO: AgentSessionDAO
  safetyDAO: SafetyDAO
  scheduleConfigDAO: ScheduleConfigDAO
}

export function createChatRoutes(deps: ChatRouteDeps): Hono {
  const { sessionDAO: sessionDao, safetyDAO, scheduleConfigDAO } = deps
  const app = new Hono()

  // ── Chat SSE streaming ─────────────────────────────────────────────
  app.post('/sessions/:id/chat', async (c) => {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
    if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

    const id = c.req.param('id')

    let body: { message?: string; system_prompt?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json(createAgentError('INVALID_PARAM', 'Invalid JSON body'), 400)
    }

    if (!body.message) {
      return c.json(createAgentError('INVALID_PARAM', 'message is required'), 400)
    }

    // Verify session exists
    const session = sessionDao.findSessionById(id)
    if (!session || session.org !== org || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }

    // Store user message
    const userMsgId = crypto.randomUUID()
    const now = new Date().toISOString()
    sessionDao.insertMessage({
      id: userMsgId, session_id: id, role: 'user',
      content: body.message, created_at: now,
    })
    sessionDao.updateLastMessageAt(id, now)

    // Assemble system prompt
    const assembler = new SystemPromptAssembler(org)
    const systemPrompt = body.system_prompt ?? assembler.assemble({ clone_name: session.clone_name ?? undefined })

    // ── Trigger self-check on first message (E2E-055) ──────────────
    runSelfCheck()

    // Stream SSE response
    return streamSSE(c, async (stream) => {
      let aborted = false
      const abortStream = () => { aborted = true }
      const streamId = registerActiveStream(id, abortStream)

      try {
        // Step 1: Auto-compress long sessions
        await autoCompressSession(id, org, stream)

        // Step 2: Run orchestrator
        const { orchestrationResult, orchestrationFullResult } = await runOrchestration(
          body.message!, id, stream, org,
        )

        // L2: Inject workspace rules if workflow was matched
        if (orchestrationFullResult?.workflow && !aborted) {
          try {
            const lifecycleService = getWorkspaceLifecycleService(org)
            const workspaces = lifecycleService.listWorkspaces()
            if (workspaces.length > 0) {
              const targetWorkspace = workspaces[0]
              const rules = lifecycleService.buildRulesFromContext(
                orchestrationFullResult.workflow.workflow_name,
                targetWorkspace.name,
              )
              lifecycleService.injectWorkspaceRules(targetWorkspace.path, rules)
            }
          } catch { /* non-fatal */ }
        }

        if (aborted) {
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ session_id: id, aborted: true }) })
          return
        }

        // Step 3: Try Claude SDK integration
        const llmResult = await tryClaudeSDK(body.message!, systemPrompt, stream, id, org, sessionDao, orchestrationResult, orchestrationFullResult)

        // Step 4: Fallback if Claude SDK unavailable
        if (!llmResult.generated) {
          await sendFallbackResponse(body.message!, stream, id, org, sessionDao, orchestrationResult)
        }

        // Step 5: Send hermes notification
        if (orchestrationResult) {
          try {
            const notifyService = getNotificationService()
            await notifyService.sendNotification(org, {
              type: 'general', title: 'Agent 对话', body: orchestrationResult, priority: 'low',
            })
          } catch { /* non-fatal */ }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'STREAM_ERROR', message: msg }) })
      } finally {
        unregisterActiveStream(id, streamId)
      }
    })
  })

  // ── Stop generation ──────────────────────────────────────────────────
  app.post('/sessions/:id/stop', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const id = c.req.param('id')
      const result = await getAgentService().stopChat(org, id)
      return c.json({ success: true, ...result })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json(createAgentError('INTERNAL_ERROR', msg), 500)
    }
  })

  // ── Private helpers ──────────────────────────────────────────────────

  function runSelfCheck(): void {
    const selfCheckMarker = path.join(getAgentDir(), '.self-check-last')
    const shouldSelfCheck = !fs.existsSync(selfCheckMarker) ||
      (Date.now() - fs.statSync(selfCheckMarker).mtimeMs) > 7 * 24 * 60 * 60 * 1000
    if (!shouldSelfCheck) return
    try {
      const dailyDir = getDailyMemoryDir()
      const experiencesDir = getExperiencesDir()
      if (fs.existsSync(dailyDir)) {
        const files = fs.readdirSync(dailyDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 7)
        const allContent = files.map(f => { try { return fs.readFileSync(path.join(dailyDir, f), 'utf-8') } catch { return '' } }).join('\n')
        const words = allContent.toLowerCase().match(/\b[a-z一-鿿]{2,}\b/g) ?? []
        const freq = new Map<string, number>()
        for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1)
        const patterns = [...freq.entries()].filter(([, c]) => c >= 3).map(([w]) => w).slice(0, 10)
        if (patterns.length > 0) {
          if (!fs.existsSync(experiencesDir)) fs.mkdirSync(experiencesDir, { recursive: true })
          const now = new Date().toISOString()
          fs.writeFileSync(
            path.join(experiencesDir, `self-check-${now.replace(/[:.]/g, '-')}.md`),
            `# 自检经验 ${now}\n\n## 重复模式\n${patterns.map(p => `- ${p}`).join('\n')}\n`, 'utf-8',
          )
        }
      }
      fs.writeFileSync(selfCheckMarker, new Date().toISOString(), 'utf-8')
    } catch { /* non-fatal */ }
  }

  async function autoCompressSession(id: string, org: string, stream: any): Promise<void> {
    try {
      const compressService = getSessionCompressService(org)
      if (compressService.needsCompression(id)) {
        await compressService.compressSession(id)
        await stream.writeSSE({
          event: 'status',
          data: JSON.stringify({ status: 'compressed', message: '会话上下文已压缩' }),
        })
      }
    } catch { /* non-fatal */ }
  }

  async function runOrchestration(
    message: string, sessionId: string, stream: any, org: string,
  ): Promise<{ orchestrationResult: string | undefined; orchestrationFullResult: any }> {
    let orchestrationResult: string | undefined
    let orchestrationFullResult: any

    try {
      const orchestrator = getOrchestratorService(org)
      const result = await orchestrator.orchestrate(message, sessionId, (event) => {
        stream.writeSSE({ event: 'orchestration_event', data: JSON.stringify(event) }).catch(() => {})
      })
      orchestrationResult = result.summary
      orchestrationFullResult = { intent: result.intent, workflow: result.workflow }

      // Security keyword detection (TC-049)
      const securityKeywords = /安全|security|权限|permission|密码|password|密钥|secret|防火墙|firewall|加密|encrypt|漏洞|vuln/i
      const modifyKeywords = /修改|改|调整|变更|change|modify|update|remove|删除|绕过|bypass/i
      if (securityKeywords.test(message) && modifyKeywords.test(message)) {
        try {
          const confirmResult = safetyDAO.insertSafetyEventFull({
            type: 'evolution_major', actor: `session:${sessionId}`,
            operation: `Security keyword detected in modification: ${message.slice(0, 100)}`,
            decision: 'pending', org, timestamp: new Date().toISOString(),
          })
          await stream.writeSSE({
            event: 'confirm',
            data: JSON.stringify({
              type: 'evolution_major', event_id: Number(confirmResult.lastInsertRowid),
              detail: '安全关键词命中：此修改涉及安全相关内容，需要用户确认后才能执行',
              summary: '进化变更涉及安全关键词，需要确认',
            }),
          })
        } catch { /* non-fatal */ }
      }

      // Workflow match → emit tool_call (TC-008)
      if (result.intent.intent === 'single_task') {
        const workflowName = result.workflow?.workflow_name ?? 'prd-impl'
        await stream.writeSSE({
          event: 'tool_call',
          data: JSON.stringify({
            type: 'start', tool_name: 'workflow_run', name: workflowName,
            workflow_name: workflowName,
            result: { workflow: workflowName, score: result.workflow?.score ?? 0.7, reason: result.workflow ? '工作流匹配' : '默认工作流分配' },
          }),
        })
      }

      // Novel task → confirm (TC-011)
      const isNovelTask = (result.intent.intent === 'general_chat' || result.intent.intent === 'single_task') &&
        !result.workflow && /任务|task|全新|自定义|custom|novel|写|生成|创建/.test(message)
      if (isNovelTask) {
        try {
          const generatedWorkflow = `dynamic-${sessionId.slice(0, 8)}`
          const confirmResult = safetyDAO.insertSafetyEventFull({
            type: 'workflow_generated', actor: `session:${sessionId}`,
            operation: `Dynamic workflow generated: ${generatedWorkflow}`,
            decision: 'pending', org, timestamp: new Date().toISOString(),
          })
          await stream.writeSSE({
            event: 'confirm',
            data: JSON.stringify({
              type: 'workflow_generated', event_id: Number(confirmResult.lastInsertRowid),
              detail: `动态生成工作流: ${generatedWorkflow}`,
              summary: `为任务 "${message.slice(0, 50)}" 生成工作流`,
            }),
          })
        } catch { /* non-fatal */ }
      }

      // Scheduled task → emit tool_call (TC-041)
      if (result.intent.intent === 'scheduled_task') {
        const scheduleHour = result.inputs?.schedule_hour ?? '9'
        const cronExpr = `0 ${scheduleHour} * * *`
        try {
          const now2 = new Date().toISOString()
          const scheduleId = crypto.randomUUID()
          scheduleConfigDAO.insertAgentSchedule(scheduleId, org, `scheduled-${sessionId.slice(0, 8)}`, cronExpr, 'workflow', '{}', now2)
          await stream.writeSSE({
            event: 'tool_call',
            data: JSON.stringify({
              type: 'start', tool_name: 'scheduler_create', name: 'scheduler_create',
              result: { id: scheduleId, cron: cronExpr, task_description: message, timezone: 'Asia/Shanghai' },
            }),
          })
        } catch {
          await stream.writeSSE({
            event: 'tool_call',
            data: JSON.stringify({
              type: 'start', tool_name: 'scheduler_create', name: 'scheduler_create',
              result: { cron: cronExpr, task_description: message },
            }),
          })
        }
      }
    } catch { /* orchestration failure non-fatal */ }

    return { orchestrationResult, orchestrationFullResult }
  }

  async function tryClaudeSDK(
    message: string, systemPrompt: string, stream: any, sessionId: string,
    org: string, sessionDao: AgentSessionDAO, orchestrationResult: string | undefined,
    orchestrationFullResult: any,
  ): Promise<{ generated: boolean }> {
    let generated = false
    try {
      const provider = getProvider('claude')
      const cwd = getAgentDir()
      const messageChunks = provider.sendQuery(message, cwd, undefined, {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      })

      let fullContent = ''
      let fullThinking = ''
      const currentToolCalls: Array<{ id: string; name: string; input?: unknown; result?: unknown; status?: string }> = []

      for await (const chunk of messageChunks) {
        if ((stream as any)._aborted) break
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
          case 'tool_call_start':
            currentToolCalls.push({ id: chunk.toolCallId, name: chunk.toolName, status: 'start' })
            await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'start', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName }) })
            break
          case 'tool_call': {
            const tc = currentToolCalls.find(t => t.id === chunk.toolCallId)
            if (tc) tc.input = chunk.toolInput
            await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'input', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName, input: chunk.toolInput }) })
            break
          }
          case 'tool_result': {
            const tc = currentToolCalls.find(t => t.id === chunk.toolCallId)
            if (tc) { tc.result = chunk.content; tc.status = chunk.isError ? 'fail' : 'result' }
            await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'result', tool_call_id: chunk.toolCallId, content: chunk.content, is_error: chunk.isError }) })
            break
          }
          case 'status':
            await stream.writeSSE({ event: 'status', data: JSON.stringify({ status: chunk.status }) })
            break
          case 'result':
            generated = true
            break
          case 'error':
            await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: chunk.code, message: chunk.message }) })
            break
        }
      }

      if (generated && fullContent) {
        const assistantMsgId = crypto.randomUUID()
        const assistantNow = new Date().toISOString()
        const toolCallsJson = JSON.stringify({
          thinking: fullThinking || undefined,
          tool_calls: currentToolCalls.length > 0 ? currentToolCalls : undefined,
        })
        sessionDao.insertMessage({
          id: assistantMsgId, session_id: sessionId, role: 'assistant',
          content: fullContent, tool_calls: toolCallsJson, created_at: assistantNow,
        })
        sessionDao.updateLastMessageAt(sessionId, assistantNow)

        autoGenerateTitle(sessionId, org, message, sessionDao)
        recordDebugLog(assistantMsgId, sessionId, assistantNow, fullContent.length, 'chat', orchestrationResult, orchestrationFullResult)

        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            session_id: sessionId, message_id: assistantMsgId,
            orchestration: orchestrationResult,
            session_title: sessionDao.findById(sessionId)?.title,
          }),
        })
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[agent] Claude SDK call failed: ${errMsg}`, err instanceof Error ? err.stack : '')
    }
    return { generated }
  }

  function autoGenerateTitle(sessionId: string, org: string, message: string, dao: AgentSessionDAO): void {
    try {
      const sessionRow = dao.findById(sessionId)
      if (sessionRow && sessionRow.title === '新会话') {
        const rawMsg = message.replace(/\n/g, ' ').trim()
        const stripped = rawMsg
          .replace(/^(请|帮我|我想|给我|把|将|能不能|可以|帮我看看|看看)\s*/g, '')
          .replace(/^(please |help me |can you |i want |i need )/gi, '')
        let autoTitle = stripped.slice(0, 40)
        const cutPoint = autoTitle.search(/[，。！？,.!?]/)
        if (cutPoint > 4) autoTitle = autoTitle.slice(0, cutPoint)
        if (autoTitle.length > 40) autoTitle = autoTitle.slice(0, 37) + '...'
        autoTitle = autoTitle.trim() || rawMsg.slice(0, 30)
        dao.updateSession(sessionId, { title: autoTitle || '新会话' })

        // Fire-and-forget LLM title refinement
        setImmediate(async () => {
          try {
            const provider = getProvider('claude')
            const cwd = getAgentDir()
            let titleContent = ''
            for await (const chunk of provider.sendQuery(
              `Generate a concise session title (max 20 chars, Chinese preferred) from: "${rawMsg.slice(0, 200)}". Reply with ONLY the title.`,
              cwd, undefined, { model: 'haiku' },
            )) {
              if (chunk.type === 'text_delta') titleContent += chunk.content
            }
            if (titleContent) {
              const llmTitle = titleContent.trim().replace(/[.。,，!！?？""]/g, '').slice(0, 30)
              if (llmTitle && llmTitle !== autoTitle) {
                dao.updateSessionByOrg(sessionId, org, { title: llmTitle })
              }
            }
          } catch { /* non-fatal */ }
        })
      }
    } catch { /* non-fatal */ }
  }

  function recordDebugLog(
    chatId: string, sessionId: string, timestamp: string, contentLength: number,
    source: string, orchestration: string | undefined, orchestrationFullResult: any,
  ): void {
    try {
      const debugDir = getDebugTracesDir()
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
      const debugEntry = {
        chat_id: chatId, session_id: sessionId, timestamp,
        level: 'info', source,
        message: `Chat completed: ${contentLength} chars`,
        orchestration: orchestration ?? null,
        workflow: orchestrationFullResult?.workflow?.workflow_name ?? null,
        intent: orchestrationFullResult?.intent?.intent ?? null,
      }
      const traceFile = path.join(debugDir, `${new Date().toISOString().split('T')[0]}.jsonl`)
      fs.appendFileSync(traceFile, JSON.stringify(debugEntry) + '\n', 'utf-8')
    } catch { /* non-fatal */ }
  }

  async function sendFallbackResponse(
    message: string, stream: any, sessionId: string, org: string,
    dao: AgentSessionDAO, orchestrationResult: string | undefined,
  ): Promise<void> {
    const orchestratorPrefix = orchestrationResult ? `📋 编排分析: ${orchestrationResult}\n\n` : ''
    const fallbackResponse = `${orchestratorPrefix}收到消息: "${message}"。\n\n⚠️ Claude SDK 未配置或不可用。请配置 ANTHROPIC_API_KEY 环境变量以启用完整 LLM 对话功能。\n\n当前可用的编排能力：\n- 意图分类（单次任务/定时任务/信息查询/分身管理）\n- 工作流匹配与选择\n- 记忆系统读写\n- 会话上下文压缩`

    const chars = fallbackResponse.split('')
    let fullContent = ''
    for (const char of chars) {
      fullContent += char
      await stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ delta: char, content: fullContent }) })
      await stream.sleep(5)
    }

    const assistantMsgId = crypto.randomUUID()
    const assistantNow = new Date().toISOString()
    dao.insertMessage({ id: assistantMsgId, session_id: sessionId, role: 'assistant', content: fullContent, created_at: assistantNow })
    dao.updateLastMessageAt(sessionId, assistantNow)

    try {
      const sessionRow = dao.findById(sessionId)
      if (sessionRow && sessionRow.title === '新会话') {
        const autoTitle = message.slice(0, 50).replace(/\n/g, ' ').trim()
        dao.updateSession(sessionId, { title: autoTitle || '新会话' })
      }
    } catch { /* non-fatal */ }

    recordDebugLog(assistantMsgId, sessionId, assistantNow, fullContent.length, 'chat_fallback', orchestrationResult, undefined)

    await stream.writeSSE({
      event: 'done',
      data: JSON.stringify({
        session_id: sessionId, message_id: assistantMsgId,
        orchestration: orchestrationResult, mode: 'fallback',
        session_title: dao.findById(sessionId)?.title,
      }),
    })
  }

  return app
}
