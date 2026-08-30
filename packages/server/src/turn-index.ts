/**
 * 轮次派生单一真相源（P 方案）。
 *
 * `agent_events.turn_index` 有两套写入者：运行中的 observability（原始碎片、能推进），
 * 以及节点收尾的 `replaceMergedEvents`（合并块覆盖、不带轮次 → 旧代码一律落 1，把 5 轮
 * 谎记成 1）。而 `llm_calls` 每回合一条、时间戳与回合精确对齐，是权威轮次源。
 *
 * 故读写两侧统一按「事件时间戳落入哪个 llm_call 时间窗」派生回合：窗口 = 最大的
 * `call.ts <= event.ts` 那次调用所属回合；早于首调用的 lead-in 归第 1 回合。
 * 抽成纯函数共享，写侧盖列、读侧兜存量，二者一致。
 */

/** 一次 llm_call 对回合边界的贡献：回合号 + 该回合起始毫秒。 */
export interface TurnBoundary {
  turn: number
  ts: number
}

/** 归一化时间戳到 epoch-ms：兼容 int（observability 写）与 ISO 串（合并覆盖写）混存。 */
export function toEpochMs(t: unknown): number {
  if (typeof t === "number") return Number.isFinite(t) ? t : 0
  if (typeof t === "string") {
    const n = Number(t)
    if (Number.isFinite(n)) return n
    const p = Date.parse(t)
    return Number.isNaN(p) ? 0 : p
  }
  return 0
}

/**
 * 由某节点的 llm_calls 构建回合边界（每回合取最早起始 ts，升序）。
 * 同一回合可能多条 call（并行工具），按 turn 归并取 min(ts)。
 */
export function buildTurnBoundaries(
  calls: Array<{ turn_index: number; timestamp: number }>,
): TurnBoundary[] {
  const minTs = new Map<number, number>()
  for (const c of calls) {
    const prev = minTs.get(c.turn_index)
    if (prev === undefined || c.timestamp < prev) minTs.set(c.turn_index, c.timestamp)
  }
  return Array.from(minTs.entries())
    .map(([turn, ts]) => ({ turn, ts }))
    .sort((a, b) => a.ts - b.ts || a.turn - b.turn)
}

/**
 * 事件所属回合：最大的 `b.ts <= evMs` 的边界回合号；无边界 → 1（lead-in / 非 agent 节点）。
 * 事件早于首次调用（如节点 start）→ 归首个回合，不产生 T0。
 */
export function deriveTurnForTs(bounds: TurnBoundary[], evMs: number): number {
  if (bounds.length === 0) return 1
  let turn = bounds[0].turn
  for (const b of bounds) {
    if (b.ts <= evMs) turn = b.turn
    else break
  }
  return turn
}
