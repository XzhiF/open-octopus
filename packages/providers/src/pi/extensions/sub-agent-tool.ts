import type { OctopusAgentDef } from '../../types'

interface SubAgentToolOptions {
  depth?: number
}

export interface SubAgentTool {
  name: string
  description: string
  allowedTools?: string[]
  executionMode?: 'sequential' | 'parallel'
  maxDepth: number
  prompt: string
  model?: string
  skills?: string[]
  execute: (input: { task: string }) => Promise<string>
}

export function toSubAgentTool(
  name: string,
  def: OctopusAgentDef,
  cwd: string,
  opts: SubAgentToolOptions = {},
): SubAgentTool {
  const depth = opts.depth ?? 0

  return {
    name: `delegate_to_${name}`,
    description: `Delegate a task to the ${name} sub-agent. ${def.description}`,
    allowedTools: def.tools,
    executionMode: def.background ? 'parallel' : 'sequential',
    maxDepth: 1,
    prompt: def.prompt,
    model: def.model,
    skills: def.skills,
    execute: async (input: { task: string }) => {
      if (depth >= 1) {
        return `Error: Sub-agent nesting depth exceeded (max=1). Cannot delegate from within a sub-agent.`
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
        const combinedPrompt = `${def.prompt}\n\nTask: ${input.task}`
        await promptSession(result.session, combinedPrompt, {
          model: def.model,
        })
        const messages = result.session.state?.messages ?? []
        const lastAssistant = messages.filter((m: any) => m.role === 'assistant').pop()
        const textContent = lastAssistant?.content
          ?.filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('') ?? ''
        return textContent || '(sub-agent produced no text output)'
      } finally {
        disposeSession(result.session)
      }
    },
  }
}
