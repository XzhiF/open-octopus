/**
 * 卡片协议 re-export 垫片（票13 单源上移）。
 *
 * 规范源 = `@octopus/shared` 的 knowledge-center/card-protocol（Lane A 生产者横跨
 * 两端：web 渲染 + server 夜巡/裁决回执写会话正文，CODING_STANDARDS #1）。
 * 票12 落地的全部导入路径 `@/lib/knowledge-center/card-protocol` 经此零改动。
 */
export {
  KC_CARD_KINDS,
  serializeKcCardBlock,
  parseKcCardPayload,
  parseKcCardBlocks,
  kcEventPageRefs,
  kcTaskStateLabel,
  shortHash,
} from "@octopus/shared"
export type {
  KcKnownCardKind,
  KcCardKind,
  KcCardEvent,
  KcIngestCardData,
  KcSourceSummaryCardData,
  KcDiffTouchedPage,
  KcRevertState,
  KcCompileDiffCardData,
  KcArchiveCompileCardData,
  KcPageMiniCardData,
  KcGuardCardData,
  KcFindingFixState,
  KcFindingCardData,
  KcBackfillCardData,
  KcMaterialPackItemView,
  KcMaterialPackRecompileState,
  KcMaterialPackCardData,
  KcCaseCardSections,
  KcCaseCardData,
  KcCaseRetireState,
  KcPageRetireCardData,
} from "@octopus/shared"
