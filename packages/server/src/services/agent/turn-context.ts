/**
 * Task-thread playbook delivery.
 *
 * The per-turn task <system-reminder> has two parts:
 *   - head     — status line (task / status / phase · round), tiny, changes
 *                whenever the task moves. Sent EVERY turn.
 *   - playbook — identity + discipline + tools + guides, large, and identical
 *                between transitions. Measured sessions re-sent a byte-identical
 *                body on 70–90% of turns; send it once per change instead.
 *
 * The chat route hashes the playbook, compares it with what the provider
 * transcript already holds (`SessionCacheContextDAO.getPlaybookHash`), and sends
 * the full body only when the hash differs. Compaction and `/clear` wipe the
 * stored hash so the next turn re-delivers the full block.
 */
import { hashPrompt } from "../../db/dao/session-cache-context-dao"

export interface TurnContextParts {
  contextHead: string
  contextPlaybook: string
}

/** Sent in place of the playbook while it is unchanged. */
export const PLAYBOOK_UNCHANGED_NOTE =
  "[说明] 身份与执行规则未变化，沿用前文送达的 playbook；以本行状态为准。"

export interface TurnContextReminder {
  /** Body to append to the user message (head + full playbook, or head + note). */
  text: string
  /** Identity of the playbook body; persist it when `full` is true. */
  playbookHash: string
  full: boolean
}

export function buildTaskPlaybookReminder(
  parts: TurnContextParts,
  deliveredHash: string | null,
): TurnContextReminder {
  // Defensive: a profile without a playbook (legacy / test double) still gets
  // its head; there is nothing to deliver or record.
  const playbook = parts.contextPlaybook ?? ""
  const head = parts.contextHead ?? ""
  if (!playbook) {
    return { text: head, playbookHash: hashPrompt(""), full: false }
  }
  const playbookHash = hashPrompt(playbook)
  const full = deliveredHash !== playbookHash
  const text = full
    ? [head, playbook].filter(Boolean).join("\n")
    : [head, PLAYBOOK_UNCHANGED_NOTE].filter(Boolean).join("\n")
  return { text, playbookHash, full }
}
