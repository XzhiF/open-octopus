import { describe, it, expect, afterEach } from "vitest"
import { applyModelPresets, ModelAliasConfigSchema, type ModelAliasConfig } from "../config/model-alias"
import { __buildOverlayForTest, __setPricingOverlayForTest, __resetPricingOverlayForTest, priceFor, type PricingTier } from "../pricing"

// model_presets 预设层（ADR-0015 §model_presets，2026-08-30）：
// ① raw 层继承（前缀预设 > 裸名预设 > 条目自身）
// ② overlay 双键装配（前缀键 = 厂商级；裸键 = claude 代理命面，撞价丢弃 + 预设终审）

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

const tier = (c: typeof COST): PricingTier => ({ input: c.input, output: c.output, cacheRead: c.cacheRead, cacheCreation: c.cacheWrite })

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
    expect(__buildOverlayForTest(cfg)["m"]).toBeUndefined()
  })

  it("无预设时原样通过", () => {
    const raw = rawCfg({ x: [{ id: "a" }] })
    expect(applyModelPresets(raw)).toBe(raw)
  })
})

describe("__buildOverlayForTest — 双键装配与撞价裁决", () => {
  it("单商条目 → 前缀键 + 裸键同时在表", () => {
    const o = __buildOverlayForTest(parse(rawCfg({ dashscope: [{ id: "m", cost: COST }] })))
    expect(o["dashscope/m"]).toEqual(tier(COST))
    expect(o["m"]).toEqual(tier(COST))
  })

  it("多商同名异价无预设 → 裸键丢弃、前缀键各自生效", () => {
    const o = __buildOverlayForTest(parse(rawCfg({
      aa: [{ id: "deepseek-chat", cost: COST }],
      bb: [{ id: "deepseek-chat", cost: COST_B }],
    })))
    expect(o["aa/deepseek-chat"]).toEqual(tier(COST))
    expect(o["bb/deepseek-chat"]).toEqual(tier(COST_B))
    expect(o["deepseek-chat"]).toBeUndefined()
  })

  it("多商同名同价 → 裸键保留", () => {
    const o = __buildOverlayForTest(parse(rawCfg({
      aa: [{ id: "m", cost: COST }],
      bb: [{ id: "m", cost: COST }],
    })))
    expect(o["m"]).toEqual(tier(COST))
  })

  it("裸名预设终审：压过多商撞价", () => {
    const o = __buildOverlayForTest(parse(rawCfg(
      { aa: [{ id: "m", cost: COST }], bb: [{ id: "m", cost: COST_B }] },
      [{ id: "m", cost: COST }],
    )))
    expect(o["m"]).toEqual(tier(COST))
  })

  it("前缀预设覆盖 custom 前缀键（且不动裸键裁决）", () => {
    const o = __buildOverlayForTest(parse(rawCfg(
      { aa: [{ id: "m", cost: COST }], bb: [{ id: "m", cost: COST_B }] },
      [{ id: "aa/m", cost: COST_B }],
    )))
    expect(o["aa/m"]).toEqual(tier(COST_B))
    expect(o["m"]).toBeUndefined() // 撞价依旧无裸键
  })

  it("预设独立挂价（custom 无此条目）也进 overlay", () => {
    const o = __buildOverlayForTest(parse(rawCfg({}, [{ id: "qwen3.8-flash", cost: COST }])))
    expect(o["qwen3.8-flash"]).toEqual(tier(COST))
  })

  it("预设 cost 块不完整 → 不参与定价；无 cost 预设纯继承不影响 overlay", () => {
    const o = __buildOverlayForTest(parse(rawCfg({}, [
      { id: "p1", cost: { input: 1, output: 2 } },
      { id: "p2", context_window: 65536 },
    ])))
    expect(o["p1"]).toBeUndefined()
    expect(o["p2"]).toBeUndefined()
  })
})

describe("priceFor 双键命中（overlay 注入）", () => {
  afterEach(() => __resetPricingOverlayForTest())

  it("pi 报前缀名命中厂商级价；claude 代理报裸名[1m]命中裸键", () => {
    __setPricingOverlayForTest(__buildOverlayForTest(parse(rawCfg(
      { dashscope: [{ id: "qwen3.7-max", cost: COST }] },
      [{ id: "qwen3.8-flash", cost: COST_B }],
    ))))
    expect(priceFor("dashscope/qwen3.7-max")).toEqual(tier(COST))
    expect(priceFor("qwen3.7-max")).toEqual(tier(COST))
    expect(priceFor("qwen3.8-flash[1m]")).toEqual(tier(COST_B))
    expect(priceFor("qwen3.8-flash[1M]")).toEqual(tier(COST_B))
    // 撞价场景裸名诚实为 NULL
    const conflicted = __buildOverlayForTest(parse(rawCfg({
      aa: [{ id: "x", cost: COST }], bb: [{ id: "x", cost: COST_B }],
    })))
    __setPricingOverlayForTest(conflicted)
    expect(priceFor("x")).toBeNull()
    expect(priceFor("x[1m]")).toBeNull()
    expect(priceFor("aa/x")).toEqual(tier(COST))
  })
})
