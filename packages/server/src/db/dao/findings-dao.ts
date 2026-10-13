import type Database from "better-sqlite3"
import { BaseDAO } from "./base"

/**
 * FindingsDAO — findings（票05 v53 纯增量新表）：知识中心 finding 持久最小面。
 *
 * 语义边界（票05 AC3「只产不裁」）：
 * - 本票消费面 = 编译管线 upsert（矛盾 finding，status 恒 open 入库）+ 读查询；
 * - 裁决迁移（open → resolved/ignored，裁决即编译）由票13 经 updateStatus 消费；
 * - upsert 幂等且**不覆盖既有 status**——重编译再现同一矛盾时刷新内容证据，
 *   但绝不回滚人已做的裁决。
 * kind 值面：本票只写 'contradiction'；'stale'|'orphan'|'missing-page'|'missing-xref'
 * 为票13 巡检预留（无 CHECK 约束钉死，避免票13 加值要动表）。
 */

export type FindingStatus = "open" | "resolved" | "ignored"

export interface FindingRow {
  id: string
  kind: string
  status: FindingStatus
  title: string
  /** JSON：{old_claim,new_claim,pages:[{path,anchor?}],raw:{path,hash}} —— 形态由产出方定 */
  detail: string
  /** JSON array：涉及页 relPath（两页矛盾 = 2 项） */
  pages: string
  /** 回指 raw 路径（溯源对质指针） */
  raw_ref: string
  /** 产出通道：compile（编译期矛盾）| patrol（票13 巡检） */
  source: string
  created_at: string
  updated_at: string
}

export interface FindingUpsert {
  id: string
  kind: string
  title: string
  detail: string
  pages: string
  raw_ref: string
  source: string
}

export class FindingsDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
  }

  /** 幂等入库：同 id 刷新证据内容（title/detail/pages/raw_ref/source），status 不动。 */
  upsert(row: FindingUpsert): void {
    this.stmt(`
      INSERT INTO findings (id, kind, title, detail, pages, raw_ref, source)
      VALUES (@id, @kind, @title, @detail, @pages, @raw_ref, @source)
      ON CONFLICT(id) DO UPDATE SET
        title=@title, detail=@detail, pages=@pages, raw_ref=@raw_ref, source=@source,
        updated_at=datetime('now')
    `).run(row)
  }

  getById(id: string): FindingRow | undefined {
    return this.stmt("SELECT * FROM findings WHERE id = ?").get(id) as FindingRow | undefined
  }

  /** 状态过滤列表（status 省略 = 全部）；新 finding 在前（票12 卡片流 / 票13 裁决面消费）。 */
  list(status?: FindingStatus): FindingRow[] {
    return status
      ? this.stmt("SELECT * FROM findings WHERE status = ? ORDER BY created_at DESC, id").all(status) as FindingRow[]
      : this.stmt("SELECT * FROM findings ORDER BY created_at DESC, id").all() as FindingRow[]
  }

  /** 开放 findings 计数（健康条「开放 findings」单一来源，prototype Tab④ 顶栏）。 */
  countOpen(): number {
    const r = this.stmt("SELECT COUNT(*) AS n FROM findings WHERE status = 'open'").get() as { n: number }
    return r.n
  }

  /** 裁决迁移（票13 消费；CHECK 约束钉三态，非法值抛错）。 */
  updateStatus(id: string, status: FindingStatus): void {
    this.stmt("UPDATE findings SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id)
  }
}
