import type { OctopusAgentDef } from '../../types'

interface SubAgentToolOptions {
  depth?: number
}

export interface SubAgentTool {
  name: string
  label: string
  description: string
  promptSnippet: string
  parameters: Record<string, any>
  execute: (toolCallId: string, args: { task: string }, signal?: any, onUpdate?: any, ctx?: any) => Promise<any>
}

export function toSubAgentTool(
  name: string,
  def: OctopusAgentDef,
  cwd: string,
  opts: SubAgentToolOptions = {},
): SubAgentTool {
  const depth = opts.depth ?? 0
  const toolName = `delegate_to_${name}`

  return {
    name: toolName,
    label: toolName,
    description: `Delegate a task to the ${name} sub-agent. ${def.description}`,
    promptSnippet: `Delegate tasks to ${name} sub-agent`,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task description to delegate to the sub-agent' },
      },
      required: ['task'],
    },
    execute: async (_toolCallId: string, args: { task: string }, _signal?: any, _onUpdate?: any, _ctx?: any) => {
      if (depth >= 1) {
        return { content: [{ type: 'text', text: `Error: Sub-agent nesting depth exceeded (max=1). Cannot delegate from within a sub-agent.` }] }
      }

      const { createOctopusHooks } = await import('./octopus-hooks')
      const { buildSessionEnv } = await import('../security')
      const { createSession, promptSession, disposeSession } = await import('../pi-sdk-adapter')
      const filteredEnv = buildSessionEnv()
      const result = await createSession({
        cwd,
        filteredEnv,
        extensions: [createOctopusHooks()],
      })

      try {
        const combinedPrompt = `${def.prompt}\n\nTask: ${args.task}`
        await promptSession(result.session, combinedPrompt, {
          model: def.model,
        })
        const messages = result.session.state?.messages ?? (result.session as any).agent?.state?.messages ?? []
        const lastAssistant = messages.filter((m: any) => m.role === 'assistant').pop()
        const textContent = lastAssistant?.content
          ?.filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('') ?? ''
        const output = textContent || '(sub-agent produced no text output)'
        return { content: [{ type: 'text', text: output }] }
      } finally {
        disposeSession(result.session)
      }
    },
  }
}
