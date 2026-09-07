// packages/server/src/routes/clone/stream-partials.ts
//
// Startup sweep for streaming assistant partials (clone chat "关闭不丢失" fix).
//
// The clone chat route persists an in-progress assistant message row with
// `metadata.streaming: true` (throttled UPSERT during generation, finalized
// at turn-end). If the server process dies mid-turn the row lingers — no
// stream owns it and the frontend would render a stuck partial forever.
//
// Called exactly once at server startup (before any route can register a
// stream in activeStreams), so every streaming row found here is an orphan:
// finalize it as `interrupted: true` (same shape the route's turn-end
// finalization produces, so the client needs no special case).
//
// Must NOT be called while streams may be active — that would corrupt live
// partials.

import type { AgentSessionDAO } from '../../db/dao'

interface PartialMeta {
  thinking?: string
  tool_calls?: Array<{ status?: string; ended_at?: number }>
  timeline?: unknown[]
  streaming?: boolean
  interrupted?: boolean
  [k: string]: unknown
}

/** Finalize a streaming partial metadata blob: drop `streaming`, mark
 *  `interrupted`, fail any non-terminal tool calls (mirrors the route's
 *  turn-end logic in routes/clone/index.ts). */
export function finalizePartialMeta(raw: string): string | null {
  const meta = JSON.parse(raw) as PartialMeta
  if (typeof meta !== 'object' || meta === null || meta.streaming !== true) return null
  delete meta.streaming
  meta.interrupted = true
  if (Array.isArray(meta.tool_calls)) {
    meta.tool_calls = meta.tool_calls.map((tc) => {
      const terminal = tc.status === 'success' || tc.status === 'result' || tc.status === 'fail'
      return terminal ? tc : { ...tc, status: 'fail', ended_at: Date.now() }
    })
  }
  return JSON.stringify(meta)
}

/** Sweep all streaming partial rows → interrupted. Returns the count
 *  finalized. Malformed metadata rows are skipped (logged), never fatal. */
export function finalizeOrphanStreamPartials(sessionDAO: AgentSessionDAO): number {
  let finalized = 0
  for (const row of sessionDAO.findStreamingMessages()) {
    try {
      const meta = finalizePartialMeta(row.metadata)
      if (meta === null) continue
      sessionDAO.updateMessage(row.id, { metadata: meta })
      finalized++
    } catch (err: unknown) {
      console.error(
        `[clone-stream-partials] failed to finalize orphan partial ${row.id} (skipped):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  if (finalized > 0) {
    console.log(`[clone-stream-partials] finalized ${finalized} orphan streaming partial(s) at startup`)
  }
  return finalized
}
