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
