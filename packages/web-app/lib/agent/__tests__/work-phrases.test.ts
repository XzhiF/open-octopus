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
})
