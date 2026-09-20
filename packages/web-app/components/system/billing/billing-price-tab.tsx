"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2, Plus, Save, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  listPrices, createPrice, updatePrice, deletePrice,
  getSettings, updateSettings,
  BillingApiError,
  type BillingPrice, type BillingPriceInput, type BillingSettings, type BillingCurrency,
} from "@/lib/billing-api"

/** 票 05 · 价格配置 Tab —— 汇率/展示币种设置卡 + 价格 CRUD 表 + 弹窗表单。 */

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
}
const EMPTY_FORM: FormState = { vendor: "", model_id: "", input_unit_price: "", output_unit_price: "", cache_write_unit_price: "", cache_read_unit_price: "", currency: "CNY" }

function priceFromRow(p: BillingPrice): FormState {
  return {
    vendor: p.vendor, model_id: p.model_id,
    input_unit_price: String(p.input_unit_price), output_unit_price: String(p.output_unit_price),
    cache_write_unit_price: String(p.cache_write_unit_price), cache_read_unit_price: String(p.cache_read_unit_price),
    currency: p.currency,
  }
}

/** 前端校验与票 03 API 口径对齐：vendor/model_id 非空、四单价为 ≥0 数值、币种枚举。 */
function validateForm(form: FormState): Partial<Record<keyof FormState, string>> {
  const errors: Partial<Record<keyof FormState, string>> = {}
  if (!form.vendor.trim()) errors.vendor = "厂商不能为空"
  if (!form.model_id.trim()) errors.model_id = "模型ID不能为空"
  for (const { key, label } of PRICE_FIELDS) {
    const n = Number(form[key].trim())
    if (form[key].trim() === "" || !Number.isFinite(n) || n < 0) errors[key] = `${label}须为 ≥ 0 的数值`
  }
  if (!["USD", "CNY"].includes(form.currency)) errors.currency = "币种只能是 USD 或 CNY"
  return errors
}

export function BillingPriceTab() {
  const [prices, setPrices] = useState<BillingPrice[]>([])
  const [settings, setSettings] = useState<BillingSettings>({ usd_to_cny: "7.0", display_currency: "CNY" })
  const [rateDraft, setRateDraft] = useState("7.0")
  const [currencyDraft, setCurrencyDraft] = useState<BillingCurrency>("CNY")
  const [loading, setLoading] = useState(true)
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsErrors, setSettingsErrors] = useState<Record<string, string>>({})
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; price: BillingPrice } | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [list, s] = await Promise.all([listPrices(), getSettings()])
      setPrices(list)
      setSettings(s)
      setRateDraft(s.usd_to_cny)
      setCurrencyDraft(s.display_currency)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载计费配置失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // ── 设置卡 ──────────────────────────────────────────────────────────
  const handleSaveSettings = useCallback(async () => {
    const errors: Record<string, string> = {}
    const n = Number(rateDraft.trim())
    if (rateDraft.trim() === "" || !Number.isFinite(n) || n <= 0) errors.usd_to_cny = "汇率须为 > 0 的数值"
    setSettingsErrors(errors)
    if (Object.keys(errors).length > 0) return
    setSavingSettings(true)
    try {
      // 保存 → 以服务端回读值展示（票 05 AC3）
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
    if (Object.keys(errors).length > 0) return // 前端拦截，不发请求（AC2）
    const input: BillingPriceInput = {
      vendor: form.vendor.trim(), model_id: form.model_id.trim(),
      input_unit_price: Number(form.input_unit_price.trim()),
      output_unit_price: Number(form.output_unit_price.trim()),
      cache_write_unit_price: Number(form.cache_write_unit_price.trim()),
      cache_read_unit_price: Number(form.cache_read_unit_price.trim()),
      currency: form.currency,
    }
    try {
      if (dialog?.mode === "edit") await updatePrice(dialog.price.id, input)
      else await createPrice(input)
      toast.success(dialog?.mode === "edit" ? "价格已更新，只影响新调用" : "价格已新增")
      setDialog(null)
      await load()
    } catch (err) {
      // 409 DUPLICATE_MODEL_ID 等 → API 错误信息透出
      toast.error(err instanceof BillingApiError ? `${err.code ? `[${err.code}] ` : ""}${err.message}` : "保存价格失败")
    }
  }, [form, dialog, load])

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deletePrice(id)
      toast.success("价格已删除，历史行数字不变")
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
      {/* 设置卡：全局手工汇率 + 展示币种（KD7/KD8） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">全局设置</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="billing-usd-to-cny">汇率（1 USD = N CNY）</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="billing-usd-to-cny"
                  className="w-28"
                  value={rateDraft}
                  onChange={(e) => setRateDraft(e.target.value)}
                />
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
              当前生效：1 USD = {settings.usd_to_cny} CNY · 展示 {settings.display_currency}（改后即时生效，只影响新调用）
            </span>
          </div>
        </CardContent>
      </Card>

      {/* 价格表 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">模型价格（单价 = 金额 / 1M tokens）</CardTitle>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" /> 新增价格
          </Button>
        </CardHeader>
        <CardContent>
          {prices.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              还没有配价。点击「新增价格」按 厂商 + 模型ID 配置四类 token 单价；未配价的模型调用会记为「未定价」，费用留空。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b-2 border-pop-bd">
                    {["厂商", "模型ID", "输入单价", "输出单价", "缓存写单价", "缓存读单价", "币种", "操作"].map((h) => (
                      <th key={h} className="px-2 py-2 font-black whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {prices.map((p) => (
                    <tr key={p.id} className="border-b border-pop-bd/50">
                      <td className="px-2 py-2">{p.vendor}</td>
                      <td className="px-2 py-2 font-mono">{p.model_id}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{unit(p.input_unit_price, p.currency)}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{unit(p.output_unit_price, p.currency)}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{unit(p.cache_write_unit_price, p.currency)}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{unit(p.cache_read_unit_price, p.currency)}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{p.currency}（{CURRENCY_SYMBOL[p.currency]}/Mtok）</td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {confirmDeleteId === p.id ? (
                          <span className="flex items-center gap-1 text-xs">
                            确认删除？
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
          )}
        </CardContent>
      </Card>

      {/* 新增/编辑弹窗 */}
      {dialog && (
        <div role="dialog" aria-label={dialog.mode === "edit" ? "编辑价格" : "新增价格"} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[480px] max-w-[92vw] rounded-xl border-2 border-pop-bd bg-pop-paper p-4 shadow-lg space-y-3">
            <h3 className="text-base font-black">{dialog.mode === "edit" ? `编辑价格 — ${dialog.price.model_id}` : "新增价格"}</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field id="bf-vendor" label="厂商" error={formErrors.vendor}>
                <Input id="bf-vendor" value={form.vendor} onChange={(e) => setForm(f => ({ ...f, vendor: e.target.value }))} />
              </Field>
              <Field id="bf-model-id" label="模型ID" error={formErrors.model_id}>
                <Input id="bf-model-id" value={form.model_id} onChange={(e) => setForm(f => ({ ...f, model_id: e.target.value }))} />
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
            </div>
            <p className="text-xs text-muted-foreground">单价语义：金额 / 1M tokens；改价只影响新调用，历史行数字不变。</p>
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

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && <p data-testid={`field-error-${FIELD_KEY_BY_LABEL[label] ?? label}`} className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

const FIELD_KEY_BY_LABEL: Record<string, string> = {
  厂商: "vendor", 模型ID: "model_id",
  输入单价: "input_unit_price", 输出单价: "output_unit_price",
  缓存写单价: "cache_write_unit_price", 缓存读单价: "cache_read_unit_price",
  币种: "currency",
}
