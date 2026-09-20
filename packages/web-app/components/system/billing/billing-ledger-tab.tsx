"use client"

import { Fragment, useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { getSettings, listBillingCalls, type BillingCallRow, type BillingSettings } from "@/lib/billing-api"

/**
 * 票 06 · 计费明细 Tab —— llm_calls 流水 + 筛选（模型/时间区间/定价状态）+
 * 展示币种换算（KD8：按**当前汇率**折算展示，历史不锁汇）+ 未定价徽标（KD4）。
 * 换算纯函数 convertCostToDisplay 单独导出，供单测直查。
 */

export type DisplayCost =
  | { kind: "amount"; symbol: "¥" | "$"; text: string }
  | { kind: "unpriced" }
  | { kind: "legacy" } // 接线前老行（price_status NULL 且无 cost）：不冒充数字

/**
 * 纯函数换算：display=CNY → cost_usd × rate；display=USD → 直显。
 * 文本保留最多 4 位小数（金额存储不截断，展示层格式化 —— 票02 口径）。
 */
export function convertCostToDisplay(
  row: Pick<BillingCallRow, "cost_usd" | "price_status">,
  display: BillingSettings["display_currency"],
  rate: number,
): DisplayCost {
  if (row.price_status === "unpriced") return { kind: "unpriced" }
  if (row.cost_usd === null || row.cost_usd === undefined) return { kind: "legacy" }
  const amount = display === "CNY" ? row.cost_usd * rate : row.cost_usd
  const text = amount.toFixed(4).replace(/\.?0+$/, "")
  return { kind: "amount", symbol: display === "CNY" ? "¥" : "$", text }
}

interface Filters {
  model: string
  from: string // datetime-local 串
  to: string
  status: "" | "priced" | "unpriced"
}
const EMPTY_FILTERS: Filters = { model: "", from: "", to: "", status: "" }

const PAGE_SIZE = 50

function toEpochMs(local: string): number | undefined {
  if (!local) return undefined
  const t = new Date(local).getTime()
  return Number.isFinite(t) ? t : undefined
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false })
}

export function BillingLedgerTab() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<BillingCallRow[]>([])
  const [total, setTotal] = useState(0)
  const [models, setModels] = useState<string[]>([])
  const [settings, setSettings] = useState<BillingSettings>({ usd_to_cny: "7.0", display_currency: "CNY" })
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    getSettings().then(setSettings).catch(() => { /* 明细可用兜底设置继续渲染 */ })
  }, [])

  const load = useCallback(async (f: Filters, p: number) => {
    setLoading(true)
    try {
      const res = await listBillingCalls({
        model: f.model || undefined,
        price_status: f.status || undefined,
        from: toEpochMs(f.from),
        to: toEpochMs(f.to),
        page: p,
        page_size: PAGE_SIZE,
      })
      setData(res.calls)
      setTotal(res.total)
      setModels(res.models)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载计费明细失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(filters, page) }, [filters, page, load])

  const setFilter = (patch: Partial<Filters>) => { setPage(1); setFilters(f => ({ ...f, ...patch })) }

  const rate = Number(settings.usd_to_cny)
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div data-testid="billing-ledger" className="p-4 space-y-3">
      {/* 筛选条 */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <div className="space-y-1">
            <Label htmlFor="bl-model">模型</Label>
            <select id="bl-model" className="h-9 rounded-md border border-pop-bd bg-pop-paper px-2 text-sm" value={filters.model} onChange={(e) => setFilter({ model: e.target.value })}>
              <option value="">全部模型</option>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bl-from">起始时间</Label>
            <input id="bl-from" type="datetime-local" className="h-9 rounded-md border border-pop-bd bg-pop-paper px-2 text-sm" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bl-to">结束时间</Label>
            <input id="bl-to" type="datetime-local" className="h-9 rounded-md border border-pop-bd bg-pop-paper px-2 text-sm" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bl-status">定价状态</Label>
            <select id="bl-status" className="h-9 rounded-md border border-pop-bd bg-pop-paper px-2 text-sm" value={filters.status} onChange={(e) => setFilter({ status: e.target.value as Filters["status"] })}>
              <option value="">全部状态</option>
              <option value="priced">已定价</option>
              <option value="unpriced">未定价</option>
            </select>
          </div>
          {(filters.model || filters.from || filters.to || filters.status) && (
            <Button size="sm" variant="outline" onClick={() => setFilter(EMPTY_FILTERS)}>清空筛选</Button>
          )}
          <div className="flex-1" />
          <span className="text-xs text-muted-foreground">
            共 {total} 条 · 金额按 {settings.display_currency} 展示（1 USD = {settings.usd_to_cny} CNY，当前汇率折算，历史不锁汇）
          </span>
        </CardContent>
      </Card>

      {/* 流水表 */}
      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : data.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">没有匹配的调用记录。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b-2 border-pop-bd">
                    {["", "时间", "模型", "输入", "输出", "缓存写", "缓存读", `费用（${settings.display_currency === "CNY" ? "¥" : "$"}）`, "状态"].map((h, i) => (
                      <th key={i} className="px-2 py-2 font-black whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((r) => {
                    const cost = convertCostToDisplay(r, settings.display_currency, Number.isFinite(rate) && rate > 0 ? rate : 1)
                    const isOpen = expanded === r.id
                    return (
                      <Fragment key={r.id}>
                        <tr className="border-b border-pop-bd/50">
                          <td className="px-2 py-2">
                            <button aria-label={isOpen ? "收起归属" : "展开归属"} onClick={() => setExpanded(isOpen ? null : r.id)}>
                              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </button>
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap">{fmtTime(r.timestamp)}</td>
                          <td className="px-2 py-2 font-mono">{r.model ?? "—"}</td>
                          <td className="px-2 py-2 text-right">{r.input_tokens}</td>
                          <td className="px-2 py-2 text-right">{r.output_tokens}</td>
                          <td className="px-2 py-2 text-right">{r.cache_creation_tokens}</td>
                          <td className="px-2 py-2 text-right">{r.cache_read_tokens}</td>
                          <td className="px-2 py-2 whitespace-nowrap">
                            {cost.kind === "amount" && (
                              <span title={r.cost_currency ? `原币 ${r.cost_native} ${r.cost_currency}` : undefined}>
                                {cost.symbol}{cost.text}
                              </span>
                            )}
                            {cost.kind === "unpriced" && (
                              <span data-testid="badge-unpriced" className="rounded-full border border-pop-amber/60 bg-pop-amber/15 px-2 py-0.5 text-xs font-bold text-pop-amber">
                                未定价
                              </span>
                            )}
                            {cost.kind === "legacy" && <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap">
                            {r.price_status === "priced" ? "已定价" : r.price_status === "unpriced" ? "未定价" : "—"}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr data-testid={`ledger-detail-${r.id}`}>
                            <td />
                            <td colSpan={8} className="px-2 pb-3 text-xs text-pop-dim">
                              <div className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-3">
                                <span>execution: <span className="font-mono">{r.execution_id}</span></span>
                                <span>node: <span className="font-mono">{r.node_execution_id}</span>（{r.node_id ?? "—"}）</span>
                                <span>session: <span className="font-mono">{r.session_id ?? "—"}</span></span>
                                <span>workflow: <span className="font-mono">{r.workflow_ref ?? "—"}</span></span>
                                <span>原币快照: {r.cost_native !== null ? `${r.cost_native} ${r.cost_currency ?? ""}` : "—"}</span>
                                <span>USD 归一: {r.cost_usd ?? "—"}</span>
                                {r.workspace_id && (
                                  <span className="col-span-full">
                                    <Link href={`/workspaces/${r.workspace_id}/executions/${r.execution_id}/observability`} className="underline">
                                      在 Observability 查看该执行 →
                                    </Link>
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* 分页 */}
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
            <span data-testid="ledger-page-indicator" className="text-sm">第 {page} / {pages} 页</span>
            <Button size="sm" variant="outline" disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)}>下一页</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
