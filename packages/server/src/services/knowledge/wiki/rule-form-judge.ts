import type { LLMCall } from "../llm"
import { callHaiku } from "../llm"
import type { RuleFormIssue, RuleFormJudge } from "./lint"

/**
 * L6 规则形态判定 — 生产 LLM 适配器（spec §增长约束 L6「编译时 LLM 判定，
 * warn + 给改写稿」；票06 遗留接线缺口修复）。
 *
 * 蒸馏适配器同款形态（distill.ts createLLMDistillSummarizer，handoff-02 纪律）：
 * 本模块把 knowledge/llm 的 LLMCall seam 包成 lint.ts 的 RuleFormJudge——
 * 单测一律 fixture-mocked LLMCall（不打真模型），生产 index.ts 注入
 * createLLMRuleFormJudge(callHaiku)。
 *
 * 离线安全（L6 = warn 级）：callHaiku 失败/未配置返回 ""；本适配器对
 * 空响应/垃圾响应/抛错一律解析为「零 issues」，绝不向上抛——判定失败
 * 绝不阻塞编译，与 judgeRuleForms 的兜底共同构成双保险。
 */

/** 送入模型的单条规则文本截断长度（规则行本就常青短句；防巨行撑爆 prompt）。 */
const MAX_RULE_CHARS = 400

export function createLLMRuleFormJudge(llmCall: LLMCall): RuleFormJudge {
  return async (rules) => {
    if (rules.length === 0) return []
    const prompt = [
      "你是知识库规则形态审查器。逐条检查下面的规则行（wiki 词条中的常青规则）。",
      "合规形态 = 祈使句（做什么/禁止什么）或事实陈述（客观口径）；",
      "违规形态 = 描述句/模糊表述（如「implement 通常 30min」——应改写为「按 ≥30min 规划预算」）。",
      '只输出严格 JSON 数组，元素形如 {"anchor":"oct-001","suggestion":"祈使化改写稿"}，' +
      "且只包含违规条目；全部合规时输出 []。suggestion 必须是不含日期的祈使句/事实陈述。",
      "禁止输出解释文字、markdown 围栏之外的任何内容。",
      rules.map(r => `【${r.anchor}】${r.text.slice(0, MAX_RULE_CHARS)}`).join("\n"),
    ].join("\n\n")

    try {
      const raw = await llmCall(prompt)
      const m = /\[[\s\S]*\]/.exec(raw)
      if (!m) return []
      const parsed: unknown = JSON.parse(m[0])
      if (!Array.isArray(parsed)) return []
      const known = new Set(rules.map(r => r.anchor))
      const out: RuleFormIssue[] = []
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue
        const { anchor, suggestion } = item as { anchor?: unknown; suggestion?: unknown }
        if (typeof anchor !== "string" || !known.has(anchor)) continue
        if (typeof suggestion !== "string" || suggestion.trim().length === 0) continue
        out.push({ anchor, suggestion: suggestion.trim() })
      }
      return out
    } catch {
      // 判定失败绝不阻塞编译（warn 级纪律；lint.ts judgeRuleForms 另有同类兜底）
      return []
    }
  }
}

/** 生产注入点：包装 knowledge/llm 的 callHaiku（haiku 别名，离线/禁用时返回 "" ⇒ 零噪音）。 */
export function createProductionRuleFormJudge(): RuleFormJudge {
  return createLLMRuleFormJudge(callHaiku)
}
