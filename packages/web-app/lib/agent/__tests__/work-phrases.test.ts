// 诙谐状态词（2026-10-29 用户）：按阶段分组、随时间轮换、同秒稳定。

import { describe, it, expect } from "vitest"
import { WORK_PHRASES, WORK_PHRASE_ROTATE_SECONDS, workPhrase, type WorkPhase } from "../work-phrases"

const PHASES: WorkPhase[] = ["thinking", "exec", "writing"]

describe("workPhrases", () => {
  it("每个阶段都有多句、且都很短（不换行、不撑爆工作行）", () => {
    for (const phase of PHASES) {
      expect(WORK_PHRASES[phase].length).toBeGreaterThanOrEqual(4)
      for (const phrase of WORK_PHRASES[phase]) {
        expect(phrase.length).toBeLessThanOrEqual(14)
        expect(phrase).not.toContain("\n")
      }
    }
  })

  it("按耗时轮换，同一桶内稳定，循环回头", () => {
    const list = WORK_PHRASES.thinking
    expect(workPhrase("thinking", 0)).toBe(list[0])
    expect(workPhrase("thinking", WORK_PHRASE_ROTATE_SECONDS - 1)).toBe(list[0])
    expect(workPhrase("thinking", WORK_PHRASE_ROTATE_SECONDS)).toBe(list[1])
    // 绕一圈回到第一句
    expect(workPhrase("thinking", WORK_PHRASE_ROTATE_SECONDS * list.length)).toBe(list[0])
  })

  it("负耗时/非整数也安全", () => {
    expect(workPhrase("exec", -3)).toBe(WORK_PHRASES.exec[0])
    expect(workPhrase("writing", 7.9)).toBe(WORK_PHRASES.writing[1])
  })

  it("同 seed 顺序稳定，不同 seed 每轮开头会变（整轮洗牌，不逐秒随机）", () => {
    // 同一轮内同一时刻多次取 → 完全一致（渲染多少次都不闪烁）
    expect(workPhrase("thinking", 9, 12345)).toBe(workPhrase("thinking", 9, 12345))
    // 同一 seed 的整圈是原列表的一个排列：不重不漏
    const list = WORK_PHRASES.thinking
    const cycle = new Set(
      list.map((_, i) => workPhrase("thinking", i * WORK_PHRASE_ROTATE_SECONDS, 12345)),
    )
    expect(cycle.size).toBe(list.length)
    // 不同轮起点（seed）→ 开头不总是同一句
    const starts = new Set([1000, 2000, 3000, 4000, 5000].map((seed) => workPhrase("thinking", 0, seed)))
    expect(starts.size).toBeGreaterThan(1)
  })

  it("不传 seed 时保持原数组顺序（兼容调用方与旧行为）", () => {
    expect(workPhrase("thinking", 0)).toBe(WORK_PHRASES.thinking[0])
    expect(workPhrase("thinking", WORK_PHRASE_ROTATE_SECONDS * 2)).toBe(WORK_PHRASES.thinking[2])
  })
})
