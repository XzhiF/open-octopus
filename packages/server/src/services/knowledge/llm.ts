// packages/server/src/services/knowledge/llm.ts
//
// Single source of truth for lightweight LLM completions used by the
// knowledge loop (rule extraction, skill proposals, compact consolidation,
// pattern analysis).
//
// Design goals:
//  * One implementation — all four knowledge services share this module.
//  * Graceful degradation — when no API key is configured the function
//    returns "" (no throw), so callers keep falling through to their
//    deterministic heuristics.
//  * Dependency-injection friendly — every service accepts an optional
//    `llmCall` parameter so tests can supply a fake without touching
//    module state, and production code can swap providers later.
//  * No new runtime dependencies — uses the global `fetch` against the
//    Anthropic Messages API; does not require `@anthropic-ai/sdk`.

export type LLMCall = (prompt: string) => Promise<string>

const DEFAULT_MODEL = "claude-haiku-4-5-20251001"
const DEFAULT_MAX_TOKENS = 1024
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Default LLM completion function used by the knowledge loop.
 *
 * Behavior:
 *   * If `OCTOPUS_KNOWLEDGE_LLM_DISABLED=1` or `ANTHROPIC_API_KEY` is unset,
 *     returns "" immediately (placeholder / offline mode).
 *   * Otherwise POSTs to the Anthropic Messages API and returns the first
 *     text block. JSON/XML parse errors inside the model output are the
 *     caller's responsibility.
 *
 * The function swallows network errors and logs them — knowledge services
 * already expect an empty response to mean "fall back to heuristics".
 */
export async function callHaiku(prompt: string): Promise<string> {
  if (process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED === "1") {
    return ""
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    // Silent no-op: absence of an API key is an expected offline state,
    // not a configuration error worth warning about on every call.
    return ""
  }

  const model = process.env.OCTOPUS_KNOWLEDGE_LLM_MODEL ?? DEFAULT_MODEL
  const maxTokens = Number(process.env.OCTOPUS_KNOWLEDGE_LLM_MAX_TOKENS ?? DEFAULT_MAX_TOKENS)
  const timeoutMs = Number(process.env.OCTOPUS_KNOWLEDGE_LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      console.warn(`[knowledge] callHaiku HTTP ${response.status}: ${body.slice(0, 200)}`)
      return ""
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const firstText = payload.content?.find((b) => b.type === "text")?.text
    return firstText ?? ""
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[knowledge] callHaiku failed: ${reason}`)
    return ""
  } finally {
    clearTimeout(timer)
  }
}
