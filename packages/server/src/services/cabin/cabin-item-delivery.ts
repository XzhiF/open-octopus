// packages/server/src/services/cabin/cabin-item-delivery.ts
//
// 事项投递的服务端兜底（2026-11-26 用户）。
//
// 事故：#IT-1 正文 1368 字，投递消息只有标题 —— 汐音只能凭标题猜需求。
// 客户端现在会带正文，但缓存 / 旧客户端 / 编辑竞态都可能让正文缺席，
// 所以 chat 路由在落库前按 cabin_items 真源再校一遍：缺的正文补在消息末尾，
// 已送达（含超限截断）的原样不动。格式与客户端共用 @octopus/shared。

import { appendMissingCabinItemBodies } from "@octopus/shared"
import type { CabinItemRow } from "../../db/types"

export interface ExpandedItemDelivery {
  /** 实际落库 / 发给模型的正文（可能已追加「按库补全」块）。 */
  content: string
  appended: boolean
  /** 被补全的事项 id（排障 / 测试用）。 */
  missing_ids: string[]
}

export function expandItemDelivery(content: string, items: CabinItemRow[]): ExpandedItemDelivery {
  return appendMissingCabinItemBodies(content, items)
}
