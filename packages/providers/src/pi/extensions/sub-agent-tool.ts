interface SubAgentDef {
  description: string
  prompt: string
  tools?: string[]
  model?: string
}

interface SubAgentToolOptions {
  agents: Record<string, SubAgentDef>
  createSession: (cwd: string, options?: any) => Promise<any>
  cwd: string
  parentSignal?: AbortSignal
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export function createSubAgentTools(opts: SubAgentToolOptions): any[] {
  return Object.entries(opts.agents).map(([name, def]) => ({
    name: `delegate_to_${name}`,
    description: def.description,
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    async execute(input: { task: string }) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

      const onParentAbort = () => controller.abort()
      opts.parentSignal?.addEventListener('abort', onParentAbort, { once: true })

      try {
        const session = await opts.createSession(opts.cwd, { model: def.model })
        const prompt = `${def.prompt}\n\n---\n\nTask: ${input.task}`
        const result = await session.prompt(prompt)
        return { content: extractResultText(result) }
      } catch (err) {
        if (controller.signal.aborted) {
          return { content: `子代理执行超时（${(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s）`, isError: true }
        }
        return { content: `子代理执行失败: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      } finally {
        clearTimeout(timeout)
        opts.parentSignal?.removeEventListener('abort', onParentAbort)
      }
    },
  }))
}

function extractResultText(result: any): string {
  if (typeof result === 'string') return result
  if (result?.messages) {
    const last = result.messages.filter((m: any) => m.role === 'assistant').pop()
    if (last?.content) {
      if (typeof last.content === 'string') return last.content
      if (Array.isArray(last.content)) {
        return last.content.filter((c: any) => c.type === 'text').map((c: any) => c.text ?? '').join('')
      }
    }
  }
  return JSON.stringify(result)
}
