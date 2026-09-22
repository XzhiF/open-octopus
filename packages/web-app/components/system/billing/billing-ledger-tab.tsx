"use client"

import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { getSettings, listBillingCalls, type BillingCallRow, type BillingDrillDown, type BillingSettings, type BillingSourceSubtotal } from "@/lib/billing-api"
import { formatTokenCount } from "@/lib/format"

/**
 * 计费明细 Tab（billing NEW-r2 · 规则账）。
 * llm_calls 流水 + 筛选（模型/时间区间/定价状态）+ 展示币种换算（KD8）。
 * NEW-r2：行上的 cost_usd/price_status 是**查询时派生值**（账本不存钱）——
 * 未定价 = 该笔时刻没有任何适用价格行（配上价后历史行立即在此出钱）；
 * 「legacy 接线前老行」态随快照列一并退役。
 * billing-coverage-2 票05：来源维度 —— 来源列（中文标签）+ 来源筛选下拉 +
 * 顶部各来源小计条（KD26，当前筛选条件下；派生 priced 求和，unpriced 计行不计费）。
 */

export type DisplayCost =
  | { kind: "amount"; symbol: "¥" | "$"; text: string }
  | { kind: "unpriced" }

/**
 * source_path 中文标签（票05 契约：六来源 + unknown）。纯函数导出供单测逐值断言；
 * 未知值（含 NULL 老行）→「未知」，不报错。
 */
export const SOURCE_PATH_LABELS: Record<string, string> = {
  workflow: "工作流",
  interaction: "交互",
  harness: "Harness",
  clone_chat: "分身聊天",
  global_chat: "全局聊天·主分身",
  session_compress: "会话压缩",
  unknown: "未知",
}
export function sourcePathLabel(v: string | null | undefined): string {
  return (v != null && SOURCE_PATH_LABELS[v]) || "未知"
}

/**
 * 纯函数换算：display=CNY → cost_usd × rate；display=USD → 直显。
 * 文本保留最多 4 位小数（金额存储不截断，展示层格式化 —— 票02 口径）。
 */
export function convertCostToDisplay(
  row: { cost_usd: number | null | undefined; price_status: string | null | undefined },
  display: BillingSettings["display_currency"],
  rate: number,
): DisplayCost {
  if (row.price_status === "unpriced" || row.cost_usd === null || row.cost_usd === undefined) return { kind: "unpriced" }
  const amount = display === "CNY" ? row.cost_usd * rate : row.cost_usd
  const text = amount.toFixed(4).replace(/\.?0+$/, "")
  return { kind: "amount", symbol: display === "CNY" ? "¥" : "$", text }
}

/** 小计条换算：cost_usd = NULL（该来源全未定价，KD4 不焊 0）→ 占位；否则按 KD8 折显。 */
export function subtotalCostDisplay(s: BillingSourceSubtotal, display: BillingSettings["display_currency"], rate: number): DisplayCost {
  if (s.cost_usd === null) return { kind: "unpriced" }
  return convertCostToDisplay({ cost_usd: s.cost_usd, price_status: "priced" }, display, rate)
}

/** 明细筛选状态（票04 起为下钻联动的目标形状，导出供类型断言）。 */
export interface Filters {
  model: string
  from: string // datetime-local 串
  to: string
  status: "" | "priced" | "unpriced"
  /** billing-coverage-2 票05: 来源筛选（"" = 全部；值域 = LLM_CALL_SOURCE_PATHS 七枚举） */
  source: string
  /** billing-report-3 票04 联动下钻：workspace / session / 厂商（"" = 全部） */
  workspace: string
  session: string
  vendor: string
}
const EMPTY_FILTERS: Filters = { model: "", from: "", to: "", status: "", source: "", workspace: "", session: "", vendor: "" }

const PAGE_SIZE = 50

function toEpochMs(local: string): number | undefined {
  if (!local) return undefined
  const t = new Date(local).getTime()
  return Number.isFinite(t) ? t : undefined
}

/** 结束时间含整分（…T23:59 → 23:59:59.999）——与报表聚合 to 日界同界，票04 下钻抽查必对上（US5）。 */
function toEpochMsEndInclusive(local: string): number | undefined {
  const t = toEpochMs(local)
  return t === undefined ? undefined : t + 59_999
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false })
}

/**
 * billing-report-3 票04 联动：报表条目点击 → 跳明细 Tab 并注入对应筛选。
 * from/to = 报表本地日区间（KD24），折成 datetime-local 串含首尾日（00:00 ~ 23:59）。
 * 纯函数导出供组件测试逐值断言。
 */
export function drillToFilters(drill: BillingDrillDown): Filters {
  return {
    ...EMPTY_FILTERS,
    model: drill.model ?? "",
    source: drill.sourcePath ?? "",
    workspace: drill.workspaceId ?? "",
    session: drill.sessionId ?? "",
    vendor: drill.vendor ?? "",
    from: drill.from ? `${drill.from}T00:00` : "",
    to: drill.to ? `${drill.to}T23:59` : "",
  }
}

export function BillingLedgerTab({ drill, onDrillConsumed }: {
  /** 报表 Tab 下钻筛选注入（票04）；应用一次即通知父层清空，允许重复下钻同一目标 */
  drill?: BillingDrillDown | null
  onDrillConsumed?: () => void
} = {}) {
  // 挂载即带 drill 时以注入值初始化（避免先拉一次无筛选的闪变）；后续 drill 变化走下方 effect
  const [filters, setFilters] = useState<Filters>(() => (drill ? drillToFilters(drill) : EMPTY_FILTERS))
  const [page, setPage] = useState(1)
  const [data, setData] = useState<BillingCallRow[]>([])
  const [total, setTotal] = useState(0)
  const [models, setModels] = useState<string[]>([])
  const [subtotals, setSubtotals] = useState<BillingSourceSubtotal[]>([])
  const [settings, setSettings] = useState<BillingSettings>({ usd_to_cny: "7.0", display_currency: "CNY" })
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    getSettings().then(setSettings).catch(() => { /* 明细可用兜底设置继续渲染 */ })
  }, [])

  // 票04 联动注入：drill 变化一次性替换筛选（保留区间 + 对应维度），应用后通知父层清空
  // （含挂载即带的初始 drill —— 已见 ref 防重复应用，清空防后续手动切 Tab 重放旧筛选）。
  const seenDrillRef = useRef<BillingDrillDown | null | undefined>(drill)
  useEffect(() => {
    if (!drill) return
    if (drill !== seenDrillRef.current) {
      seenDrillRef.current = drill
      setPage(1)
      setFilters(drillToFilters(drill))
    }
    onDrillConsumed?.()
  }, [drill, onDrillConsumed])

  const load = useCallback(async (f: Filters, p: number) => {
    setLoading(true)
    try {
      const res = await listBillingCalls({
        model: f.model || undefined,
        price_status: f.status || undefined,
        source_path: f.source || undefined,
        workspace_id: f.workspace || undefined,
        session_id: f.session || undefined,
        vendor: f.vendor || undefined,
        from: toEpochMs(f.from),
        to: toEpochMsEndInclusive(f.to),
        page: p,
        page_size: PAGE_SIZE,
      })
      setData(res.calls)
      setTotal(res.total)
      setModels(res.models)
      setSubtotals(res.source_subtotals)
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
              {/* 下钻注入的模型可能不在回包 models 列（如别名形态）→ 补渲染选中项，选择器不丢值 */}
              {filters.model !== "" && !models.includes(filters.model) && <option value={filters.model}>{filters.model}</option>}
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
          <div className="space-y-1">
            <Label htmlFor="bl-source">来源</Label>
            <select id="bl-source" data-testid="filter-source" className="h-9 rounded-md border border-pop-bd bg-pop-paper px-2 text-sm" value={filters.source} onChange={(e) => setFilter({ source: e.target.value })}>
              <option value="">全部来源</option>
              {Object.entries(SOURCE_PATH_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>
          {/* 票04 联动下钻维度：workspace / session / 厂商（多为报表注入的 id，文本框可手输可清） */}
          <div className="space-y-1">
            <Label htmlFor="bl-workspace">Workspace</Label>
            <input id="bl-workspace" data-testid="filter-workspace" type="text" placeholder="workspace id" className="h-9 w-40 rounded-md border border-pop-bd bg-pop-paper px-2 text-sm font-mono" value={filters.workspace} onChange={(e) => setFilter({ workspace: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bl-session">Session</Label>
            <input id="bl-session" data-testid="filter-session" type="text" placeholder="session id" className="h-9 w-40 rounded-md border border-pop-bd bg-pop-paper px-2 text-sm font-mono" value={filters.session} onChange={(e) => setFilter({ session: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bl-vendor">厂商</Label>
            <input id="bl-vendor" data-testid="filter-vendor" type="text" placeholder="精确匹配" className="h-9 w-28 rounded-md border border-pop-bd bg-pop-paper px-2 text-sm" value={filters.vendor} onChange={(e) => setFilter({ vendor: e.target.value })} />
          </div>
          {(filters.model || filters.from || filters.to || filters.status || filters.source || filters.workspace || filters.session || filters.vendor) && (
            <Button size="sm" variant="outline" onClick={() => setFilter(EMPTY_FILTERS)}>清空筛选</Button>
          )}
          <div className="flex-1" />
          <span className="text-xs text-muted-foreground">
            共 {total} 条 · 金额按 {settings.display_currency} 展示（1 USD = {settings.usd_to_cny} CNY，当前汇率折算，历史不锁汇）
          </span>
        </CardContent>
      </Card>

      {/* 来源小计条（票05 / KD26 —— 当前筛选条件下的各来源合计；unpriced 计行不计费） */}
      {subtotals.length > 0 && (
        <div data-testid="source-subtotals" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs">
          <span className="font-black text-pop-dim">来源小计</span>
          {subtotals.map((s) => {
            const d = subtotalCostDisplay(s, settings.display_currency, Number.isFinite(rate) && rate > 0 ? rate : 1)
            const unpricedCount = s.count - s.priced_count
            return (
              <span key={s.source} data-testid={`subtotal-${s.source}`} className="rounded-full border border-pop-bd/60 bg-pop-paper px-2 py-0.5">
                {sourcePathLabel(s.source)}：
                {d.kind === "amount" ? `${d.symbol}${d.text}` : "—"}
                {" · "}{s.count} 条{unpricedCount > 0 ? `（含未定价 ${unpricedCount}）` : ""}
              </span>
            )
          })}
          <span className="text-pop-dim">注：小计 = 已定价行求和；未定价计入条数不计入费用</span>
        </div>
      )}

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
                    {[
                      { h: "", cls: "" }, { h: "时间", cls: "" }, { h: "模型", cls: "" }, { h: "来源", cls: "" },
                      { h: "输入", cls: "text-right" }, { h: "输出", cls: "text-right" },
                      { h: "缓存写", cls: "text-right" }, { h: "缓存读", cls: "text-right" },
                      { h: `费用（${settings.display_currency === "CNY" ? "¥" : "$"}）`, cls: "text-right" },
                      { h: "状态", cls: "" },
                    ].map((c, i) => (
                      <th key={i} className={`px-2 py-2 font-black whitespace-nowrap ${c.cls}`}>{c.h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((r) => {
                    const cost = convertCostToDisplay(r, settings.display_currency, Number.isFinite(rate) && rate > 0 ? rate : 1)
                    const isOpen = expanded === r.id
                    return (
                      <Fragment key={r.id}>
                        <tr data-testid={`call-row-${r.id}`} className="border-b border-pop-bd/50">
                          <td className="px-2 py-2">
                            <button aria-label={isOpen ? "收起归属" : "展开归属"} onClick={() => setExpanded(isOpen ? null : r.id)}>
                              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </button>
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap">{fmtTime(r.timestamp)}</td>
                          <td className="px-2 py-2 font-mono">{r.model ?? "—"}</td>
                          <td className="px-2 py-2 whitespace-nowrap">
                            <span data-testid={`source-badge-${r.id}`} title={r.source_path ?? undefined} className="rounded border border-pop-bd/60 bg-pop-paper px-1.5 py-0.5 text-xs">
                              {sourcePathLabel(r.source_path)}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-right" title={r.input_tokens.toLocaleString("en-US")}>{formatTokenCount(r.input_tokens, 2)}</td>
                          <td className="px-2 py-2 text-right" title={r.output_tokens.toLocaleString("en-US")}>{formatTokenCount(r.output_tokens, 2)}</td>
                          <td className="px-2 py-2 text-right" title={r.cache_creation_tokens.toLocaleString("en-US")}>{formatTokenCount(r.cache_creation_tokens, 2)}</td>
                          <td className="px-2 py-2 text-right" title={r.cache_read_tokens.toLocaleString("en-US")}>{formatTokenCount(r.cache_read_tokens, 2)}</td>
                          <td className="px-2 py-2 text-right whitespace-nowrap">
                            {cost.kind === "amount" && (
                              <span title="查询时按价格规则现算（NEW-r2）">
                                {cost.symbol}{cost.text}
                              </span>
                            )}
                            {cost.kind === "unpriced" && (
                              <span data-testid="badge-unpriced" className="rounded-full border border-pop-amber/60 bg-pop-amber/15 px-2 py-0.5 text-xs font-bold text-pop-amber">
                                未定价
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap">
                            {r.price_status === "priced" ? "已定价" : "未定价"}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr data-testid={`ledger-detail-${r.id}`}>
                            <td />
                            <td colSpan={9} className="px-2 pb-3 text-xs text-pop-dim">
                              <div className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-3">
                                <span>execution: <span className="font-mono">{r.execution_id}</span></span>
                                <span>node: <span className="font-mono">{r.node_execution_id}</span>（{r.node_id ?? "—"}）</span>
                                <span>session: <span className="font-mono">{r.session_id ?? "—"}</span></span>
                                <span>workflow: <span className="font-mono">{r.workflow_ref ?? "—"}</span></span>
                                <span>来源: {sourcePathLabel(r.source_path)}（{r.source_path ?? "NULL"}）</span>
                                <span>USD（查询时派生）: {r.cost_usd ?? "—"}</span>
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
