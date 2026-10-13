import { createProductionKnowledgeLLM, type LLMCall } from "../llm"

/**
 * 策展编译 LLM — 生产适配器（知识中心票05，rule-form-judge/distill 同款注入纪律）。
 *
 * 单测一律 fixture-mocked LLMCall（不打真模型，spec Testing Decisions）；生产在
 * index.ts 注入本函数。与 L6 judge 不同点：策展计划是编译的**输入**而非 warn 附加——
 * 离线/禁用返回空串，由 CuratorCompileService 判 LLM_UNAVAILABLE 失败（任务态可见），
 * 绝不静默降级成空计划。
 *
 * 离线闸/provider 取用/模型覆盖/错文留痕的制式已并入共享核
 * `createProductionKnowledgeLLM`（llm.ts，code-review judgement 收口同构 32 行）。
 * 模型：默认 sonnet（多页抽取+对照 diff 需要中等推理力）；`OCTOPUS_CURATOR_MODEL` 覆盖。
 */
export const CURATOR_MODEL_ENV = "OCTOPUS_CURATOR_MODEL"

export function createProductionCuratorLLM(): LLMCall {
  return createProductionKnowledgeLLM({ channel: "curator", modelEnv: CURATOR_MODEL_ENV })
}
