import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../schema"
import { HarnessDAO } from "../harness-dao"
import type { HarnessEvent } from "@octopus/shared"

let db: Database.Database
let dao: HarnessDAO
let dbPath: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-harness-dao-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new HarnessDAO(db)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
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

describe("HarnessDAO", () => {
  describe("harness_events", () => {
    it("inserts and retrieves an event", () => {
      const event = makeEvent()
      dao.insertEvent(event)
      const events = dao.findEvents("exec-001")
      expect(events).toHaveLength(1)
      expect(events[0].id).toBe(event.id)
      expect(events[0].execution_id).toBe("exec-001")
      expect(events[0].event_type).toBe("diagnosis")
      expect(events[0].detector).toBe("stupid_retry")
    })

    it("returns empty array when no events exist", () => {
      const events = dao.findEvents("nonexistent")
      expect(events).toEqual([])
    })

    it("filters events by type", () => {
      dao.insertEvent(makeEvent({ id: "e1", event_type: "diagnosis" }))
      dao.insertEvent(makeEvent({ id: "e2", event_type: "intervention" }))
      dao.insertEvent(makeEvent({ id: "e3", event_type: "blocked" }))

      const diagnosis = dao.findEvents("exec-001", { type: "diagnosis" })
      expect(diagnosis).toHaveLength(1)
      expect(diagnosis[0].id).toBe("e1")

      const intervention = dao.findEvents("exec-001", { type: "intervention" })
      expect(intervention).toHaveLength(1)
      expect(intervention[0].id).toBe("e2")
    })

    it("filters events by severity", () => {
      dao.insertEvent(makeEvent({ id: "e1", severity: "warning" }))
      dao.insertEvent(makeEvent({ id: "e2", severity: "critical" }))

      const critical = dao.findEvents("exec-001", { severity: "critical" })
      expect(critical).toHaveLength(1)
      expect(critical[0].id).toBe("e2")
    })

    it("combines type and severity filters", () => {
      dao.insertEvent(makeEvent({ id: "e1", event_type: "diagnosis", severity: "warning" }))
      dao.insertEvent(makeEvent({ id: "e2", event_type: "diagnosis", severity: "critical" }))
      dao.insertEvent(makeEvent({ id: "e3", event_type: "intervention", severity: "warning" }))

      const result = dao.findEvents("exec-001", { type: "diagnosis", severity: "critical" })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe("e2")
    })

    it("orders events by timestamp ASC", () => {
      dao.insertEvent(makeEvent({ id: "e3", timestamp: 3000 }))
      dao.insertEvent(makeEvent({ id: "e1", timestamp: 1000 }))
      dao.insertEvent(makeEvent({ id: "e2", timestamp: 2000 }))

      const events = dao.findEvents("exec-001")
      expect(events.map(e => e.id)).toEqual(["e1", "e2", "e3"])
    })

    it("counts events for an execution", () => {
      dao.insertEvent(makeEvent({ id: "e1" }))
      dao.insertEvent(makeEvent({ id: "e2" }))
      dao.insertEvent(makeEvent({ id: "e3" }))

      expect(dao.countEvents("exec-001")).toBe(3)
      expect(dao.countEvents("nonexistent")).toBe(0)
    })
  })

  describe("harness_config", () => {
    it("returns null when no config exists", () => {
      expect(dao.getConfig()).toBeNull()
    })

    it("saves and retrieves config", () => {
      const yaml = "detectors:\n  stupid_retry:\n    enabled: true\n"
      const row = dao.saveConfig(yaml)

      expect(row.id).toBe("default")
      expect(row.config_yaml).toBe(yaml)
      expect(row.version).toBe(1)

      const retrieved = dao.getConfig()
      expect(retrieved).not.toBeNull()
      expect(retrieved!.config_yaml).toBe(yaml)
      expect(retrieved!.version).toBe(1)
    })

    it("bumps version on update", () => {
      dao.saveConfig("v1")
      const row2 = dao.saveConfig("v2")
      expect(row2.version).toBe(2)
      expect(row2.config_yaml).toBe("v2")

      const row3 = dao.saveConfig("v3")
      expect(row3.version).toBe(3)
    })

    it("supports custom config id", () => {
      dao.saveConfig("custom-config", "custom-id")
      const retrieved = dao.getConfig("custom-id")
      expect(retrieved).not.toBeNull()
      expect(retrieved!.config_yaml).toBe("custom-config")
      expect(retrieved!.id).toBe("custom-id")
    })
  })
})
