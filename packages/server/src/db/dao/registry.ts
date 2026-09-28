// packages/server/src/db/dao/registry.ts
//
// DAO 注册表 —— P1 单引擎迁移 B0.5 收口票（p1-batch-plan.md §5 方案1）。
//
// 为什么存在：`src/index.ts` 是 7/7 迁移批次的公共冲突面 —— 每批都要在
// 这里改自己那一个 DAO 的构造/import。外提后 B1-B5 每批只改本文件里
// 自己那 1-2 行（eager 工厂 + lazy 工厂），index.ts 直到 B6 才再动。
//
// 迁移期约定（§5 方案3）：
//   - 新异步 DAO（extends BasePgDAO）一律经本注册表注入，禁止新增
//     `new XxxDAO(getDb())` 直构。
//   - lazyDAO 工厂签名 `make: (db: DbHandle) => T`：混合期 SQLite DAO 收
//     Database、已迁 PG 的 DAO 收 Sql。当前句柄源仍是 getDb()（SQLite）；
//     B6 收口时 DbHandle 收窄为 Sql、句柄源换成池。
//
// 行为与 index.ts 原 :127-173 / :379-413 逐字等价（B0.5 只做搬家，零语义变化）。

import type { Sql } from "postgres"
import { getDb } from "../connection"
import { getPgPool } from "../pg/pool"
import {
  WorkspaceDAO, ExecutionDAO, TokenUsageDAO, ScheduleConfigDAO,
  ScheduleRunDAO, ChatDAO, OrgDAO, AgentSessionDAO, EvolutionDAO,
  CloneDAO, SafetyDAO, PendingReviewDAO, KnowledgeEffectivenessDAO,
  ArchiveDAO, ArchiveDraftDAO, InteractionMessageDAO, AgentVersionDAO,
  HarnessDAO, TaskDAO,
} from "./index"

/** 迁移期双引擎句柄联合（B6 收窄为 Sql）。Database 侧经 getDb() 的 ReturnType 取，避免直引无类型包。 */
export type DbHandle = ReturnType<typeof getDb> | Sql

type DatabaseDb = ReturnType<typeof getDb>

/**
 * B1+ 已迁 PG 的 DAO（extends BasePgDAO）的句柄源 —— postgres.js 池。
 * 池未注册（OCTOPUS_PG_URL 未配 / initPgPool 未完成）时**抛错**：
 * lazyDAO 的 Proxy 在每次属性访问时构造，抛错则保持未构造态，下次访问自动重试
 * （自愈窗口 = initPgPool 的连接往返）。启动路径 eager 位点同样走 lazyDAO，
 * 不会因池晚到而崩启动。
 */
export function pgSql(): Sql {
  const h = getPgPool()
  if (!h) throw new Error("[registry] PG pool not registered — set OCTOPUS_PG_URL (or registerPgPool in tests)")
  return h.sql
}

export interface AllDAOs {
  workspace: WorkspaceDAO
  execution: ExecutionDAO
  tokenUsage: TokenUsageDAO
  scheduleConfig: ScheduleConfigDAO
  scheduleRun: ScheduleRunDAO
  chat: ChatDAO
  org: OrgDAO
  agentSession: AgentSessionDAO
  evolution: EvolutionDAO
  clone: CloneDAO
  safety: SafetyDAO
  pendingReview: PendingReviewDAO
  knowledgeEffectiveness: KnowledgeEffectivenessDAO
  archive: ArchiveDAO
  archiveDraft: ArchiveDraftDAO
  interactionMessage: InteractionMessageDAO
  agentVersion: AgentVersionDAO
  harness: HarnessDAO
  // 03: first-class tasks table DAO (v2-D1).
  task: TaskDAO
}

/** 启动路径（非 VITEST）用：db 已就绪，全部立即构造 —— fail-fast。 */
export function createAllDAOs(db: DatabaseDb): AllDAOs {
  return {
    workspace: new WorkspaceDAO(db),
    execution: new ExecutionDAO(db),
    tokenUsage: lazyDAO(() => new TokenUsageDAO(pgSql())), // B4: PG
    scheduleConfig: new ScheduleConfigDAO(db),
    scheduleRun: new ScheduleRunDAO(db),
    chat: lazyDAO(() => new ChatDAO(pgSql())), // B1: PG
    org: lazyDAO(() => new OrgDAO(pgSql())), // B1: PG
    agentSession: lazyDAO(() => new AgentSessionDAO(pgSql())), // B3: PG
    evolution: lazyDAO(() => new EvolutionDAO(pgSql())), // B3: PG
    clone: lazyDAO(() => new CloneDAO(pgSql())), // B1: PG
    safety: lazyDAO(() => new SafetyDAO(pgSql())), // B2: PG
    pendingReview: lazyDAO(() => new PendingReviewDAO(pgSql())), // B2: PG
    knowledgeEffectiveness: lazyDAO(() => new KnowledgeEffectivenessDAO(pgSql())), // B2: PG
    archive: new ArchiveDAO(db),
    archiveDraft: new ArchiveDraftDAO(db),
    interactionMessage: lazyDAO(() => new InteractionMessageDAO(pgSql())), // B2: PG
    agentVersion: lazyDAO(() => new AgentVersionDAO(pgSql())), // B1: PG
    harness: lazyDAO(() => new HarnessDAO(pgSql())), // B1: PG
    task: lazyDAO(() => new TaskDAO(pgSql())), // B2: PG
  }
}

/**
 * 测试模式（VITEST）用：首次方法访问时才构造真 DAO。
 * 时序与 index.ts 原 lazyDAO 完全一致 —— 每次访问都在构造时读 getDb()，
 * 因此测试在 import 之后、首个请求之前 initDb() 的既有习惯不变。
 */
export function lazyDAO<T>(make: (db: DbHandle) => T): T {
  let real: T | null = null
  return new Proxy({} as Record<PropertyKey, unknown>, {
    get(_, prop) {
      if (!real) real = make(getDb())
      const val = (real as Record<PropertyKey, unknown>)[prop as string]
      return typeof val === 'function' ? val.bind(real) : val
    },
  }) as T
}

/** lazy 兜底注册表 —— 内容与 createAllDAOs 一一对应。 */
export function createLazyDAOs(): AllDAOs {
  return {
    workspace: lazyDAO((db) => new WorkspaceDAO(db as DatabaseDb)),
    execution: lazyDAO((db) => new ExecutionDAO(db as DatabaseDb)),
    tokenUsage: lazyDAO(() => new TokenUsageDAO(pgSql())), // B4: PG
    scheduleConfig: lazyDAO((db) => new ScheduleConfigDAO(db as DatabaseDb)),
    scheduleRun: lazyDAO((db) => new ScheduleRunDAO(db as DatabaseDb)),
    chat: lazyDAO(() => new ChatDAO(pgSql())), // B1: PG
    org: lazyDAO(() => new OrgDAO(pgSql())), // B1: PG
    agentSession: lazyDAO(() => new AgentSessionDAO(pgSql())), // B3: PG
    evolution: lazyDAO(() => new EvolutionDAO(pgSql())), // B3: PG
    clone: lazyDAO(() => new CloneDAO(pgSql())), // B1: PG
    safety: lazyDAO(() => new SafetyDAO(pgSql())), // B2: PG
    pendingReview: lazyDAO(() => new PendingReviewDAO(pgSql())), // B2: PG
    knowledgeEffectiveness: lazyDAO(() => new KnowledgeEffectivenessDAO(pgSql())), // B2: PG
    archive: lazyDAO((db) => new ArchiveDAO(db as DatabaseDb)),
    archiveDraft: lazyDAO((db) => new ArchiveDraftDAO(db as DatabaseDb)),
    interactionMessage: lazyDAO(() => new InteractionMessageDAO(pgSql())), // B2: PG
    agentVersion: lazyDAO(() => new AgentVersionDAO(pgSql())), // B1: PG
    harness: lazyDAO(() => new HarnessDAO(pgSql())), // B1: PG
    // 03 (v2-D1): tasks table DAO. Added to the lazy fallback so `d.task` works
    // in test mode (VITEST) where `daos` is null and the lazy proxy branch is used.
    // 04's task-author autosave seam + TasksService both consume it.
    task: lazyDAO(() => new TaskDAO(pgSql())), // B2: PG
  }
}
