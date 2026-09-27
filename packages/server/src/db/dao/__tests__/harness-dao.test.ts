// P1 B1: HarnessDAO 已迁 postgres.js —— 本文件从 new Database(:memory:) 切到
// PG 随机测试库（每例一座，README 施工图快路径）。用例语义与条数逐条保持。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { HarnessDAO } from "../harness-dao"
import type { HarnessEvent } from "@octopus/shared"
import { describePg, setupPgSchema, type PgFixture } from "../../pg/__tests__/dao-fixture"

let pg: PgFixture
let dao: HarnessDAO

beforeEach(async () => {
  pg = await setupPgSchema()
  dao = new HarnessDAO(pg.sql)
})

afterEach(async () => {
  await pg.close()
})

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    execution_id: "exec-001",
    node_id: "step1",
    timestamp: Date.now(),
    event_type: "diagnosis",
    detector: "stupid_retry",
    severity: "warning",
    report_json: JSON.stringify({ detector: "stupid_retry" }),
    action_json: null,
    result_json: null,
    token_usage_json: null,
    created_at: Date.now(),
    ...overrides,
  }
}

describePg("HarnessDAO", () => {
  describe("harness_events", () => {
    it("inserts and retrieves an event", async () => {
      const event = makeEvent()
      await dao.insertEvent(event)
      const events = await dao.findEvents("exec-001")
      expect(events).toHaveLength(1)
      expect(events[0].id).toBe(event.id)
      expect(events[0].execution_id).toBe("exec-001")
      expect(events[0].event_type).toBe("diagnosis")
      expect(events[0].detector).toBe("stupid_retry")
    })

    it("returns empty array when no events exist", async () => {
      const events = await dao.findEvents("nonexistent")
      expect(events).toEqual([])
    })

    it("filters events by type", async () => {
      await dao.insertEvent(makeEvent({ id: "e1", event_type: "diagnosis" }))
      await dao.insertEvent(makeEvent({ id: "e2", event_type: "intervention" }))
      await dao.insertEvent(makeEvent({ id: "e3", event_type: "blocked" }))

      const diagnosis = await dao.findEvents("exec-001", { type: "diagnosis" })
      expect(diagnosis).toHaveLength(1)
      expect(diagnosis[0].id).toBe("e1")

      const intervention = await dao.findEvents("exec-001", { type: "intervention" })
      expect(intervention).toHaveLength(1)
      expect(intervention[0].id).toBe("e2")
    })

    it("filters events by severity", async () => {
      await dao.insertEvent(makeEvent({ id: "e1", severity: "warning" }))
      await dao.insertEvent(makeEvent({ id: "e2", severity: "critical" }))

      const critical = await dao.findEvents("exec-001", { severity: "critical" })
      expect(critical).toHaveLength(1)
      expect(critical[0].id).toBe("e2")
    })

    it("combines type and severity filters", async () => {
      await dao.insertEvent(makeEvent({ id: "e1", event_type: "diagnosis", severity: "warning" }))
      await dao.insertEvent(makeEvent({ id: "e2", event_type: "diagnosis", severity: "critical" }))
      await dao.insertEvent(makeEvent({ id: "e3", event_type: "intervention", severity: "warning" }))

      const result = await dao.findEvents("exec-001", { type: "diagnosis", severity: "critical" })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe("e2")
    })

    it("orders events by timestamp ASC", async () => {
      await dao.insertEvent(makeEvent({ id: "e3", timestamp: 3000 }))
      await dao.insertEvent(makeEvent({ id: "e1", timestamp: 1000 }))
      await dao.insertEvent(makeEvent({ id: "e2", timestamp: 2000 }))

      const events = await dao.findEvents("exec-001")
      expect(events.map(e => e.id)).toEqual(["e1", "e2", "e3"])
    })

    it("counts events for an execution", async () => {
      await dao.insertEvent(makeEvent({ id: "e1" }))
      await dao.insertEvent(makeEvent({ id: "e2" }))
      await dao.insertEvent(makeEvent({ id: "e3" }))

      expect(await dao.countEvents("exec-001")).toBe(3)
      expect(await dao.countEvents("nonexistent")).toBe(0)
    })
  })

  describe("harness_config", () => {
    it("returns null when no config exists", async () => {
      expect(await dao.getConfig()).toBeNull()
    })

    it("saves and retrieves config", async () => {
      const yaml = "detectors:\n  stupid_retry:\n    enabled: true\n"
      const row = await dao.saveConfig(yaml)

      expect(row.id).toBe("default")
      expect(row.config_yaml).toBe(yaml)
      expect(row.version).toBe(1)

      const retrieved = await dao.getConfig()
      expect(retrieved).not.toBeNull()
      expect(retrieved!.config_yaml).toBe(yaml)
      expect(retrieved!.version).toBe(1)
    })

    it("bumps version on update", async () => {
      await dao.saveConfig("v1")
      const row2 = await dao.saveConfig("v2")
      expect(row2.version).toBe(2)
      expect(row2.config_yaml).toBe("v2")

      const row3 = await dao.saveConfig("v3")
      expect(row3.version).toBe(3)
    })

    it("supports custom config id", async () => {
      await dao.saveConfig("custom-config", "custom-id")
      const retrieved = await dao.getConfig("custom-id")
      expect(retrieved).not.toBeNull()
      expect(retrieved!.config_yaml).toBe("custom-config")
      expect(retrieved!.id).toBe("custom-id")
    })
  })
})
