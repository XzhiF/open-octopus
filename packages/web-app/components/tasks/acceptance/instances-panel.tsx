// packages/web-app/components/tasks/acceptance/instances-panel.tsx
//
// 「测试实例」面板（2026-09-24，自动回收 + 一键关闭）。验收 runbook/探针在任务
// worktree 拉起的常驻进程（next dev / node server / java…）由 server 端按端口
// 反查登记进 ~/.octopus/instances/{taskId}.json；决策/停止会自动回收，本面板是
// 剩余的手动面：列出现场（含 server 重启前的残留）、单条/全部关闭。
//
// external 行 = 分支端口文件里活着但未登记的 listener —— 多半是用户在 worktree
// 手动 `pnpm dev` 起的整棵 dev 树。关闭走 close-dev（服务端三重闸兜底宿主保护），
// 文案必须如实说明「会终止整个进程树」。
//
// 数据自治：rev（父层在 preview 事件/决策/中止后自增）驱动 refetch，动作成功后
// 自增自己的 rev —— 与 preview-bar 的呈现层不同，这里不假设父层持有实例态。

"use client"

import { useCallback, useEffect, useState } from "react"
import { Server, X, TriangleAlert, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/scheduler/confirm-dialog"
import {
  listTaskInstances, reclaimTaskInstances, closeDevInstance,
  type InstancesPayload, type TestInstanceEntry,
} from "@/lib/tasks-api"

interface InstancesPanelProps {
  taskId: string
  /** 父层状态推进计数（preview 状态流转 / 轮次变化）→ 触发 refetch。 */
  rev: string
  disabledReason?: string
}

const SRC_TXT: Record<string, string> = {
  "preview-up": "预览拉起",
  "probe-launcher": "探针拉起",
}

export function InstancesPanel({ taskId, rev, disabledReason }: InstancesPanelProps) {
  const [data, setData] = useState<InstancesPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmCloseDev, setConfirmCloseDev] = useState<{ port: number; label: string } | null>(null)

  const reload = useCallback(async () => {
    if (!taskId) return
    try {
      setData(await listTaskInstances(taskId))
      setError(null)
    } catch (e: unknown) {
      // 409（无 awaiting 轮）等 = 没有可展示的现场，诚实清空而非报错刷屏
      const status = (e as { status?: number }).status
      if (status === 404 || status === 409) { setData({ entries: [], external: [] }); setError(null); return }
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [taskId])

  useEffect(() => { void reload() }, [reload, rev])

  // 有存活实例时轻轮询：stop 后的异步 reclaim 需要几秒收敛（down→等端口→
  // 树杀），SSE 无实例面事件 —— 收干净（total=0）后自动停表，不空转。
  useEffect(() => {
    const live = (data?.entries ?? []).some((e) => e.status !== "stopped") || (data?.external.length ?? 0) > 0
    if (!live) return
    const t = setInterval(() => { void reload() }, 4000)
    return () => clearInterval(t)
  }, [data, reload])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try { await fn(); await reload() } catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const aliveEntries = (data?.entries ?? []).filter((e) => e.status !== "stopped")
  const total = aliveEntries.length + (data?.external.length ?? 0)

  const closeEntry = (entry: TestInstanceEntry) =>
    void act(() => reclaimTaskInstances(taskId, [entry.id]))
  const closeAll = () =>
    void act(async () => {
      await reclaimTaskInstances(taskId)
      for (const x of data?.external ?? []) {
        try { await closeDevInstance(taskId, x.port) } catch { /* 三闸拒绝由 error 行呈现 */ }
      }
    })
  const doCloseDev = (port: number) =>
    void act(() => closeDevInstance(taskId, port))

  return (
    <div className="rounded-[13px] border-2 border-pop-bd bg-pop-paper shadow-pop-sm" data-testid="instances-panel">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Server className="size-3.5 shrink-0 text-pop-dim" />
        <span className="font-mono text-[9.5px] font-black tracking-[.09em] text-pop-dim">测试实例</span>
        {total > 0 && (
          <span className="rounded-full bg-pop-green/15 px-1.5 py-px font-mono text-[9px] font-bold text-pop-green">{total} 在跑</span>
        )}
        {total === 0 && !error && (
          <span className="font-mono text-[10px] text-pop-dim">无在跑的测试实例 — 端口没有被占用</span>
        )}
        {aliveEntries.length > 0 && (
          <Button size="sm" variant="destructive" className="ml-auto h-6 px-2.5 text-[10px]" disabled={busy || !!disabledReason} onClick={closeAll} data-testid="instances-close-all">
            <RotateCcw className="size-3 mr-1" />全部关闭
          </Button>
        )}
      </div>

      {error && (
        <div className="border-t border-pop-bd/10 px-3 py-1.5 font-mono text-[10px] text-pop-red" data-testid="instances-error">{error}</div>
      )}

      {aliveEntries.length > 0 && (
        <div className="border-t border-pop-bd/10">
          {aliveEntries.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5" data-testid={`instance-entry-${e.source}`}>
              <span className={`inline-block size-2 rounded-full ${e.status === "alive" ? "bg-pop-green" : "bg-pop-dim"}`} />
              <span className="rounded-full border border-pop-bd/40 px-1.5 py-px font-mono text-[9px] font-bold text-pop-dim">{SRC_TXT[e.source] ?? e.source}</span>
              <span className="font-mono text-[10.5px] text-pop-ink/80">{e.ports.map((p) => `:${p}`).join(" ") || "端口未知"}</span>
              {e.pids.length > 0 && <span className="font-mono text-[9.5px] text-pop-dim">pid {e.pids.join(",")}</span>}
              {e.workspace_path && <span className="max-w-[220px] truncate font-mono text-[9.5px] text-pop-dim" title={e.workspace_path}>{e.workspace_path}</span>}
              {e.status === "stale" && <span className="font-mono text-[9.5px] text-pop-amber">已失联（进程不在）</span>}
              <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[10px] text-pop-red" disabled={busy || !!disabledReason} onClick={() => closeEntry(e)} data-testid={`instance-close-${e.id}`}>
                <X className="size-3 mr-0.5" />关闭
              </Button>
            </div>
          ))}
        </div>
      )}

      {(data?.external.length ?? 0) > 0 && (
        <div className="border-t border-pop-bd/10">
          {data!.external.map((x) => (
            <div key={`ext-${x.port}`} className="flex flex-wrap items-center gap-2 px-3 py-1.5" data-testid="instance-external">
              <TriangleAlert className="size-3 shrink-0 text-pop-amber" />
              <span className="font-mono text-[10.5px] text-pop-ink/80">
                外部 dev 实例 :{x.port}（{x.role}{x.branch ? `，分支 ${x.branch}` : ""}）— 未登记（多半是在 worktree 手动 pnpm dev 起的）
              </span>
              <Button size="sm" variant="outline" className="ml-auto h-6 px-2 text-[10px] text-pop-red" disabled={busy || !!disabledReason} onClick={() => setConfirmCloseDev({ port: x.port, label: x.branch ?? "" })} data-testid={`instance-close-dev-${x.port}`}>
                <X className="size-3 mr-0.5" />关闭
              </Button>
            </div>
          ))}
        </div>
      )}

      {disabledReason && total > 0 && (
        <div className="border-t border-pop-bd/10 px-3 py-1 font-mono text-[9.5px] text-pop-dim">{disabledReason}</div>
      )}

      <ConfirmDialog
        open={!!confirmCloseDev}
        onOpenChange={(o) => { if (!o) setConfirmCloseDev(null) }}
        title={`关闭端口 :${confirmCloseDev?.port ?? ""} 上的 dev 实例？`}
        description={`将终止 :${confirmCloseDev?.port ?? ""} 上整个 dev 进程树（含 pnpm/dev.mjs 父进程）。当前 Octopus 宿主实例不受影响（服务端有宿主端口/进程/祖先链三重闸）。确认？`}
        confirmLabel="终止进程树"
        variant="destructive"
        loading={busy}
        onConfirm={() => {
          const p = confirmCloseDev?.port
          setConfirmCloseDev(null)
          if (p !== undefined) doCloseDev(p)
        }}
      />
    </div>
  )
}
