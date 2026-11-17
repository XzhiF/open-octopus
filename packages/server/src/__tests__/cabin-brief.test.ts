import { describe, it, expect } from "vitest"
import {
  parseDecisionEnvelope, normalizeBrief, formatDispatchMessage,
  formatRelayMessage, formatReceiptLine, askOptionLabels, firstAskQuestion,
} from "../services/cabin/cabin-brief"

const QUESTIONS = {
  questions: [{
    question: "回调失败后用什么通道重试？",
    header: "通道",
    multiSelect: false,
    options: [
      { label: "短信", description: "只做通道验证，不落库" },
      { label: "邮件", description: "多一张投递记录表，phase1 变厚" },
    ],
  }],
}

describe("parseDecisionEnvelope（design 24 §3）", () => {
  it("抽出「决策 / 建议」两行 + 选项影响", () => {
    const text = [
      "回调失败后有两个通道，各有取舍。",
      "",
      "决策：失败回调用什么通道重试？",
      "建议：短信 · 最薄，先验证通道可用性",
    ].join("\n")
    expect(parseDecisionEnvelope(text, QUESTIONS)).toEqual({
      decision: "失败回调用什么通道重试？",
      recommendation: { label: "短信", reason: "最薄，先验证通道可用性" },
      options: [
        { label: "短信", impact: "只做通道验证，不落库" },
        { label: "邮件", impact: "多一张投递记录表，phase1 变厚" },
      ],
    })
  })

  it("缺行 → 缺字段（不用默认值填，避免 UI 渲染空块）", () => {
    const parsed = parseDecisionEnvelope("只有一个问题。", QUESTIONS)
    expect(parsed.decision).toBeUndefined()
    expect(parsed.recommendation).toBeUndefined()
    expect(parsed.options).toHaveLength(2)
  })

  it("「建议：无」不算推荐；破折号写法也认", () => {
    expect(parseDecisionEnvelope("建议：无（信息不足）").recommendation).toBeUndefined()
    expect(parseDecisionEnvelope("建议：邮件 —— 记录更完整").recommendation)
      .toEqual({ label: "邮件", reason: "记录更完整" })
  })

  it("从 questions 里取第一个问题 / 选项标签", () => {
    expect(firstAskQuestion(QUESTIONS)?.question).toBe("回调失败后用什么通道重试？")
    expect(askOptionLabels(QUESTIONS)).toEqual(["短信", "邮件"])
  })
})

describe("normalizeBrief（design 25 §6.1）", () => {
  it("goal 必填；缺省 autonomy=checkpoint", () => {
    expect(normalizeBrief({ goal: "   " })).toBeNull()
    expect(normalizeBrief({ goal: "打通重试" })?.autonomy).toBe("checkpoint")
  })

  it("数组去空 + 截断", () => {
    const brief = normalizeBrief({
      goal: "g",
      done_when: [" a ", ""],
      refs: Array.from({ length: 30 }, (_, i) => `f${i}`),
    })!
    expect(brief.done_when).toEqual(["a"])
    expect(brief.refs).toHaveLength(20)
  })
})

describe("formatDispatchMessage（I4：原文与转述分离）", () => {
  const message = formatDispatchMessage({
    title: "支付回调重试",
    mandateStrength: "explicit",
    clarify: "ask",
    brief: normalizeBrief({
      goal: "失败回调按通道重试一次",
      done_when: ["有可查询的重试记录"],
      autonomy: "checkpoint",
    }),
    original: "给我把支付回调加上重试，先别落库",
    rules: "纪律：先澄清。",
  })

  it("两段都在：意图（汐音编译）+ 用户原文（逐字，权威）", () => {
    expect(message).toContain("## 意图（汐音编译，可执行）")
    expect(message).toContain("## 用户原文（逐字，权威）")
    expect(message).toContain("给我把支付回调加上重试，先别落库")
    expect(message).toContain("autonomy：checkpoint")
  })

  it("原文不是 brief 的子串也能独立存活（brief 不能覆盖原文）", () => {
    expect(message.indexOf("## 用户原文")).toBeLessThan(message.indexOf("给我把支付回调"))
    expect(message).toContain("冲突时以「用户原文」为准")
  })

  it("没有 brief 时退回「只有原文」，仍然成立", () => {
    const bare = formatDispatchMessage({
      title: "t", mandateStrength: "explicit", clarify: "ask",
      brief: null, original: "原话", rules: "",
    })
    expect(bare).not.toContain("## 意图")
    expect(bare).toContain("## 用户原文（逐字，权威）\n原话")
  })
})

describe("formatRelayMessage（verbatim 不可改）", () => {
  it("逐字块 === 用户选择；framing 另起一段且不改选择", () => {
    const message = formatRelayMessage({
      handle: "#1", askId: "ask_7f3a", choice: "短信",
      note: "只做通道验证，本 phase 不落库",
      framing: "本 phase 不落库；其余按原计划",
    })
    expect(message).toContain("[决策 · #1 · ask_7f3a] 短信")
    expect(message).toContain("（逐字）短信")
    expect(message).toContain("（补充）只做通道验证，本 phase 不落库")
    expect(message).toContain("理由与边界")
    expect(message).toContain("用户回答了以下问题：短信")
    expect(message).not.toContain("（逐字）邮件")
  })

  it("没有 note / framing 时不出现空行块", () => {
    const message = formatRelayMessage({ handle: "#2", askId: "ask_1", choice: "A" })
    expect(message).not.toContain("（补充）")
    expect(message).not.toContain("理由与边界")
  })

  it("回执单行带 handle（多条线并发时可指代）", () => {
    expect(formatReceiptLine({ handle: "#1", title: "支付", choice: "短信", relayed: "assistant" }))
      .toBe("✓ #1 支付 · 按「短信」交代下去")
    expect(formatReceiptLine({ handle: "#1", title: "支付", choice: "短信", relayed: "fallback" }))
      .toContain("已直接转达")
  })
})
