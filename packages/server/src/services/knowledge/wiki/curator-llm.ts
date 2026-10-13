import { getProvider } from "@octopus/providers"
import { createProviderLLMCall, type LLMCall } from "../llm"

/**
 * 策展编译 LLM — 生产适配器（知识中心票05，rule-form-judge/distill 同款注入纪律）。
 *
 * 单测一律 fixture-mocked LLMCall（不打真模型，spec Testing Decisions）；生产在
 * index.ts 注入本函数。与 L6 judge 不同点：策展计划是编译的**输入**而非 warn 附加——
 * 离线/禁用返回空串，由 CuratorCompileService 判 LLM_UNAVAILABLE 失败（任务态可见），
 * 绝不静默降级成空计划。
 *
 * 模型：默认 sonnet（多页抽取+对照 diff 需要中等推理力）；`OCTOPUS_CURATOR_MODEL` 覆盖。
 * `OCTOPUS_KNOWLEDGE_LLM_DISABLED=1` ⇒ 恒空串（llm.ts callHaiku 同款离线开关）。
 */
export const CURATOR_MODEL_ENV = "OCTOPUS_CURATOR_MODEL"

export function createProductionCuratorLLM(): LLMCall {
  if (process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED === "1") {
    return async () => ""
  }
  return async (prompt: string): Promise<string> => {
    try {
      const provider = getProvider("claude")
      const call = createProviderLLMCall(provider, process.cwd(), process.env[CURATOR_MODEL_ENV] ?? "sonnet")
      return await call(prompt)
    } catch (err) {
      // provider 未配置/构建失败 ⇒ 空串（调用方按 LLM_UNAVAILABLE 处理；错文进 stderr 留痕）
      console.warn(`[curator] provider LLM unavailable: ${err instanceof Error ? err.message : String(err)}`)
      return ""
    }
  }
}
