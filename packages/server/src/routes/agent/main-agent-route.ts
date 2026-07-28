// packages/server/src/routes/agent/main-agent-route.ts
//
// Main Agent unified entry route — POST /api/agent/chat
// Supports:
//   1. LLM routing with tool-based delegation (default)
//   2. Deterministic @@mention delegation via delegate_to field
//
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import crypto from 'crypto'
import type { MessageChunk } from '@octopus/providers'
import { getProvider } from '@octopus/providers'
import type { AgentSessionDAO } from '../../db/dao'
import { CloneRuntime } from '../../services/agent/clone-runtime'
import { SystemPromptAssembler } from '../../services/agent/system-prompt-assembler'
import { registerActiveStream, unregisterActiveStream } from '../../services/agent/agent-service'
import { getAgentDir, getBuiltInCloneDir, getCloneDir, getAgentSkillsDir } from '../../services/agent/paths'
import { getEvolutionService } from '../../services/agent/evolution-service'
import { resolveCloneInfo } from '../../services/agent/clone-resolver'
import { isBuiltinClone } from '../../services/agent/builtin-clones'
import type { CloneDef } from '@octopus/shared'
import fs from 'fs'
import path from 'path'

// ── Route deps ─────────────────────────────────────────────────────

export interface MainAgentRouteDeps {
  sessionDAO: AgentSessionDAO
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

const EVOLUTION_TOOLS_PROMPT = `
## Self-Evolution Tools

You can autonomously improve your skills through these evolution operations:

- **mark_insight**: Record a lightweight "this could be improved" signal during conversation. Use when you notice a skill could be better but don't want to modify it right now. Input: { skill_name: string, insight: string }
- **evolve_skill**: Directly modify a SKILL.md file with an improvement. Use for minor wording/step fixes. Input: { skill_name: string, summary: string, new_content: string }
- **create_experience**: Record a valuable lesson learned from this session. Input: { skill_name: string, content: string }
- **merge_skills**: Combine overlapping or related skills into one. Input: { source_skills: string[], target_skill: string }
- **archive_skill**: Archive a skill that is no longer useful. Input: { skill_name: string, reason: string }

Use mark_insight liberally (it's cheap). Use evolve_skill sparingly (only for clear improvements).
At the end of a productive session, consider using create_experience to capture lessons.
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

// ── Route factory ──────────────────────────────────────────────────

export function createMainAgentRoute(deps: MainAgentRouteDeps): Hono {
  const { sessionDAO } = deps
  const app = new Hono()

  app.post('/chat', async (c) => {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string) || 'default'

    let body: { message?: string; session_id?: string; delegate_to?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid JSON body' } }, 400)
    }

    if (!body.message) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'message is required' } }, 400)
    }

    // Resolve or create session
    let sessionId = body.session_id
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
    // Deterministic delegation (@@mention)
    // ══════════════════════════════════════════════════════════════
    if (body.delegate_to) {
      const targetClone = body.delegate_to

      // Self-reference check: if session belongs to same clone, treat as normal message
      const session = sessionDAO.findById(sessionId)
      if (session?.clone_name === targetClone) {
        // Self-reference → fall through to normal LLM routing
      } else {
        // Resolve clone from filesystem
        const cloneDef = resolveCloneDefFromFs(targetClone)
        if (!cloneDef) {
          return streamSSE(c, async (stream) => {
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ code: 'CLONE_NOT_FOUND', message: `Clone "${targetClone}" not found` }),
            })
          })
        }

        return streamSSE(c, async (stream) => {
          const abortStream = () => {}
          const streamId = registerActiveStream(sessionId!, abortStream)

          try {
            // Signal delegation start
            await stream.writeSSE({
              event: 'delegation_start',
              data: JSON.stringify({ clone_name: targetClone, display_name: cloneDef.displayName }),
            })

            const runtime = new CloneRuntime(cloneDef, org)
            const cwd = runtime.getDefaultCwd()
            let fullContent = ''

            for await (const chunk of runtime.chat(body.message!, sessionId!, null, cwd)) {
              if ((stream as any)._aborted) break

              if (chunk.type === 'text_delta') {
                fullContent += chunk.content
                await stream.writeSSE({
                  event: 'text_delta',
                  data: JSON.stringify({ delta: chunk.content, content: fullContent, source: targetClone }),
                })
              } else if (chunk.type === 'error') {
                await stream.writeSSE({
                  event: 'error',
                  data: JSON.stringify({ code: chunk.code, message: chunk.message }),
                })
              }
            }

            // Signal delegation end
            await stream.writeSSE({
              event: 'delegation_end',
              data: JSON.stringify({ clone_name: targetClone }),
            })

            // Store assistant message with source metadata
            if (fullContent) {
              const assistantMsgId = crypto.randomUUID()
              const assistantNow = new Date().toISOString()
              const metadata = JSON.stringify({ source: targetClone, delegation: true })

              sessionDAO.insertMessage({
                id: assistantMsgId, session_id: sessionId!, role: 'assistant',
                content: fullContent, metadata, created_at: assistantNow,
              })
              sessionDAO.updateLastMessageAt(sessionId!, assistantNow)

              await stream.writeSSE({
                event: 'done',
                data: JSON.stringify({
                  session_id: sessionId,
                  message_id: assistantMsgId,
                  session_title: sessionDAO.findById(sessionId!)?.title,
                }),
              })
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ code: 'DELEGATION_ERROR', message: `Delegation to ${targetClone} failed: ${msg}` }),
            })
          } finally {
            unregisterActiveStream(sessionId!, streamId)
          }
        })
      }
    }

    // ══════════════════════════════════════════════════════════════
    // Normal LLM routing (with optional tool-based delegation)
    // ══════════════════════════════════════════════════════════════
    const assembler = new SystemPromptAssembler(org)
    const baseSystemPrompt = assembler.assemble()
    const systemPrompt = `${baseSystemPrompt}\n\n${DELEGATION_TOOLS_PROMPT}\n\n${EVOLUTION_TOOLS_PROMPT}`

    return streamSSE(c, async (stream) => {
      let aborted = false
      const abortStream = () => { aborted = true }
      const streamId = registerActiveStream(sessionId!, abortStream)

      try {
        const provider = getProvider('claude')
        const cwd = getAgentDir()

        const chunks = provider.sendQuery(body.message!, cwd, undefined, {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
        })

        let fullContent = ''
        let fullThinking = ''
        let delegationDetected: { cloneName: string; task: string } | null = null
        const evolutionToolCalls: Array<{ id: string; name: string; input?: Record<string, unknown> }> = []
        const toolCalls: Array<{
          id: string; name: string; input?: unknown; result?: unknown; isError?: boolean
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
            case 'tool_call_start':
              toolCalls.push({ id: chunk.toolCallId, name: chunk.toolName })
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
              }
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'input', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName, input: chunk.toolInput }) })
              break
            }
            case 'tool_result': {
              const tc = toolCalls.find(t => t.id === chunk.toolCallId)
              if (tc) { tc.result = chunk.content; tc.isError = chunk.isError }
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'result', tool_call_id: chunk.toolCallId, content: chunk.content, is_error: chunk.isError }) })
              break
            }
            case 'status':
              await stream.writeSSE({ event: 'status', data: JSON.stringify({ status: chunk.status }) })
              break
            case 'result':
              break
            case 'error':
              await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: chunk.code, message: chunk.message }) })
              break
          }
        }

        // If delegation was detected, execute via CloneRuntime
        if (delegationDetected && !aborted) {
          await executeDelegation(
            delegationDetected, sessionId!, org, stream,
          )
        }

        // Execute evolution tool calls
        if (evolutionToolCalls.length > 0 && !aborted) {
          await executeEvolutionTools(evolutionToolCalls, org, sessionId!, stream)
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

const EVOLUTION_TOOL_NAMES = ['mark_insight', 'evolve_skill', 'create_experience', 'merge_skills', 'archive_skill']

// ── Evolution tool execution ──────────────────────────────────────

async function executeEvolutionTools(
  toolCalls: Array<{ id: string; name: string; input?: Record<string, unknown> }>,
  org: string,
  sessionId: string,
  stream: any,
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
            const dao = (evolutionService as unknown as { dao: import('../../db/dao/evolution-dao').EvolutionDAO }).dao
            const markResult = dao.insertMark({ skill_name: skillName, insight, session_id: sessionId, org })
            resultContent = `Insight marked (id: ${markResult.lastInsertRowid}) for skill "${skillName}"`
          } catch {
            resultContent = `Failed to mark insight for "${skillName}"`
          }
          break
        }

        case 'evolve_skill': {
          const skillName = String(input.skill_name ?? '')
          const summary = String(input.summary ?? '')
          const newContent = String(input.new_content ?? '')
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
              const bakPath = skillPath + '.bak'
              if (!fs.existsSync(bakPath)) fs.copyFileSync(skillPath, bakPath)
            }
            if (newContent) {
              fs.writeFileSync(skillPath, newContent, 'utf-8')
            } else {
              const current = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, 'utf-8') : ''
              fs.writeFileSync(skillPath, current + `\n\n> Evolution (${new Date().toISOString().split('T')[0]}): ${summary}`, 'utf-8')
            }
            evolutionService.recordEvolution(org, {
              skill_name: skillName, change_type: 'minor', level: 'minor', summary,
            })
            resultContent = `Skill "${skillName}" evolved: ${summary}`
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
          resultContent = 'merge_skills: skill merging is not yet implemented. Please use evolve_skill to manually consolidate content.'
          break
        }

        case 'archive_skill': {
          const skillName = String(input.skill_name ?? '')
          const reason = String(input.reason ?? 'archived by agent')
          if (!skillName) {
            resultContent = 'Error: skill_name is required'
            break
          }
          try {
            const evolutionService = getEvolutionService()
            evolutionService.recordEvolution(org, {
              skill_name: skillName, change_type: 'major', level: 'major',
              summary: `Archived: ${reason}`,
            })
            resultContent = `Skill "${skillName}" archived: ${reason}`
          } catch {
            resultContent = `Failed to archive skill "${skillName}"`
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

// ── Delegation execution ───────────────────────────────────────────

async function executeDelegation(
  delegation: { cloneName: string; task: string },
  sessionId: string,
  org: string,
  stream: any,
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
    for await (const chunk of runtime.chat(delegation.task, sessionId, null, cwd)) {
      if (chunk.type === 'text_delta') {
        delegateContent += chunk.content
        await stream.writeSSE({
          event: 'text_delta',
          data: JSON.stringify({ delta: chunk.content, content: delegateContent, source: cloneName }),
        })
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await stream.writeSSE({
      event: 'error',
      data: JSON.stringify({ code: 'DELEGATION_ERROR', message: `Delegation to ${cloneName} failed: ${msg}` }),
    })
  }
}
