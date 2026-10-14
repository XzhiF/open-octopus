// packages/server/src/services/knowledge/__tests__/case-symptom.test.ts
//
// P3 票03 — 同症状判例判定（occurrences 合并的判据）· 纯函数单测。
//
// 背景（spec §判例自动提取「occurrences 合并：同症状判定复用规则近义先例（归一化+jaccard）」）：
// 勘探证实该先例在全仓不存在（server-sockets.md §4.2 坑——归一化+jaccard 无任何实现），
// 本票按 spec 字样自建确定性纯函数。expected 真相源：票面字样 + 手算样例（禁 tautological）。

import { describe, it, expect } from "vitest"
import {
  normalizeSymptom,
  symptomTokens,
  jaccard,
  CASE_SYMPTOM_JACCARD_THRESHOLD,
  findSimilarSymptom,
} from "../case-symptom"

describe("normalizeSymptom（归一化：小写/全角折半/标点转空白/压空白）", () => {
  it("大小写折叠、中文标点与括号成空白、连续空白压一、首尾修剪", () => {
    // expected 手算：小写 + 「：（）！」等标点→空格 + 压空白
    expect(normalizeSymptom("  登录接口报 500（Cookie 未清理）！ ")).toBe("登录接口报 500 cookie 未清理")
  })

  it("下划线等代码标点同样成词界（LOCKFILE_CONFIG_MISMATCH → 三个词根）", () => {
    expect(normalizeSymptom("CI 报 LOCKFILE_CONFIG_MISMATCH")).toBe("ci 报 lockfile config mismatch")
  })

  it("全角字符折半角（ＡＢＣ１２３ → abc123）", () => {
    expect(normalizeSymptom("端口ＡＢＣ１２３占用")).toBe("端口abc123占用")
  })
})

describe("symptomTokens（ASCII 词 + CJK 字符二元切分）", () => {
  it("「登录接口 500：cookie 未清」手算 token 集：ascii 2 词 + CJK 二元 4 枚", () => {
    // expected 独立构造（非实现反推）：登录/录接/接口 + 未清 + 500 + cookie
    expect([...symptomTokens("登录接口 500：cookie 未清")].sort()).toEqual(
      ["500", "cookie", "登录", "接口", "录接", "未清"].sort(),
    )
  })

  it("单字 CJK 段不成对，原样入集；数字串是独立词", () => {
    expect([...symptomTokens("好 502 错")].sort()).toEqual(["502", "好", "错"])
  })

  it("纯标点 → 空集", () => {
    expect(symptomTokens("！！！")).toEqual(new Set())
  })
})

describe("jaccard（集合交并比，永不抛）", () => {
  it("同集=1；空集对空集=0（无相似可言）；一方空=0", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(1)
    expect(jaccard(new Set(), new Set())).toBe(0)
    expect(jaccard(new Set(["a"]), new Set())).toBe(0)
  })

  it("交集 2 / 并集 4 = 0.5（{a,b,c} vs {a,b,d} 手算）", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["a", "b", "defg"]))).toBeCloseTo(2 / 4, 10)
  })
})

describe("findSimilarSymptom（既判例症状集中找同症状命中；阈值单源常量）", () => {
  // 阈值票面运营语义独立钉：宽松准入下「同症状」不能形同虚设（<0.5 会并掉太多不相干判例）
  it("阈值常量 = 0.5（运营调参入口，spec 判例质量风险预案）", () => {
    expect(CASE_SYMPTOM_JACCARD_THRESHOLD).toBe(0.5)
  })

  const existing = [
    "登录接口 500：cookie 未清",
    "pnpm lockfile 版本错配",
  ]

  it("近义改写命中第一条（交集5/并集8=0.625 ≥ 阈值）", () => {
    // expected 手算：query=登录接口报 500 cookie 没清
    //   query tokens {登录,录接,接口,口报,500,cookie,没清} 7 枚
    //   existing[0] tokens {登录,录接,接口,500,cookie,未清} 6 枚
    //   交 {登录,录接,接口,500,cookie}=5，并=8 ⇒ 5/8=0.625
    const hit = findSimilarSymptom(existing, "登录接口报 500 cookie 没清")
    expect(hit).toBeDefined()
    expect(hit!.index).toBe(0)
    expect(hit!.symptom).toBe(existing[0])
    expect(hit!.score).toBeCloseTo(5 / 8, 6)
  })

  it("无关症状零命中（token 全不交 ⇒ 新判例通道，不并档）", () => {
    expect(findSimilarSymptom(existing, "actuator 把在跑的执行报成 stale")).toBeUndefined()
  })

  it("交 2 并 6 = 1/3 < 阈值判不中；交 4 并 5 = 0.8 ≥ 阈值判命中", () => {
    const base = "登录接口 500" // tokens: 登录,录接,接口,500（4 枚）
    const sparse = "接口 500 未清 日志" // tokens: 接口,500,未清,日志 → 交2并6=1/3
    expect(findSimilarSymptom([sparse], base)).toBeUndefined()
    const near = "登录接口 500 未清" // tokens 5 枚，含 base 全部 → 交4并5=0.8
    const hit = findSimilarSymptom([near], base)
    expect(hit!.index).toBe(0)
    expect(hit!.score).toBeCloseTo(4 / 5, 10)
  })

  it("多条命中取分高者；同分取先位（确定性）", () => {
    const dup = ["登录接口 500：cookie 未清", "登录接口 500：cookie 未清"]
    const hit = findSimilarSymptom(dup, "登录接口 500：cookie 未清")
    expect(hit!.index).toBe(0)
    expect(hit!.score).toBe(1)
  })
})
