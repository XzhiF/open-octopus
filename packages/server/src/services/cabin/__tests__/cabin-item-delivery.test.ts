// 事项投递的服务端兜底（2026-11-26 用户）：
//   客户端带正文是常态；旧客户端 / 缓存过期只发标题时，chat 路由按
//   cabin_items 真源把正文补进本轮消息（落库 + 喂模型的是同一份）。

import { describe, it, expect } from "vitest"
import { expandItemDelivery } from "../cabin-item-delivery"
import type { CabinItemRow } from "../../../db/types"

function row(
  seq: number,
  title: string,
  body: string,
  kind: CabinItemRow["kind"] = "optimize",
): CabinItemRow {
  return {
    id: `ci-${seq}`,
    cabin_id: "c1",
    seq,
    kind,
    status: "todo",
    title,
    body,
    created_at: "2026-11-26T00:00:00.000Z",
    updated_at: "2026-11-26T00:00:00.000Z",
    delivered_at: null,
    closed_at: null,
    delivery_session_id: null,
    delivery_message_id: null,
  } as CabinItemRow
}

describe("expandItemDelivery", () => {
  it("只发了标题（旧客户端）→ 按库补全正文", () => {
    const res = expandItemDelivery("处理这几条事项：\n- #IT-1 开始第一个登录需求与环境说明", [
      row(1, "开始第一个登录需求与环境说明", "现在需求是需要做 PC 端的密码登录……"),
    ])
    expect(res.appended).toBe(true)
    expect(res.missing_ids).toEqual(["ci-1"])
    expect(res.content).toContain("现在需求是需要做 PC 端的密码登录……")
  })

  it("客户端已带正文 → 不动消息", () => {
    const content = "处理这几条事项：\n### #IT-2 时间列太窄（优化）\n按原型给时间列固定宽度。"
    const res = expandItemDelivery(content, [row(2, "时间列太窄", "按原型给时间列固定宽度。")])
    expect(res.appended).toBe(false)
    expect(res.content).toBe(content)
  })

  it("空正文 / 事项已删（传空数组）→ 不动消息", () => {
    expect(expandItemDelivery("处理这几条事项：", [row(3, "空正文", "")]).appended).toBe(false)
    expect(expandItemDelivery("处理这几条事项：", []).appended).toBe(false)
  })
})
