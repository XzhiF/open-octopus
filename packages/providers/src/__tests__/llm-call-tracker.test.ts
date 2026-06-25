import { describe, it, expect } from "vitest"
import { LLMCallTracker } from "../llm-call-tracker"

/**
 * LLMCallTracker 单元测试
 *
 * 核心设计：tracker 在 stream 阶段只记录元数据，token 字段全部为 0。
 * 等 result 事件到达时，calibrateFromModelUsage 用 modelUsage 的权威
 * 总量按模型均匀分配到该模型的 completed calls 上。
 *
 * 测试场景 (A-F)：
 *   A. 1 模型 1 call：calibrate 后 call 的 token 完全等于 modelUsage
 *   B. 1 模型 3 calls：均匀分配，余数丢到最后一个 call
 *   C. 2 模型各 2 calls：按模型分组独立分配
 *   D. modelUsage 为空对象：completedCalls 保持全 0
 *   E. calls 中没有的 model 出现在 modelUsage：不崩溃、忽略
 *   F. result 事件不到达：getLLMCalls 返回全 0 的 records
 */

function makeModelUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0,
  costUSD?: number
): Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }> {
  return {
    [model]: { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD },
  }
}

/**
 * 模拟一个完整的 message 生命周期：start → delta(stopReason) → stop
 * 返回 messageId 供后续断言使用
 */
function simulateOneCall(tracker: LLMCallTracker, model: string, messageId: string): string {
  tracker.onMessageStart(messageId, model)
  tracker.onTextDelta()
  tracker.onMessageDelta("end_turn")
  tracker.onMessageStop(messageId)
  return messageId
}

describe("LLMCallTracker", () => {
  describe("stream 阶段不记录 token（所有 token 字段应为 0）", () => {
    it("单个 call 的 inputTokens / outputTokens / cache / cost 在 stream 阶段保持 0", () => {
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-1")

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(1)
      expect(calls[0].inputTokens).toBe(0)
      expect(calls[0].outputTokens).toBe(0)
      expect(calls[0].cacheReadTokens).toBe(0)
      expect(calls[0].cacheCreationTokens).toBe(0)
      expect(calls[0].costUsd).toBe(0)
    })

    it("result 事件不到达时 (Case F)：getLLMCalls 返回全 0 的 records", () => {
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-1")
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-2")

      // 不调用 calibrateFromModelUsage，模拟 result 事件丢失
      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(2)
      for (const call of calls) {
        expect(call.inputTokens).toBe(0)
        expect(call.outputTokens).toBe(0)
        expect(call.costUsd).toBe(0)
      }
    })
  })

  describe("calibrateFromModelUsage (权威覆盖)", () => {
    it("Case A: 1 模型 1 call，calibrate 后 call 的 token 完全等于 modelUsage", () => {
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-1")

      tracker.calibrateFromModelUsage(
        makeModelUsage("claude-sonnet-4-5-20250827", 1000, 500, 200, 100, 0.05)
      )

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(1)
      expect(calls[0].inputTokens).toBe(1000)
      expect(calls[0].outputTokens).toBe(500)
      expect(calls[0].cacheReadTokens).toBe(200)
      expect(calls[0].cacheCreationTokens).toBe(100)
      expect(calls[0].costUsd).toBeCloseTo(0.05, 6)
    })

    it("Case B: 1 模型 3 calls，均匀分配，余数丢到最后一个 call", () => {
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-1")
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-2")
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-3")

      // input 1000 / 3 = 333.333 → 333, 333, 334（余数丢到最后一个）
      // output 500 / 3 = 166.666 → 166, 166, 168
      tracker.calibrateFromModelUsage(
        makeModelUsage("claude-sonnet-4-5-20250827", 1000, 500)
      )

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(3)

      // 总和严格等于权威值
      const totalInput = calls.reduce((s, c) => s + c.inputTokens, 0)
      const totalOutput = calls.reduce((s, c) => s + c.outputTokens, 0)
      expect(totalInput).toBe(1000)
      expect(totalOutput).toBe(500)

      // 前两个 call 是 floor，最后一个 call 拿走余数
      expect(calls[0].inputTokens).toBe(333)
      expect(calls[1].inputTokens).toBe(333)
      expect(calls[2].inputTokens).toBe(334)

      expect(calls[0].outputTokens).toBe(166)
      expect(calls[1].outputTokens).toBe(166)
      expect(calls[2].outputTokens).toBe(168)
    })

    it("Case C: 2 模型各 2 calls，按模型分组独立分配", () => {
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-s1")
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-s2")
      simulateOneCall(tracker, "claude-opus-4-20250514", "msg-o1")
      simulateOneCall(tracker, "claude-opus-4-20250514", "msg-o2")

      tracker.calibrateFromModelUsage({
        "claude-sonnet-4-5-20250827": { inputTokens: 1000, outputTokens: 500 },
        "claude-opus-4-20250514": { inputTokens: 2000, outputTokens: 1000 },
      })

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(4)

      // Sonnet 组
      const sonnetCalls = calls.filter(c => c.model === "claude-sonnet-4-5-20250827")
      expect(sonnetCalls).toHaveLength(2)
      expect(sonnetCalls[0].inputTokens).toBe(500)
      expect(sonnetCalls[1].inputTokens).toBe(500)
      expect(sonnetCalls[0].outputTokens).toBe(250)
      expect(sonnetCalls[1].outputTokens).toBe(250)

      // Opus 组
      const opusCalls = calls.filter(c => c.model === "claude-opus-4-20250514")
      expect(opusCalls).toHaveLength(2)
      expect(opusCalls[0].inputTokens).toBe(1000)
      expect(opusCalls[1].inputTokens).toBe(1000)
      expect(opusCalls[0].outputTokens).toBe(500)
      expect(opusCalls[1].outputTokens).toBe(500)
    })

    it("Case D: modelUsage 为空对象 → completedCalls 保持全 0", () => {
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-1")

      tracker.calibrateFromModelUsage({})

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(1)
      expect(calls[0].inputTokens).toBe(0)
      expect(calls[0].outputTokens).toBe(0)
    })

    it("Case E: calls 中没有 model X，modelUsage 有 model X → 不崩溃", () => {
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-1")

      // modelUsage 里有一个 tracker 没记录到的模型
      expect(() => {
        tracker.calibrateFromModelUsage({
          "claude-sonnet-4-5-20250827": { inputTokens: 1000, outputTokens: 500 },
          "claude-opus-4-20250514": { inputTokens: 2000, outputTokens: 1000 },
        })
      }).not.toThrow()

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(1)
      // Sonnet 的 call 应该正常分配
      expect(calls[0].inputTokens).toBe(1000)
      expect(calls[0].outputTokens).toBe(500)
    })

    it("无 costUSD 时按 pricing 自动算", () => {
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-1")

      // 不传 costUSD，让 tracker 根据 MODEL_PRICING 自动计算
      // sonnet: input 3/1e6, output 15/1e6, cacheRead 0.30/1e6, cacheCreation 3.75/1e6
      // 1000 * 3/1e6 + 500 * 15/1e6 + 200 * 0.30/1e6 + 100 * 3.75/1e6 = 0.010935
      tracker.calibrateFromModelUsage(
        makeModelUsage("claude-sonnet-4-5-20250827", 1000, 500, 200, 100)
      )

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(1)
      expect(calls[0].costUsd).toBeCloseTo(0.010935, 6)
    })

    it("calibrate 可多次调用，后调覆盖前调", () => {
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-1")

      // 第一次 calibrate
      tracker.calibrateFromModelUsage(
        makeModelUsage("claude-sonnet-4-5-20250827", 1000, 500)
      )
      expect(tracker.getLLMCalls()[0].inputTokens).toBe(1000)

      // 第二次 calibrate 覆盖
      tracker.calibrateFromModelUsage(
        makeModelUsage("claude-sonnet-4-5-20250827", 2000, 1000)
      )
      expect(tracker.getLLMCalls()[0].inputTokens).toBe(2000)
      expect(tracker.getLLMCalls()[0].outputTokens).toBe(1000)
    })

    it("calibrateFromModelUsage 接收 null/undefined 不崩溃", () => {
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-1")

      expect(() => tracker.calibrateFromModelUsage(null as unknown as Record<string, never>)).not.toThrow()
      expect(() => tracker.calibrateFromModelUsage(undefined as unknown as Record<string, never>)).not.toThrow()

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(1)
      expect(calls[0].inputTokens).toBe(0)
      expect(calls[0].outputTokens).toBe(0)
    })

    it("Case B 扩展：多 call 的 costUsd 均匀分配，总和严格等于 authCost", () => {
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-1")
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-2")
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-3")

      const authCost = 0.123456789
      tracker.calibrateFromModelUsage({
        "claude-sonnet-4-5-20250827": {
          inputTokens: 1000,
          outputTokens: 500,
          costUSD: authCost,
        },
      })

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(3)

      // 每个 call 的 costUsd 都存在
      for (const call of calls) {
        expect(typeof call.costUsd).toBe("number")
        expect(call.costUsd).toBeGreaterThan(0)
      }

      // 总和严格等于 authCost（允许 IEEE 754 浮点 1e-12 级误差）
      const totalCost = calls.reduce((s, c) => s + (c.costUsd ?? 0), 0)
      expect(totalCost).toBeCloseTo(authCost, 10)
    })
  })

  describe("元数据字段（不受 calibrate 影响）", () => {
    it("保留 messageId / model / stopReason / durationMs", () => {
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-1")

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(1)
      expect(calls[0].messageId).toBe("msg-1")
      expect(calls[0].model).toBe("claude-sonnet-4-5-20250827")
      expect(calls[0].stopReason).toBe("end_turn")
      expect(calls[0].durationMs).toBeGreaterThanOrEqual(0)
    })

    it("onMessageStart 只接受 (messageId, model) 两个参数", () => {
      const tracker = new LLMCallTracker()
      // 新接口签名：onMessageStart(messageId, model)
      // 第二个参数是 model，不是 inputTokens
      tracker.onMessageStart("msg-1", "claude-sonnet-4-5-20250827")
      tracker.onMessageStop("msg-1")

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(1)
      expect(calls[0].messageId).toBe("msg-1")
      expect(calls[0].model).toBe("claude-sonnet-4-5-20250827")
    })

    it("calibrate 时 model key 必须与 tracker 存的 model 完全一致（full ID，非 alias）", () => {
      // 这是审查者 CRITICAL 问题的回归测试：
      // provider 曾经把短别名 'sonnet' 存到 tracker，但 result.modelUsage
      // 的 key 是完整 ID 'claude-sonnet-4-5-20250827'，导致 calibrate 匹配不上。
      const tracker = new LLMCallTracker()
      // tracker 必须存完整 ID（由 provider 用 e.message.model 填充）
      simulateOneCall(tracker, "claude-sonnet-4-5-20250827", "msg-1")

      tracker.calibrateFromModelUsage({
        "claude-sonnet-4-5-20250827": { inputTokens: 1000, outputTokens: 500 },
      })

      const calls = tracker.getLLMCalls()
      expect(calls[0].inputTokens).toBe(1000)
      expect(calls[0].outputTokens).toBe(500)

      // 反面：如果 tracker 存的是短别名 'sonnet'，calibrate 不会生效
      const tracker2 = new LLMCallTracker()
      simulateOneCall(tracker2, "sonnet", "msg-1")  // 短别名（错误用法）
      tracker2.calibrateFromModelUsage({
        "claude-sonnet-4-5-20250827": { inputTokens: 1000, outputTokens: 500 },
      })
      const calls2 = tracker2.getLLMCalls()
      expect(calls2[0].inputTokens).toBe(0)  // ← 因为 key 不匹配
      expect(calls2[0].outputTokens).toBe(0)
    })

    it("modelUsage 的 key 带 ANSI 转义码时，仍能匹配 clean model name", () => {
      // 真实场景：某些 SDK 版本在 result.modelUsage 的 key 里混入 ANSI 样式码
      // （例如 'qwen3.7-max\x1b[1m'），而 stream event 的 message.model 是干净的
      // （'qwen3.7-max'）。tracker 必须两边都剥离 ANSI 让 key 对齐。
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "qwen3.7-max", "msg-1")  // clean model name

      // modelUsage key 带 ANSI bold 转义码 '\x1b[1m'
      tracker.calibrateFromModelUsage({
        "qwen3.7-max\x1b[1m": { inputTokens: 1000, outputTokens: 5536, costUSD: 0.5 },
      })

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(1)
      expect(calls[0].model).toBe("qwen3.7-max")  // 存的是 clean name
      expect(calls[0].inputTokens).toBe(1000)       // ← 能正确分配
      expect(calls[0].outputTokens).toBe(5536)
      expect(calls[0].costUsd).toBeCloseTo(0.5, 6)
    })

    it("modelUsage 的 key 带 literal 变体后缀（如 Qwen 的 [1m]）时仍能匹配", () => {
      // 真实场景（已复现）：Qwen SDK 的 result.modelUsage key 可能包含
      // literal '[1m]' 后缀（1M context 变体），例如 'qwen3.7-max[1m]'，
      // 而 stream event 的 message.model 返回 clean name 'qwen3.7-max'。
      // 这是两套不同的命名约定，归一化后才能匹配。
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "qwen3.7-max", "msg-1")

      tracker.calibrateFromModelUsage({
        "qwen3.7-max[1m]": { inputTokens: 30, outputTokens: 5536, costUSD: 0.49497675 },
      })

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(1)
      expect(calls[0].model).toBe("qwen3.7-max")
      expect(calls[0].inputTokens).toBe(30)
      expect(calls[0].outputTokens).toBe(5536)
      expect(calls[0].costUsd).toBeCloseTo(0.49497675, 6)
    })

    it("变体后缀只剥离末尾的、符合 [数字m/k] 模式的片段", () => {
      // 避免误伤：中间的方括号不应被剥离
      const tracker = new LLMCallTracker()
      simulateOneCall(tracker, "custom-[beta]-model", "msg-1")

      tracker.calibrateFromModelUsage({
        "custom-[beta]-model": { inputTokens: 100, outputTokens: 50 },
      })

      const calls = tracker.getLLMCalls()
      expect(calls[0].model).toBe("custom-[beta]-model")
      expect(calls[0].inputTokens).toBe(100)
    })

    it("onMessageDelta 只接受 (stopReason) 一个参数", () => {
      const tracker = new LLMCallTracker()
      tracker.onMessageStart("msg-1", "claude-sonnet-4-5-20250827")
      // 新接口签名：onMessageDelta(stopReason)
      tracker.onMessageDelta("tool_use")
      tracker.onMessageStop("msg-1")

      const calls = tracker.getLLMCalls()
      expect(calls).toHaveLength(1)
      expect(calls[0].stopReason).toBe("tool_use")
      expect(calls[0].outputTokens).toBe(0)
    })

    it("updateInputTokens 方法应被移除（编译级保证，此处不测）", () => {
      const tracker = new LLMCallTracker()
      // 该方法应不存在；通过 TypeScript 编译保证
      // 运行时验证：tracker 上不应有此方法
      expect(typeof (tracker as any).updateInputTokens).toBe("undefined")
    })
  })
})
