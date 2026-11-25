// packages/server/src/services/cabin/cabin-item-service.ts
//
// 舱内事项（2026-11-24 用户）：零散小待办 —— 优化 / 修复 / 想法。
//
// 与「任务」不是一层：任务有 spec / phase / 工作树 / 验收 / 归档；事项只是一条
// 待办条目。生命周期：
//   todo ──投递给主对话──> delivered ──人确认──> done / dropped
//   todo ──人直接勾掉────> done / dropped
// closed_at 留痕，记录不做 TTL；删除是显式动作。
//
// 单仓单舱：所有读写都以 cabin_id 过滤，id 不能跨舱操作（写一次归属纪律）。

import crypto from "node:crypto"
import type Database from "better-sqlite3"
import type { CabinItemRow } from "../../db/types"

export type CabinItemKind = CabinItemRow["kind"]
export type CabinItemStatus = CabinItemRow["status"]

export class CabinItemError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = "CabinItemError"
  }
}

export interface CabinItemPatch {
  title?: string
  body?: string
  kind?: CabinItemKind
}

const TITLE_MAX = 200
const BODY_MAX = 8000
const BATCH_MAX = 50

function nowIso(): string {
  return new Date().toISOString()
}

function clampText(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("")
}

export class CabinItemService {
  constructor(private readonly db: Database.Database) {}

  private assertCabin(cabinId: string): void {
    const row = this.db.prepare(
      "SELECT id FROM cabins WHERE id = ? AND deleted_at IS NULL",
    ).get(cabinId) as { id: string } | undefined
    if (!row) throw new CabinItemError(404, `cabin not found: ${cabinId}`)
  }

  private assertItem(cabinId: string, itemId: string): CabinItemRow {
    const row = this.db.prepare(
      "SELECT * FROM cabin_items WHERE id = ? AND cabin_id = ?",
    ).get(itemId, cabinId) as CabinItemRow | undefined
    if (!row) throw new CabinItemError(404, `item not found: ${itemId}`)
    return row
  }

  list(cabinId: string): CabinItemRow[] {
    this.assertCabin(cabinId)
    return this.db.prepare(
      `SELECT * FROM cabin_items WHERE cabin_id = ?
        ORDER BY CASE WHEN status IN ('todo','delivered') THEN 0 ELSE 1 END,
                 created_at DESC, rowid DESC`,
    ).all(cabinId) as CabinItemRow[]
  }

  get(cabinId: string, itemId: string): CabinItemRow {
    this.assertCabin(cabinId)
    return this.assertItem(cabinId, itemId)
  }

  create(cabinId: string, input: { title?: string; body?: string; kind?: CabinItemKind }): CabinItemRow {
    this.assertCabin(cabinId)
    const now = nowIso()
    const id = `ci-${crypto.randomUUID()}`
    const title = clampText((input.title ?? "").trim(), TITLE_MAX)
    const body = clampText(input.body ?? "", BODY_MAX)
    const kind: CabinItemKind = input.kind ?? "optimize"
    const insert = this.db.transaction(() => {
      const next = this.db.prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM cabin_items WHERE cabin_id = ?",
      ).get(cabinId) as { seq: number }
      this.db.prepare(
        `INSERT INTO cabin_items
           (id, cabin_id, seq, kind, status, title, body,
            created_at, updated_at, delivered_at, closed_at,
            delivery_session_id, delivery_message_id)
         VALUES (?,?,?,?, 'todo', ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ).run(id, cabinId, next.seq, kind, title, body, now, now)
      return this.assertItem(cabinId, id)
    })
    return insert()
  }

  update(cabinId: string, itemId: string, patch: CabinItemPatch): CabinItemRow {
    this.assertCabin(cabinId)
    this.assertItem(cabinId, itemId)
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.title !== undefined) {
      sets.push("title = ?")
      params.push(clampText(patch.title.trim(), TITLE_MAX))
    }
    if (patch.body !== undefined) {
      sets.push("body = ?")
      params.push(clampText(patch.body, BODY_MAX))
    }
    if (patch.kind !== undefined) {
      sets.push("kind = ?")
      params.push(patch.kind)
    }
    if (sets.length === 0) return this.assertItem(cabinId, itemId)
    sets.push("updated_at = ?")
    params.push(nowIso(), itemId, cabinId)
    this.db.prepare(
      `UPDATE cabin_items SET ${sets.join(", ")} WHERE id = ? AND cabin_id = ?`,
    ).run(...params)
    return this.assertItem(cabinId, itemId)
  }

  remove(cabinId: string, itemId: string): void {
    this.assertCabin(cabinId)
    this.assertItem(cabinId, itemId)
    this.db.prepare("DELETE FROM cabin_items WHERE id = ? AND cabin_id = ?").run(itemId, cabinId)
  }

  /** 投递给主对话：todo → delivered。已 delivered / 关闭的不动（幂等）。 */
  deliver(
    cabinId: string,
    ids: string[],
    refs?: { sessionId?: string | null; messageId?: string | null },
  ): CabinItemRow[] {
    this.assertCabin(cabinId)
    const list = this.normalizeIds(ids)
    const now = nowIso()
    const stmt = this.db.prepare(
      `UPDATE cabin_items
          SET status = 'delivered', delivered_at = ?, updated_at = ?,
              delivery_session_id = COALESCE(?, delivery_session_id),
              delivery_message_id = COALESCE(?, delivery_message_id)
        WHERE id = ? AND cabin_id = ? AND status = 'todo'`,
    )
    const run = this.db.transaction(() => {
      for (const id of list) {
        stmt.run(now, now, refs?.sessionId ?? null, refs?.messageId ?? null, id, cabinId)
      }
    })
    run()
    return this.listByIds(cabinId, list)
  }

  /** 人确认关项：todo / delivered → done | dropped。 */
  close(cabinId: string, ids: string[], outcome: 'done' | 'dropped'): CabinItemRow[] {
    this.assertCabin(cabinId)
    const list = this.normalizeIds(ids)
    const now = nowIso()
    const stmt = this.db.prepare(
      `UPDATE cabin_items
          SET status = ?, closed_at = ?, updated_at = ?
        WHERE id = ? AND cabin_id = ? AND status IN ('todo','delivered')`,
    )
    const run = this.db.transaction(() => {
      for (const id of list) stmt.run(outcome, now, now, id, cabinId)
    })
    run()
    return this.listByIds(cabinId, list)
  }

  /** 记录页签里的「重新打开」：done / dropped → todo（交付 / 关闭时间留痕）。 */
  reopen(cabinId: string, itemId: string): CabinItemRow {
    this.assertCabin(cabinId)
    this.assertItem(cabinId, itemId)
    this.db.prepare(
      `UPDATE cabin_items SET status = 'todo', closed_at = NULL, updated_at = ?
        WHERE id = ? AND cabin_id = ? AND status IN ('done','dropped')`,
    ).run(nowIso(), itemId, cabinId)
    return this.assertItem(cabinId, itemId)
  }

  /** 当前未决条数（todo + delivered）—— HUD 徽标与 attention 读它。 */
  countOpen(cabinId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM cabin_items
        WHERE cabin_id = ? AND status IN ('todo','delivered')`,
    ).get(cabinId) as { n: number }
    return row.n
  }

  private normalizeIds(ids: string[]): string[] {
    const list = Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)))
    if (list.length === 0) throw new CabinItemError(400, "ids is required")
    if (list.length > BATCH_MAX) throw new CabinItemError(400, `too many ids (max ${BATCH_MAX})`)
    return list
  }

  private listByIds(cabinId: string, ids: string[]): CabinItemRow[] {
    if (ids.length === 0) return []
    const marks = ids.map(() => "?").join(",")
    return this.db.prepare(
      `SELECT * FROM cabin_items WHERE cabin_id = ? AND id IN (${marks})
        ORDER BY seq ASC`,
    ).all(cabinId, ...ids) as CabinItemRow[]
  }
}
