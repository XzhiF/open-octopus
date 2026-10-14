// LIKE 通配符转义单源（aa-fix 票·Standards #1）：三处同口径实现
// （task-dao.escapeLikeParam / wiki-article-dao.searchLike / assist-workflow-service.listRuns）
// 收敛到 db/like-escape 前的**等价性钉**：新单源与两旧式在恶意输入上逐字节同形。
// expected 真相源=手算字面量（独立于被测实现），旧式对照=替换点原码逐字（先钉后换纪律）。
import { describe, it, expect } from "vitest"
import { escapeLikeParam } from "../like-escape"

// ── 被替换的旧口径逐字（两份正则是同集合的两种写法）──────────────────
const legacyTaskDaoForm = (raw: string): string => raw.replace(/[\\%_]/g, (ch) => `\\${ch}`)
const legacyWikiAssistForm = (query: string): string => query.replace(/[%_\\]/g, "\\$&")

describe("escapeLikeParam 单源 — 与三处现场旧口径逐字节等价（行为零变）", () => {
  // 手算期望值表（ESCAPE '\' 语义：\ % _ 三字符各自前置一个反斜杠，其余字节原样）
  const cases: Array<[string, string]> = [
    ["", ""],
    ["plain", "plain"],
    ["100%", `100\\%`],
    ["under_score", "under\\_score"],
    ["back\\slash", "back\\\\slash"],
    ["%_", "\\%\\_"],
    ["\\%", "\\\\\\%"],
    ["a%b_c\\d", `a\\%b\\_c\\\\d`],
    ["中文%中文_中文\\", `中文\\%中文\\_中文\\\\`],
    ["50% off_day \\100", `50\\% off\\_day \\\\100`],
  ]

  it.each(cases)("输入 %j ⇒ 转义 %j（手算字面量钉死）", (input, expected) => {
    expect(escapeLikeParam(input)).toBe(expected)
  })

  it.each(cases)("输入 %j ⇒ 与 task-dao 旧式同形", (input) => {
    expect(escapeLikeParam(input)).toBe(legacyTaskDaoForm(input))
  })

  it.each(cases)("输入 %j ⇒ 与 wiki-article-dao/assist-workflow-service 旧式同形", (input) => {
    expect(escapeLikeParam(input)).toBe(legacyWikiAssistForm(input))
  })

  it("只转义 \\ % _ 三字符：ESCAPE 子句外的其他字符（含引号/方括号）不动", () => {
    const hostile = `'; DROP--["x"] %_\\ 100%`
    expect(escapeLikeParam(hostile)).toBe(`'; DROP--["x"] \\%\\_\\\\ 100\\%`)
  })
})
