// M3 · 设备令牌闸 + 配对闭环（2026-11-27）
//
// 三条验收（design 35 §5 M3）在这里落成断言：
//   ① 非回环无令牌请求 /api/cabins → 401；
//   ② 桌面（回环）功能不变 —— 不带任何令牌照常 200；
//   ③ 吊销后该设备立刻 401。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Hono } from 'hono'
import { initDb, closeDb } from '../db/connection'
import { applySchema } from '../db/schema'
import { DeviceDAO } from '../db/dao'
import {
  DeviceAuthService,
  PairingError,
  PAIR_MAX_ATTEMPTS,
  hashToken,
} from '../services/device-auth'
import {
  PEER_HEADER,
  createDeviceAuthMiddleware,
  isAllowedUpgrade,
  isLocalRequest,
  peerFromConnection,
} from '../middleware/device-auth'
import { createDeviceRoutes } from '../routes/devices'

const TEST_DB = path.join(os.tmpdir(), `device-auth-test-${Date.now()}.db`)

let db: ReturnType<typeof initDb>
let auth: DeviceAuthService
let app: Hono
let clockOffset = 0

function now(): number {
  return Date.now() + clockOffset
}

function makeApp(): Hono {
  const instance = new Hono()
  instance.use('*', createDeviceAuthMiddleware((token) => auth.authenticate(token)))
  instance.get('/api/cabins', (c) => c.json({ cabins: [] }))
  instance.route('/api', createDeviceRoutes(() => auth))
  return instance
}

function local(): Record<string, string> {
  return { [PEER_HEADER]: 'local' }
}

function remote(): Record<string, string> {
  return { [PEER_HEADER]: 'remote' }
}

beforeAll(() => {
  db = initDb(TEST_DB)
  applySchema(db)
  auth = new DeviceAuthService({ dao: () => new DeviceDAO(db), now })
  app = makeApp()
})

afterAll(() => {
  closeDb()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('peerFromConnection — 谁算本机', () => {
  it('回环直连、没有转发头 → local', () => {
    expect(peerFromConnection('127.0.0.1', { host: 'localhost:3001' })).toBe('local')
    expect(peerFromConnection('::1', { host: 'localhost:3001' })).toBe('local')
    expect(peerFromConnection('::ffff:127.0.0.1', { host: '127.0.0.1:47820' })).toBe('local')
  })

  it('回环但经反向代理（XFF / 转发头）→ remote', () => {
    expect(peerFromConnection('127.0.0.1', { host: 'localhost', 'x-forwarded-for': '100.64.0.9' })).toBe('remote')
    expect(peerFromConnection('127.0.0.1', { host: 'localhost', 'x-forwarded-proto': 'https' })).toBe('remote')
    expect(peerFromConnection('127.0.0.1', { host: 'localhost', forwarded: 'for=100.64.0.9' })).toBe('remote')
  })

  it('回环但 Host 是 *.ts.net → remote（tailscale serve 的信号）', () => {
    expect(peerFromConnection('127.0.0.1', { host: 'shufang-pc.tail1234.ts.net' })).toBe('remote')
    expect(peerFromConnection('127.0.0.1', { host: 'shufang-pc.tail1234.ts.net:443' })).toBe('remote')
  })

  it('非回环地址 → remote（哪怕伪造了转发头）', () => {
    expect(peerFromConnection('192.168.1.20', { host: 'localhost' })).toBe('remote')
    expect(peerFromConnection('100.64.0.9', { host: 'localhost' })).toBe('remote')
    expect(peerFromConnection(undefined, { host: 'localhost' })).toBe('remote')
  })
})

describe('device-auth 中间件', () => {
  it('没有 peer 头（进程内直调 / 单测）按本机处理', async () => {
    const res = await app.request('/api/cabins')
    expect(res.status).toBe(200)
    expect(isLocalRequest(new Headers())).toBe(true)
  })

  it('远程无令牌 → 401 + WWW-Authenticate', async () => {
    const res = await app.request('/api/cabins', { headers: remote() })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
    const body = await res.json() as { error: string; message: string }
    expect(body.error).toBe('unauthorized')
    expect(body.message).toContain('手机配对')
  })

  it('令牌不对 → 401；本地回环即使带坏令牌也放行', async () => {
    const bad = await app.request('/api/cabins', {
      headers: { ...remote(), Authorization: 'Bearer deadbeefdeadbeefdeadbeef' },
    })
    expect(bad.status).toBe(401)

    const localBad = await app.request('/api/cabins', {
      headers: { ...local(), Authorization: 'Bearer deadbeefdeadbeefdeadbeef' },
    })
    expect(localBad.status).toBe(200)
  })

  it('探活与兑换码在闸外：远程无令牌也能到路由', async () => {
    const health = await app.request('/api/actuator/health', { headers: remote() })
    // 本测试 app 没挂 actuator 路由 → 404 说明中间件放行了（若被闸住会是 401）
    expect(health.status).toBe(404)

    const redeem = await app.request('/api/pair/redeem', {
      method: 'POST',
      headers: { ...remote(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    })
    expect(redeem.status).toBe(400)
  })
})

describe('配对码 → 令牌', () => {
  async function mintToken(name = '测试手机'): Promise<{ token: string; deviceId: string }> {
    const codeRes = await app.request('/api/pair/code', { method: 'POST', headers: local() })
    expect(codeRes.status).toBe(200)
    const { code } = await codeRes.json() as { code: string; expires_at: string }
    expect(code).toMatch(/^\d{6}$/)

    const redeemRes = await app.request('/api/pair/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, platform: 'android' }),
    })
    expect(redeemRes.status).toBe(200)
    const out = await redeemRes.json() as { token: string; device: { id: string } }
    return { token: out.token, deviceId: out.device.id }
  }

  it('回环生成码；远程不能生成', async () => {
    const denied = await app.request('/api/pair/code', { method: 'POST', headers: remote() })
    expect(denied.status).toBe(403)
  })

  it('兑换成功：令牌 64 hex，库里只有 sha256 与前缀', async () => {
    const { token, deviceId } = await mintToken('书房手机')
    expect(token).toMatch(/^[0-9a-f]{64}$/)

    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as {
      token_hash: string; token_prefix: string; name: string; platform: string | null; revoked_at: string | null
    }
    expect(row.token_hash).toBe(hashToken(token))
    expect(row.token_hash).not.toBe(token)
    expect(row.token_prefix).toBe(token.slice(0, 8))
    expect(row.name).toBe('书房手机')
    expect(row.platform).toBe('android')
    expect(row.revoked_at).toBeNull()

    const ok = await app.request('/api/cabins', {
      headers: { ...remote(), Authorization: `Bearer ${token}` },
    })
    expect(ok.status).toBe(200)
  })

  it('码只能用一次；码错 5 次作废', async () => {
    const codeRes = await app.request('/api/pair/code', { method: 'POST', headers: local() })
    const { code } = await codeRes.json() as { code: string }

    const first = await app.request('/api/pair/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(first.status).toBe(200)

    const second = await app.request('/api/pair/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(second.status).toBe(400)

    const codeRes2 = await app.request('/api/pair/code', { method: 'POST', headers: local() })
    const { code: code2 } = await codeRes2.json() as { code: string }
    const wrong = code2 === '000000' ? '000001' : '000000'
    let lastStatus = 0
    for (let i = 0; i < PAIR_MAX_ATTEMPTS; i++) {
      const res = await app.request('/api/pair/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: wrong }),
      })
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)

    // 作废之后，即使拿正确的码也换不到（码已清空）。
    const after = await app.request('/api/pair/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code2 }),
    })
    expect(after.status).toBe(400)
  })

  it('配对码 2 分钟过期', async () => {
    const codeRes = await app.request('/api/pair/code', { method: 'POST', headers: local() })
    const { code } = await codeRes.json() as { code: string }
    clockOffset += 2 * 60_000 + 1000
    try {
      const res = await app.request('/api/pair/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { message: string }
      expect(body.message).toContain('过期')
    } finally {
      clockOffset = 0
    }
  })

  it('PairingError 状态码映射', () => {
    expect(new PairingError('x', 429).status).toBe(429)
  })
})

describe('设备管理（仅回环）', () => {
  it('列表不含 token_hash；改名生效；吊销后立刻 401', async () => {
    const codeRes = await app.request('/api/pair/code', { method: 'POST', headers: local() })
    const { code } = await codeRes.json() as { code: string }
    const redeemRes = await app.request('/api/pair/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: '旧名字' }),
    })
    const { token, device } = await redeemRes.json() as { token: string; device: { id: string } }

    const listRes = await app.request('/api/devices', { headers: local() })
    expect(listRes.status).toBe(200)
    const list = await listRes.json() as { devices: Array<Record<string, unknown>> }
    const mine = list.devices.find((d) => d.id === device.id)!
    expect(mine).toBeTruthy()
    expect('token_hash' in mine).toBe(false)
    expect(String(mine.token_prefix)).toHaveLength(8)

    const renameRes = await app.request(`/api/devices/${device.id}`, {
      method: 'PATCH',
      headers: { ...local(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新名字' }),
    })
    expect(renameRes.status).toBe(200)
    const renamed = await renameRes.json() as { device: { name: string } }
    expect(renamed.device.name).toBe('新名字')

    const before = await app.request('/api/cabins', {
      headers: { ...remote(), Authorization: `Bearer ${token}` },
    })
    expect(before.status).toBe(200)

    const delRes = await app.request(`/api/devices/${device.id}`, { method: 'DELETE', headers: local() })
    expect(delRes.status).toBe(204)

    const after = await app.request('/api/cabins', {
      headers: { ...remote(), Authorization: `Bearer ${token}` },
    })
    expect(after.status).toBe(401)

    // 行还在（吊销是账本），只是带 revoked_at。
    const row = db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(device.id) as { revoked_at: string | null }
    expect(row.revoked_at).toBeTruthy()
  })

  it('远程不能列设备 / 改名 / 吊销（哪怕持有有效令牌）', async () => {
    const codeRes = await app.request('/api/pair/code', { method: 'POST', headers: local() })
    const { code } = await codeRes.json() as { code: string }
    const redeemRes = await app.request('/api/pair/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: '远程手机' }),
    })
    const { token, device } = await redeemRes.json() as { token: string; device: { id: string } }
    const headers = { ...remote(), Authorization: `Bearer ${token}` }

    expect((await app.request('/api/devices', { headers })).status).toBe(403)
    expect((await app.request(`/api/devices/${device.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hack' }),
    })).status).toBe(403)
    expect((await app.request(`/api/devices/${device.id}`, { method: 'DELETE', headers })).status).toBe(403)
  })
})

describe('WebSocket 升级守卫（工作区文档同样可写）', () => {
  const lookup = (token: string) => auth.authenticate(token)

  async function mintToken(): Promise<{ token: string; deviceId: string }> {
    const codeRes = await app.request('/api/pair/code', { method: 'POST', headers: local() })
    const { code } = await codeRes.json() as { code: string }
    const redeemRes = await app.request('/api/pair/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    const out = await redeemRes.json() as { token: string; device: { id: string } }
    return { token: out.token, deviceId: out.device.id }
  }

  it('本机回环直接放行；远程没令牌拒绝', () => {
    expect(isAllowedUpgrade('127.0.0.1', { host: 'localhost' }, '/workspace:ws1', lookup)).toBe(true)
    expect(isAllowedUpgrade('127.0.0.1', { host: 'localhost', 'x-forwarded-for': '100.64.0.9' }, '/workspace:ws1', lookup)).toBe(false)
    expect(isAllowedUpgrade('192.168.1.20', { host: 'localhost' }, '/workspace:ws1', lookup)).toBe(false)
  })

  it('远程带 ?token= 或 Authorization 头且令牌有效才放行', async () => {
    const { token, deviceId } = await mintToken()
    const remoteHeaders = { host: 'shufang-pc.tail1234.ts.net' }

    expect(isAllowedUpgrade('127.0.0.1', remoteHeaders, `/workspace:ws1?token=${token}`, lookup)).toBe(true)
    expect(isAllowedUpgrade('127.0.0.1', { ...remoteHeaders, authorization: `Bearer ${token}` }, '/workspace:ws1', lookup)).toBe(true)
    expect(isAllowedUpgrade('127.0.0.1', remoteHeaders, '/workspace:ws1', lookup)).toBe(false)
    expect(isAllowedUpgrade('127.0.0.1', remoteHeaders, '/workspace:ws1?token=deadbeefdeadbeef', lookup)).toBe(false)

    auth.revoke(deviceId)
    expect(isAllowedUpgrade('127.0.0.1', remoteHeaders, `/workspace:ws1?token=${token}`, lookup)).toBe(false)
  })
})
