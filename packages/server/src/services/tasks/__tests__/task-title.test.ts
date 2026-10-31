// packages/server/src/services/tasks/__tests__/task-title.test.ts
//
// 新建开发任务的 AI 标题（2026-10-29）。两段契约：
//   1. derivedTaskNameFromMessage —— 必须与 web-app `ChatTab.taskNameFromMessage`
//      逐字节一致（下面样例与 components/agent/chat/__tests__/task-name.test.tsx
//      同批），否则服务端「名字仍是自动名」的判据失效，AI 标题永不落地。
//   2. normalizeTaskTitle —— 吃掉模型常见的标点/前缀/多行噪声。

import { describe, it, expect } from "vitest"
import { derivedTaskNameFromMessage, normalizeTaskTitle } from "../task-title"

describe("derivedTaskNameFromMessage — 与客户端同规则", () => {
  it("取首行并去首尾空白", () => {
    expect(derivedTaskNameFromMessage("  手机号注册\n第二行需求细节")).toBe("手机号注册")
  })

  it("≤40 字原样保留（含中文）", () => {
    const short = "开发手机号验证码注册功能"
    expect(derivedTaskNameFromMessage(short)).toBe(short)
  })

  it("超 40 字截成 39 + …", () => {
    const long = "一".repeat(41)
    const out = derivedTaskNameFromMessage(long)
    expect(out).toBe(`${"一".repeat(39)}…`)
    expect(out.length).toBe(40)
  })

  it("空输入回落占位名（与 ChatTab.NEW_TASK_NAME 一致）", () => {
    expect(derivedTaskNameFromMessage("\n\n")).toBe("新开发任务")
  })
})

describe("normalizeTaskTitle — 模型输出清洗", () => {
  it("去掉「标题：」前缀、标点与引号", () => {
    expect(normalizeTaskTitle("标题：手机号注册功能。")).toBe("手机号注册功能")
    expect(normalizeTaskTitle("「手机号验证码注册」")).toBe("手机号验证码注册")
  })

  it("只保留首行，封顶 30 字", () => {
    expect(normalizeTaskTitle("手机号注册\n多余的说明")).toBe("手机号注册")
    expect(normalizeTaskTitle("二".repeat(40))).toBe("二".repeat(30))
  })

  it("空/纯标点 → null（调用方保留截串名）", () => {
    expect(normalizeTaskTitle("  ")).toBeNull()
    expect(normalizeTaskTitle("。。！")).toBeNull()
  })
})
