// packages/server/src/services/knowledge/health-score.ts
//
// health score 0-100 —— P4 票08「数值处方」的**公式与权重单源纯函数面**
// （spec 故事 8「库的健康一屏可见」；票07 effectiveness-confidence.ts 同构制式：
// 公式入码单源，消费面共用防漂移）。
//
// 公式（票面逐字：open findings 按 severity 加权 + 容量水位项）：
//   score = clamp(0, 100, round(100 − Σ_open severityWeight(kind) − capacityDeduction))
//   capacityDeduction = Σ_pages max(0, waterline − HEALTH_CAPACITY_FLOOR) × HEALTH_CAPACITY_PENALTY_SCALE
//
// 设计注记：
//  - **双轨是特性**：bloat finding（离散处方，达 0.8 即报）与容量项（连续梯度，越 0.8
//    逐水位扣分）同看水位——finding 被 ignore/resolved 后水位分仍扣（fs 事实不随裁决消失），
//    水位回落则分自愈（无需撤裁决）。owner 想「裁决即止渴」处理掉 bloat finding 后
//    水位项仍在，这正是「容量水位是健康本身、处方是建议」的分离。
//  - 权重与阈值都是**可调运营参数、不是架构**（「参数不是架构」case-symptom/confidence
//    两先例同律）：本文件是码面单源；SCHEMA.md 措辞同步属人工共演面（真盘文件由 owner
//    落笔，自动通道永不改写——manual-files 写保护同律）。
//  - findings.kind 表值开放（schema.sql 无 CHECK，「避免加值要动表」DAO 头注同律）⇒
//    未知 kind 走 minor 保守扣分，绝不炸健康接口。

import type { PatrolFindingKind } from "./patrol"

export type FindingSeverity = "critical" | "major" | "minor"

/** 档位权重（每档扣分）：一票面手算基准 8/4/2（96 分库容 ≈ 12 个 critical，钳 0 护栏见公式）。 */
export const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  critical: 8,
  major: 4,
  minor: 2,
}

/**
 * kind → severity 全表（Record<PatrolFindingKind,…> 编译期穷尽——新 kind 不映射即 tsc 红，
 * 防「加查忘配权重」漂移；红线2 面：全表只是处方分级，无任何自动执行语义）。
 */
export const SEVERITY_BY_KIND: Record<PatrolFindingKind, FindingSeverity> = {
  contradiction: "critical", // 断言对立=信息可信度直接受损
  stale: "major", // 消费侧证伪=规则与现场脱节
  "missing-page": "major", // 断链=导航协议失约
  "index-budget": "major", // INDEX 恒见预算触警=第一跳可寻性受损（票03 生产者）
  "low-confidence": "major", // 实效账目差（票07 生产者）
  bloat: "major", // 逼近 L1 触顶=增长失控前兆（D1）
  duplicate: "major", // 跨页碎片堆积（D2）
  "volatile-expired": "major", // 已声明的时效承诺失守（D7）
  orphan: "minor", // 零入链=可寻性弱，非正确性
  "missing-xref": "minor", // 缺互链=织网稀疏
  "case-backlog": "minor", // 蒸馏积压=转化延迟
  zombie: "minor", // 长期无人消费=清理建议（窄口自动退役另有票09）
  "domain-skew": "minor", // 锚点分布失衡=结构债
}

/** 未知/未来 kind 的保守档位（kind 值面开放：表无 CHECK，加值不动表——扣分也不许炸）。 */
export const UNKNOWN_KIND_SEVERITY: FindingSeverity = "minor"

/** 容量水位地板：与巡检 D1 预警线同值同义（BLOAT_WATERLINE_RATIO）——调整须两处同步，走 SCHEMA.md 人工共演。 */
export const HEALTH_CAPACITY_FLOOR = 0.8

/** 容量项比例尺：每越地板 1.0 水位扣 25 分（满页 1.0 ⇒ 5 分；1.2 ⇒ 10 分）。 */
export const HEALTH_CAPACITY_PENALTY_SCALE = 25

/** kind → severity（未知 ⇒ minor）。 */
export function severityOf(kind: string): FindingSeverity {
  return SEVERITY_BY_KIND[kind as PatrolFindingKind] ?? UNKNOWN_KIND_SEVERITY
}

/** 容量水位项（输入=各在册页 L1 水位，口径单源 patrol.pageWaterline）。 */
export function capacityDeduction(pageWaterlines: number[]): number {
  let sum = 0
  for (const w of pageWaterlines) {
    if (w > HEALTH_CAPACITY_FLOOR) sum += w - HEALTH_CAPACITY_FLOOR
  }
  return sum * HEALTH_CAPACITY_PENALTY_SCALE
}

/**
 * 总分：open findings 加权扣分 + 容量水位项，round 后钳 [0,100]。
 * 输入面刻意最小（kind 列表 + 水位列表）——纯数据进纯分出，路由/巡检/测试三面共用。
 */
export function computeHealthScore(input: {
  openFindings: Array<{ kind: string }>
  pageWaterlines: number[]
}): number {
  let findingDeduction = 0
  for (const f of input.openFindings) findingDeduction += SEVERITY_WEIGHT[severityOf(f.kind)]
  const raw = 100 - findingDeduction - capacityDeduction(input.pageWaterlines)
  return Math.max(0, Math.min(100, Math.round(raw)))
}
