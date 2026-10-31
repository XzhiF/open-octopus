// 新建开发任务的第一版标题（2026-10-29）。样例与服务端
// src/services/tasks/__tests__/task-title.test.ts 同批 —— 两边逐字节一致，
// 服务端「名字仍是自动名 → 可以换成 AI 标题」的判据才成立。

import { describe, it, expect } from 'vitest'
import { NEW_TASK_NAME, taskNameFromMessage } from '../task-name'

describe("taskNameFromMessage — 与服务端 derivedTaskNameFromMessage 同规则", () => {
  it("取首行并去首尾空白", () => {
    expect(taskNameFromMessage("  手机号注册\n第二行需求细节")).toBe("手机号注册")
  })

  it("≤40 字原样保留（含中文）", () => {
    const short = "开发手机号验证码注册功能"
    expect(taskNameFromMessage(short)).toBe(short)
  })

  it("超 40 字截成 39 + …", () => {
    const long = "一".repeat(41)
    const out = taskNameFromMessage(long)
    expect(out).toBe(`${"一".repeat(39)}…`)
    expect(out.length).toBe(40)
  })

  it("空输入回落占位名（与服务端同字面）", () => {
    expect(taskNameFromMessage("\n\n")).toBe(NEW_TASK_NAME)
    expect(NEW_TASK_NAME).toBe("新开发任务")
  })
})
