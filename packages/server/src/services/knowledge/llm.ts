// packages/server/src/services/knowledge/llm.ts
//
// LLM completion for the knowledge loop (rule extraction, compact,
// pattern analysis).
//
// Uses the same IAgentProvider as the rest of the server (Claude SDK),
// so auth is inherited from the global provider config — no separate
// ANTHROPIC_API_KEY needed.

import type { IAgentProvider, MessageChunk } from "@octopus/providers"
import { getProvider } from "@octopus/providers"

export type LLMCall = (prompt: string) => Promise<string>

/**
 * Collect text from a provider stream.
 *
 * `sendQuery` returns an AsyncGenerator<MessageChunk>. This helper
 * iterates it and returns the final text content.
 */
async function collectStream(
  stream: AsyncGenerator<MessageChunk>,
): Promise<string> {
  let text = ""
  for await (const chunk of stream) {
    if (chunk.type === "text_delta") {
      text += chunk.content
    } else if (chunk.type === "result" && chunk.content) {
      text = chunk.content
    }
  }
  return text
}

/**
 * Create an LLM call function backed by the given provider.
 *
 * Usage:
 *   const llmCall = createProviderLLMCall(getProvider('claude'))
 *   const result = await llmCall("your prompt here")
 */
export function createProviderLLMCall(
  provider: IAgentProvider,
  cwd: string = process.cwd(),
  model: string = "haiku",
): LLMCall {
  return async (prompt: string): Promise<string> => {
    try {
      const stream = provider.sendQuery(prompt, cwd, undefined, { model })
      return await collectStream(stream)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`[knowledge] provider LLM call failed: ${reason}`)
      return ""
    }
  }
}

/**
 * 生产 LLM 适配器共享核（code-review judgement：curator-llm/archive-ingest-llm
 * 同构 32 行收口于此；两模块降级为 channel+modelEnv 两参数的委托）。
 *
 * 行为制式（原样保留）：创建时过 `OCTOPUS_KNOWLEDGE_LLM_DISABLED=1` 离线闸（恒空串，
 * 调用方按"无响应"失败形态处理，绝不静默降级）；调用时取 claude provider、
 * 模型 = `process.env[modelEnv]`（逐拍读，保留 env 后改语义）?? defaultModel；
 * provider 未配置/构建失败 ⇒ 空串 + stderr 留痕（`[${channel}]` 前缀）。
 * 单测一律 fixture-mocked LLMCall（spec Testing Decisions），生产注入在 index.ts。
 */
export function createProductionKnowledgeLLM(opts: {
  channel: string
  modelEnv: string
  defaultModel?: string
}): LLMCall {
  if (process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED === "1") {
    return async () => ""
  }
  return async (prompt: string): Promise<string> => {
    try {
      const provider = getProvider("claude")
      const call = createProviderLLMCall(provider, process.cwd(), process.env[opts.modelEnv] ?? opts.defaultModel ?? "sonnet")
      return await call(prompt)
    } catch (err) {
      console.warn(`[${opts.channel}] provider LLM unavailable: ${err instanceof Error ? err.message : String(err)}`)
      return ""
    }
  }
}

/**
 * Streaming LLM call using the claude provider.
 * Yields each text_delta as it arrives from the provider.
 */
export async function* callHaikuStream(prompt: string): AsyncGenerator<string> {
  if (process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED === "1") {
    return
  }

  try {
    const provider = getProvider("claude")
    const stream = provider.sendQuery(prompt, process.cwd(), undefined, {
      model: "haiku",
      systemPrompt: "You are a helpful assistant. Respond concisely with only the requested output.",
    })
    for await (const chunk of stream) {
      if (chunk.type === "text_delta") {
        yield chunk.content
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[knowledge] callHaikuStream failed: ${reason}`)
  }
}

/**
 * Default LLM call using the claude provider.
 * Returns "" if the provider is not available (offline / not configured).
 */
export async function callHaiku(prompt: string): Promise<string> {
  if (process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED === "1") {
    return ""
  }

  try {
    const provider = getProvider("claude")
    const stream = provider.sendQuery(prompt, process.cwd(), undefined, {
      model: "haiku",
      systemPrompt: "You are a helpful assistant. Respond concisely with only the requested output.",
    })
    return await collectStream(stream)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[knowledge] callHaiku failed: ${reason}`)
    return ""
  }
}
