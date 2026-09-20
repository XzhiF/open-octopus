import type { BillingCurrency, BillingPriceRow } from "../db/dao/billing-dao"
import { BillingDAO } from "../db/dao/billing-dao"

/**
 * BillingService — 算钱的唯一 seam（billing-core-1 ticket 02 / spec「单一 seam」）。
 *
 * 所有记账写入口的 cost 都必须经这里产出（票 04 接线）；SDK 上报的 `costUsd`
 * 字段不作为账（KD2），本 service 的输入只有 四类 token 数 + 配置价格行。
 *
 * 口径：
 *   - US3  `cost_native = Σ(四类 token × 对应单价) / 1_000_000`（单价 = 金额/1M，KD6）
 *   - KD5  `cost_usd` 存按记账时刻汇率归一的 USD 值；原币 USD 时同值直存
 *   - KD7  汇率每次 compute 实时读 `billing_setting.usd_to_cny`，不缓存、不锁历史
 *   - KD4  匹配不到价格行 → cost 三元组 NULL + `price_status='unpriced'`，绝不估算
 *   - KD9  匹配 = `llm_calls.model` 与价格行 `model_id` 精确相等；null/'' 直接未匹配
 */

/** 四类 token 用量 —— 与采集 seam（tracker result chunk / llm_calls 列）同语义。 */
export interface TokenCostUsage {
  inputTokens: number
  outputTokens: number
  /** 缓存写入（cache_creation）*/
  cacheCreationTokens: number
  /** 缓存读取（cache_read）*/
  cacheReadTokens: number
}

/** 落进 llm_calls 三新列（v45）的快照三元组 + 状态。 */
export interface CallCost {
  cost_native: number | null
  cost_currency: BillingCurrency | null
  cost_usd: number | null
  price_status: "priced" | "unpriced"
}

const UNPRICED: CallCost = {
  cost_native: null,
  cost_currency: null,
  cost_usd: null,
  price_status: "unpriced",
}

export class BillingService {
  constructor(private readonly dao: BillingDAO) {}

  /** KD9：model_id 精确匹配。null/''/未知 → null（= 未匹配，交给 compute 出 unpriced）。 */
  matchPrice(model: string | null | undefined): BillingPriceRow | null {
    if (!model) return null
    return this.dao.getPriceByModel(model)
  }

  /**
   * US3/KD5：按配置价格算钱。price 为 null → KD4 未定价三元组（不估算）。
   * 汇率在调用时刻实时读取（KD7）——改 setting 立即影响下一笔 compute（US6 的
   * 「只影响新调用」由各记账点的快照写库保证，本函数自身无状态）。
   */
  compute(usage: TokenCostUsage, price: BillingPriceRow | null): CallCost {
    if (!price) return { ...UNPRICED }
    const costNative =
      (usage.inputTokens * price.input_unit_price +
        usage.outputTokens * price.output_unit_price +
        usage.cacheCreationTokens * price.cache_write_unit_price +
        usage.cacheReadTokens * price.cache_read_unit_price) /
      1_000_000
    const costUsd = price.currency === "USD" ? costNative : costNative / this.dao.getUsdToCny()
    return {
      cost_native: costNative,
      cost_currency: price.currency,
      cost_usd: costUsd,
      price_status: "priced",
    }
  }

  /** match + compute 的组合入口 —— 票 04 记账接线用的就是这一个调用点。 */
  computeForModel(model: string | null | undefined, usage: TokenCostUsage): CallCost {
    return this.compute(usage, this.matchPrice(model))
  }
}
