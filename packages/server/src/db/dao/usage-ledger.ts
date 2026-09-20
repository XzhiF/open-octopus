/**
 * UsageLedger 写侧（C3 · ADR-0016）。
 * node_token_usages 是全站总量唯一账本（D4）；它的写入口收敛在
 * TokenUsageDAO.recordNodeUsage。
 *
 * billing-core-1 票04：原先这里挂着唯一的 cost 决策函数（上游给价→shared 价表估算→NULL
 * 三态）；票02/04 把算钱收敛到 BillingService（billing_price_config 是唯一价格真相源，
 * KD2 —— SDK 上报价不作账、KD4 —— 未配价不估算），旧决策函数连同 shared 价表引用一并
 * 移除，server 记账写路径不再出现价表兜底。
 */

export type NodeUsageSource = 'node' | 'interaction' | 'harness'
