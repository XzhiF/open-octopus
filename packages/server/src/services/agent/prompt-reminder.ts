/**
 * Transient per-turn context (task status, spec notices, authoring resources)
 * must never mutate the system prompt: the provider cache is a prefix cache,
 * and the system prompt sits in front of the whole transcript. A changed
 * system prompt therefore invalidates the entire cached conversation.
 *
 * Attach such facts to the *user message* instead, after the cached prefix,
 * wrapped as a system-reminder. Persistence/SSE keep the raw user text.
 */
export function withTransientReminder(content: string, reminder?: string | null): string {
  const body = reminder?.trim()
  if (!body) return content
  return `${content}\n\n<system-reminder>\n${body}\n</system-reminder>`
}
