// packages/server/src/services/remote-control.ts
//
// M4 · 远程拉起（2026-11-27）。
//
// 背景：Octopus 的 server 嵌在桌面程序里，程序没跑时没有任何监听者。
// 手机靠系统自带的 sshd 进来执行 `octopus-ctl.ps1 status|start`（强制命令），
// 再由脚本通过「登录时运行」的计划任务把 Octopus.exe --tray 拉起来。
//
// 这里只做 PC 侧的两件事：
//   1. 读 install-remote.ps1 写下的 ~/.octopus/remote/remote.json；
//   2. 配对时从密钥池里取一把「槽位」的私钥交给手机，然后把它从磁盘删掉 ——
//      私钥只该存在手机的安全存储里。公钥早已由安装器写进
//      administrators_authorized_keys，并且加了 restrict + command=。
//
// 手机端不需要知道对面是 Windows 还是 macOS：只认 status / start 两个动词和一份 JSON。

import { execFileSync, spawn } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

declare const __dirname: string
const _dirname: string =
  typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url))

export interface RemoteConfig {
  version: number
  os: string
  ssh_user: string
  ssh_port: number
  tailscale_hosts: string[]
  task_name: string
  ctl_path: string
  slots_dir: string
  authorized_keys_path?: string
  installed_at: string
}

export interface RemoteStatus {
  installed: boolean
  os: string | null
  ssh_user: string | null
  ssh_port: number | null
  task_name: string | null
  installed_at: string | null
  slots_total: number
  slots_available: number
  tailscale_hosts: string[]
  /** 配置在、但槽位目录读不了之类的问题；只用于设置页提示。 */
  error?: string
}

export interface IssuedSshKey {
  slot: string
  user: string
  port: number
  /** OpenSSH 私钥全文（-----BEGIN OPENSSH PRIVATE KEY-----）。只在此响应里出现一次。 */
  private_key: string
  hosts: string[]
}

export type AllocateResult =
  | { ok: true; key: IssuedSshKey }
  | { ok: false; reason: "not_installed" | "no_keys" | "unreadable" }

/** 一键启用（桌面端设置页）：发起一次 UAC 安装，返回「已发起」由前端轮询状态。 */
export interface SetupResult {
  started: boolean
  installed?: boolean
  reason?:
    | "installer_missing"
    | "unsupported_platform"
    | "already_starting"
    | "elevation_unavailable"
    | "spawn_failed"
  installer?: string
  message?: string
}

export interface RemoteControlDeps {
  configPath?: string
  /** 测试注入：真实实现会起一个 UAC 提权的 PowerShell。 */
  launch?: () => SetupResult
  now?: () => number
}

const SETUP_THROTTLE_MS = 3 * 60_000

/**
 * 安装器在哪儿：打包后在 resources/remote（桌面端启动 sidecar 时设 OCTOPUS_REMOTE_DIR），
 * 开发时在仓库根 scripts/remote。
 */
export function findRemoteScriptsDir(): string | null {
  const candidates = [
    process.env.OCTOPUS_REMOTE_DIR,
    path.join(process.cwd(), "remote"),
    path.resolve(_dirname, "../../../scripts/remote"),
    path.resolve(process.cwd(), "../../scripts/remote"),
    path.resolve(process.cwd(), "scripts/remote"),
  ].filter((c): c is string => typeof c === "string" && c.length > 0)

  for (const dir of candidates) {
    try {
      if (
        fs.existsSync(path.join(dir, "install-remote.ps1")) &&
        fs.existsSync(path.join(dir, "octopus-ctl.ps1"))
      ) {
        return dir
      }
    } catch {
      /* 读不到就试下一个 */
    }
  }
  return null
}

/**
 * 当前进程是不是管理员 + 系统有没有开 UAC。
 *
 * 有的机器把 UAC 关掉了（EnableLUA=0）：这时进程本身就是完整管理员令牌，
 * `Start-Process -Verb RunAs` 既不弹窗也会直接失败 —— 必须改成「直接执行」。
 */
function probeWindowsElevation(): { elevated: boolean; uacEnabled: boolean } {
  try {
    const script = [
      "$p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()",
      "$e = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      "$u = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System').EnableLUA",
      "Write-Output ('{0}|{1}' -f $e, $u)",
    ].join("; ")
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: 8000, windowsHide: true },
    )
    const [elevated, uac] = out.trim().split("|")
    return {
      elevated: String(elevated).trim().toLowerCase() === "true",
      uacEnabled: String(uac ?? "1").trim() !== "0",
    }
  } catch {
    // 探测失败按「需要提权」处理：UAC 正常时会弹窗，异常时前端会超时提示。
    return { elevated: false, uacEnabled: true }
  }
}

/** 起一个提权 PowerShell 跑安装器。UAC 弹窗出现在用户桌面上；结果靠前端轮询。 */
export function launchRemoteInstaller(): SetupResult {
  if (process.platform !== "win32") {
    return { started: false, reason: "unsupported_platform", message: "一键启用目前只支持 Windows" }
  }
  const dir = findRemoteScriptsDir()
  if (!dir) {
    return {
      started: false,
      reason: "installer_missing",
      message: "这个版本的桌面端里没带安装器 —— 也可以在电脑上手动运行 scripts/remote/install-remote.ps1",
    }
  }
  const installer = path.join(dir, "install-remote.ps1")
  const elevation = probeWindowsElevation()

  try {
    if (elevation.elevated) {
      // 已经是管理员令牌（包括 UAC 被关掉的机器）：直接跑，不用也弹不出 UAC。
      // 注意不能 detached：Windows 上 detached + stdio ignore 的子进程在部分宿主里
      // 根本不会落地（2026-11-27 本机实测：detached=true 三个变体都不执行）。
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installer],
        { detached: false, stdio: "ignore", windowsHide: true },
      )
      child.on("error", () => { })
      child.unref()
      return { started: true, installer }
    }
    if (!elevation.uacEnabled) {
      return {
        started: false,
        reason: "elevation_unavailable",
        message:
          "这台电脑关掉了 UAC，当前进程又不是管理员 —— 请用管理员身份启动 Octopus，或手动运行安装器",
      }
    }

    // UAC 正常：Start-Process 的 -ArgumentList 用空格拼接，路径里有空格时要自带引号。
    const quoted = `"${installer}"`.replace(/'/g, "''")
    const command =
      `Start-Process -FilePath "powershell.exe" -Verb RunAs ` +
      `-ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${quoted}')`
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { detached: false, stdio: "ignore", windowsHide: true },
    )
    // spawn 的失败是异步事件；不挂监听会让 server 进程直接崩。失败时前端会超时并提示看日志。
    child.on("error", () => { })
    child.unref()
    return { started: true, installer }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { started: false, reason: "spawn_failed", message }
  }
}

const SLOT_FILE = /^slot-\d+$/
const SLOT_PUB = /^slot-\d+\.pub$/

export class RemoteControlService {
  private readonly launch: () => SetupResult
  private readonly now: () => number
  private lastLaunchAt: number | null = null

  constructor(private readonly deps: RemoteControlDeps = {}) {
    this.launch = deps.launch ?? launchRemoteInstaller
    this.now = deps.now ?? (() => Date.now())
  }

  configPath(): string {
    return this.deps.configPath ?? path.join(os.homedir(), ".octopus", "remote", "remote.json")
  }

  readConfig(): RemoteConfig | null {
    try {
      const raw = fs.readFileSync(this.configPath(), "utf8")
      const json = JSON.parse(raw) as Partial<RemoteConfig> | null
      if (!json || typeof json !== "object") return null
      if (typeof json.slots_dir !== "string" || !json.slots_dir) return null
      if (typeof json.ssh_user !== "string" || !json.ssh_user) return null
      return {
        version: Number(json.version ?? 1),
        os: String(json.os ?? "windows"),
        ssh_user: json.ssh_user,
        ssh_port: Number(json.ssh_port ?? 22) || 22,
        tailscale_hosts: Array.isArray(json.tailscale_hosts)
          ? json.tailscale_hosts.filter((h): h is string => typeof h === "string")
          : [],
        task_name: String(json.task_name ?? "Octopus"),
        ctl_path: String(json.ctl_path ?? ""),
        slots_dir: json.slots_dir,
        authorized_keys_path: typeof json.authorized_keys_path === "string" ? json.authorized_keys_path : undefined,
        installed_at: String(json.installed_at ?? ""),
      }
    } catch {
      return null
    }
  }

  status(): RemoteStatus {
    const cfg = this.readConfig()
    if (!cfg) {
      return {
        installed: false,
        os: null,
        ssh_user: null,
        ssh_port: null,
        task_name: null,
        installed_at: null,
        slots_total: 0,
        slots_available: 0,
        tailscale_hosts: [],
      }
    }
    let available = 0
    let total = 0
    let error: string | undefined
    try {
      const entries = fs.readdirSync(cfg.slots_dir)
      available = entries.filter((n) => SLOT_FILE.test(n)).length
      total = entries.filter((n) => SLOT_PUB.test(n)).length
    } catch {
      error = "密钥槽目录读不到 —— 重新运行 install-remote.ps1"
    }
    return {
      installed: true,
      os: cfg.os,
      ssh_user: cfg.ssh_user,
      ssh_port: cfg.ssh_port,
      task_name: cfg.task_name,
      installed_at: cfg.installed_at,
      slots_total: total,
      slots_available: available,
      tailscale_hosts: cfg.tailscale_hosts,
      ...(error ? { error } : {}),
    }
  }

  /**
   * 取一把还没发出去的槽位：读私钥 → 立刻从磁盘删掉 → 返回给调用方。
   * 删除失败就不发 —— 宁可用完槽位，也不让「已经发给手机的私钥」还躺在 PC 上。
   */
  allocate(): AllocateResult {
    const cfg = this.readConfig()
    if (!cfg) return { ok: false, reason: "not_installed" }

    let slots: string[]
    try {
      slots = fs
        .readdirSync(cfg.slots_dir)
        .filter((n) => SLOT_FILE.test(n))
        .sort()
    } catch {
      return { ok: false, reason: "unreadable" }
    }
    if (slots.length === 0) return { ok: false, reason: "no_keys" }

    const slot = slots[0]
    const keyPath = path.join(cfg.slots_dir, slot)
    let privateKey: string
    try {
      privateKey = fs.readFileSync(keyPath, "utf8")
    } catch {
      return { ok: false, reason: "unreadable" }
    }
    if (!privateKey.includes("BEGIN OPENSSH PRIVATE KEY")) {
      return { ok: false, reason: "unreadable" }
    }
    try {
      fs.unlinkSync(keyPath)
    } catch {
      return { ok: false, reason: "unreadable" }
    }

    return {
      ok: true,
      key: {
        slot,
        user: cfg.ssh_user,
        port: cfg.ssh_port,
        private_key: privateKey,
        hosts: cfg.tailscale_hosts,
      },
    }
  }

  /**
   * 一键启用：没装才发起；3 分钟内不重复弹 UAC。
   * 真正的安装是异步的（用户还要点 UAC），前端靠轮询 status() 看结果。
   */
  setup(): SetupResult {
    if (this.status().installed) return { started: false, installed: true }
    const now = this.now()
    if (this.lastLaunchAt !== null && now - this.lastLaunchAt < SETUP_THROTTLE_MS) {
      return {
        started: false,
        reason: "already_starting",
        message: "已经发起过一次了 —— 在 UAC 弹窗里点「是」；如果取消了，稍后再试或看安装日志",
      }
    }
    const result = this.launch()
    if (result.started) this.lastLaunchAt = now
    return result
  }
}

let instance: RemoteControlService | undefined

export function getRemoteControlService(): RemoteControlService {
  return (instance ??= new RemoteControlService())
}
