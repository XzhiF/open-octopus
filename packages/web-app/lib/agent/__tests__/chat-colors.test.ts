// chat 输出过程三色（2026-10-29 用户确认的 A+B 方案）：
//   紫 = 想 · 青 = 动手 · 橙 = 说；工作行 spinner/秒数跟阶段走。
// 约束：颜色只上标签/前缀/竖线/工具名，正文永远是白色。

import { describe, it, expect } from "vitest"
import { THINKING_TONE, TOOL_TONE, WORK_PHASE_TONE } from "../chat-colors"
import { WORK_PHRASES, type WorkPhase } from "../work-phrases"

describe("chatColors", () => {
  it("工作行三阶段颜色各不相同：思考紫 / 执行青 / 输出橙", () => {
    expect(WORK_PHASE_TONE.thinking.spin).toBe("text-pop-purple")
    expect(WORK_PHASE_TONE.exec.spin).toBe("text-pop-cyan")
    expect(WORK_PHASE_TONE.writing.spin).toBe("text-pop-pink")
    const spins = Object.values(WORK_PHASE_TONE).map((tone) => tone.spin)
    expect(new Set(spins).size).toBe(3)
  })

  it("每个 WorkPhase 都有色调（新增阶段不会漏配）", () => {
    for (const phase of Object.keys(WORK_PHRASES) as WorkPhase[]) {
      expect(WORK_PHASE_TONE[phase]).toBeTruthy()
      expect(WORK_PHASE_TONE[phase].secs).toBeTruthy()
    }
  })

  it("思考紫、工具青，且都不碰正文色（正文必须保持白）", () => {
    expect(THINKING_TONE.label).toContain("text-pop-purple")
    expect(TOOL_TONE.name).toContain("text-pop-cyan")
    expect(THINKING_TONE.label).not.toContain("pop-ink")
    expect(TOOL_TONE.name).not.toContain("pop-ink")
  })
})
