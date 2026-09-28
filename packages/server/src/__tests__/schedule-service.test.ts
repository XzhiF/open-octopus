import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type Database from "better-sqlite3"
import { closeDb, initDb } from "../db/connection"
import { WorkspaceScheduleService } from "../services/schedule"
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO } from '../db/dao'
import { SSEService } from "../services/sse"
import { initExecutionServiceRegistry } from "../services/execution-service-registry"
import { describePg, setupRegisteredPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"
import os from "os"
import path from "path"
import fs from "fs"

// P1 B5 票4：schedules/schedule_executions/schedule_audit_logs 已随 ScheduleConfigDAO/
// ScheduleRunDAO 落 PG（B5 票1）。executions/workspaces 仍在 SQLite（票5 域），
// 因此 workspaces 父行双引擎各插一份（findWorkspaceOrg/schedules FK 读 PG 侧）。
// initDb 点亮全局句柄供 registry lazyDAO；setupRegisteredPgSchema 注册全局池。
describePg("WorkspaceScheduleService (PG)", () => {
  let db: Database.Database
  let pg: PgFixture
  let sse: SSEService
  let service: WorkspaceScheduleService
  const tmpfiles: string[] = []

  /** workspaces 父行两侧各插一份：SQLite 给 ExecutionDAO/registry，PG 给
   *  ScheduleConfigDAO.findWorkspaceOrg + schedules.workspace_id FK。 */
  async function seedWorkspace(id: string, name: string, org: string, wsPath: string): Promise<void> {
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    ).run(id, name, org, wsPath, now, now)
    await pg.sql.unsafe(
      `INSERT INTO workspaces (id, name, org, path, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
      [id, name, org, wsPath, now, now],
    )
  }

  beforeEach(async () => {
    pg = await setupRegisteredPgSchema()
    const dbPath = path.join(os.tmpdir(), `test-sched-svc-${Date.now()}.db`)
    tmpfiles.push(dbPath)
    db = initDb(dbPath)
    db.pragma("foreign_keys = ON")

    // Seed a workspace for foreign key references
    await seedWorkspace("ws-1", "Test Workspace", "xzf", "/tmp/ws")

    sse = new SSEService()
    initExecutionServiceRegistry(db, sse, undefined)
    service = new WorkspaceScheduleService(
      sse,
      new ScheduleConfigDAO(pg.sql),
      new ScheduleRunDAO(pg.sql),
      new ExecutionDAO(db),
    )
  })

  afterEach(async () => {
    await pg.close()
    db.close()
    closeDb()
    for (const f of tmpfiles) {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
    tmpfiles.length = 0
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
    it("creates a schedule with valid input", async () => {
      const schedule = await service.create("ws-1", makeScheduleInput())
      expect(schedule.id).toBeTruthy()
      expect(schedule.name).toBe("Test Schedule")
      expect(schedule.cron_expression).toBe("0 9 * * *")
      expect(schedule.timezone).toBe("Asia/Shanghai")
      expect(schedule.enabled).toBe(true)
      expect(schedule.cron_description).toBeTruthy()
      expect(schedule.next_trigger_at).toBeTruthy()
    })

    it("rejects duplicate schedule names within workspace", async () => {
      await service.create("ws-1", makeScheduleInput({ name: "Unique" }))
      await expect(
        service.create("ws-1", makeScheduleInput({ name: "Unique" })),
      ).rejects.toThrow(/已存在/)
    })

    it("allows same name in different orgs", async () => {
      // Create second workspace in a different org
      await seedWorkspace("ws-2", "WS2", "other-org", "/tmp/ws2")

      await service.create("ws-1", makeScheduleInput({ name: "Shared" }))
      const s2 = await service.create("ws-2", makeScheduleInput({ name: "Shared" }))
      expect(s2.name).toBe("Shared")
    })

    it("lists schedules for workspace", async () => {
      await service.create("ws-1", makeScheduleInput({ name: "S1" }))
      await service.create("ws-1", makeScheduleInput({ name: "S2" }))
      const list = await service.list("ws-1")
      expect(list.length).toBe(2)
    })

    it("filters list by status", async () => {
      const s1 = await service.create("ws-1", makeScheduleInput({ name: "S1" }))
      await service.create("ws-1", makeScheduleInput({ name: "S2" }))
      await service.disable("ws-1", s1.id)
      expect((await service.list("ws-1", { status: "enabled" })).length).toBe(1)
      expect((await service.list("ws-1", { status: "disabled" })).length).toBe(1)
    })

    it("escapes LIKE metacharacters in search", async () => {
      await service.create("ws-1", makeScheduleInput({ name: "100% Done" }))
      await service.create("ws-1", makeScheduleInput({ name: "normal" }))
      // Searching for '%' should not match all records
      const results = await service.list("ws-1", { search: "%" })
      // '%' as literal should only match names containing '%'
      expect(results.length).toBe(1)
      expect(results[0].name).toBe("100% Done")
    })

    it("gets schedule by id", async () => {
      const created = await service.create("ws-1", makeScheduleInput())
      const fetched = await service.getById("ws-1", created.id)
      expect(fetched).toBeDefined()
      expect(fetched!.id).toBe(created.id)
    })

    it("returns undefined for non-existent schedule", async () => {
      expect(await service.getById("ws-1", "non-existent")).toBeUndefined()
    })

    it("updates schedule fields", async () => {
      const created = await service.create("ws-1", makeScheduleInput())
      const updated = await service.update("ws-1", created.id, { name: "Updated Name" })
      expect(updated.name).toBe("Updated Name")
    })

    it("recalculates next_trigger_at on cron change", async () => {
      const created = await service.create("ws-1", makeScheduleInput())
      const original = created.next_trigger_at
      const updated = await service.update("ws-1", created.id, {
        cron_expression: "*/5 * * * *",
      })
      expect(updated.next_trigger_at).not.toBe(original)
    })

    it("soft-deletes schedule", async () => {
      const created = await service.create("ws-1", makeScheduleInput())
      await service.delete("ws-1", created.id)
      const list = await service.list("ws-1")
      expect(list.length).toBe(0)
      // Soft-deleted should still exist in DB (PG 侧 schedules)
      const rows = await pg.sql<{ deleted_at: Date | null }[]>`
        SELECT deleted_at FROM schedules WHERE id = ${created.id}`
      expect(rows[0]!.deleted_at).toBeTruthy()
    })
  })

  // ── Enable / Disable ─────────────────────────────────────────────────

  describe("WorkspaceScheduleService enable/disable", () => {
    it("disables a schedule", async () => {
      const created = await service.create("ws-1", makeScheduleInput())
      const disabled = await service.disable("ws-1", created.id)
      expect(disabled.enabled).toBe(false)
      expect(disabled.next_trigger_at).toBeNull()
    })

    it("re-enabling recalculates next_trigger_at", async () => {
      const created = await service.create("ws-1", makeScheduleInput())
      await service.disable("ws-1", created.id)
      const enabled = await service.enable("ws-1", created.id)
      expect(enabled.enabled).toBe(true)
      expect(enabled.next_trigger_at).toBeTruthy()
    })
  })

  // ── Validation ───────────────────────────────────────────────────────

  describe("WorkspaceScheduleService validation", () => {
    it("rejects invalid cron expression", async () => {
      await expect(
        service.create("ws-1", makeScheduleInput({ cron_expression: "invalid" })),
      ).rejects.toThrow()
    })

    it("rejects invalid timezone", async () => {
      await expect(
        service.create("ws-1", makeScheduleInput({ timezone: "Not/A/Timezone" })),
      ).rejects.toThrow()
    })

    it("rejects empty name", async () => {
      await expect(
        service.create("ws-1", makeScheduleInput({ name: "" })),
      ).rejects.toThrow()
    })

    it("rejects notify_on_failure without channel/target", async () => {
      await expect(
        service.create("ws-1", makeScheduleInput({ notify_on_failure: true })),
      ).rejects.toThrow(/通知/)
    })

    it("accepts notify_on_failure with channel and target", async () => {
      const s = await service.create("ws-1", makeScheduleInput({
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
    it("creates a triggered execution record and starts execution", async () => {
      const created = await service.create("ws-1", makeScheduleInput())
      const exec = await service.trigger("ws-1", created.id, "manual")
      expect(exec!.id).toBeTruthy()
      // trigger() now starts the actual execution, so status transitions from
      // 'triggered' to 'running' (or 'failed' if execution service can't start)
      expect(["triggered", "running", "failed"]).toContain(exec!.status)
      expect(exec!.trigger_type).toBe("manual")
    })

    it("rejects trigger when already running", async () => {
      const created = await service.create("ws-1", makeScheduleInput())
      await service.trigger("ws-1", created.id, "manual")

      // Ensure there's an active execution record for the concurrency check
      // The trigger might have started the execution (status='running') or
      // failed (status='failed'). Insert a 'running' record to test the guard.
      const activeCount = Number((await pg.sql`
        SELECT COUNT(*)::int AS cnt FROM schedule_executions
        WHERE schedule_id = ${created.id} AND status IN ('triggered', 'running')`
        )[0]!.cnt)

      if (activeCount > 0) {
        // B-NEW-3 fix: trigger now returns null and writes audit log instead of throwing
        const result = await service.trigger("ws-1", created.id, "manual")
        expect(result).toBeNull()
      } else {
        // If the execution already completed, manually set status to 'running' for test
        await pg.sql`UPDATE schedule_executions SET status = 'running' WHERE schedule_id = ${created.id}`
        const result = await service.trigger("ws-1", created.id, "manual")
        expect(result).toBeNull()
      }
    })
  })

  // ── Emergency Stop ───────────────────────────────────────────────────

  describe("WorkspaceScheduleService emergencyStop", () => {
    it("disables all enabled schedules in workspace", async () => {
      await service.create("ws-1", makeScheduleInput({ name: "S1" }))
      await service.create("ws-1", makeScheduleInput({ name: "S2" }))
      const result = await service.emergencyStop("ws-1")
      expect(result.disabled_count).toBe(2)
      expect((await service.list("ws-1", { status: "enabled" })).length).toBe(0)
    })

    it("returns 0 when no schedules to disable", async () => {
      const result = await service.emergencyStop("ws-1")
      expect(result.disabled_count).toBe(0)
    })
  })

  // ── Audit Logs ───────────────────────────────────────────────────────

  describe("WorkspaceScheduleService audit logs", () => {
    it("creates audit log on schedule creation", async () => {
      await service.create("ws-1", makeScheduleInput())
      const logs = await service.listAuditLogs("ws-1")
      expect(logs.items.length).toBe(1)
      expect(logs.items[0].action).toBe("created")
    })

    it("supports pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await service.create("ws-1", makeScheduleInput({ name: `S${i}` }))
      }
      const page1 = await service.listAuditLogs("ws-1", { page: 1, limit: 2 })
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
})
