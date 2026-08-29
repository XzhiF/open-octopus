import { priceFor, estimateCost } from '@octopus/shared'
import type { ModelUsage, TokenUsage, TokenUsageDelta } from '@octopus/shared'

/**
 * 单次 LLM call 记录。token 字段继承全站规范形状 TokenUsage
 * （纯值口径：inputTokens 不含 cache，见 shared/types/usage.ts）。
 */
export interface LLMCallRecord extends TokenUsage {
  turnIndex: number
  messageId: string
  model?: string
  stopReason?: string
  timestamp: number
  durationMs: number
  ttftMs?: number
  costUsd?: number
}

interface ActiveCall {
  messageId: string
  model?: string
  startTime: number
  firstTokenTime?: number
  stopReason?: string
  /** message_delta 实测 usage（SDK/端点提供时）。calibrate 阶段保留不覆盖 */
  usage?: TokenUsageDelta
}

/**
 * 归一化 model name，剥离两类常见"装饰"：
 *
 * 1. ANSI escape sequences（例如终端 bold `\x1b[1m`）。
 *    某些 SDK 版本会在 result.modelUsage 的 key 里混入这些控制码。
 *
 * 2. Literal 变体后缀（例如 Qwen 的 `[1m]` = 1M context 变体）。
 *    SDK 在 stream event 的 message.model 字段里返回 clean name
 *    （`qwen3.7-max`），但在 result.modelUsage 的 key 里可能返回带变体
 *    后缀的版本（`qwen3.7-max[1m]`），导致按 key 匹配失败。
 *
 * 归一化后两种写法会收敛到同一 key，让 calibrateFromModelUsage 匹配成功。
 */
function normalizeModelName(value: string): string {
  // 1. 剥离 ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  let normalized = value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  // 2. 剥离末尾的 `[Xm]` / `[Xk]` 变体后缀（X = 数字，例如 [1m]、[32k]）
  //    仅剥离末尾的、符合此模式的片段，避免误伤模型名中间的合法方括号
  normalized = normalized.replace(/\[\d+[mk]\]$/i, '')
  return normalized
}

/**
 * 「保留实测 + 残差分配」的字段级分配器。
 * 不变式：authTotal ≥ Σ(measured) 时，分配后 Σ === authTotal（严格相等）。
 */
function distributeResidual(
  calls: LLMCallRecord[],
  authTotal: number,
  get: (c: LLMCallRecord) => number,
  set: (c: LLMCallRecord, v: number) => void,
): void {
  if (authTotal <= 0) return
  const measured = calls.reduce((s, c) => s + (get(c) || 0), 0)
  const residual = authTotal - measured
  if (residual <= 0) return // 实测已 ≥ 权威值：信任实测，不倒扣
  const unfilled = calls.filter(c => (get(c) || 0) === 0)
  if (unfilled.length === 0) {
    const last = calls[calls.length - 1]
    set(last, get(last) + residual)
    return
  }
  const per = Math.floor(residual / unfilled.length)
  unfilled.forEach((c, i) => {
    set(c, i === unfilled.length - 1 ? residual - per * (unfilled.length - 1) : per)
  })
}

export class LLMCallTracker {
  private activeCalls = new Map<string, ActiveCall>()
  private completedCalls: LLMCallRecord[] = []
  private currentTurn = 0

  /**
   * Stream 阶段记录元数据 + message_delta 的实测 usage（若有）。
   * 权威总量仍由 calibrateFromModelUsage 在 result 时保证 Σ===authTotal，
   * 但 calibrate 会保留这里的实测值，只分配残差。
   *
   * 不读 message_start.usage.input_tokens：该字段含 cache-reused tokens，
   * 实测放大数千倍（35355 vs 真值 18）。
   *
   * 模型名会剥离 ANSI 转义码，确保和 result.modelUsage 的 key 对齐。
   */
  onMessageStart(messageId: string, model?: string): void {
    this.currentTurn++
    this.activeCalls.set(messageId, {
      messageId,
      model: model != null ? normalizeModelName(model) : undefined,
      startTime: Date.now(),
    })
  }

  onTextDelta(): void {
    this.markFirstToken()
  }

  onThinkingDelta(): void {
    this.markFirstToken()
  }

  /**
   * message_delta 携带本条消息的累计终值 usage（output_tokens 必有，
   * input/cache 按端点可能缺失）。stopReason 与 usage 都记录到 ActiveCall。
   */
  onMessageDelta(stopReason?: string, usage?: ActiveCall['usage']): void {
    if (!stopReason && !usage) return
    for (const call of this.activeCalls.values()) {
      if (stopReason) call.stopReason = stopReason
      if (usage) call.usage = { ...(call.usage ?? {}), ...usage }
    }
  }

  onMessageStop(messageId: string): LLMCallRecord | null {
    const call = this.activeCalls.get(messageId)
    if (!call) return null

    this.activeCalls.delete(messageId)

    // 实测值优先；未携带 usage 的字段为 0，由 calibrateFromModelUsage 分配残差。
    const record: LLMCallRecord = {
      turnIndex: this.currentTurn || 1,
      messageId: call.messageId,
      model: call.model,
      stopReason: call.stopReason,
      timestamp: call.startTime,
      durationMs: Date.now() - call.startTime,
      ttftMs: call.firstTokenTime ? call.firstTokenTime - call.startTime : undefined,
      inputTokens: call.usage?.inputTokens ?? 0,
      outputTokens: call.usage?.outputTokens ?? 0,
      cacheReadTokens: call.usage?.cacheReadTokens ?? 0,
      cacheCreationTokens: call.usage?.cacheCreationTokens ?? 0,
      // C2：cost 初始不是 0 而是未知 —— 0 会在下游 ?? 兜底里伪装成实测值
    }
    this.completedCalls.push(record)
    return record
  }

  updateModel(messageId: string, model: string): void {
    const call = this.activeCalls.get(messageId)
    if (call) call.model = normalizeModelName(model)
  }

  /**
   * 用 result 事件的权威 modelUsage（全站规范形状 ModelUsage[]，由 provider
   * 在 SDK seam 完成 snake→规范转换后传入）覆盖 completedCalls 的 token / cost 字段。
   *
   * 分配策略：
   *   - 按模型分组（模型名先 normalizeModelName，与 stream 阶段记录的 key 对齐）
   *   - 同模型 N 个 call 均匀分配（floor），余数丢到最后一个 call
   *   - 保证 SUM(call.token) === authTotal（严格相等，无累积误差）
   *
   * 如果 result 事件不到达，completedCalls 保持全 0 — 这比显示错误数据更好。
   */
  calibrateFromModelUsage(modelUsages: readonly ModelUsage[]): void {
    if (!modelUsages || modelUsages.length === 0) return

    const callsByModel = new Map<string, LLMCallRecord[]>()
    for (const call of this.completedCalls) {
      const model = call.model ?? 'unknown'
      if (!callsByModel.has(model)) callsByModel.set(model, [])
      callsByModel.get(model)!.push(call)
    }

    for (const usage of modelUsages) {
      // 剥离 ANSI 转义码，和 tracker 存的 clean model key 对齐
      const model = normalizeModelName(usage.model)
      const calls = callsByModel.get(model)
      if (!calls || calls.length === 0) continue

      const authInput = usage.inputTokens ?? 0
      const authOutput = usage.outputTokens ?? 0
      const authCacheRead = usage.cacheReadTokens ?? 0
      const authCacheCreation = usage.cacheCreationTokens ?? 0
      // SDK 给了 costUSD 就用（0 视为未定价，seam 已归一 undefined）；
      // 否则查 shared 价表估算（models.yaml 补价通道）。未定价 → null → 不编数。
      const authCost = usage.costUsd ?? estimateCost(usage, priceFor(model))

      // 每个 token 字段独立做「保留实测 + 残差分配」：
      //   - residual = authTotal − Σ(measured)；≤0 时信任实测，不倒扣
      //   - residual 优先分给该字段为 0 的 records（未测得），floor + 尾差
      //   - 无未测 record 时并入最后一条（吸收同模型辅助调用等真实开销）
      //   - 全部未测时退化为原「均匀分配」语义，Σ===authTotal 不变
      distributeResidual(calls, authInput, c => c.inputTokens, (c, v) => { c.inputTokens = v })
      distributeResidual(calls, authOutput, c => c.outputTokens, (c, v) => { c.outputTokens = v })
      distributeResidual(calls, authCacheRead, c => c.cacheReadTokens, (c, v) => { c.cacheReadTokens = v })
      distributeResidual(calls, authCacheCreation, c => c.cacheCreationTokens, (c, v) => { c.cacheCreationTokens = v })

      // costUsd 无 per-turn 实测来源（价格表不完整），仍按均匀分配到全部 records。
      // 未定价（authCost === null）时跳过分配：records 保持未知，下游写 NULL。
      const n = calls.length
      if (authCost !== null) {
        // costUsd 用整数皮科单位（1e12）分配，避免浮点精度问题
        // 1e12 足以覆盖 $0.000001 ~ $10000 的典型 cost 范围，
        // 且乘以 1e12 后仍在 Number.MAX_SAFE_INTEGER 范围内
        const costPicous = Math.round(authCost * 1e12)
        const perCostPicous = Math.floor(costPicous / n)

        for (let i = 0; i < n; i++) {
          const isLast = i === n - 1
          calls[i].costUsd = isLast
            ? (costPicous - perCostPicous * (n - 1)) / 1e12
            : perCostPicous / 1e12
        }
      }
    }
  }

  getAllCalls(): LLMCallRecord[] {
    return [...this.completedCalls]
  }

  /**
   * 别名，与 IAgentProvider.getLLMCalls 接口签名对齐。
   */
  getLLMCalls(): LLMCallRecord[] {
    return this.getAllCalls()
  }

  reset(): void {
    this.activeCalls.clear()
    this.completedCalls = []
    this.currentTurn = 0
  }

  private markFirstToken(): void {
    for (const call of this.activeCalls.values()) {
      if (!call.firstTokenTime) {
        call.firstTokenTime = Date.now()
      }
    }
  }
}
