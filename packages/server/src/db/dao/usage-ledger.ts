import { type LlmCallSource } from '@octopus/shared'

/**
 * UsageLedger 写侧（C3 · ADR-0016）。
 * node_token_usages 是全站总量唯一账本（D4）；它的写入口收敛在
 * TokenUsageDAO.recordNodeUsage，cost 决策函数委托 shared 单源（见文件尾）。
 */

// 'chat'：token-capture-1 票01 / KD6（phase1 只扩这一个值）。
// all-sources-2 票04 / KD3：账本对称推全源 —— 接受 llm_calls 全词表（shared 单源，
// scheduler/aux_* 随票04 挂点进来）+ 'node'（引擎账本行专用，llm_calls 词表无此值）。
export type NodeUsageSource = 'node' | LlmCallSource

// cost 三态（上游给价→用；没给→shared 价表估算；仍无→NULL，绝不焊 0）已下沉
// @octopus/shared/pricing.ledgerCostUsd 单源 —— server 写入口与 CLI 直写共用同一
// 函数体（review：两处逐字复制=公式漂移风险）。re-export 保持既有调用方 import 面不变。
export { ledgerCostUsd } from '@octopus/shared'
