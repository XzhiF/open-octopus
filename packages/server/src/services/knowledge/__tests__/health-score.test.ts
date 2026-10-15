// packages/server/src/services/knowledge/__tests__/health-score.test.ts
//
// P4 票08 — health score 0-100（S1，spec 故事 8「库的健康一屏可见」，票面清单第 2 行）。
//
// 公式真相源 = 票面逐字「open findings 按 severity 加权 + 容量水位项」：
//   score = clamp(0,100) round( 100 − Σ_open severityWeight(kind) − capacityDeduction )
//   capacityDeduction = Σ_pages max(0, waterline − FLOOR) × SCALE，FLOOR=0.8、SCALE=25
// 权重/阈值都是**可调运营参数不是架构**（票07 CONFIDENCE_MIN_SAMPLES 同律）：单源入码，
// 调整走 SCHEMA.md 人工同步（措辞建议随票报告，owner 落笔；真盘文件自动通道永不改写）。
// Expected 一律独立手算（禁 tautology）：fixture 账目给已知 kind 组合，期望值从票面
// 公式手算，不 import 实现常量做期望（severity 分组面除外——分组是展示派生非公式）。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { FindingsDAO } from "../../../db/dao/findings-dao"
import {
  computeHealthScore,
  capacityDeduction,
  severityOf,
  HEALTH_CAPACITY_FLOOR,
  HEALTH_CAPACITY_PENALTY_SCALE,
  SEVERITY_WEIGHT,
} from "../health-score"
import { WikiPatrolService } from "../patrol"

describe("health score 公式（纯函数面·独立手算）", () => {
  it("票面手算例：1 critical + 1 major + 1 minor open ⇒ 100−8−4−2=86；无水位越线零容量扣分", () => {
    const score = computeHealthScore({
      openFindings: [{ kind: "contradiction" }, { kind: "bloat" }, { kind: "orphan" }],
      pageWaterlines: [0.5, 0.2],
    })
    expect(score).toBe(86)
  })

  it("容量水位项：满页 waterline=1.0 ⇒ (1.0−0.8)×25=5 分 ⇒ 86−5=81（水位与 finding 双轨扣分是公式本意）", () => {
    const score = computeHealthScore({
      openFindings: [{ kind: "contradiction" }, { kind: "bloat" }, { kind: "orphan" }],
      pageWaterlines: [1.0, 0.5],
    })
    expect(score).toBe(81)
  })

  it("空库（零 finding 零水位）⇒ 100；水位恰在 FLOOR 不扣（> 严格越线才进容量项）", () => {
    expect(computeHealthScore({ openFindings: [], pageWaterlines: [] })).toBe(100)
    expect(capacityDeduction([HEALTH_CAPACITY_FLOOR, 0.3])).toBe(0)
  })

  it("下钳 0：巨额扣分不产负分（12 critical ⇒ 100−96−…；再加水位钳到 0）", () => {
    const many = Array.from({ length: 12 }, () => ({ kind: "contradiction" }))
    expect(computeHealthScore({ openFindings: many, pageWaterlines: [2.0] })).toBe(0)
  })

  it("未知 kind（未来表值开放面）⇒ 按 minor 保守扣分不炸（findings.kind 无 CHECK 同律）", () => {
    expect(severityOf("some-future-kind")).toBe("minor")
    expect(computeHealthScore({ openFindings: [{ kind: "some-future-kind" }], pageWaterlines: [] })).toBe(100 - SEVERITY_WEIGHT.minor)
  })

  it("severity 三档权重与 kind 映射钉死（治理账面：SCHEMA.md 措辞同步此表）", () => {
    expect(SEVERITY_WEIGHT).toEqual({ critical: 8, major: 4, minor: 2 })
    expect(HEALTH_CAPACITY_PENALTY_SCALE).toBe(25)
    expect(severityOf("contradiction")).toBe("critical")
    expect(severityOf("stale")).toBe("major")
    expect(severityOf("index-budget")).toBe("major")
    expect(severityOf("low-confidence")).toBe("major")
    expect(severityOf("bloat")).toBe("major")
    expect(severityOf("duplicate")).toBe("major")
    expect(severityOf("volatile-expired")).toBe("major")
    expect(severityOf("orphan")).toBe("minor")
    expect(severityOf("missing-xref")).toBe("minor")
    expect(severityOf("case-backlog")).toBe("minor")
    expect(severityOf("zombie")).toBe("minor")
    expect(severityOf("domain-skew")).toBe("minor")
  })
})

describe("WikiPatrolService.healthScore()（集成面：open findings 表值 + 在册页水位）", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string
  let wikiRoot: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-health-"))
    root = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(root, "wiki")
    fs.mkdirSync(path.join(wikiRoot, "entities"), { recursive: true })
  })
  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function smallPage(rel: string, id: string, type: string): void {
    const abs = path.join(wikiRoot, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, [
      "---",
      `id: ${id}`,
      `type: ${type}`,
      `title: ${id} 页`,
      `summary: ${id} 摘要`,
      "topics: []",
      "aliases: []",
      "links: []",
      "last_compiled: 2026-10-12",
      "sources: []",
      "---",
      "",
      "## 概述\n\n短页远低水位线。",
    ].join("\n"), "utf-8")
  }

  it("空库（零页）⇒ null 诚实不可评（avgConfidence null 先例同律：不伪造满分）", () => {
    expect(new WikiPatrolService({ db, root }).healthScore()).toBeNull()
  })

  it("在册页+已知 open findings 账 ⇒ 手算 100−(8+4+2)=86；resolved/ignored 行不扣（裁决过的不再拉健康）", () => {
    smallPage("entities/ent-a.md", "ent-a", "entity")
    const dao = new FindingsDAO(db)
    dao.upsert({ id: "fnd-aaaa0000000001", kind: "contradiction", title: "t", detail: "{}", pages: "[]", raw_ref: "", source: "patrol" })
    dao.upsert({ id: "fnd-aaaa0000000002", kind: "bloat", title: "t", detail: "{}", pages: "[]", raw_ref: "", source: "patrol" })
    dao.upsert({ id: "fnd-aaaa0000000003", kind: "orphan", title: "t", detail: "{}", pages: "[]", raw_ref: "", source: "patrol" })
    dao.upsert({ id: "fnd-aaaa0000000004", kind: "contradiction", title: "t", detail: "{}", pages: "[]", raw_ref: "", source: "patrol" })
    dao.updateStatus("fnd-aaaa0000000004", "resolved")
    expect(new WikiPatrolService({ db, root }).healthScore()).toBe(86)
  })

  it("水位进容量项：构造满页（bloat 同口径）⇒ 该页水位越 FLOOR ⇒ 86 再扣容量分（双轨同源，水位口径单源）", () => {
    const filler = Array.from({ length: 110 }, (_, i) => `超长行${i + 1}`).join("\n")
    const abs = path.join(wikiRoot, "topics", "top-fat.md")
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, [
      "---",
      "id: top-fat",
      "type: topic",
      "title: top-fat 页",
      "summary: 胖页",
      "topics: []",
      "aliases: []",
      "links: []",
      "last_compiled: 2026-10-12",
      "sources: []",
      "---",
      "",
      `## 说明\n\n${filler}\n`,
    ].join("\n"), "utf-8")
    const svc = new WikiPatrolService({ db, root })
    const score = svc.healthScore()!
    // 手算：序列化 ≈124 行 / 120 闸 ⇒ 水位≈1.033 ⇒ 容量项≈(1.033−0.8)×25≈5.8 ⇒ score≈94。
    // 序列化行数与 fixture 手写字节的差异 ≤±2 行（roundtrip 清洗面）——公式精确值已由
    // 纯函数面钉死（1.0⇒5），集成面断「越线水位进总分」的接线语义与量级（92-99 带）。
    expect(score).toBeLessThan(100)
    expect(score).toBeGreaterThanOrEqual(92)
    expect(score).toBeLessThanOrEqual(99)
  })
})
