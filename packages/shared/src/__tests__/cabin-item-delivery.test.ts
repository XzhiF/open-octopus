// 事项投递正文协议（2026-11-26 用户事故）：
//   #IT-1 标题 18 字、正文 1368 字，投递消息只有标题 —— 汐音只能凭标题猜需求。
//   口径：标题做索引，正文逐字；超长显式截断并指路回读，绝不静默丢。

import { describe, it, expect } from "vitest"
import {
  appendMissingCabinItemBodies,
  CABIN_ITEM_DELIVERY_BODY_MAX,
  formatCabinItemBlocks,
  formatCabinItemDeliveryText,
  type CabinItemDTO,
} from "../types/cabin"

function item(
  seq: number,
  title: string,
  body = "",
  kind: CabinItemDTO["kind"] = "optimize",
): CabinItemDTO {
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
  }
}

describe("formatCabinItemDeliveryText — 标题 + 正文", () => {
  it("正文逐字随投递送出（事故回归：#IT-1 的长正文）", () => {
    const body = "现在需求是需要做 PC 端的密码登录，参考原来验证码登录的实现，\n通过 dubbo 接口引入 miyuan-user 的登录服务。"
    const text = formatCabinItemDeliveryText([item(1, "开始第一个登录需求与环境说明", body)])
    expect(text.startsWith("处理这几条事项：")).toBe(true)
    expect(text).toContain("#IT-1 开始第一个登录需求与环境说明（优化）")
    expect(text).toContain(body)
  })

  it("空正文只发标题，不留空块", () => {
    const blocks = formatCabinItemBlocks([item(2, "时间列太窄", "   ")])
    expect(blocks).toEqual(["### #IT-2 时间列太窄（优化）"])
  })

  it("单条超长：显式截断 + 指路回读，不静默丢", () => {
    const body = "甲".repeat(CABIN_ITEM_DELIVERY_BODY_MAX + 120)
    const text = formatCabinItemDeliveryText([item(3, "长文", body)])
    expect(text).toContain("甲".repeat(CABIN_ITEM_DELIVERY_BODY_MAX))
    expect(text).not.toContain("甲".repeat(CABIN_ITEM_DELIVERY_BODY_MAX + 1))
    expect(text).toContain("本次截断至")
    expect(text).toContain("cabin_list_items")
  })

  it("总量上限：后面的条目显式标注未送出（不静默省略）", () => {
    const a = "乙".repeat(300)
    const b = "丙".repeat(300)
    const text = formatCabinItemDeliveryText(
      [item(4, "第一条", a), item(5, "第二条", b)],
      { totalMax: 400 },
    )
    expect(text).toContain(a)
    expect(text).toContain("#IT-5 第二条")
    expect(text).toContain("未随本次投递送出")
    expect(text).not.toContain(b)
  })

  it("kind 标签保留：优化 / 修复 / 想法", () => {
    const text = formatCabinItemDeliveryText([
      item(6, "修复项", "", "fix"),
      item(7, "想法项", "", "idea"),
    ])
    expect(text).toContain("（修复）")
    expect(text).toContain("（想法）")
  })
})

describe("appendMissingCabinItemBodies — 服务端按库兜底", () => {
  it("旧客户端只发标题：正文补在消息末尾", () => {
    const body = "第一次点没反应，第二次才保存。怀疑受控表单首次校验把提交吞了。"
    const res = appendMissingCabinItemBodies(
      "处理这几条事项：\n- #IT-8 设置页保存按钮要点两次才生效",
      [item(8, "设置页保存按钮要点两次才生效", body)],
    )
    expect(res.appended).toBe(true)
    expect(res.missing_ids).toEqual(["ci-8"])
    expect(res.content).toContain("【事项正文 · 服务端按数据库补全】")
    expect(res.content).toContain(body)
  })

  it("正文已在消息里：原样返回，不重复", () => {
    const body = "补充上下文：复现步骤 / 期望行为 / 约束。"
    const content = formatCabinItemDeliveryText([item(9, "已经有正文", body)])
    const res = appendMissingCabinItemBodies(content, [item(9, "已经有正文", body)])
    expect(res.appended).toBe(false)
    expect(res.content).toBe(content)
  })

  it("客户端超限截断过：只校验前缀，不重复补全", () => {
    const body = "丁".repeat(CABIN_ITEM_DELIVERY_BODY_MAX + 50)
    const content = formatCabinItemDeliveryText([item(10, "截断正文", body)])
    const res = appendMissingCabinItemBodies(content, [item(10, "截断正文", body)])
    expect(res.appended).toBe(false)
  })

  it("空正文不触发补全", () => {
    const res = appendMissingCabinItemBodies("处理这几条事项：\n- #IT-11 空正文", [
      item(11, "空正文", ""),
    ])
    expect(res.appended).toBe(false)
  })

  it("多条里只有缺的补，已送的不重复", () => {
    const sent = "已经送到的一段正文"
    const missing = "还没送到的一段正文"
    const content = formatCabinItemDeliveryText([item(12, "已送", sent)])
    const res = appendMissingCabinItemBodies(content, [
      item(12, "已送", sent),
      item(13, "未送", missing),
    ])
    expect(res.appended).toBe(true)
    expect(res.missing_ids).toEqual(["ci-13"])
    expect(res.content.match(new RegExp(sent, "g"))).toHaveLength(1)
  })
})
