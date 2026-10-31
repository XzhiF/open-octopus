// 新建任务的 org 起手解析（bug 2026-10-27）：不能取排序第一名。
// 优先级：用户上次选的 org → 最近任务的 org → 注册顺序首位。

import { describe, it, expect } from "vitest"
import { resolveTaskOrg } from "../task-org"

const ORGS = ["miyuan", "xzf", "xzf-dev"]

describe("resolveTaskOrg", () => {
  it("用户上次选过的 org 优先（哪怕排序靠后）", () => {
    expect(resolveTaskOrg({ orgs: ORGS, remembered: "xzf", recentTaskOrgs: ["miyuan"] })).toBe("xzf")
  })

  it("没有记忆时跟随最近任务的 org", () => {
    expect(resolveTaskOrg({ orgs: ORGS, remembered: null, recentTaskOrgs: [null, "xzf"] })).toBe("xzf")
  })

  it("记忆的 org 已注销 → 忽略，继续看最近任务", () => {
    expect(resolveTaskOrg({ orgs: ORGS, remembered: "gone", recentTaskOrgs: ["xzf-dev"] })).toBe("xzf-dev")
  })

  it("都没有 → 注册列表首位（不再额外假设）", () => {
    expect(resolveTaskOrg({ orgs: ORGS })).toBe("miyuan")
  })

  it("org 列表为空 → default", () => {
    expect(resolveTaskOrg({ orgs: [], remembered: "xzf" })).toBe("default")
  })
})
