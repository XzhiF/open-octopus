"use client"

// 分身窗（clone-dev task kind，2026-11-25）：作业坞里的「分身」业务弹窗。
// 七个 tab：分身卡片 / 人格 / 工具 / 技能 / 权限与边界 / 验证清单 / 包与台账。
// 数据全部来自真实 API（clone-dev state + 分身文件），不维护第二份状态。

import { useCallback, useEffect, useMemo, useState } from "react"
import type { TaskView } from "@/lib/tasks-api"
import { toast } from "sonner"
import { getCloneDevState, verifyCloneDev, type CloneDevSnapshot } from "@/lib/tasks-api"
import { getCloneFile, listCloneFiles } from "@/lib/agent/api"
import { cn } from "@/lib/utils"

type Tab = "card" | "persona" | "tools" | "skills" | "perm" | "verify" | "pkg"

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "card", label: "分身卡片" },
  { id: "persona", label: "人格" },
  { id: "tools", label: "工具" },
  { id: "skills", label: "技能" },
  { id: "perm", label: "权限与边界" },
  { id: "verify", label: "验证清单" },
  { id: "pkg", label: "包与台账" },
]

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-pop-bd/60 py-2 last:border-b-0">
      <span className="w-16 shrink-0 pt-0.5 text-[11px] font-bold text-pop-dim">{label}</span>
      <div className="min-w-0 flex-1 text-[12.5px] text-pop-ink">{children}</div>
    </div>
  )
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className={cn("mt-0.5 text-[13px]", ok ? "text-pop-green" : "text-pop-rose")}>{ok ? "✓" : "×"}</span>
      <div>
        <div className="text-[12.5px] font-bold text-pop-ink">{label}</div>
        {detail && <div className="mt-0.5 font-mono text-[10.5px] leading-4 text-pop-dim">{detail}</div>}
      </div>
    </div>
  )
}

export function CloneDevWindow({ task, onMutated }: { task: TaskView; onMutated?: () => void }) {
  const [snap, setSnap] = useState<CloneDevSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>("card")
  const [persona, setPersona] = useState("")
  const [files, setFiles] = useState<Array<{ path: string; name: string; type: string }>>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const next = await getCloneDevState(task.id)
      setSnap(next)
      setError(null)
      const name = next.state.clone_name
      if (name) {
        void getCloneFile(name, "persona.md")
          .then((r) => setPersona(r.content))
          .catch(() => setPersona(""))
        void listCloneFiles(name, true)
          .then((r) => setFiles(r.files))
          .catch(() => setFiles([]))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [task.id])

  useEffect(() => {
    void load()
  }, [load, task.version])

  const runVerify = async () => {
    setBusy(true)
    try {
      const next = await verifyCloneDev(task.id)
      setSnap(next)
      onMutated?.()
      const v = next.state.verification
      if (v?.tools_called && v.boundary_blocked && v.identity_switch) toast.success("三条判据全绿")
      else toast.warning("验证未全部通过，看「验证清单」里的证据")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const skills = useMemo(() => {
    const fromClone = snap?.clone?.info?.skills ?? []
    const fromFiles = files
      .filter((f) => f.path.startsWith("skills/") && f.name === "SKILL.md")
      .map((f) => f.path.split("/")[1])
    return [...new Set([...fromClone, ...fromFiles])]
  }, [snap, files])

  const kitTools = snap?.state.kit?.tools ?? []
  const v = snap?.state.verification

  if (error) {
    return (
      <div className="p-4 text-[12px] text-pop-rose">
        读取分身状态失败：{error}
        <button type="button" className="ml-2 underline" onClick={() => void load()}>
          重试
        </button>
      </div>
    )
  }
  if (!snap) return <div className="p-4 text-[12px] text-pop-dim">加载中…</div>

  const stageLabel =
    snap.state.stage === "merged" ? "已合入" : snap.state.stage === "verified" ? "验证通过 · 待合入" : "开发中"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-pop-bd px-2 py-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            data-clone-tab={t.id}
            className={cn(
              "rounded px-2 py-1 text-[11.5px] font-bold transition-colors",
              tab === t.id ? "bg-pop-pink/15 text-pop-pink" : "text-pop-dim hover:bg-white/5 hover:text-pop-ink",
            )}
          >
            {t.label}
          </button>
        ))}
        <span className="ml-auto font-mono text-[10.5px] text-pop-dim">{snap.state.clone_name}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "card" && (
          <div>
            <Row label="代号">
              <span className="font-mono">{snap.state.clone_name}</span>
            </Row>
            <Row label="显示名">{snap.clone?.info?.displayName ?? "—"}</Row>
            <Row label="类型">{snap.state.clone_type === "built-in" ? "内置分身" : "用户自定义 · 可卸载"}</Row>
            <Row label="模式">{snap.state.mode === "create" ? "新建" : "维护"}</Row>
            <Row label="状态">
              <span
                className={cn(
                  snap.state.stage === "merged"
                    ? "text-pop-green"
                    : snap.state.stage === "verified"
                      ? "text-pop-amber"
                      : "text-pop-dim",
                )}
              >
                {stageLabel}
              </span>
            </Row>
            <Row label="目录">
              <span className="break-all font-mono text-[11px] text-pop-dim">{snap.clone?.dir ?? "尚未建档"}</span>
            </Row>
            <Row label="任务">
              <span className="font-mono text-[11px] text-pop-dim">
                clone-dev · {snap.state.complete ? "awaiting_archive" : "draft"}
              </span>
            </Row>
          </div>
        )}

        {tab === "persona" && (
          <pre className="whitespace-pre-wrap break-words rounded border border-pop-bd bg-pop-paper/60 p-3 text-[12px] leading-5 text-pop-ink">
            {persona || "（persona.md 尚未写入）"}
          </pre>
        )}

        {tab === "tools" && (
          <div>
            {kitTools.length === 0 ? (
              <p className="text-[12px] text-pop-dim">这是个无工具分身（只有人格 + 技能）。</p>
            ) : (
              kitTools.map((name) => (
                <Row key={name} label={name}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11.5px]">{name}</span>
                    <span
                      className={cn(
                        "rounded-full border px-1.5 py-0.5 text-[10px] font-bold",
                        v?.tools_called
                          ? "border-pop-green/40 bg-pop-green/10 text-pop-green"
                          : "border-pop-bd bg-pop-idle text-pop-dim",
                      )}
                    >
                      {v?.tools_called ? "已验证" : "已声明"}
                    </span>
                  </div>
                </Row>
              ))
            )}
            <p className="mt-3 font-mono text-[10.5px] text-pop-dim">
              kit：{snap.state.kit?.enabled ? snap.state.kit.package : "未启用"} · 进程内 MCP · 会话级懒加载
            </p>
          </div>
        )}

        {tab === "skills" && (
          <div>
            {skills.length === 0 ? (
              <p className="text-[12px] text-pop-dim">还没有技能。</p>
            ) : (
              skills.map((s) => (
                <Row key={s} label="SKILL">
                  <span className="font-mono text-[11.5px]">{s}</span>
                </Row>
              ))
            )}
          </div>
        )}

        {tab === "perm" && (
          <div>
            <Row label="可调工具">
              <span className="font-mono text-[11px]">{kitTools.length ? kitTools.join(", ") : "仅内置工具"}</span>
            </Row>
            <Row label="可写路径">
              <span className="font-mono text-[11px]">~/.octopus/agent/clones/{snap.state.clone_name}/ · packages/clone-kits/{snap.state.clone_name}/ · task home</span>
            </Row>
            <Row label="硬规则">
              <ul className="list-disc space-y-1 pl-4 text-[11.5px] text-pop-dim">
                <li>不得修改 shared / server / engine / web-app 核心</li>
                <li>kit 单向依赖核心；核心不 import kit；kit 之间不互相依赖</li>
                <li>卸载 = 删除分身目录，核心必须不受影响</li>
              </ul>
            </Row>
          </div>
        )}

        {tab === "verify" && (
          <div>
            <Check ok={!!v?.tools_called} label="工具可用" detail={v?.tools_called ? "每个声明的工具自检通过" : "尚未验证或存在失败"} />
            <Check ok={!!v?.boundary_blocked} label="越权被拦" detail={v?.boundary_blocked ? "穿越路径被拒绝，合法路径放行" : "尚未验证"} />
            <Check ok={!!v?.identity_switch} label="身份可用" detail={v?.identity_switch ? "persona 与技能目录齐全，可切换身份" : "尚未验证"} />
            {v?.ran_at && <p className="mt-2 text-[10.5px] text-pop-dim">最近一次：{new Date(v.ran_at).toLocaleString()}</p>}
            {v?.message && <p className="mt-1 text-[10.5px] text-pop-amber">{v.message}</p>}
            {v?.evidence?.length ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-[11px] font-bold text-pop-dim">证据（{v.evidence.length} 条）</summary>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10.5px] leading-4 text-pop-dim">
                  {v.evidence.join("\n")}
                </pre>
              </details>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => void runVerify()}
              className="mt-3 rounded border border-pop-pink/50 bg-pop-pink/10 px-2.5 py-1 text-[11.5px] font-bold text-pop-pink disabled:opacity-50"
            >
              {busy ? "验证中…" : "跑一次验证"}
            </button>
          </div>
        )}

        {tab === "pkg" && (
          <div>
            <Row label="仓库包">
              <span className="break-all font-mono text-[11px]">
                packages/clone-kits/{snap.state.clone_name}/{snap.state.kit?.enabled ? "（index.ts + dist/）" : "（无，轻分身）"}
              </span>
            </Row>
            <Row label="用户目录">
              <span className="break-all font-mono text-[11px]">
                ~/.octopus/agent/clones/{snap.state.clone_name}/&#123;config.json, persona.md, skills/, kit/, CHANGES.jsonl&#125;
              </span>
            </Row>
            <Row label="安装">
              <span className="font-mono text-[11px]">{snap.state.runtime?.installed_at ?? "合入时自动安装"}</span>
            </Row>
            <Row label="文件">
              <span className="text-[11px] text-pop-dim">{files.length} 个</span>
            </Row>
          </div>
        )}
      </div>
    </div>
  )
}
