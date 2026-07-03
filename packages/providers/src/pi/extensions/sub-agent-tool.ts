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
  depth?: number
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const MAX_DEPTH = 3

export function createSubAgentTools(opts: SubAgentToolOptions): any[] {
  const currentDepth = opts.depth ?? 0
  return Object.entries(opts.agents).map(([name, def]) => ({
    name: `delegate_to_${name}`,
    description: def.description,
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    async execute(input: { task: string }) {
      if (currentDepth >= MAX_DEPTH) {
        return { content: '不支持嵌套委派: 已达最大深度限制', isError: true }
      }

      const controller = new AbortController()
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

      const onParentAbort = () => controller.abort()
      opts.parentSignal?.addEventListener('abort', onParentAbort, { once: true })

      try {
        const session = await opts.createSession(opts.cwd, { model: def.model })
        const prompt = `${def.prompt}\n\n---\n\nTask: ${input.task}`

        // Race prompt against timeout so we don't hang on unresponsive sessions
        const result = await Promise.race([
          session.prompt(prompt),
          new Promise<never>((_, reject) =>
            setTimeout(() => {
              controller.abort()
              reject(new Error('__timeout__'))
            }, timeoutMs),
          ),
        ])
        return { content: extractResultText(result) }
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.message === '__timeout__')) {
          return { content: `子代理执行超时（${timeoutMs / 1000}s）`, isError: true }
        }
        return { content: `子代理执行失败: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      } finally {
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
