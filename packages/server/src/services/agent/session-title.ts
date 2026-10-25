/**
 * Deterministic session title from the first user message. Shared by the main
 * agent route and the task-author clone route so "auto title" behaves the same
 * in both surfaces: strip conversational lead-ins, cut at the first sentence
 * boundary, cap at 40 chars.
 */
export function deriveSessionTitle(message: string): string {
  const rawMsg = message.replace(/\n/g, ' ').trim()
  const stripped = rawMsg
    .replace(/^(请|帮我|我想|给我|把|将|能不能|可以|帮我看看|看看)\s*/g, '')
    .replace(/^(please |help me |can you |i want |i need )/gi, '')
  let title = stripped.slice(0, 40)
  const cutPoint = title.search(/[，。！？,.!?]/)
  if (cutPoint > 4) title = title.slice(0, cutPoint)
  if (title.length > 40) title = title.slice(0, 37) + '...'
  return title.trim() || rawMsg.slice(0, 30) || '新会话'
}
