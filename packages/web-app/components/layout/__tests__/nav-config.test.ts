import { describe, expect, it } from "vitest"
import { NAV_GROUPS, findNavItem, isNavItemActive } from "../nav-config"

describe("nav-config", () => {
  it("按 工作/资产/系统 三组组织十项", () => {
    expect(NAV_GROUPS.map((group) => group.label)).toEqual([
      "工作",
      "资产",
      "系统",
    ])
    expect(NAV_GROUPS.flatMap((group) => group.items)).toHaveLength(10)
  })

  it("对话只在首页激活，不吞掉今日", () => {
    const home = findNavItem("/")
    expect(home?.name).toBe("对话")
    expect(isNavItemActive("/", home!)).toBe(true)
    expect(isNavItemActive("/dashboard", home!)).toBe(false)
  })

  it("系统管理覆盖 /system/* 子路由", () => {
    expect(findNavItem("/system/billing")?.name).toBe("系统管理")
    expect(findNavItem("/system/models")?.name).toBe("系统管理")
  })

  it("动态路由归属最近的前缀项", () => {
    expect(findNavItem("/workspaces/ws-1")?.name).toBe("工作空间")
    expect(findNavItem("/knowledge/wiki/page")?.name).toBe("知识中心")
    expect(findNavItem("/scheduler/jobs/1")?.name).toBe("系统调度")
  })
})
