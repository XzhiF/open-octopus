// packages/server/src/services/device-auth.ts
//
// M3 · 最简鉴权（2026-11-27）：一台手机一条长期令牌。
//
// 形态（design 35 §3）：
//   · PC 回环设置页生成一次性 6 位配对码（TTL 2 分钟，只留内存）→ 手机提交码
//     兑换 32 字节令牌；DB 只存 sha256，明文只在兑换响应里出现一次。
//   · 鉴权热路径 = Authorization: Bearer <token> → sha256 → devices 未吊销行。
//   · 不做 scope / 多用户：能配对的设备就是「自己人」，与桌面回环同一信任级。
//
// last_seen 写库做节流（默认 60s/设备）：SSE 与轮询请求很密，不必每次都落盘。

import crypto from "crypto"
import { DeviceDAO } from "../db/dao/device-dao"
import { getDb } from "../db/connection"
import type { DeviceRow } from "../db/types"

export const PAIR_CODE_TTL_MS = 2 * 60_000
export const PAIR_MAX_ATTEMPTS = 5
export const TOKEN_BYTES = 32

const LAST_SEEN_THROTTLE_MS = 60_000

/** 设置页展示面 —— 永不含 token_hash / 明文令牌。 */
export interface DeviceView {
  id: string
  name: string
  platform: string | null
  token_prefix: string
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
  /** M4：这台手机拿走的 SSH 密钥槽；null = 没配远程拉起。 */
  ssh_key_slot: string | null
}

export function deviceView(row: DeviceRow): DeviceView {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    token_prefix: row.token_prefix,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at,
    ssh_key_slot: row.ssh_key_slot ?? null,
  }
}

export type PairErrorStatus = 400 | 404 | 429

export class PairingError extends Error {
  constructor(message: string, readonly status: PairErrorStatus = 400) {
    super(message)
    this.name = "PairingError"
  }
}

export interface DeviceAuthDeps {
  dao: () => DeviceDAO
  /** 测试可注入时钟 / 随机源。 */
  now?: () => number
  id?: () => string
  token?: () => string
  code?: () => string
}

interface ActivePairCode {
  code: string
  expiresAt: number
  attempts: number
}

export class DeviceAuthService {
  private pair: ActivePairCode | null = null
  private readonly lastSeenAt = new Map<string, number>()
  private readonly deps: Required<DeviceAuthDeps>

  constructor(deps: DeviceAuthDeps) {
    this.deps = {
      dao: deps.dao,
      now: deps.now ?? (() => Date.now()),
      id: deps.id ?? (() => crypto.randomUUID()),
      token: deps.token ?? (() => crypto.randomBytes(TOKEN_BYTES).toString("hex")),
      code: deps.code ?? (() => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0")),
    }
  }

  /**
   * 生成一次性配对码。只在 PC 回环上调用（路由层把关）。
   * 同一时间只留一个有效码：重新生成 = 旧码立即作废。
   */
  createPairCode(): { code: string; expires_at: string } {
    const now = this.deps.now()
    let code = this.deps.code()
    for (let i = 0; i < 5 && this.pair && this.pair.code === code; i++) code = this.deps.code()
    const expiresAt = now + PAIR_CODE_TTL_MS
    this.pair = { code, expiresAt, attempts: 0 }
    return { code, expires_at: new Date(expiresAt).toISOString() }
  }

  /** 当前有效码（只读诊断用；不含 attempt 计数）。 */
  peekPairCode(): { code: string; expires_at: string } | null {
    const pair = this.pair
    if (!pair) return null
    if (this.deps.now() >= pair.expiresAt) {
      this.pair = null
      return null
    }
    return { code: pair.code, expires_at: new Date(pair.expiresAt).toISOString() }
  }

  /**
   * 手机端兑换：码 → 长期令牌（明文只此一次）。
   * 码错 5 次直接作废；过期码同样作废。所有失败都不会泄漏「是否有设备配对过」。
   */
  redeem(rawCode: string, meta: { name?: string | null; platform?: string | null } = {}): {
    token: string
    device: DeviceView
  } {
    const code = typeof rawCode === "string" ? rawCode.trim() : ""
    const pair = this.pair
    if (!pair || this.deps.now() >= pair.expiresAt) {
      this.pair = null
      throw new PairingError("配对码已过期 —— 在电脑「设置 → 手机配对」重新生成", 400)
    }
    if (!code || code !== pair.code) {
      pair.attempts += 1
      if (pair.attempts >= PAIR_MAX_ATTEMPTS) {
        this.pair = null
        throw new PairingError("配对码错误次数过多 —— 在电脑上重新生成一个", 429)
      }
      throw new PairingError("配对码不对", 400)
    }

    this.pair = null
    const token = this.deps.token()
    const nowIso = new Date(this.deps.now()).toISOString()
    const row: DeviceRow = {
      id: this.deps.id(),
      name: cleanName(meta.name),
      token_hash: hashToken(token),
      token_prefix: token.slice(0, 8),
      platform: cleanPlatform(meta.platform),
      created_at: nowIso,
      last_seen_at: nowIso,
      revoked_at: null,
      ssh_key_slot: null,
    }
    this.deps.dao().insert(row)
    return { token, device: deviceView(row) }
  }

  /** 鉴权热路径。返回设备行；令牌无效 / 已吊销 → null。 */
  authenticate(token: string | null | undefined): DeviceRow | null {
    if (!token || token.length < 16) return null
    const row = this.deps.dao().findActiveByTokenHash(hashToken(token))
    if (!row) return null
    const now = this.deps.now()
    const last = this.lastSeenAt.get(row.id) ?? 0
    if (now - last >= LAST_SEEN_THROTTLE_MS) {
      this.lastSeenAt.set(row.id, now)
      try {
        this.deps.dao().touchLastSeen(row.id, new Date(now).toISOString())
      } catch {
        /* last_seen 只是显示，写失败不影响鉴权 */
      }
    }
    return row
  }

  list(): DeviceView[] {
    return this.deps.dao().list().map(deviceView)
  }

  rename(id: string, name: string): DeviceView | null {
    const clean = typeof name === "string" ? name.trim().slice(0, 64) : ""
    if (!clean) return null
    const dao = this.deps.dao()
    dao.rename(id, clean)
    const row = dao.getById(id)
    return row ? deviceView(row) : null
  }

  /** 吊销：行保留，下一次鉴权立刻 401。 */
  revoke(id: string): boolean {
    const dao = this.deps.dao()
    const row = dao.getById(id)
    if (!row) return false
    dao.revoke(id, new Date(this.deps.now()).toISOString())
    return true
  }

  /** M4：配对时记录这台手机拿走的 SSH 密钥槽（只读展示与对账用）。 */
  attachKeySlot(id: string, slot: string): DeviceView | null {
    const dao = this.deps.dao()
    dao.setSshKeySlot(id, slot)
    const row = dao.getById(id)
    return row ? deviceView(row) : null
  }
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex")
}

function cleanName(raw: string | null | undefined): string {
  const v = typeof raw === "string" ? raw.trim() : ""
  return (v || "手机").slice(0, 64)
}

function cleanPlatform(raw: string | null | undefined): string | null {
  const v = typeof raw === "string" ? raw.trim() : ""
  if (!v) return null
  return v.slice(0, 32)
}

// ── 惰性单例（与 getFindingOps 同轨：import 级不碰 DB）────────────────────

let instance: DeviceAuthService | undefined

export function getDeviceAuthService(): DeviceAuthService {
  return (instance ??= new DeviceAuthService({ dao: () => new DeviceDAO(getDb()) }))
}
