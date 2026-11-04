import { describe, it, expect } from "vitest"
import { applyModelPresets, ModelAliasConfigSchema, type ModelAliasConfig } from "../config/model-alias"

// model_presets 预设层（ADR-0015 §model_presets，2026-08-30）：
// raw 层继承（前缀预设 > 裸名预设 > 条目自身）。
// 2026-11-04：shared 的 models.yaml/内置价 overlay 已删（唯一计价源 =
// server billing_price_config），此处只测预设继承本身。

const COST = { input: 0.2, output: 1.5, cacheRead: 0.04, cacheWrite: 0.25 }
const COST_B = { input: 0.5, output: 2.5, cacheRead: 0.1, cacheWrite: 0.6 }

function rawCfg(custom: Record<string, unknown[]>, presets: unknown[] = []): Record<string, unknown> {
  return {
    default: "pro",
    custom_providers: Object.fromEntries(
      Object.entries(custom).map(([p, models]) => [p, { base_url: "http://x", models }]),
    ),
    model_presets: presets,
  }
}

function parse(cfg: Record<string, unknown>): ModelAliasConfig {
  const r = ModelAliasConfigSchema.safeParse(applyModelPresets(cfg))
  if (!r.success) throw new Error(JSON.stringify(r.error.issues))
  return r.data
}

describe("applyModelPresets — raw 层继承", () => {
  it("裸名预设供给缺失字段（cost/context_window）", () => {
    const cfg = parse(rawCfg(
      { dashscope: [{ id: "qwen3.7-max" }] },
      [{ id: "qwen3.7-max", cost: COST, context_window: 131072 }],
    ))
    const m = cfg.custom_providers.dashscope.models[0]
    expect(m.cost).toEqual(COST)
    expect(m.context_window).toBe(131072)
  })

  it("前缀预设优先于裸名预设", () => {
    const cfg = parse(rawCfg(
      { dashscope: [{ id: "glm" }] },
      [
        { id: "glm", cost: COST },
        { id: "dashscope/glm", cost: COST_B },
      ],
    ))
    expect(cfg.custom_providers.dashscope.models[0].cost).toEqual(COST_B)
  })

  it("条目已写优先；cost 逐字段合并（条目 input 压预设，缺的从预设补）", () => {
    const cfg = parse(rawCfg(
      { dashscope: [{ id: "m", cost: { input: 9 } }] },
      [{ id: "m", cost: COST }],
    ))
    expect(cfg.custom_providers.dashscope.models[0].cost).toEqual({ ...COST, input: 9 })
  })

  it("键匹配 trim+lowercase（预设 DashScope/Qwen 命中 qwen）", () => {
    const cfg = parse(rawCfg(
      { dashscope: [{ id: "Qwen " }] },
      [{ id: " DashScope/QWEN ", cost: COST }],
    ))
    expect(cfg.custom_providers.dashscope.models[0].cost).toEqual(COST)
  })

  it("id/name 不被继承覆盖", () => {
    const cfg = parse(rawCfg(
      { dashscope: [{ id: "m", name: "mine" }] },
      [{ id: "m", name: "preset-name", cost: COST }],
    ))
    expect(cfg.custom_providers.dashscope.models[0].name).toBe("mine")
  })

  it("预设 cost 块不完整 → 不流入继承（防 schema default(0) 补出半假价）", () => {
    const cfg = parse(rawCfg(
      { dashscope: [{ id: "m" }] },
      [{ id: "m", cost: { input: 1, output: 2 }, context_window: 65536 }],
    ))
    const m = cfg.custom_providers.dashscope.models[0]
    expect(m.context_window).toBe(65536)          // 标量字段照常继承
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) // 未定价而非半假价
  })

  it("无预设时原样通过", () => {
    const raw = rawCfg({ x: [{ id: "a" }] })
    expect(applyModelPresets(raw)).toBe(raw)
  })
})
