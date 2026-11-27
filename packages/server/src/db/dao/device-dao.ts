import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { DeviceRow } from "../types"

/**
 * DeviceDAO — 手机设备令牌（M3 · 2026-11-27）。
 *
 * 写面只有三件事：兑换时插一行、鉴权时摸一下 last_seen、设置页改名 / 吊销。
 * 吊销不删行 —— 谁在什么时候配对过是账本；`revoked_at` 非空即失效。
 */
export class DeviceDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
  }

  insert(row: DeviceRow): void {
    this.stmt(`
      INSERT INTO devices
        (id, name, token_hash, token_prefix, platform, created_at, last_seen_at, revoked_at, ssh_key_slot)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      row.id, row.name, row.token_hash, row.token_prefix, row.platform,
      row.created_at, row.last_seen_at, row.revoked_at, row.ssh_key_slot,
    )
  }

  getById(id: string): DeviceRow | undefined {
    return this.stmt("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined
  }

  /** 鉴权热路径：令牌哈希 → 未吊销的设备行。 */
  findActiveByTokenHash(tokenHash: string): DeviceRow | undefined {
    return this.stmt(
      "SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL",
    ).get(tokenHash) as DeviceRow | undefined
  }

  list(): DeviceRow[] {
    return this.stmt(
      "SELECT * FROM devices ORDER BY created_at DESC, rowid DESC",
    ).all() as DeviceRow[]
  }

  touchLastSeen(id: string, at: string): void {
    this.stmt("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at, id)
  }

  rename(id: string, name: string): void {
    this.stmt("UPDATE devices SET name = ? WHERE id = ?").run(name, id)
  }

  revoke(id: string, at: string): void {
    this.stmt(
      "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(at, id)
  }

  /** M4：配对时记录这台手机拿走的 SSH 密钥槽。 */
  setSshKeySlot(id: string, slot: string | null): void {
    this.stmt("UPDATE devices SET ssh_key_slot = ? WHERE id = ?").run(slot, id)
  }
}
