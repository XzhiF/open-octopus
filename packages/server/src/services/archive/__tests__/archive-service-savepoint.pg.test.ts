/**
 * 票6aR · archive-service §6 最高危事务的 savepoint 化失败注入用例。
 *
 * 场景：archiveWorkspaceForDelete 的事务体内 for 循环逐条写 execution_archive。
 * 旧 sqlite 语义 = 体内单条失败语句不污染事务（failures 收集后统一 throw 回滚）；
 * PG 裸事务 = 第一条失败语句即 abort 全事务（后续全部 25P02，failures 收集逻辑全毁）。
 * 票6a 改为逐条 tx.savepoint：失败只回滚该 savepoint，事务保持可用。
 *
 * 本用例钉住「第一条失败不回滚已成功（事务不被拖垮）」语义：
 * 注入 exec-1 写失败后，exec-2/exec-3 的写入照常执行（不出现
 * current transaction is aborted），failures 恰为一条纯注入错误；
 * 随后 ArchivePartialFailure 照旧整体回滚（删除路径不变量：归档失败 → 不删数据），
 * 落 archive_failed 诊断态。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ArchiveDAO } from "../../../db/dao/archive-dao"
import { ExecutionDAO } from "../../../db/dao/execution-dao"
import { WorkspaceDAO } from "../../../db/dao/workspace-dao"
import type { PgSql } from "../../../db/dao/base-pg"
import type { ExecutionArchiveRow } from "../../../db/types"
import { ArchiveService, ArchivePartialFailure } from "../archive-service"
import { describePg, setupPgSchema, type PgFixture } from "../../../db/pg/__tests__/dao-fixture"

describePg("ArchiveService workspace transaction — savepoint 失败注入（PG）", () => {
  let pg: PgFixture

  beforeAll(async () => {
    pg = await setupPgSchema()
  })
  afterAll(async () => {
    await pg?.close()
  })
  beforeEach(async () => {
    await pg.truncate("execution_archive", "workspace_archive", "executions", "workspaces")
    await pg.sql.unsafe(
      `INSERT INTO workspaces (id, name, org, status, path, created_at, updated_at)
       VALUES ('ws-sp', 'savepoint-ws', 'test-org', 'active', '/tmp/ws-savepoint-test', now(), now())`,
    )
    for (const id of ["exec-1", "exec-2", "exec-3"]) {
      await pg.sql.unsafe(
        `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, created_at, updated_at)
         VALUES ($1, 'ws-sp', 'test.yaml', 'test-workflow', 'completed', 'test-org', now(), now())`,
        [id] as never,
      )
    }
  })

  function makeService(archiveDaoForTx?: (tx: PgSql) => ArchiveDAO): ArchiveService {
    return new ArchiveService(
      new ArchiveDAO(pg.sql),
      new ExecutionDAO(pg.sql),
      () => pg.sql,
      undefined,
      archiveDaoForTx,
    )
  }

  /** §8 网③ 注入缝：按 execution_id 让 insertExecutionArchive 抛错。 */
  function failingInsertFactory(failOn: string, message: string) {
    return (tx: PgSql): ArchiveDAO => {
      const dao = new ArchiveDAO(tx)
      const orig = dao.insertExecutionArchive.bind(dao)
      dao.insertExecutionArchive = async (row: ExecutionArchiveRow) => {
        if (row.execution_id === failOn) throw new Error(message)
        return orig(row)
      }
      return dao
    }
  }

  it("第一条失败不回滚已成功：savepoint 后循环继续、failures 恰一条注入错误、最终整体回滚", async () => {
    const injected = "injected archive failure"
    const service = makeService(failingInsertFactory("exec-1", injected))

    let caught: unknown
    try {
      await service.archiveWorkspaceForDelete("ws-sp", new WorkspaceDAO(pg.sql))
      throw new Error("expected archiveWorkspaceForDelete to reject")
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ArchivePartialFailure)
    const failure = caught as ArchivePartialFailure
    // 核心断言（savepoint 语义）：失败恰为注入的那一条 —— 若事务被第一条失败
    // 语句 abort（25P02），exec-2/exec-3 会连坐出 3 条 "current transaction is
    // aborted" 型错误，failures 收集逻辑即毁。
    expect(failure.failures).toHaveLength(1)
    expect(failure.failures[0].execId).toBe("exec-1")
    expect(failure.failures[0].error).toContain(injected)
    expect(JSON.stringify(failure.failures)).not.toMatch(/aborted/iu)

    // 回滚不变量：事务体零落库（归档失败 → 不删数据的删除路径前提）。
    const execArch = await pg.sql.unsafe(
      `SELECT COUNT(*)::int AS cnt FROM execution_archive WHERE workspace_id = 'ws-sp'`,
    )
    const wsArch = await pg.sql.unsafe(
      `SELECT COUNT(*)::int AS cnt FROM workspace_archive WHERE workspace_id = 'ws-sp'`,
    )
    expect(Number((execArch[0] as { cnt: number }).cnt)).toBe(0)
    expect(Number((wsArch[0] as { cnt: number }).cnt)).toBe(0)

    // 事务回滚后 catch 分支的诊断态（池句柄事务外写，与 sqlite 时代一致）。
    const ws = await new WorkspaceDAO(pg.sql).findById("ws-sp")
    expect(ws!.archive_status).toBe("archive_failed")
  })

  it("对照：无注入时三条 execution_archive + workspace_archive 全落库", async () => {
    const service = makeService()
    const result = await service.archiveWorkspaceForDelete("ws-sp", new WorkspaceDAO(pg.sql))
    expect(result.archived).toBe(true)
    expect(result.execution_count).toBe(3)

    const execArch = await pg.sql.unsafe(
      `SELECT COUNT(*)::int AS cnt FROM execution_archive WHERE workspace_id = 'ws-sp'`,
    )
    const ws = await new WorkspaceDAO(pg.sql).findById("ws-sp")
    expect(Number((execArch[0] as { cnt: number }).cnt)).toBe(3)
    expect(ws!.archive_status).toBe("archived")
  })
})
