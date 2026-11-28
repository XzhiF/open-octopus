// M4 · 远程拉起（2026-11-27）
//
// 这里只测 PC 侧的编排：remote.json 的读法、密钥槽的发放（发完即删）、
// 以及 redeem 在 wants_remote 时的返回形状。真正的 SSH / 计划任务在
// scripts/remote/*.ps1 里，由安装器自测覆盖。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Hono } from 'hono'
import { initDb, closeDb } from '../db/connection'
import { applySchema } from '../db/schema'
import { DeviceDAO } from '../db/dao'
import { DeviceAuthService } from '../services/device-auth'
import { findRemoteScriptsDir, RemoteControlService } from '../services/remote-control'
import { createDeviceRoutes } from '../routes/devices'
import { PEER_HEADER } from '../middleware/device-auth'

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS1rZXktZm9yLXRlc3Q=\n-----END OPENSSH PRIVATE KEY-----\n'

let dir: string
let slotsDir: string
let configPath: string
let remote: RemoteControlService

function writeConfig(overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      os: 'windows',
      ssh_user: 'EDY',
      ssh_port: 22,
      tailscale_hosts: ['shufang-pc.tail1234.ts.net'],
      task_name: 'Octopus',
      ctl_path: 'C:\\ProgramData\\octopus\\octopus-ctl.ps1',
      slots_dir: slotsDir,
      authorized_keys_path: 'C:\\ProgramData\\ssh\\administrators_authorized_keys',
      installed_at: '2026-11-27T00:00:00.000Z',
      ...overrides,
    }),
    'utf8',
  )
}

function addSlot(n: number, body = PRIVATE_KEY): void {
  const name = `slot-${String(n).padStart(2, '0')}`
  fs.writeFileSync(path.join(slotsDir, name), body, 'utf8')
  fs.writeFileSync(path.join(slotsDir, `${name}.pub`), `ssh-ed25519 AAAABLOB${n} octopus-remote:${name}`, 'utf8')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-remote-test-'))
  slotsDir = path.join(dir, 'slots')
  configPath = path.join(dir, 'remote.json')
  fs.mkdirSync(slotsDir)
  remote = new RemoteControlService({ configPath })
})

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* windows 偶发占用 */ }
})

describe('RemoteControlService', () => {
  it('没装：installed=false，allocate 返回 not_installed', () => {
    const status = remote.status()
    expect(status.installed).toBe(false)
    expect(status.slots_available).toBe(0)
    expect(remote.allocate()).toEqual({ ok: false, reason: 'not_installed' })
  })

  it('槽位计数：pub 是总量，私钥是余量', () => {
    writeConfig()
    addSlot(1)
    addSlot(2)
    const status = remote.status()
    expect(status.installed).toBe(true)
    expect(status.ssh_user).toBe('EDY')
    expect(status.slots_total).toBe(2)
    expect(status.slots_available).toBe(2)
  })

  it('发放一次 → 私钥返回并从磁盘删除；发完 → no_keys', () => {
    writeConfig()
    addSlot(1)
    addSlot(2)

    const first = remote.allocate()
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.key.slot).toBe('slot-01')
    expect(first.key.user).toBe('EDY')
    expect(first.key.port).toBe(22)
    expect(first.key.private_key).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(first.key.hosts).toEqual(['shufang-pc.tail1234.ts.net'])
    expect(fs.existsSync(path.join(slotsDir, 'slot-01'))).toBe(false)
    expect(fs.existsSync(path.join(slotsDir, 'slot-01.pub'))).toBe(true)

    expect(remote.status().slots_available).toBe(1)

    const second = remote.allocate()
    expect(second.ok && second.key.slot).toBe('slot-02')

    expect(remote.allocate()).toEqual({ ok: false, reason: 'no_keys' })
  })

  it('私钥内容不像 OpenSSH → 拒绝发放，且不删文件', () => {
    writeConfig()
    addSlot(1, 'not a key')
    expect(remote.allocate()).toEqual({ ok: false, reason: 'unreadable' })
    expect(fs.existsSync(path.join(slotsDir, 'slot-01'))).toBe(true)
  })

  it('槽位目录读不到 → status 带 error，allocate 返回 unreadable', () => {
    writeConfig({ slots_dir: path.join(dir, 'missing') })
    const status = remote.status()
    expect(status.installed).toBe(true)
    expect(status.error).toContain('密钥槽')
    expect(remote.allocate()).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('一键启用：没装才发起；3 分钟内不重复弹 UAC；装了就只报 installed', () => {
    let launches = 0
    const svc = new RemoteControlService({
      configPath,
      launch: () => {
        launches++
        return { started: true, installer: 'C:\\x\\install-remote.ps1' }
      },
    })

    expect(svc.setup()).toEqual({ started: true, installer: 'C:\\x\\install-remote.ps1' })
    expect(svc.setup()).toMatchObject({ started: false, reason: 'already_starting' })
    expect(launches).toBe(1)

    writeConfig()
    expect(svc.setup()).toEqual({ started: false, installed: true })
    expect(launches).toBe(1)
  })

  it('安装器没带：setup 返回 installer_missing', () => {
    const svc = new RemoteControlService({
      configPath,
      launch: () => ({ started: false, reason: 'installer_missing', message: '没带安装器' }),
    })
    expect(svc.setup()).toMatchObject({ started: false, reason: 'installer_missing' })
  })

  it('OCTOPUS_REMOTE_DIR 指到哪就找哪（按平台找对应的安装器）', () => {
    const scriptsDir = path.join(dir, 'scripts')
    fs.mkdirSync(scriptsDir)
    for (const file of ['install-remote.ps1', 'octopus-ctl.ps1', 'install-remote.sh', 'octopus-ctl.sh']) {
      fs.writeFileSync(path.join(scriptsDir, file), '')
    }
    const prev = process.env.OCTOPUS_REMOTE_DIR
    process.env.OCTOPUS_REMOTE_DIR = scriptsDir
    try {
      expect(findRemoteScriptsDir('win32')).toBe(scriptsDir)
      expect(findRemoteScriptsDir('darwin')).toBe(scriptsDir)
    } finally {
      if (prev === undefined) delete process.env.OCTOPUS_REMOTE_DIR
      else process.env.OCTOPUS_REMOTE_DIR = prev
    }
  })

  it('只有 PowerShell 脚本时，macOS 会继续向下找 .sh 而不是误用 .ps1', () => {
    const scriptsDir = path.join(dir, 'scripts-win-only')
    fs.mkdirSync(scriptsDir)
    fs.writeFileSync(path.join(scriptsDir, 'install-remote.ps1'), '')
    fs.writeFileSync(path.join(scriptsDir, 'octopus-ctl.ps1'), '')
    const prev = process.env.OCTOPUS_REMOTE_DIR
    process.env.OCTOPUS_REMOTE_DIR = scriptsDir
    try {
      expect(findRemoteScriptsDir('win32')).toBe(scriptsDir)
      const macDir = findRemoteScriptsDir('darwin')
      expect(macDir).not.toBe(scriptsDir)
      if (macDir) expect(fs.existsSync(path.join(macDir, 'install-remote.sh'))).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.OCTOPUS_REMOTE_DIR
      else process.env.OCTOPUS_REMOTE_DIR = prev
    }
  })

  it('status 带宿主平台，未安装时也能让设置页选对文案', () => {
    const status = remote.status()
    expect(['win32', 'darwin', 'linux']).toContain(status.platform)
    expect(status.installed).toBe(false)
  })
})

describe('redeem × 远程拉起', () => {
  const TEST_DB = path.join(os.tmpdir(), `remote-redeem-${Date.now()}.db`)
  let db: ReturnType<typeof initDb>
  let auth: DeviceAuthService
  let app: Hono

  function local(): Record<string, string> {
    return { [PEER_HEADER]: 'local' }
  }
  function remoteHeaders(): Record<string, string> {
    return { [PEER_HEADER]: 'remote' }
  }

  async function mintCode(): Promise<string> {
    const res = await app.request('/api/pair/code', { method: 'POST', headers: local() })
    expect(res.status).toBe(200)
    return ((await res.json()) as { code: string }).code
  }

  async function redeem(payload: Record<string, unknown>): Promise<Response> {
    return app.request('/api/pair/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  beforeEach(() => {
    db = initDb(TEST_DB)
    applySchema(db)
    auth = new DeviceAuthService({ dao: () => new DeviceDAO(db) })
    remote = new RemoteControlService({
      configPath,
      launch: () => ({ started: true, installer: 'C:\\x\\install-remote.ps1' }),
    })
    app = new Hono()
    app.route('/api', createDeviceRoutes(() => auth, () => remote))
  })

  afterEach(() => {
    closeDb()
    try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB) } catch { }
  })

  it('wants_remote：返回私钥 + 记录槽位；槽位私钥从磁盘消失', async () => {
    writeConfig()
    addSlot(1)
    const code = await mintCode()
    const res = await redeem({ code, name: '书房手机', wants_remote: true })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      device: { id: string; ssh_key_slot: string | null }
      ssh: { slot: string; user: string; port: number; private_key: string }
    }
    expect(body.token).toMatch(/^[0-9a-f]{64}$/)
    expect(body.ssh.slot).toBe('slot-01')
    expect(body.ssh.private_key).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(body.device.ssh_key_slot).toBe('slot-01')
    expect(fs.existsSync(path.join(slotsDir, 'slot-01'))).toBe(false)

    const list = await app.request('/api/devices', { headers: local() })
    const devices = ((await list.json()) as { devices: Array<{ id: string; ssh_key_slot: string | null }> }).devices
    expect(devices.find((d) => d.id === body.device.id)?.ssh_key_slot).toBe('slot-01')
  })

  it('不带 wants_remote：不分配槽位', async () => {
    writeConfig()
    addSlot(1)
    const code = await mintCode()
    const res = await redeem({ code })
    const body = (await res.json()) as { device: { ssh_key_slot: string | null }; ssh?: unknown }
    expect(body.ssh).toBeUndefined()
    expect(body.device.ssh_key_slot).toBeNull()
    expect(fs.existsSync(path.join(slotsDir, 'slot-01'))).toBe(true)
  })

  it('没装 / 没槽位：配对照常成功，只是带 ssh_unavailable', async () => {
    const code = await mintCode()
    const notInstalled = (await (await redeem({ code, wants_remote: true })).json()) as { ssh_unavailable?: string; token?: string }
    expect(notInstalled.token).toMatch(/^[0-9a-f]{64}$/)
    expect(notInstalled.ssh_unavailable).toBe('not_installed')

    writeConfig()
    const code2 = await mintCode()
    const noKeys = (await (await redeem({ code: code2, wants_remote: true })).json()) as { ssh_unavailable?: string }
    expect(noKeys.ssh_unavailable).toBe('no_keys')
  })

  it('远程拉起状态只许回环', async () => {
    writeConfig()
    expect((await app.request('/api/remote/status', { headers: local() })).status).toBe(200)
    expect((await app.request('/api/remote/status', { headers: remoteHeaders() })).status).toBe(403)
  })

  it('一键启用：本机 202 发起；远程 403；已在跑时返回 installed', async () => {
    const first = await app.request('/api/remote/setup', { method: 'POST', headers: local() })
    expect(first.status).toBe(202)
    const body = (await first.json()) as { started: boolean; installer?: string }
    expect(body.started).toBe(true)
    expect(body.installer).toContain('install-remote.ps1')

    const again = await app.request('/api/remote/setup', { method: 'POST', headers: local() })
    expect(again.status).toBe(409)

    const denied = await app.request('/api/remote/setup', { method: 'POST', headers: remoteHeaders() })
    expect(denied.status).toBe(403)

    writeConfig()
    const done = await app.request('/api/remote/setup', { method: 'POST', headers: local() })
    expect(done.status).toBe(200)
    expect(await done.json()).toMatchObject({ started: false, installed: true })
  })
})
