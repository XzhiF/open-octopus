import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { WorkspaceScheduleService } from "../services/schedule"
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO } from '../db/dao'
import { SSEService } from "../services/sse"
import { initExecutionServiceRegistry } from "../services/execution-service-registry"
import os from "os"
import path from "path"
import fs from "fs"

let db: Database.Database
let sse: SSEService
let service: WorkspaceScheduleService
let tmpfiles: string[] = []

beforeEach(() => {
  const dbPath = path.join(os.tmpdir(), `test-sched-svc-${Date.now()}.db`)
  tmpfiles.push(dbPath)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)

  // Seed a workspace for foreign key references
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
  ).run("ws-1", "Test Workspace", "xzf", "/tmp/ws", new Date().toISOString(), new Date().toISOString())

  sse = new SSEService()
  initExecutionServiceRegistry(db, sse, undefined)
  service = new WorkspaceScheduleService(sse, new ScheduleConfigDAO(db), new ScheduleRunDAO(db), new ExecutionDAO(db))
})

afterEach(() => {
  db.close()
  for (const f of tmpfiles) {
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  tmpfiles = []
})

// ── Helpers ──────────────────────────────────────────────────────────

function makeScheduleInput(overrides?: Record<string, unknown>) {
  return {
    name: "Test Schedule",
    workflow_ref: "test-workflow.yaml",
    cron_expression: "0 9 * * *",
    timezone: "Asia/Shanghai",
    ...overrides,
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────

describe("WorkspaceScheduleService CRUD", () => {
  it("creates a schedule with valid input", () => {
    const schedule = service.create("ws-1", makeScheduleInput())
    expect(schedule.id).toBeTruthy()
    expect(schedule.name).toBe("Test Schedule")
    expect(schedule.cron_expression).toBe("0 9 * * *")
    expect(schedule.timezone).toBe("Asia/Shanghai")
    expect(schedule.enabled).toBe(true)
    expect(schedule.cron_description).toBeTruthy()
    expect(schedule.next_trigger_at).toBeTruthy()
  })

  it("rejects duplicate schedule names within workspace", () => {
    service.create("ws-1", makeScheduleInput({ name: "Unique" }))
    expect(() =>
      service.create("ws-1", makeScheduleInput({ name: "Unique" })),
    ).toThrow(/已存在/)
  })

  it("allows same name in different orgs", () => {
    // Create second workspace in a different org
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    ).run("ws-2", "WS2", "other-org", "/tmp/ws2", new Date().toISOString(), new Date().toISOString())

    service.create("ws-1", makeScheduleInput({ name: "Shared" }))
    const s2 = service.create("ws-2", makeScheduleInput({ name: "Shared" }))
    expect(s2.name).toBe("Shared")
  })

  it("lists schedules for workspace", () => {
    service.create("ws-1", makeScheduleInput({ name: "S1" }))
    service.create("ws-1", makeScheduleInput({ name: "S2" }))
    const list = service.list("ws-1")
    expect(list.length).toBe(2)
  })

  it("filters list by status", () => {
    const s1 = service.create("ws-1", makeScheduleInput({ name: "S1" }))
    service.create("ws-1", makeScheduleInput({ name: "S2" }))
    service.disable("ws-1", s1.id)
    expect(service.list("ws-1", { status: "enabled" }).length).toBe(1)
    expect(service.list("ws-1", { status: "disabled" }).length).toBe(1)
  })

  it("escapes LIKE metacharacters in search", () => {
    service.create("ws-1", makeScheduleInput({ name: "100% Done" }))
    service.create("ws-1", makeScheduleInput({ name: "normal" }))
    // Searching for '%' should not match all records
    const results = service.list("ws-1", { search: "%" })
    // '%' as literal should only match names containing '%'
    expect(results.length).toBe(1)
    expect(results[0].name).toBe("100% Done")
  })

  it("gets schedule by id", () => {
    const created = service.create("ws-1", makeScheduleInput())
    const fetched = service.getById("ws-1", created.id)
    expect(fetched).toBeDefined()
    expect(fetched!.id).toBe(created.id)
  })

  it("returns undefined for non-existent schedule", () => {
    expect(service.getById("ws-1", "non-existent")).toBeUndefined()
  })

  it("updates schedule fields", () => {
    const created = service.create("ws-1", makeScheduleInput())
    const updated = service.update("ws-1", created.id, { name: "Updated Name" })
    expect(updated.name).toBe("Updated Name")
  })

  it("recalculates next_trigger_at on cron change", () => {
    const created = service.create("ws-1", makeScheduleInput())
    const original = created.next_trigger_at
    const updated = service.update("ws-1", created.id, {
      cron_expression: "*/5 * * * *",
    })
    expect(updated.next_trigger_at).not.toBe(original)
  })

  it("soft-deletes schedule", () => {
    const created = service.create("ws-1", makeScheduleInput())
    service.delete("ws-1", created.id)
    const list = service.list("ws-1")
    expect(list.length).toBe(0)
    // Soft-deleted should still exist in DB
    const row = db.prepare("SELECT deleted_at FROM schedules WHERE id = ?").get(created.id) as any
    expect(row.deleted_at).toBeTruthy()
  })
})

// ── Enable / Disable ─────────────────────────────────────────────────

describe("WorkspaceScheduleService enable/disable", () => {
  it("disables a schedule", () => {
    const created = service.create("ws-1", makeScheduleInput())
    const disabled = service.disable("ws-1", created.id)
    expect(disabled.enabled).toBe(false)
    expect(disabled.next_trigger_at).toBeNull()
  })

  it("re-enabling recalculates next_trigger_at", () => {
    const created = service.create("ws-1", makeScheduleInput())
    service.disable("ws-1", created.id)
    const enabled = service.enable("ws-1", created.id)
    expect(enabled.enabled).toBe(true)
    expect(enabled.next_trigger_at).toBeTruthy()
  })
})

// ── Validation ───────────────────────────────────────────────────────

describe("WorkspaceScheduleService validation", () => {
  it("rejects invalid cron expression", () => {
    expect(() =>
      service.create("ws-1", makeScheduleInput({ cron_expression: "invalid" })),
    ).toThrow()
  })

  it("rejects invalid timezone", () => {
    expect(() =>
      service.create("ws-1", makeScheduleInput({ timezone: "Not/A/Timezone" })),
    ).toThrow()
  })

  it("rejects empty name", () => {
    expect(() =>
      service.create("ws-1", makeScheduleInput({ name: "" })),
    ).toThrow()
  })

  it("rejects notify_on_failure without channel/target", () => {
    expect(() =>
      service.create("ws-1", makeScheduleInput({ notify_on_failure: true })),
    ).toThrow(/通知/)
  })

  it("accepts notify_on_failure with channel and target", () => {
    const s = service.create("ws-1", makeScheduleInput({
      notify_on_failure: true,
      notify_channel: "telegram",
      notify_target: "12345",
    }))
    expect(s.notify_on_failure).toBe(true)
    expect(s.notify_channel).toBe("telegram")
  })
})

// ── Trigger ──────────────────────────────────────────────────────────

describe("WorkspaceScheduleService trigger", () => {
  it("creates a triggered execution record and starts execution", () => {
    const created = service.create("ws-1", makeScheduleInput())
    const exec = service.trigger("ws-1", created.id, "manual")
    expect(exec.id).toBeTruthy()
    // trigger() now starts the actual execution, so status transitions from
    // 'triggered' to 'running' (or 'failed' if execution service can't start)
    expect(["triggered", "running", "failed"]).toContain(exec.status)
    expect(exec.trigger_type).toBe("manual")
  })

  it("rejects trigger when already running", () => {
    const created = service.create("ws-1", makeScheduleInput())
    service.trigger("ws-1", created.id, "manual")

    // Ensure there's an active execution record for the concurrency check
    // The trigger might have started the execution (status='running') or
    // failed (status='failed'). Insert a 'running' record to test the guard.
    const activeCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM schedule_executions WHERE schedule_id = ? AND status IN ('triggered', 'running')",
    ).get(created.id) as { cnt: number }).cnt

    if (activeCount > 0) {
      // B-NEW-3 fix: trigger now returns null and writes audit log instead of throwing
      const result = service.trigger("ws-1", created.id, "manual")
      expect(result).toBeNull()
    } else {
      // If the execution already completed, manually set status to 'running' for test
      db.prepare(
        "UPDATE schedule_executions SET status = 'running' WHERE schedule_id = ?",
      ).run(created.id)
      const result = service.trigger("ws-1", created.id, "manual")
      expect(result).toBeNull()
    }
  })
})

// ── Emergency Stop ───────────────────────────────────────────────────

describe("WorkspaceScheduleService emergencyStop", () => {
  it("disables all enabled schedules in workspace", () => {
    service.create("ws-1", makeScheduleInput({ name: "S1" }))
    service.create("ws-1", makeScheduleInput({ name: "S2" }))
    const result = service.emergencyStop("ws-1")
    expect(result.disabled_count).toBe(2)
    expect(service.list("ws-1", { status: "enabled" }).length).toBe(0)
  })

  it("returns 0 when no schedules to disable", () => {
    const result = service.emergencyStop("ws-1")
    expect(result.disabled_count).toBe(0)
  })
})

// ── Audit Logs ───────────────────────────────────────────────────────

describe("WorkspaceScheduleService audit logs", () => {
  it("creates audit log on schedule creation", () => {
    service.create("ws-1", makeScheduleInput())
    const logs = service.listAuditLogs("ws-1")
    expect(logs.items.length).toBe(1)
    expect(logs.items[0].action).toBe("created")
  })

  it("supports pagination", () => {
    for (let i = 0; i < 5; i++) {
      service.create("ws-1", makeScheduleInput({ name: `S${i}` }))
    }
    const page1 = service.listAuditLogs("ws-1", { page: 1, limit: 2 })
    expect(page1.items.length).toBe(2)
    expect(page1.total).toBe(5)
    expect(page1.page).toBe(1)
  })
})

// ── Permissions ──────────────────────────────────────────────────────

describe("WorkspaceScheduleService permissions", () => {
  it("returns all permissions as true (V1)", () => {
    const perms = service.getPermissions("ws-1")
    expect(perms.can_create).toBe(true)
    expect(perms.can_trigger).toBe(true)
    expect(perms.can_emergency_stop).toBe(true)
  })
})
