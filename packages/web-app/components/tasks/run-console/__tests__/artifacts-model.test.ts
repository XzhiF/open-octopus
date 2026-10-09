// 票 11 ⑩回补 — ▣ 产物页签的展示模型纯层（徽标件数 / 体积记数 / 预览截断）。
// 数据 = GET /api/tasks/:id/artifacts/manifest（server 分好组，这里不重分组）。

import { describe, it, expect } from "vitest"
import { manifestTotalCount, artifactSizeText, previewTruncate } from "../artifacts-model"

describe("artifacts-model — 徽标计数/体积记数/预览截断（票11）", () => {
  it("manifestTotalCount：逐组求和（徽标 = 件数，原型 artifactsOf.length 口径）", () => {
    expect(manifestTotalCount({
      groups: [
        { key: "spec", label: "s", items: [{ name: "a", path: "home:a", bytes: 1, mtime: "" }, { name: "b", path: "home:b", bytes: 1, mtime: "" }] },
        { key: "report", label: "r", items: [] },
        { key: "prototype", label: "p", items: [{ name: "t", path: "ws:t", bytes: 1, mtime: "" }] },
      ],
    })).toBe(3)
    expect(manifestTotalCount({ groups: [] })).toBe(0)
  })

  it("artifactSizeText：K/M 记数（口径同消耗卡 formatTokenCount 的视觉族；命名避开 C4 受禁 format* 前缀）", () => {
    expect(artifactSizeText(999)).toBe("999 B")
    expect(artifactSizeText(2048)).toBe("2.0 KB")
    expect(artifactSizeText(3_500_000)).toBe("3.3 MB")
  })

  it("previewTruncate：预览现读文本封顶截断（超长不白屏，如实标注）", () => {
    const long = "x".repeat(20_000)
    const { text, truncated } = previewTruncate(long, 10_000)
    expect(text).toHaveLength(10_000)
    expect(truncated).toBe(true)
    expect(previewTruncate("short", 10_000)).toEqual({ text: "short", truncated: false })
  })
})
