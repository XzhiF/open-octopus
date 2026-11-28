// 事项状态批量改（2026-11-26 用户）：舱主工具 cabin_set_item_status 的服务端实现。
//   覆盖：done / dropped 关项、todo 重开、缺 id 不拖垮整批、舱隔离。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../../db/schema"
import { CabinItemService } from "../cabin-item-service"

describe("CabinItemService.setStatus", () => {
  let db: Database.Database
  let svc: CabinItemService

  const insertCabin = (id: string) =>
    db.prepare(
      "INSERT INTO cabins (id, name, path, created_at, updated_at) VALUES (?,?,?,?,?)",
    ).run(id, id, `C:\\tmp\\${id}`, "2026-11-26T00:00:00.000Z", "2026-11-26T00:00:00.000Z")

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    svc = new CabinItemService(db)
    insertCabin("c1")
    insertCabin("c2")
  })

  afterEach(() => {
    db.close()
  })

  it("done / dropped 关项并写 closed_at，todo 重开并清空 closed_at", () => {
    const a = svc.create("c1", { title: "A" })
    const b = svc.create("c1", { title: "B" })
    svc.deliver("c1", [a.id, b.id])

    const done = svc.setStatus("c1", [a.id], "done")
    expect(done.missing).toEqual([])
    expect(done.items[0].status).toBe("done")
    expect(done.items[0].closed_at).toBeTruthy()

    const dropped = svc.setStatus("c1", [b.id], "dropped")
    expect(dropped.items[0].status).toBe("dropped")

    const reopened = svc.setStatus("c1", [a.id], "todo")
    expect(reopened.items[0].status).toBe("todo")
    expect(reopened.items[0].closed_at).toBeNull()
  })

  it("缺 id 报 missing，其余照常改；别的舱的 id 不能动", () => {
    const mine = svc.create("c1", { title: "mine" })
    const other = svc.create("c2", { title: "other" })

    const res = svc.setStatus("c1", [mine.id, "ci-nope", other.id], "done")
    expect(res.missing.sort()).toEqual(["ci-nope", other.id].sort())
    expect(res.items).toHaveLength(1)
    expect(res.items[0].status).toBe("done")
    expect(svc.get("c2", other.id).status).toBe("todo")
  })

  it("重复改同一目标状态是幂等的，不会刷新 closed_at 以外的行", () => {
    const a = svc.create("c1", { title: "A" })
    svc.setStatus("c1", [a.id], "done")
    const first = svc.get("c1", a.id)
    const again = svc.setStatus("c1", [a.id], "done")
    expect(again.items[0].status).toBe("done")
    expect(again.items[0].closed_at).toBe(first.closed_at)
  })
})
