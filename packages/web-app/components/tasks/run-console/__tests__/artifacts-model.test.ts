// 产物窗口展示模型纯层（2026-10-29 方案2 — phase × 轮次）：
// 数据 = GET /api/tasks/:id/artifacts/manifest（server 归组，前端不重分组）。
// 体积记数走 lib/format.ts::formatBytes 单源。

import { describe, it, expect } from "vitest"
import { formatBytes } from "@/lib/format"
import type { ArtifactManifestBody, ArtifactManifestItem, ArtifactManifestPhase } from "@/lib/types"
import {
  prettyJsonForPreview,
  manifestTotalCount,
  phaseArtifactCount,
  previewTruncate,
  tokenizeJson,
} from "../artifacts-model"

const item = (path: string): ArtifactManifestItem => ({ name: path, path, bytes: 1, mtime: "", kind: "evidence" })

const phase = (items: ArtifactManifestItem[], rounds: ArtifactManifestPhase["rounds"]): ArtifactManifestPhase => ({
  index: 1, name: "p", slug: "p", dir: ".scratch/x/p", status: "pending",
  currentRound: null, acceptedRound: null, items, rounds,
})

describe("artifacts-model — 件数/预览截断 + 体积走 formatBytes 单源", () => {
  it("phaseArtifactCount = 批次级 + 各轮次", () => {
    expect(phaseArtifactCount(phase([item("a"), item("b")], [{ round: 1, items: [item("c")] }]))).toBe(3)
    expect(phaseArtifactCount(phase([], []))).toBe(0)
  })

  it("manifestTotalCount = phases + 未归属 + 原型", () => {
    const body: ArtifactManifestBody = {
      phases: [phase([item("a")], [{ round: 1, items: [item("b"), item("c")] }])],
      unassigned: [item("d")],
      prototype: [item("e")],
    }
    expect(manifestTotalCount(body)).toBe(5)
    expect(manifestTotalCount({ phases: [], unassigned: [], prototype: [] })).toBe(0)
  })

  it("体积记数走 formatBytes 单源（B/KB/MB 三档值不变）", () => {
    expect(formatBytes(999)).toBe("999 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(3_500_000)).toBe("3.3 MB")
  })

  it("previewTruncate：预览现读文本封顶截断（超长不白屏，如实标注）", () => {
    const long = "x".repeat(20_000)
    const { text, truncated } = previewTruncate(long, 10_000)
    expect(text).toHaveLength(10_000)
    expect(truncated).toBe(true)
    expect(previewTruncate("short", 10_000)).toEqual({ text: "short", truncated: false })
  })

  it("prettyJsonForPreview：能 parse 就 2 空格美化；坏 JSON 原样返回", () => {
    expect(prettyJsonForPreview('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', parsed: true })
    expect(prettyJsonForPreview("{oops")).toEqual({ text: "{oops", parsed: false })
  })

  it("tokenizeJson：key / string / number / boolean / null / punct 分色，字符串后跟冒号才算 key", () => {
    const tokens = tokenizeJson('{\n  "up": "npm run dev",\n  "n": 3,\n  "ok": true,\n  "x": null\n}')
    const marked = tokens.filter((t) => t.kind !== "plain")
    const pick = (kind: string) => marked.filter((t) => t.kind === kind).map((t) => t.text)
    expect(pick("key")).toEqual(['"up"', '"n"', '"ok"', '"x"'])
    expect(pick("string")).toEqual(['"npm run dev"'])
    expect(pick("number")).toEqual(["3"])
    expect(pick("boolean")).toEqual(["true"])
    expect(pick("null")).toEqual(["null"])
    // 标点不吞空白：原文的空格/换行仍在 plain token 里
    expect(tokens.some((t) => t.kind === "plain" && t.text.includes("\n"))).toBe(true)
  })
})
