// packages/server/src/services/tasks/archive-ingest-llm.ts
//
// 归档总结 LLM — 生产适配器（知识中心票10；与 curator-llm 同构的制式已并入共享核
// createProductionKnowledgeLLM——llm.ts，code-review judgement 收口）。
//
// 单测一律 fixture-mocked ArchiveSummarizer（不打真模型，spec Testing Decisions）；
// 生产在 index.ts 注入本函数。`OCTOPUS_KNOWLEDGE_LLM_DISABLED=1` ⇒ 恒空串
// （llm.ts callHaiku 同款离线闸）；空串由 ArchiveIngestService 判 SUMMARIZE_EMPTY
// = 跳过投喂，归档照常——绝不静默落一份空总结进不可变 raw。
// 模型：默认 sonnet（台账归纳 + 素材摘合需中等推理力）；`OCTOPUS_ARCHIVE_SUMMARY_MODEL` 覆盖。

import { createProductionKnowledgeLLM } from "../knowledge/llm"
import type { ArchiveSummarizer } from "./archive-ingest-service"

export const ARCHIVE_SUMMARY_MODEL_ENV = "OCTOPUS_ARCHIVE_SUMMARY_MODEL"

export function createProductionArchiveSummarizer(): ArchiveSummarizer {
  return createProductionKnowledgeLLM({ channel: "archive-ingest", modelEnv: ARCHIVE_SUMMARY_MODEL_ENV })
}
