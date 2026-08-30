import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

// C5（ADR-0016 采集层清扫的收口）：Pi 采集卫生门禁。
// 探针定夺依据 = 读源 pi-agent-core@0.80.3：agent_end 的 emit 恒为 {type, messages}，
// 从不携带 usage。本门禁锁两件事，防其在依赖升级/重构中复活：
//   G1 aggregator 唯一喂源是 message_end（agent_end 僵尸双源已删）
//   G2 llm_calls 明细接线 per-message 实测 usage（Pi 行恒 0 bug 已修）

const PROVIDER_SRC = readFileSync(join(__dirname, "..", "pi", "provider.ts"), "utf8")

describe("pi collection hygiene (C5)", () => {
  it("G1: tokenAgg.add 全站只在 message_end 一个喂点（无 agent_end 双源）", () => {
    const addCalls = PROVIDER_SRC.match(/tokenAgg\.add\(/g) ?? []
    expect(addCalls.length).toBe(1)
    // 且该喂点位于 message_end 分支内（usage 取自 event.message）
    const messageEndBlock = PROVIDER_SRC.match(
      /event\.type === 'message_end'[\s\S]*?\n      \}/,
    )
    expect(messageEndBlock, "message_end 分支缺失").not.toBeNull()
    expect(messageEndBlock![0]).toContain("tokenAgg.add(")
    // 显式反证：不存在 agent_end 携带 usage 的喂入
    expect(PROVIDER_SRC).not.toMatch(/agent_end[\s\S]{0,80}tokenAgg\.add/)
  })

  it("G2: message_end 的 onMessageDelta 接线实测 usage（Pi llm_calls 不再恒 0）", () => {
    const deltaWithUsage = PROVIDER_SRC.match(
      /onMessageDelta\(\s*event\.stopReason,\s*usage \?/,
    )
    expect(deltaWithUsage, "onMessageDelta 未接线 usage —— Pi 明细将退回恒 0").not.toBeNull()
  })
})
