// 舱名规则（v5）：名字可选，没填时由 init 开头按需求取 —— 纯函数，毫秒级。

import { describe, it, expect } from "vitest"
import { CABIN_NAME_MAX, nameForRequirements, UNNAMED_CABIN_NAME } from "../cabin-naming"

describe("nameForRequirements", () => {
  it("关键词命中：电商 / 对账 / 健康", () => {
    expect(nameForRequirements("做一个电商后台，长期维护订单、库存和结算对账")).toBe("电商舱")
    expect(nameForRequirements("帮我盯对账")).toBe("账本舱")
    expect(nameForRequirements("长期做健康管理")).toBe("健康舱")
  })

  it("没命中：剥掉动词前缀取前几个字 + 舱；空需求给「新舱」", () => {
    expect(nameForRequirements("帮我搭一个极光发布台")).toBe("极光发布舱")
    expect(nameForRequirements("")).toBe("新舱")
    expect(nameForRequirements("   ")).toBe("新舱")
  })

  it("名字不超过输入框上限", () => {
    expect(nameForRequirements("一二三四五六七八九十一二三四五六七八九十").length)
      .toBeLessThanOrEqual(CABIN_NAME_MAX)
  })

  it("未命名舱是建舱时的占位名（init 会换掉它）", () => {
    expect(UNNAMED_CABIN_NAME).toBe("未命名舱")
  })
})