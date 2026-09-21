"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import {
  getReportSummary, getReportTrend, getReportBreakdown, getReportRanking,
  type BillingDrillDown, type BillingReportBreakdownItem, type BillingReportGroupBy,
  type BillingReportRankBy, type BillingReportRankItem,
  type BillingReportSummary, type BillingReportTrend,
} from "@/lib/billing-api"

/**
 * billing-report-3 票03 · 报表 Tab —— 区间选择（7/30/90 天快捷 + 自定义）联动刷新
 * 汇总卡行（US1：总费用/调用数/四类 token/未定价占比）+ 按日趋势折线（US2：
 * 默认叠加上一等长区间虚线，hover Tooltip 出当日数值）。
 * billing-report-3 票04 · 续填 —— 分布区（US3：模型/厂商/来源路径三图，图例含 cost 与
 * share）+ 排行区（US4：workspace/session Top10 双列表）+ 联动下钻（条目点击 →
 * onDrill 上抛，页面层切「计费明细」Tab 注入对应筛选并保留区间；'unknown' 归属
 * 降级为仅区间筛选 —— 明细端点无对应可筛值）。
 * 口径全部由服务端票 01/02 端点保证（KD20 单表 / KD21 未定价计数量不计费用 /
 * KD22 SQL 聚合 + 双币种出参 / KD24 本地日界 / KD25 Top10）；本组件只做渲染与参数联动。
 * 币种符号与金额直取回包 display_currency/cost_display（US6 与明细页同汇率）。
 */

type Preset = "7" | "30" | "90" | "custom"

/** 本地日界（KD24 与 server localDayStr 同规则：主机时区、YYYY-MM-DD）。 */
function localDayStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function shiftLocalDay(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number)
  return localDayStr(new Date(y, m - 1, d + days))
}
function dayCount(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number)
  const [ty, tm, td] = to.split("-").map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1
}
function presetRange(p: Preset): { from: string; to: string } {
  const to = localDayStr(new Date())
  if (p === "custom") return { from: shiftLocalDay(to, -29), to }
  return { from: shiftLocalDay(to, -(Number(p) - 1)), to }
}

/** 金额格式化：与明细页同口径（最多 4 位小数，去尾零）；NULL=全未定价 → 占位（KD4）。 */
export function fmtDisplayAmount(v: number | null, currency: "USD" | "CNY"): string {
  if (v === null || !Number.isFinite(v)) return "—"
  const symbol = currency === "CNY" ? "¥" : "$"
  return symbol + v.toFixed(4).replace(/\.?0+$/, "")
}
/** 未定价占比：0.25 → "25%"（与 API ratio 逐值一致，仅展示层百分化）。 */
export function fmtRatio(ratio: number): string {
  return `${Number((ratio * 100).toFixed(1))}%`
}

/**
 * 票04 联动：分布条目 key / 排行条目 id → 明细下钻筛选（票面语义）。
 * 'unknown' 归属（模型/厂商无价、归属 id 缺失）无对应可筛值 → 降级为仅区间；
 * 来源 'unknown' 例外 —— 明细端点 source_path=unknown 兜 NULL 老行（票05/AC3 口径），照常注入。
 * 纯函数导出供组件测试逐值断言。
 */
export function drillForBreakdown(groupBy: BillingReportGroupBy, key: string, range: { from: string; to: string }): BillingDrillDown {
  if (groupBy !== "source" && key === "unknown") return { from: range.from, to: range.to }
  if (groupBy === "model") return { model: key, from: range.from, to: range.to }
  if (groupBy === "vendor") return { vendor: key, from: range.from, to: range.to }
  return { sourcePath: key, from: range.from, to: range.to }
}
export function drillForRanking(by: BillingReportRankBy, id: string, range: { from: string; to: string }): BillingDrillDown {
  if (id === "unknown") return { from: range.from, to: range.to }
  return by === "workspace" ? { workspaceId: id, from: range.from, to: range.to } : { sessionId: id, from: range.from, to: range.to }
}

const BREAKDOWN_TITLES: Record<BillingReportGroupBy, string> = { model: "模型", vendor: "厂商", source: "来源路径" }
const RANKING_TITLES: Record<BillingReportRankBy, string> = { workspace: "Workspace", session: "Session" }

/** 分布条形行（KD26 选型内「条」；HTML 条避免图表库 jsdom 无尺寸问题，图例含 cost 与 share）。 */
function BreakdownCard({ groupBy, items, currency, onSelect }: {
  groupBy: BillingReportGroupBy
  items: BillingReportBreakdownItem[]
  currency: "USD" | "CNY"
  onSelect: (key: string) => void
}) {
  const shareSum = items.reduce((s, it) => s + it.share, 0)
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">费用分布 · {BREAKDOWN_TITLES[groupBy]}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 ? (
          <p data-testid={`breakdown-${groupBy}-empty`} className="py-4 text-center text-sm text-muted-foreground">该区间没有可分布的调用。</p>
        ) : items.map((it) => (
          <button
            key={it.key}
            type="button"
            data-testid={`breakdown-item-${groupBy}-${it.key}`}
            data-share={it.share}
            title={`点击跳计费明细（按${BREAKDOWN_TITLES[groupBy]}筛选）`}
            onClick={() => onSelect(it.key)}
            className="block w-full rounded-md border border-transparent px-2 py-1 text-left transition-colors hover:border-pop-bd hover:bg-accent"
          >
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate font-bold text-pop-ink">{it.key}</span>
              <span data-testid={`breakdown-legend-${groupBy}-${it.key}`} className="whitespace-nowrap text-pop-dim">
                {fmtDisplayAmount(it.cost_display, currency)} · {fmtRatio(it.share)} · {it.calls} 次
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-accent">
              <div className="h-full rounded-full bg-pop-yellow" style={{ width: `${Math.min(100, it.share * 100)}%` }} />
            </div>
          </button>
        ))}
        <p data-testid={`breakdown-${groupBy}-sum`} className="text-right text-xs text-pop-dim" title="三分布 share 合计应为 100%±1%（US3；无费用基准时全 0）">share 合计 {fmtRatio(shareSum)}</p>
      </CardContent>
    </Card>
  )
}

/** 排行列表条（US4 Top10；序号 + 名称 + 费用 + 调用数，点击下钻）。 */
function RankingCard({ by, items, currency, onSelect }: {
  by: BillingReportRankBy
  items: BillingReportRankItem[]
  currency: "USD" | "CNY"
  onSelect: (id: string) => void
}) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{RANKING_TITLES[by]} 费用排行 Top{items.length || 10}</CardTitle></CardHeader>
      <CardContent className="space-y-1">
        {items.length === 0 ? (
          <p data-testid={`ranking-${by}-empty`} className="py-4 text-center text-sm text-muted-foreground">该区间没有可排行的归属。</p>
        ) : items.map((it, i) => (
          <button
            key={it.id}
            type="button"
            data-testid={`ranking-item-${by}-${i + 1}`}
            data-id={it.id}
            title={`点击跳计费明细（按 ${RANKING_TITLES[by]} 筛选）`}
            onClick={() => onSelect(it.id)}
            className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left text-xs transition-colors hover:border-pop-bd hover:bg-accent"
          >
            <span className="w-6 shrink-0 font-black text-pop-dim">#{i + 1}</span>
            <span className="min-w-0 flex-1 truncate font-bold text-pop-ink" title={it.id}>{it.name}</span>
            <span className="whitespace-nowrap text-pop-dim">{fmtDisplayAmount(it.cost_display, currency)} · {it.calls} 次</span>
          </button>
        ))}
      </CardContent>
    </Card>
  )
}

function SummaryCard({ label, testId, value, hint }: { label: string; testId: string; value: string; hint?: string }) {
  return (
    <Card className="min-w-0">
      <CardContent className="p-3">
        <p className="truncate text-xs font-bold text-pop-dim">{label}</p>
        <p data-testid={testId} className="truncate text-lg font-black text-pop-ink" title={hint}>{value}</p>
      </CardContent>
    </Card>
  )
}

export function BillingReportTab({ onDrill }: {
  /** 票04 联动：条目点击 → 上钻筛选（页面层切明细 Tab 注入）；缺省 = 纯浏览不联动 */
  onDrill?: (d: BillingDrillDown) => void
} = {}) {
  const [preset, setPreset] = useState<Preset>("30")
  const [range, setRange] = useState(() => presetRange("30"))
  const [summary, setSummary] = useState<BillingReportSummary | null>(null)
  const [trend, setTrend] = useState<BillingReportTrend | null>(null)
  const [prevTrend, setPrevTrend] = useState<BillingReportTrend | null>(null)
  const [breakdowns, setBreakdowns] = useState<Record<BillingReportGroupBy, BillingReportBreakdownItem[]>>({ model: [], vendor: [], source: [] })
  const [rankings, setRankings] = useState<Record<BillingReportRankBy, BillingReportRankItem[]>>({ workspace: [], session: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (r: { from: string; to: string }) => {
    setLoading(true)
    setError(null)
    const len = dayCount(r.from, r.to)
    const prev = { from: shiftLocalDay(r.from, -len), to: shiftLocalDay(r.from, -1) }
    try {
      const [s, t, bm, bv, bs, rw, rs] = await Promise.all([
        getReportSummary(r), getReportTrend(r),
        getReportBreakdown("model", r), getReportBreakdown("vendor", r), getReportBreakdown("source", r),
        getReportRanking("workspace", r), getReportRanking("session", r),
      ])
      setSummary(s)
      setTrend(t)
      setBreakdowns({ model: bm.items, vendor: bv.items, source: bs.items })
      setRankings({ workspace: rw.items, session: rs.items })
      // 上一等长区间仅作叠加参考 —— 失败降级为不叠加，不打断主视图
      try {
        setPrevTrend(await getReportTrend(prev))
      } catch {
        setPrevTrend(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载报表失败")
      setSummary(null)
      setTrend(null)
      setBreakdowns({ model: [], vendor: [], source: [] })
      setRankings({ workspace: [], session: [] })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(range) }, [range, load])

  const applyPreset = (p: Preset) => { setPreset(p); if (p !== "custom") setRange(presetRange(p)) }
  const setEdge = (edge: "from" | "to", v: string) => {
    setPreset("custom")
    setRange(r => ({ ...r, [edge]: v }))
  }

  const chartData = trend
    ? trend.days.map((d, i) => ({
        date: d.date.slice(5), // MM-DD 轴刻度
        cost: d.cost_display ?? 0,
        prevCost: prevTrend?.days[i]?.cost_display ?? null,
      }))
    : []
  const empty = !loading && !error && summary !== null && summary.total_calls === 0

  const currency = summary?.display_currency ?? "CNY"
  return (
    <div data-testid="billing-report" className="p-4 space-y-3">
      {/* 区间选择器 */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <div className="flex gap-1">
            {(["7", "30", "90"] as const).map((p) => (
              <button
                key={p}
                onClick={() => applyPreset(p)}
                className={cn(
                  "rounded-lg border-2 px-3 py-1 text-sm transition-all",
                  preset === p
                    ? "border-pop-bd bg-pop-yellow font-black text-pop-ink"
                    : "border-transparent font-bold text-pop-dim hover:bg-accent",
                )}
              >
                {p} 天
              </button>
            ))}
          </div>
          <div className="space-y-1">
            <Label htmlFor="br-from">起始日期</Label>
            <input id="br-from" type="date" className="h-9 rounded-md border border-pop-bd bg-pop-paper px-2 text-sm" value={range.from} onChange={(e) => setEdge("from", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="br-to">结束日期</Label>
            <input id="br-to" type="date" className="h-9 rounded-md border border-pop-bd bg-pop-paper px-2 text-sm" value={range.to} onChange={(e) => setEdge("to", e.target.value)} />
          </div>
          <div className="flex-1" />
          <span className="text-xs text-muted-foreground">
            区间 {range.from} ~ {range.to} · 未定价调用计数量不计费用
          </span>
        </CardContent>
      </Card>

      {loading && (
        <div data-testid="report-loading" className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && error && (
        <Card>
          <CardContent className="py-8">
            <p data-testid="report-error" className="text-center text-sm text-pop-amber">报表加载失败：{error}</p>
          </CardContent>
        </Card>
      )}

      {!loading && !error && summary && (
        <>
          {/* 汇总卡行（US1） */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <SummaryCard label={`总费用（${currency}）`} testId="summary-cost" value={fmtDisplayAmount(summary.total_cost_display, currency)} hint={`${summary.total_cost_usd ?? "—"} USD × ${summary.currency_rate}`} />
            <SummaryCard label="调用数" testId="summary-calls" value={String(summary.total_calls)} />
            <SummaryCard label="输入 token" testId="summary-token-in" value={String(summary.tokens.in)} />
            <SummaryCard label="输出 token" testId="summary-token-out" value={String(summary.tokens.out)} />
            <SummaryCard label="缓存写 token" testId="summary-token-cache-w" value={String(summary.tokens.cache_w)} />
            <SummaryCard label="缓存读 token" testId="summary-token-cache-r" value={String(summary.tokens.cache_r)} />
            <SummaryCard
              label="未定价占比"
              testId="summary-unpriced-ratio"
              value={fmtRatio(summary.unpriced.ratio)}
              hint={`未定价 ${summary.unpriced.calls}/${summary.total_calls} 次调用：计数量不计费用`}
            />
          </div>
          <p data-testid="summary-unpriced-calls" className="px-1 text-xs text-pop-dim" title="未定价口径（KD21）：计入调用数与 token 量，不计入费用，此角标显式提示占比避免费用被低估 —— 计数量不计费用">
            未定价 {summary.unpriced.calls} 次（角标 tooltip：计数量不计费用）
          </p>

          {/* 趋势折线（US2） */}
          {empty ? (
            <Card>
              <CardHeader><CardTitle className="text-base">按日趋势</CardTitle></CardHeader>
              <CardContent><p data-testid="report-empty" className="py-8 text-center text-sm text-muted-foreground">该区间没有调用记录。</p></CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader><CardTitle className="text-base">按日趋势（虚线 = 上一等长区间 {prevTrend ? `${prevTrend.from} ~ ${prevTrend.to}` : "不可用"}）</CardTitle></CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(v: number, name: string) => [fmtDisplayAmount(v, currency), name]} />
                      <Legend />
                      <Line type="monotone" dataKey="cost" name={`本期费用（${currency}）`} stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      <Line type="monotone" dataKey="prevCost" name="上期费用" stroke="hsl(var(--chart-2))" strokeWidth={1.5} strokeDasharray="4 4" dot={false} connectNulls={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          {/* 分布区（US3 · 票04）：模型/厂商/来源路径三图，条目点击下钻明细 */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {(["model", "vendor", "source"] as const).map((g) => (
              <BreakdownCard
                key={g}
                groupBy={g}
                items={breakdowns[g]}
                currency={currency}
                onSelect={(key) => onDrill?.(drillForBreakdown(g, key, range))}
              />
            ))}
          </div>

          {/* 排行区（US4 · 票04）：workspace / session Top10 双列表，条目点击下钻明细 */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {(["workspace", "session"] as const).map((by) => (
              <RankingCard
                key={by}
                by={by}
                items={rankings[by]}
                currency={currency}
                onSelect={(id) => onDrill?.(drillForRanking(by, id, range))}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
