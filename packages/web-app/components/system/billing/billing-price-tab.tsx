"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Loader2, Plus, Save, Pencil, Trash2, Calculator } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  listPrices, createPrice, updatePrice, deletePrice,
  getSettings, updateSettings, listBillingCalls, previewPrice,
  BillingApiError,
  type BillingPrice, type BillingPriceInput, type BillingSettings, type BillingCurrency,
  type BillingPricePreview,
} from "@/lib/billing-api"

/**
 * 配价 Tab（billing NEW-r2 · 规则账）。
 * 每模型一组：一条「正常价」（全时段兜底，晚配价立即回算历史）+ 若干「时间段价」
 * （半开区间 [from, to)，窗口内优先，互不重叠 —— 重叠/倒序/第二条兜底价 400）。
 * 附试算器：模型+日期+token → 命中哪条价、算出多少钱（与账本同一套 SQL，永不分叉）。
 */

const CURRENCY_SYMBOL: Record<BillingCurrency, string> = { USD: "$", CNY: "¥" }
const PRICE_FIELDS = [
  { key: "input_unit_price", label: "输入单价" },
  { key: "output_unit_price", label: "输出单价" },
  { key: "cache_write_unit_price", label: "缓存写单价" },
  { key: "cache_read_unit_price", label: "缓存读单价" },
] as const

type FormState = {
  vendor: string
  model_id: string
  input_unit_price: string
  output_unit_price: string
  cache_write_unit_price: string
  cache_read_unit_price: string
  currency: BillingCurrency
  /** 日期串（YYYY-MM-DD）；空串 = 不设界。两条都空 = 正常价（兜底）。 */
  valid_from: string
  valid_to: string
}
const EMPTY_FORM: FormState = {
  vendor: "", model_id: "", input_unit_price: "", output_unit_price: "",
  cache_write_unit_price: "", cache_read_unit_price: "", currency: "CNY",
  valid_from: "", valid_to: "",
}

/** epoch ms → 本地日历日 YYYY-MM-DD。 */
function msToLocalDate(ms: number | null): string {
  if (ms === null) return ""
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地日历回退一天（半开区间止日 = 显示"前一天"；用日历运算而非 -1ms，DST 下不漂）。 */
function prevLocalDay(ms: number): string {
  const d = new Date(ms)
  d.setDate(d.getDate() - 1)
  return msToLocalDate(d.getTime())
}

function priceFromRow(p: BillingPrice): FormState {
  return {
    vendor: p.vendor, model_id: p.model_id,
    input_unit_price: String(p.input_unit_price), output_unit_price: String(p.output_unit_price),
    cache_write_unit_price: String(p.cache_write_unit_price), cache_read_unit_price: String(p.cache_read_unit_price),
    currency: p.currency,
    valid_from: msToLocalDate(p.valid_from), valid_to: msToLocalDate(p.valid_to),
  }
}

function isCatchall(p: { valid_from: number | null; valid_to: number | null }): boolean {
  return p.valid_from === null && p.valid_to === null
}

/** 窗口人话：兜底 =「全时段」；否则 [from, to) 显示（右界开区间标注到前一天）。 */
function windowLabel(p: BillingPrice): string {
  if (isCatchall(p)) return "全时段（正常价）"
  const from = p.valid_from !== null ? msToLocalDate(p.valid_from) : "起"
  const to = p.valid_to !== null ? prevLocalDay(p.valid_to) : "至今"
  return `${from} ~ ${to}`
}

function validateForm(form: FormState): Partial<Record<keyof FormState, string>> {
  const errors: Partial<Record<keyof FormState, string>> = {}
  if (!form.vendor.trim()) errors.vendor = "厂商不能为空"
  if (!form.model_id.trim()) errors.model_id = "模型ID不能为空"
  for (const { key, label } of PRICE_FIELDS) {
    const n = Number(form[key].trim())
    if (form[key].trim() === "" || !Number.isFinite(n) || n < 0) errors[key] = `${label}须为 ≥ 0 的数值`
  }
  if (!["USD", "CNY"].includes(form.currency)) errors.currency = "币种只能是 USD 或 CNY"
  if (form.valid_from && form.valid_to && form.valid_from >= form.valid_to) {
    errors.valid_to = "结束日必须晚于开始日（区间含开始日、不含结束日）"
  }
  return errors
}

export function BillingPriceTab() {
  const [prices, setPrices] = useState<BillingPrice[]>([])
  const [settings, setSettings] = useState<BillingSettings>({ usd_to_cny: "7.0", display_currency: "CNY" })
  const [rateDraft, setRateDraft] = useState("7.0")
  const [currencyDraft, setCurrencyDraft] = useState<BillingCurrency>("CNY")
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsErrors, setSettingsErrors] = useState<Record<string, string>>({})
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; price: BillingPrice } | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [list, s, calls] = await Promise.all([listPrices(), getSettings(), listBillingCalls({ page_size: 1 })])
      setPrices(list)
      setSettings(s)
      setRateDraft(s.usd_to_cny)
      setCurrencyDraft(s.display_currency)
      setModels(calls.models)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载计费配置失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // 按模型分组（组内：正常价在前，时间段按起日排）。
  const groups = useMemo(() => {
    const map = new Map<string, BillingPrice[]>()
    for (const p of prices) {
      const arr = map.get(p.model_id) ?? []
      arr.push(p)
      map.set(p.model_id, arr)
    }
    return Array.from(map.entries()).map(([model_id, rows]) => ({
      model_id,
      rows: rows.sort((a, b) => (isCatchall(a) ? -1 : isCatchall(b) ? 1 : (a.valid_from ?? 0) - (b.valid_from ?? 0))),
    })).sort((a, b) => a.model_id.localeCompare(b.model_id))
  }, [prices])

  // ── 设置卡 ──────────────────────────────────────────────────────────
  const handleSaveSettings = useCallback(async () => {
    const errors: Record<string, string> = {}
    const n = Number(rateDraft.trim())
    if (rateDraft.trim() === "" || !Number.isFinite(n) || n <= 0) errors.usd_to_cny = "汇率须为 > 0 的数值"
    setSettingsErrors(errors)
    if (Object.keys(errors).length > 0) return
    setSavingSettings(true)
    try {
      const effective = await updateSettings({ usd_to_cny: rateDraft.trim(), display_currency: currencyDraft })
      setSettings(effective)
      setRateDraft(effective.usd_to_cny)
      setCurrencyDraft(effective.display_currency)
      toast.success(`已生效：1 USD = ${effective.usd_to_cny} CNY，展示币种 ${effective.display_currency}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存设置失败")
    } finally {
      setSavingSettings(false)
    }
  }, [rateDraft, currencyDraft])

  // ── 价格表单 ────────────────────────────────────────────────────────
  const openCreate = () => { setForm(EMPTY_FORM); setFormErrors({}); setDialog({ mode: "create" }) }
  const openEdit = (p: BillingPrice) => { setForm(priceFromRow(p)); setFormErrors({}); setDialog({ mode: "edit", price: p }) }

  const submitForm = useCallback(async () => {
    const errors = validateForm(form)
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return
    const input: BillingPriceInput = {
      vendor: form.vendor.trim(), model_id: form.model_id.trim(),
      input_unit_price: Number(form.input_unit_price.trim()),
      output_unit_price: Number(form.output_unit_price.trim()),
      cache_write_unit_price: Number(form.cache_write_unit_price.trim()),
      cache_read_unit_price: Number(form.cache_read_unit_price.trim()),
      currency: form.currency,
      valid_from: form.valid_from || null,
      valid_to: form.valid_to || null,
    }
    try {
      if (dialog?.mode === "edit") await updatePrice(dialog.price.id, input)
      else await createPrice(input)
      toast.success(dialog?.mode === "edit" ? "价格已更新，全部历史账目按新规则重算" : "价格已新增，历史未定价账目立即生效")
      setDialog(null)
      await load()
    } catch (err) {
      toast.error(err instanceof BillingApiError ? `${err.code ? `[${err.code}] ` : ""}${err.message}` : "保存价格失败")
    }
  }, [form, dialog, load])

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deletePrice(id)
      toast.success("价格已删除；该窗口内的历史账目重算为未定价")
      setConfirmDeleteId(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    }
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const unit = (v: number, currency: BillingCurrency) => `${v} ${CURRENCY_SYMBOL[currency]}`

  return (
    <div className="p-4 space-y-4">
      {/* 设置卡：全局手工汇率 + 展示币种（KD7/KD8；NEW-r2 语义 = 即时全局重算） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">全局设置</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="billing-usd-to-cny">汇率（1 USD = N CNY）</Label>
              <div className="flex items-center gap-2">
                <Input id="billing-usd-to-cny" className="w-28" value={rateDraft} onChange={(e) => setRateDraft(e.target.value)} />
                <span className="text-sm text-muted-foreground">CNY</span>
              </div>
              {settingsErrors.usd_to_cny && (
                <p data-testid="field-error-usd_to_cny" className="text-xs text-destructive">{settingsErrors.usd_to_cny}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="billing-display-currency">展示币种</Label>
              <select
                id="billing-display-currency"
                className="h-9 rounded-md border border-pop-bd bg-pop-paper px-2 text-sm"
                value={currencyDraft}
                onChange={(e) => setCurrencyDraft(e.target.value as BillingCurrency)}
              >
                <option value="CNY">CNY</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <Button size="sm" onClick={handleSaveSettings} disabled={savingSettings}>
              {savingSettings ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
              保存设置
            </Button>
            <span className="text-xs text-muted-foreground">
              当前生效：1 USD = {settings.usd_to_cny} CNY · 展示 {settings.display_currency}（改后全局账目即时重算）
            </span>
          </div>
        </CardContent>
      </Card>

      {/* 价格规则表：按模型分组 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">价格规则（单价 = 金额 / 1M tokens；钱查询时算，改价即重算历史）</CardTitle>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" /> 新增价格
          </Button>
        </CardHeader>
        <CardContent>
          {groups.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              还没有配价。为模型配一条「正常价」（全时段兜底，历史账目立即出钱），或加「时间段价」覆盖特定区间（如厂商调价）。
            </p>
          ) : (
            <div className="space-y-4">
              {groups.map(g => (
                <div key={g.model_id} className="rounded-lg border border-pop-bd/60">
                  <div className="px-3 py-2 border-b border-pop-bd/50 font-mono text-sm font-bold">{g.model_id}</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left border-b border-pop-bd/50">
                          {["类型/窗口", "厂商", "输入单价", "输出单价", "缓存写单价", "缓存读单价", "币种", "操作"].map((h) => (
                            <th key={h} className="px-2 py-1.5 font-black whitespace-nowrap text-xs">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {g.rows.map((p) => (
                          <tr key={p.id} className="border-b border-pop-bd/30 last:border-b-0">
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              <span className={isCatchall(p)
                                ? "rounded bg-muted px-1.5 py-0.5 text-xs font-bold"
                                : "rounded border border-pop-bd px-1.5 py-0.5 text-xs"}>
                                {windowLabel(p)}
                              </span>
                            </td>
                            <td className="px-2 py-1.5">{p.vendor}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{unit(p.input_unit_price, p.currency)}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{unit(p.output_unit_price, p.currency)}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{unit(p.cache_write_unit_price, p.currency)}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{unit(p.cache_read_unit_price, p.currency)}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{CURRENCY_SYMBOL[p.currency]}/Mtok</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {confirmDeleteId === p.id ? (
                                <span className="flex items-center gap-1 text-xs">
                                  删除后该窗口账目重算为未定价，确认？
                                  <Button size="sm" variant="destructive" onClick={() => void handleDelete(p.id)}>确认删除</Button>
                                  <Button size="sm" variant="outline" onClick={() => setConfirmDeleteId(null)}>取消</Button>
                                </span>
                              ) : (
                                <span className="flex items-center gap-1">
                                  <Button size="sm" variant="outline" onClick={() => openEdit(p)}>
                                    <Pencil className="h-3 w-3 mr-1" /> 编辑
                                  </Button>
                                  <Button size="sm" variant="outline" onClick={() => setConfirmDeleteId(p.id)}>
                                    <Trash2 className="h-3 w-3 mr-1" /> 删除
                                  </Button>
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 试算器：这笔钱是怎么算出来的 */}
      <PriceCalculator models={models} />

      {/* 新增/编辑弹窗 */}
      {dialog && (
        <div role="dialog" aria-label={dialog.mode === "edit" ? "编辑价格" : "新增价格"} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[520px] max-w-[92vw] rounded-xl border-2 border-pop-bd bg-pop-paper p-4 shadow-lg space-y-3">
            <h3 className="text-base font-black">{dialog.mode === "edit" ? `编辑价格 — ${dialog.price.model_id}` : "新增价格"}</h3>
            <datalist id="billing-model-options">
              {models.map(m => <option key={m} value={m} />)}
            </datalist>
            <div className="grid grid-cols-2 gap-3">
              <Field id="bf-vendor" label="厂商" error={formErrors.vendor}>
                <Input id="bf-vendor" value={form.vendor} onChange={(e) => setForm(f => ({ ...f, vendor: e.target.value }))} />
              </Field>
              <Field id="bf-model-id" errorKey="model_id" label="模型ID（下拉选账本出现过的规范名，也可手输备价）" error={formErrors.model_id}>
                <Input id="bf-model-id" list="billing-model-options" value={form.model_id} onChange={(e) => setForm(f => ({ ...f, model_id: e.target.value }))} />
              </Field>
              {PRICE_FIELDS.map(({ key, label }) => (
                <Field key={key} id={`bf-${key}`} label={label} error={formErrors[key]}>
                  <Input
                    id={`bf-${key}`}
                    inputMode="decimal"
                    value={form[key]}
                    onChange={(e) => setForm(f => ({ ...f, [key]: e.target.value }))}
                  />
                </Field>
              ))}
              <Field id="bf-currency" label="币种" error={formErrors.currency}>
                <select
                  id="bf-currency"
                  className="h-9 w-full rounded-md border border-pop-bd bg-pop-paper px-2 text-sm"
                  value={form.currency}
                  onChange={(e) => setForm(f => ({ ...f, currency: e.target.value as BillingCurrency }))}
                >
                  <option value="CNY">CNY（¥/Mtok）</option>
                  <option value="USD">USD（$/Mtok）</option>
                </select>
              </Field>
              <Field id="bf-valid-from" errorKey="valid_from" label="生效起日（空 = 全时段正常价）" error={formErrors.valid_from}>
                <Input id="bf-valid-from" type="date" value={form.valid_from} onChange={(e) => setForm(f => ({ ...f, valid_from: e.target.value }))} />
              </Field>
              <Field id="bf-valid-to" errorKey="valid_to" label="失效止日（不含当日）" error={formErrors.valid_to}>
                <Input id="bf-valid-to" type="date" value={form.valid_to} onChange={(e) => setForm(f => ({ ...f, valid_to: e.target.value }))} />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">
              单价语义：金额 / 1M tokens。起+止都空 = 正常价（每模型至多一条，全时段兜底）；
              带窗口 = 时间段价（含起日、不含止日，同模型窗口不得重叠）。保存后全部历史账目即时重算。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialog(null)}>取消</Button>
              <Button size="sm" onClick={() => void submitForm()}>保存</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PriceCalculator({ models }: { models: string[] }) {
  const [form, setForm] = useState({
    model: "", date: new Date().toISOString().slice(0, 10),
    input_tokens: "1000000", output_tokens: "100000", cache_creation_tokens: "0", cache_read_tokens: "0",
  })
  const [result, setResult] = useState<BillingPricePreview | null>(null)
  const [busy, setBusy] = useState(false)

  const TOKEN_INPUTS = [
    { key: "input_tokens", label: "输入" },
    { key: "output_tokens", label: "输出" },
    { key: "cache_creation_tokens", label: "缓存写" },
    { key: "cache_read_tokens", label: "缓存读" },
  ] as const

  const run = useCallback(async () => {
    if (!form.model.trim() || !form.date) { toast.error("模型与日期必填"); return }
    setBusy(true)
    try {
      setResult(await previewPrice({
        model: form.model.trim(), date: form.date,
        input_tokens: Math.max(0, Number(form.input_tokens) || 0),
        output_tokens: Math.max(0, Number(form.output_tokens) || 0),
        cache_creation_tokens: Math.max(0, Number(form.cache_creation_tokens) || 0),
        cache_read_tokens: Math.max(0, Number(form.cache_read_tokens) || 0),
      }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "试算失败")
      setResult(null)
    } finally {
      setBusy(false)
    }
  }, [form])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Calculator className="h-4 w-4" /> 试算器 —— 这笔钱是怎么算出来的</CardTitle>
      </CardHeader>
      <CardContent>
        <datalist id="calc-model-options">{models.map(m => <option key={m} value={m} />)}</datalist>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 items-end">
          <Field id="pc-model" label="模型">
            <Input id="pc-model" list="calc-model-options" value={form.model} onChange={(e) => setForm(f => ({ ...f, model: e.target.value }))} placeholder="账本上的规范模型名" />
          </Field>
          <Field id="pc-date" label="日期（查询时刻落在哪个价窗口）">
            <Input id="pc-date" type="date" value={form.date} onChange={(e) => setForm(f => ({ ...f, date: e.target.value }))} />
          </Field>
          <div className="space-y-1">
            <Label>&nbsp;</Label>
            <Button size="sm" onClick={() => void run()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Calculator className="h-4 w-4 mr-1" />}试算
            </Button>
          </div>
          {TOKEN_INPUTS.map(({ key, label }) => (
            <Field key={key} id={`pc-${key}`} label={`${label} token 数`}>
              <Input id={`pc-${key}`} inputMode="numeric" value={form[key]} onChange={(e) => setForm(f => ({ ...f, [key]: e.target.value }))} />
            </Field>
          ))}
        </div>
        {result && (
          <div data-testid="price-preview-result" className="mt-3 rounded-lg border border-pop-bd/60 p-3 text-sm space-y-1">
            {result.price_status === "unpriced" ? (
              <p className="font-bold">未定价 —— 该日期没有命中任何价格行（账本上这笔费用将显示为空，不焊 0）</p>
            ) : (
              <>
                <p>
                  命中价行：<span className="font-mono">{result.vendor ?? "-"}</span> · {result.model ?? "-"}
                  {result.price_id && <span className="text-muted-foreground">（price_id {result.price_id.slice(0, 8)}…）</span>}
                </p>
                <p>
                  费用：<b>{result.cost_native} {result.cost_currency ?? ""}</b>
                  <span className="text-muted-foreground"> = 原币；折 </span>
                  <b>${result.cost_usd}</b>
                  <span className="text-muted-foreground">（展示 </span><b>{result.cost_display} {result.display_currency}</b><span className="text-muted-foreground">，汇率 ×{result.currency_rate}）</span>
                </p>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Field({ id, label, errorKey, error, children }: { id: string; label: string; errorKey?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && <p data-testid={`field-error-${errorKey ?? FIELD_KEY_BY_LABEL[label] ?? label}`} className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

const FIELD_KEY_BY_LABEL: Record<string, string> = {
  厂商: "vendor", 模型ID: "model_id",
  输入单价: "input_unit_price", 输出单价: "output_unit_price",
  缓存写单价: "cache_write_unit_price", 缓存读单价: "cache_read_unit_price",
  币种: "currency",
}
