"use client"

// 设置 → 手机配对（M3 · 2026-11-27）。
//
// 一台手机一条长期令牌：这里生成一次性 6 位码，手机端兑换后长期使用；
// 令牌明文只在手机那一侧保存（flutter_secure_storage），服务端只留 sha256。
//
// 三个动作都要求「本机直连」：从 ts.net 域名打开 Web 会 403 —— 这是有意的，
// 手机令牌不能自己再签发令牌；被偷的手机也改不了 / 吊销不了别的设备。

import { Check, Copy, KeyRound, Pencil, RefreshCw, Smartphone, Terminal, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  PairingApiError,
  createPairCode,
  enableRemoteControl,
  getRemoteControlStatus,
  listPairedDevices,
  renamePairedDevice,
  revokePairedDevice,
  type PairCode,
  type PairedDevice,
  type RemoteControlStatus,
} from "@/lib/device-pairing-api"

function groupCode(code: string): string {
  if (code.length !== 6) return code
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

function secondsUntil(iso: string): number {
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return 0
  return Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—"
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return "—"
  const diff = Date.now() - at.getTime()
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return at.toLocaleDateString("zh-CN")
}

/** 服务端状态里带 platform；读不到时退回桌面壳 / 浏览器 UA（开发态直接开 Vite 也能选对文案）。 */
function localPlatform(): "win32" | "darwin" | "linux" | null {
  const injected = (
    window as unknown as { octopusDesktop?: { platform?: string } }
  ).octopusDesktop?.platform
  if (injected === "win32" || injected === "darwin" || injected === "linux") return injected
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent
  if (/Mac/i.test(ua)) return "darwin"
  if (/Win/i.test(ua)) return "win32"
  if (/Linux/i.test(ua)) return "linux"
  return null
}

export function DevicePairingPanel() {
  const [devices, setDevices] = useState<PairedDevice[] | null>(null)
  const [remote, setRemote] = useState<RemoteControlStatus | null | undefined>(undefined)
  // 设置页同时服务 Windows / macOS 桌面端：文案跟着宿主平台走（服务端 status 里带 platform）。
  const platform = remote?.platform ?? localPlatform()
  const isMac = platform === "darwin"
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupNote, setSetupNote] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState<PairCode | null>(null)
  const [left, setLeft] = useState(0)
  const [copied, setCopied] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")

  const load = useCallback(async () => {
    try {
      setDevices(await listPairedDevices())
      setError(null)
    } catch (err) {
      setDevices([])
      setError(err instanceof Error ? err.message : String(err))
    }
    try {
      setRemote(await getRemoteControlStatus())
    } catch {
      // 远程拉起是可选能力：读不到就当没装，不打断配对主流程。
      setRemote(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const stopPoll = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => stopPoll, [stopPoll])

  /** 安装是异步的（用户还要点 UAC）：先立刻问一次，没装好就 2 秒一轮，最多 2 分钟。 */
  const pollRemote = useCallback(
    async (deadline: number) => {
      try {
        const next = await getRemoteControlStatus()
        setRemote(next)
        if (next.installed) {
          setSetupNote("已启用")
          stopPoll()
          return
        }
      } catch {
        /* 装到一半读不到，继续等 */
      }
      if (Date.now() > deadline) {
        setSetupNote(
          isMac
            ? "没等到安装完成 —— 看看管理员授权是不是被取消了；日志在 ~/Library/Logs/Octopus/remote-install.log"
            : "没等到安装完成 —— 看看 UAC 是不是被取消了；日志在 %TEMP%\\octopus-remote-install.log",
        )
        stopPoll()
        return
      }
      pollRef.current = window.setTimeout(() => {
        void pollRemote(deadline)
      }, 2000)
    },
    [isMac, stopPoll],
  )

  const enable = useCallback(async () => {
    setSetupBusy(true)
    setSetupNote(null)
    try {
      const result = await enableRemoteControl()
      if (result.installed) {
        setSetupNote("已启用")
        await load()
        return
      }
      if (!result.started) {
        setSetupNote(result.message ?? "没能发起安装")
        if (result.reason === "already_starting") await pollRemote(Date.now() + 120_000)
        return
      }
      setSetupNote(
        isMac
          ? "已发起 —— 管理员授权弹窗里点「好」并输入密码；首次会顺带打开「远程登录」"
          : "已发起 —— 弹出 UAC 就点「是」；这台机器关了 UAC 的话会直接安装",
      )
      await pollRemote(Date.now() + 120_000)
    } catch (err) {
      if (err instanceof PairingApiError && err.status === 403) {
        setSetupNote("只能在这台电脑上启用 —— 请在电脑上用 localhost 打开设置")
      } else {
        setSetupNote(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSetupBusy(false)
    }
  }, [isMac, load, pollRemote])

  useEffect(() => {
    if (!code) return
    const tick = () => {
      const next = secondsUntil(code.expires_at)
      setLeft(next)
      if (next <= 0) setCode(null)
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [code])

  const generate = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await createPairCode()
      setCode(next)
      setLeft(secondsUntil(next.expires_at))
      setCopied(false)
    } catch (err) {
      if (err instanceof PairingApiError && err.status === 403) {
        setError("只能在这台电脑上生成配对码 —— 请在电脑上用 localhost 打开设置。")
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }, [])

  const copyCode = useCallback(async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code.code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* 剪贴板不可用就算了，码就在眼前 */
    }
  }, [code])

  const startRename = useCallback((device: PairedDevice) => {
    setRenamingId(device.id)
    setRenameValue(device.name)
  }, [])

  const saveRename = useCallback(async () => {
    const id = renamingId
    const name = renameValue.trim()
    if (!id || !name) return
    setBusy(true)
    try {
      const next = await renamePairedDevice(id, name)
      setDevices((prev) => prev?.map((d) => (d.id === id ? next : d)) ?? prev)
      setRenamingId(null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [renamingId, renameValue])

  const revoke = useCallback(async (device: PairedDevice) => {
    const ok = window.confirm(
      `吊销「${device.name}」？\n这台手机下一次请求就会 401，需要重新配对才能再用。`,
    )
    if (!ok) return
    setBusy(true)
    try {
      await revokePairedDevice(device.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [load])

  const activeCount = useMemo(
    () => devices?.filter((d) => !d.revoked_at).length ?? 0,
    [devices],
  )

  return (
    <div className="flex h-full flex-col" data-testid="device-pairing-panel">
      <div className="border-b border-border bg-background px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">手机配对</h1>
        <p className="text-sm text-muted-foreground">
          手机经 Tailscale 访问这台电脑时，用一次性配对码换一条长期设备令牌。
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {error ? (
          <div
            data-testid="pairing-error"
            className="mb-6 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}

        <section className="max-w-2xl" data-pairing-section="code">
          <h2 className="mb-3 text-sm font-medium">配对码</h2>
          <div className="rounded-lg border border-border bg-card px-4 py-4">
            <div className="flex items-start gap-4">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">6 位码，2 分钟内有效，只能用一次</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  手机添加设备时如果提示「需要配对码」，就在这里生成。设备管理只在本机可用。
                </p>

                {code ? (
                  <div className="mt-4 flex flex-wrap items-center gap-4">
                    <div
                      data-testid="pair-code"
                      className="rounded-lg border-[1.5px] border-pop-bd bg-pop-paper px-5 py-3 font-mono text-3xl font-black tracking-[0.2em] text-pop-ink tabular-nums"
                    >
                      {groupCode(code.code)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <div>{left} 秒后失效</div>
                      <div className="mt-1 font-mono">{code.code}</div>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void copyCode()}>
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copied ? "已复制" : "复制"}
                    </Button>
                  </div>
                ) : null}

                <div className="mt-4">
                  <Button
                    size="sm"
                    data-testid="pair-code-button"
                    disabled={busy}
                    onClick={() => void generate()}
                  >
                    <RefreshCw className={busy ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                    {code ? "重新生成" : "生成配对码"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-8 max-w-2xl" data-pairing-section="remote">
          <h2 className="mb-3 text-sm font-medium">远程拉起（可选）</h2>
          <div className="rounded-lg border border-border bg-card px-4 py-4" data-testid="remote-status">
            <div className="flex items-start gap-4">
              <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                {remote === undefined ? (
                  <p className="text-sm text-muted-foreground">读取中…</p>
                ) : remote?.installed ? (
                  <>
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      已就绪
                      <span className="rounded border border-emerald-500/40 px-1.5 py-0.5 text-[10px] text-emerald-600">
                        密钥槽 {remote.slots_available} / {remote.slots_total}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      SSH {remote.ssh_user}@{remote.ssh_port} · {isMac ? "登录项" : "计划任务"}{" "}
                      {remote.task_name}
                      {remote.slots_available === 0 ? " · 槽位用完了，重跑一次安装器可补" : ""}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      手机配对时换走一把私钥（PC 上发完即删，只在手机的安全存储里留底）。
                      之后 Octopus 没启动，手机也能看到「在线 · 未启动」并一键拉起。
                    </p>
                    {remote.error ? (
                      <p className="mt-2 text-xs text-destructive">{remote.error}</p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium">未安装</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {isMac
                        ? "开启后，手机在 Octopus 没启动时也能把它拉起来。点下面的按钮会弹一次管理员授权（安装登录项；首次可能顺带打开「远程登录」）。"
                        : "开启后，手机在 Octopus 没启动时也能把它拉起来。点下面的按钮会弹一次 UAC；首次可能顺带启用 Windows 的 OpenSSH Server（一两分钟）。"}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        data-testid="remote-setup-button"
                        disabled={setupBusy}
                        onClick={() => void enable()}
                      >
                        {setupBusy ? (
                          <RefreshCw className="h-4 w-4 animate-spin" />
                        ) : (
                          <Terminal className="h-4 w-4" />
                        )}
                        {setupBusy ? (isMac ? "等待授权…" : "等待 UAC…") : "启用远程拉起"}
                      </Button>
                      <span className="text-[11px] text-muted-foreground">装完当场自测</span>
                    </div>
                    {setupNote ? (
                      <p data-testid="remote-setup-note" className="mt-2 text-xs text-muted-foreground">
                        {setupNote}
                      </p>
                    ) : null}
                    <p className="mt-3 text-[11px] text-muted-foreground">也可以手动运行：</p>
                    <code className="mt-1 block overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-[11px]">
                      {isMac
                        ? "bash scripts/remote/install-remote.sh"
                        : "powershell -ExecutionPolicy Bypass -File scripts\\remote\\install-remote.ps1"}
                    </code>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {isMac
                        ? "默认只追加一把只能用 status/start 的 SSH 密钥、注册登录项 —— 不改 sshd 配置、不重启 sshd，你原来的远程登录方式不受影响。"
                        : "默认只追加一把只能用 status/start 的 SSH 密钥、注册登录计划任务 —— 不改 sshd 配置、不重启 sshd，你原来的远程登录方式不受影响。"}
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="mt-8 max-w-2xl" data-pairing-section="devices">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
            已配对设备
            <span className="text-xs font-normal text-muted-foreground">
              {activeCount} 台有效
            </span>
          </h2>

          {devices === null ? (
            <div className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
              读取中…
            </div>
          ) : devices.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card/50 px-4 py-6 text-sm text-muted-foreground">
              还没有配对的手机。手机上填好地址后，如果提示要配对码，就在这里生成一个。
            </div>
          ) : (
            <ul className="space-y-2">
              {devices.map((device) => {
                const revoked = !!device.revoked_at
                const renaming = renamingId === device.id
                return (
                  <li
                    key={device.id}
                    data-testid="paired-device"
                    className={`rounded-lg border border-border bg-card px-4 py-3 ${revoked ? "opacity-60" : ""}`}
                  >
                    <div className="flex items-start gap-3">
                      <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        {renaming ? (
                          <div className="flex items-center gap-2">
                            <Input
                              value={renameValue}
                              maxLength={64}
                              autoFocus
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveRename()
                                if (e.key === "Escape") setRenamingId(null)
                              }}
                            />
                            <Button size="sm" disabled={busy || !renameValue.trim()} onClick={() => void saveRename()}>
                              保存
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setRenamingId(null)}>
                              取消
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{device.name}</span>
                            {revoked ? (
                              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                已吊销
                              </span>
                            ) : (
                              <span className="rounded border border-emerald-500/40 px-1.5 py-0.5 text-[10px] text-emerald-600">
                                有效
                              </span>
                            )}
                            {device.platform ? (
                              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                {device.platform}
                              </span>
                            ) : null}
                            {device.ssh_key_slot ? (
                              <span
                                className="rounded border border-sky-500/40 px-1.5 py-0.5 text-[10px] text-sky-600"
                                title="配对时下发了 SSH 私钥，可以在没启动时把电脑拉起来"
                              >
                                远程 {device.ssh_key_slot}
                              </span>
                            ) : null}
                          </div>
                        )}
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
                          <span>令牌 {device.token_prefix}…</span>
                          <span>配对 {formatWhen(device.created_at)}</span>
                          <span>上次活跃 {formatWhen(device.last_seen_at)}</span>
                        </div>
                      </div>
                      {!revoked && !renaming ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title="改名"
                            onClick={() => startRename(device)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title="吊销"
                            data-testid="revoke-device"
                            onClick={() => void revoke(device)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          <p className="mt-4 text-xs text-muted-foreground">
            服务端只保存令牌的 sha256；手机端把明文令牌放在系统安全存储里。
            吊销后那台手机的请求会立刻 401，需要重新配对。
          </p>
        </section>
      </div>
    </div>
  )
}
