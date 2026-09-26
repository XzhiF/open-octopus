import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { normalizeModelId } from "@octopus/shared"
import { llmCallsCostedViewSql } from "./price-sql"

// Cross-format __dirname: works in both CJS (tsup provides it) and ESM
declare const __dirname: string
const _dirname: string =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url))

export const SCHEMA_VERSION = 49

/**
 * Apply the complete unified schema to the given database.
 * Reads schema.sql from the same directory (works in both dev and bundled output).
 * Idempotent — all statements use IF NOT EXISTS.
 */
export function applySchema(db: Database.Database): void {
  // Handle schema changes for existing tables
  handleSchemaMigrations(db)

  const sqlPath = path.join(_dirname, "schema.sql")
  const sql = fs.readFileSync(sqlPath, "utf-8")
  db.exec(sql)

  // billing NEW-r2: 派生视图 llm_calls_costed（账本 + 查询时匹配的价格/厂商列）。
  // DROP+CREATE 每次重建 —— DDL 由 price-sql 生成，视图与代码永远同源。
  db.exec("DROP VIEW IF EXISTS llm_calls_costed")
  db.exec(llmCallsCostedViewSql())

  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}

function handleSchemaMigrations(db: Database.Database): void {
  // Check if execution_archive table exists with old schema (has 'id' column instead of 'execution_id' as PRIMARY KEY)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_archive'").all()
  if (tables.length > 0) {
    const cols = db.prepare("PRAGMA table_info(execution_archive)").all() as { name: string; pk: number }[]
    const idCol = cols.find(c => c.name === 'id')

    // Old schema: has 'id' as PRIMARY KEY (new schema uses 'execution_id' as PK)
    if (idCol && idCol.pk === 1) {
      const count = (db.prepare("SELECT COUNT(*) as cnt FROM execution_archive").get() as { cnt: number }).cnt
      // Rename to backup instead of dropping — preserves data for manual inspection
      db.exec("ALTER TABLE execution_archive RENAME TO execution_archive_old_schema_backup")
      console.log(`[schema] Renamed old execution_archive (${count} rows) → execution_archive_old_schema_backup`)
    }
  }

  // Check if workspace_archive table exists with old schema (has 'id' column and old column names)
  const wsTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_archive'").all()
  if (wsTables.length > 0) {
    const cols = db.prepare("PRAGMA table_info(workspace_archive)").all() as { name: string }[]
    const idCol = cols.find(c => c.name === 'id')
    const nameCol = cols.find(c => c.name === 'name')

    // Old schema: has 'id' as PRIMARY KEY and 'workspace_name' instead of 'name'
    // New schema: uses 'workspace_id' as PRIMARY KEY and has 'name' column
    if (idCol || !nameCol) {
      const count = (db.prepare("SELECT COUNT(*) as cnt FROM workspace_archive").get() as { cnt: number }).cnt
      // Rename to backup instead of dropping — preserves data for manual inspection
      db.exec("ALTER TABLE workspace_archive RENAME TO workspace_archive_old_schema_backup")
      console.log(`[schema] Renamed old workspace_archive (${count} rows) → workspace_archive_old_schema_backup`)
    }
  }

  // Drop legacy linked_* columns from chat_sessions (removed in interaction-node feature)
  dropLegacyColumnsFromChatSessions(db)

  // Add missing columns for existing tables
  ensureColumnsForExistingTables(db)

  // Migrate FTS table to include source column (schema version 29)
  migrateFtsTableWithSource(db)

  // Migrate experiences_fts to v2 content-sync mode (schema version 35)
  migrateExperiencesFtsV2(db)

  // schema v37: schedules — drop NOT NULL on cron_expression + add task-pool columns
  migrateSchedulesV37(db)

  // schema v38 ADDITIVE: origin cols are added via ensureColumnsForExistingTables
  // above (origin_type/origin_id/origin_role/assoc_meta). Nothing to do here for
  // the additive phase — origin cols coexist with the v37 task-pool hack cols
  // (trigger_source / source_chat_session_id) transiently.

  // schema v38b (ticket 06 / SG1b): DROP the task-pool hack cols trigger_source +
  // source_chat_session_id. Their承重 sites (scheduler-engine failed-promotion +
  // checkQueuedTasks filter + task-dispatch-service child creation) are migrated
  // to origin_type in the same ticket. Done AFTER the origin col migration above
  // so the build stays green through the removal. Safe on fresh DBs (table may
  // not exist yet / cols may not exist) and on existing dev DBs (cols dropped).
  migrateSchedulesV38DropTriggerCols(db)

  // schema v40 (task-phase-redesign K3): tasks.status CHECK gains awaiting_review +
  // archiving. Runs AFTER ensureColumnsForExistingTables so the v40 cols
  // (workspace_id / phase_index / round_index) are already on the old table and get
  // carried by the copy. Re-entrant: once the live table's DDL text contains the new
  // statuses it no-ops.
  migrateTasksStatusCheckV40(db)

  // schema v41 (ADR-0021): tasks.trigger_* / executions.task_id+run_id /
  // workspaces.task_id+run_id. AFTER the v40 rebuild on purpose — see the function doc.
  ensureColumnsV41(db)

  // schema v42 (ADR-0021 票03): schedules stops being a task's shadow — the polymorphic
  // origin back-reference and the envelope's due-time column come off.
  migrateSchedulesV42DropOriginCols(db)

  // schema v43 (perf/agent-event-optimize): agent_events timestamp 类型收口 + 冗余索引下线。
  migrateAgentEventsV43(db)

  // schema v44 (task-exec-tree): the single-instance latch widens from ROOTS to
  // INSTANCES — a v4 round chains under its predecessor (parent_id = 上一轮) so the task
  // reads as one tree, and a chained round must keep holding the latch.
  migrateExecTaskLatchV44(db)

  // schema v47 (billing-coverage-2 票04, KD17): llm_calls 归属列可空化 rebuild。
  // 跑在 v46 回填之前 —— 回填随后在同一张终态表上收敛。
  migrateLlmCallsNullableAttributionV47(db)

  // schema v46 (billing-coverage-2 票01, KD21): source_path 历史行回填。跑在
  // ensureColumnsForExistingTables 之后（列必已存在）；幂等 —— 只动 NULL 行。
  const v46Backfilled = backfillLlmCallSourcePath(db)
  if (v46Backfilled > 0) {
    console.log(`[schema v46] llm_calls: backfilled source_path on ${v46Backfilled} legacy rows`)
  }

  // schema v48 (billing NEW-r2): 计费翻转 —— 快照账 → 规则账。
  // llm_calls/ntu 的 cost 快照列全部移除、billing_price_config 加时间窗口、
  // 模型名统一归一化（normalizeModelId）。幂等：全部按列存在性/差异检测。
  migrateBillingV48(db)
}

/**
 * schema v46 (billing-coverage-2 票01): 回填 llm_calls 历史行的 source_path（KD21 ——
 * 可推断者如实，余 unknown；不造假归属，数据诚实优先）。推断依据 = 既有写入点特征：
 *   该 node_execution 有账本行 source='interaction' → interaction（优先于 execution 关联，
 *     interaction 轮同样挂在 node_executions 下）
 *   该 node_execution 有账本行 source='harness'    → harness
 *   有 node_executions / executions 关联            → workflow
 *   推不出                                          → unknown
 * 幂等：只写 source_path IS NULL 的行，重跑零变更（票 AC3）。返回变更行数供观测/测试。
 */
export function backfillLlmCallSourcePath(db: Database.Database): number {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_calls'").all()
  if (tables.length === 0) return 0 // fresh DB — schema.sql creates the column directly, no legacy rows
  try {
    return db.prepare(`
      UPDATE llm_calls SET source_path = CASE
        WHEN EXISTS (SELECT 1 FROM node_token_usages ntu
                     WHERE ntu.node_execution_id = llm_calls.node_execution_id AND ntu.source = 'interaction') THEN 'interaction'
        WHEN EXISTS (SELECT 1 FROM node_token_usages ntu
                     WHERE ntu.node_execution_id = llm_calls.node_execution_id AND ntu.source = 'harness') THEN 'harness'
        WHEN EXISTS (SELECT 1 FROM node_executions ne WHERE ne.id = llm_calls.node_execution_id) THEN 'workflow'
        WHEN EXISTS (SELECT 1 FROM executions e WHERE e.id = llm_calls.execution_id) THEN 'workflow'
        ELSE 'unknown'
      END
      WHERE source_path IS NULL
    `).run().changes
  } catch (err) {
    console.warn(`[schema v46] source_path backfill skipped: ${err instanceof Error ? err.message : String(err)}`)
    return 0
  }
}

/**
 * schema v47 (billing-coverage-2 票04, KD17「归属维度可得性如实」): llm_calls 的
 * node_execution_id / execution_id 从 NOT NULL 放宽为可空 —— 聊天/压缩类行
 * (session_compress 起，票 02/03 的 clone_chat/global_chat 同理) 没有执行链路，
 * 归属止步于 session 级；与其造假 FK 目标，不如如实留 NULL。FK 引用保留：
 * 非 NULL 值仍必须是真实 node_execution（SQLite 对 NULL 外键不强制）。
 *
 * SQLite 无法原地改 NOT NULL → 蓝绿 rebuild（同 v40 tasks 惯例）：建新表、显式列
 * 拷贝、换名。数据保留由设计 —— llm_calls 是已收的账，一行都不能丢。无子表引用
 * llm_calls（grep 证实），DROP+RENAME 不 strand 外键；foreign_keys 在 swap 前后
 * 关/复（FK 检查在事务里 toggle 无效，故 toggle 包在 transaction 外）。旧索引随表
 * 消失，由 schema.sql 的 CREATE INDEX IF NOT EXISTS（migrations 之后执行）重建。
 *
 * 幂等：PRAGMA table_info 显示两列已可空 → 直接返回；fresh DB 跳过（表不存在，
 * schema.sql 直接建 v47 形状）。
 */
function migrateLlmCallsNullableAttributionV47(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(llm_calls)").all() as Array<{ name: string; notnull: number }>
  if (cols.length === 0) return // fresh DB — schema.sql creates the v47 shape directly
  if (!cols.some(c => c.name === "node_execution_id" && c.notnull === 1)) return // already rebuilt

  const count = (db.prepare("SELECT COUNT(*) as cnt FROM llm_calls").get() as { cnt: number }).cnt
  // v48 形状：无 cost 快照列（钱查询时算）。旧表上残留的 cost 列不拷贝 —— 直接弃。
  const keepCols = [
    "id", "node_execution_id", "execution_id", "turn_index", "call_index", "message_id",
    "model", "stop_reason", "timestamp", "duration_ms", "ttft_ms",
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens",
    "org", "workspace_id", "workflow_ref", "node_id", "session_id", "instance_id", "source_path",
  ]
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE llm_calls_v47_rebuild (
        id                    TEXT PRIMARY KEY,
        node_execution_id     TEXT,
        execution_id          TEXT,
        turn_index            INTEGER NOT NULL,
        call_index            INTEGER NOT NULL,
        message_id            TEXT,
        model                 TEXT,
        stop_reason           TEXT,
        timestamp             INTEGER NOT NULL,
        duration_ms           INTEGER NOT NULL,
        ttft_ms               INTEGER,
        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        org                   TEXT,
        workspace_id          TEXT,
        workflow_ref          TEXT,
        node_id               TEXT,
        session_id            TEXT,
        instance_id           TEXT,
        source_path           TEXT,
        FOREIGN KEY (node_execution_id) REFERENCES node_executions(id)
      )
    `)
    // 只拷新表也有的列（旧表可能有 v45 cost 残留列）。
    const srcCols = cols.map(c => c.name).filter(n => keepCols.includes(n))
    db.exec(`
      INSERT INTO llm_calls_v47_rebuild (${srcCols.join(", ")})
      SELECT ${srcCols.join(", ")} FROM llm_calls
    `)
    db.exec("DROP TABLE llm_calls")
    db.exec("ALTER TABLE llm_calls_v47_rebuild RENAME TO llm_calls")
  })

  const fkWasOn = db.pragma("foreign_keys", { simple: true }) as number
  db.pragma("foreign_keys = OFF")
  try {
    rebuild()
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON")
  }
  // eslint-disable-next-line no-console
  console.log(`[schema v47] llm_calls rebuilt with nullable attribution cols (${count} rows preserved)`)
}

/**
 * schema v48 (billing NEW-r2): 计费翻转 —— 快照账 → 规则账。三件事，全部幂等：
 *
 *   1) 弃列 —— llm_calls 的 cost_usd/cost_native/cost_currency/price_status 与
 *      node_token_usages.cost_usd 全部删除。钱不再落账本；一切"显示钱"的地方
 *      都是查询时按 billing_price_config 窗口现算的派生值。ntu 旧复合索引引用
 *      cost_usd，先 DROP INDEX（schema.sql 的新版复合索引已不含该列，随后重建）。
 *   2) 价格表窗口化 —— 旧形状（model_id UNIQUE、无 valid_from）rebuild 成新形状；
 *      存量价行全部平移为「兜底价」（窗口双 NULL = 全时段生效）——这正是本次翻转
 *      的语义：晚配的价立刻回算全部历史。
 *   3) 模型名归一化 —— llm_calls.model / ntu.model / price.model_id 三表统一走
 *      shared normalizeModelId（剥 SDK/代理的 `[1M]` 等尾部残渣）；归一化后撞同一
 *      规范名的多条兜底价只保留 updated_at 最新的一条（其余删除，防部分唯一索引
 *      违反 + 消歧）。
 *
 * fresh DB 各步自动跳过（列/表形状检测差异，无操作）。
 */
export function migrateBillingV48(db: Database.Database): void {
  // 派生视图依赖 billing_price_config/llm_calls 列 —— 本迁移的 DROP COLUMN/RENAME
  // 会被 SQLite「dependents」检查拒绝。先撤视图；applySchema 在迁移之后统一重建。
  db.exec("DROP VIEW IF EXISTS llm_calls_costed")

  const colsOf = (t: string): string[] =>
    (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name)

  // ── 1) 弃快照列 ─────────────────────────────────────────────────
  const llmCols = colsOf("llm_calls")
  for (const col of ["cost_usd", "cost_native", "cost_currency", "price_status"]) {
    if (llmCols.includes(col)) {
      try {
        db.exec(`ALTER TABLE llm_calls DROP COLUMN ${col}`)
        console.log(`[schema v48] llm_calls.${col} dropped (cost is derived at query time)`)
      } catch (err) {
        console.warn(`[schema v48] llm_calls.${col} drop skipped: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  if (colsOf("node_token_usages").includes("cost_usd")) {
    db.exec("DROP INDEX IF EXISTS idx_ntu_composite") // 旧索引引用 cost_usd，先撤
    try {
      db.exec("ALTER TABLE node_token_usages DROP COLUMN cost_usd")
      console.log("[schema v48] node_token_usages.cost_usd dropped (node cost derives from llm_calls)")
    } catch (err) {
      console.warn(`[schema v48] ntu.cost_usd drop skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── 2) 价格表窗口化（存量行 → 全时段兜底价） ─────────────────────
  const priceCols = colsOf("billing_price_config")
  if (priceCols.length > 0 && !priceCols.includes("valid_from")) {
    const carry = [
      "id", "vendor", "model_id", "input_unit_price", "output_unit_price",
      "cache_write_unit_price", "cache_read_unit_price", "currency", "created_at", "updated_at",
    ].filter(c => priceCols.includes(c))
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE billing_price_config_v48 (
          id                     TEXT PRIMARY KEY,
          vendor                 TEXT NOT NULL,
          model_id               TEXT NOT NULL,
          input_unit_price       REAL NOT NULL,
          output_unit_price      REAL NOT NULL,
          cache_write_unit_price REAL NOT NULL,
          cache_read_unit_price  REAL NOT NULL,
          currency               TEXT NOT NULL CHECK (currency IN ('USD','CNY')),
          valid_from             INTEGER,
          valid_to               INTEGER,
          created_at             TEXT NOT NULL,
          updated_at             TEXT NOT NULL
        )
      `)
      db.exec(`INSERT INTO billing_price_config_v48 (${carry.join(", ")}) SELECT ${carry.join(", ")} FROM billing_price_config`)
      db.exec("DROP TABLE billing_price_config")
      db.exec("ALTER TABLE billing_price_config_v48 RENAME TO billing_price_config")
    })
    rebuild()
    console.log("[schema v48] billing_price_config rebuilt with valid_from/valid_to (legacy rows → catch-all prices)")
  }

  // ── 3) 模型名归一化 + 兜底价并撞 ─────────────────────────────────
  // 先撤部分唯一索引再改名/并撞（归一化可能把两条价撞进同键）；收尾重建索引。
  db.exec("DROP INDEX IF EXISTS ux_price_catchall")
  const normalizeIn = (table: string, col: string): number => {
    if (colsOf(table).length === 0) return 0
    const names = (db.prepare(`SELECT DISTINCT ${col} AS n FROM ${table} WHERE ${col} IS NOT NULL`).all() as Array<{ n: string }>).map(r => r.n)
    const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`)
    let changed = 0
    for (const n of names) {
      const norm = normalizeModelId(n)
      if (norm !== null && norm !== n) {
        upd.run(norm, n)
        changed++
      }
    }
    return changed
  }
  const dedupeCatchall = `
      DELETE FROM billing_price_config
      WHERE valid_from IS NULL AND valid_to IS NULL AND EXISTS (
        SELECT 1 FROM billing_price_config o
        WHERE o.valid_from IS NULL AND o.valid_to IS NULL
          AND o.model_id = billing_price_config.model_id
          AND (o.updated_at > billing_price_config.updated_at
               OR (o.updated_at = billing_price_config.updated_at AND o.id > billing_price_config.id))
      )
    `
  const merge = db.transaction(() => {
    const hasPrice = colsOf("billing_price_config").length > 0
    // 并撞先行（保留 updated_at 最新，同分取 id 大者 —— 确定性）
    const mergedFirst = hasPrice ? db.prepare(dedupeCatchall).run().changes : 0
    const nPrice = normalizeIn("billing_price_config", "model_id")
    const nCalls = normalizeIn("llm_calls", "model")
    const nNtu = normalizeIn("node_token_usages", "model")
    // 归一化可能引入新的兜底撞车 —— 再并一次
    if (nPrice > 0 && hasPrice) db.prepare(dedupeCatchall).run()
    return { mergedFirst, nPrice, nCalls, nNtu }
  })
  const m = merge()
  if (m.nPrice > 0 || m.nCalls > 0 || m.nNtu > 0 || m.mergedFirst > 0) {
    console.log(`[schema v48] model names normalized (price=${m.nPrice}, llm_calls=${m.nCalls}, ntu=${m.nNtu}, catch-all merged=${m.mergedFirst})`)
  }
  // fresh DB（迁移先于 schema.sql 建表）表还不存在 —— 索引改由 schema.sql 的 IF NOT EXISTS 建。
  if (colsOf("billing_price_config").length > 0) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_price_catchall ON billing_price_config(model_id)
        WHERE valid_from IS NULL AND valid_to IS NULL;
      CREATE INDEX IF NOT EXISTS ix_price_match ON billing_price_config(model_id, valid_from);
    `)
  }
}

/**
 * schema v43: agent_events 两项收口 —
 * 1. 回填文本时间戳:合并写路径 (replaceMergedEvents) 历史上往 INTEGER 列直存 ISO 串。
 *    SQLite 排序里整数恒小于文本,retention 的 `WHERE timestamp < <epoch-ms>` 对这些行
 *    永不命中 → 合并事件(节点收尾后的存活者)无限累积。统一换算成 epoch-ms。
 *    幂等:typeof='text' 不再命中即完成;无法解析的串保留原样并告警。
 * 2. 删除 idx_agent_events_node:与 PK 自动索引 (node_execution_id, event_order) 及
 *    idx_agent_events_turn 的左前缀完全重复,每次 insert 白维护一棵 B-tree。
 *    替代的 idx_agent_events_ts(服务 retention 范围扫描)由 schema.sql 的
 *    CREATE INDEX IF NOT EXISTS 在每次启动时自动补齐,不在此处建。
 */
function migrateAgentEventsV43(db: Database.Database): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_events'").all()
  if (tables.length === 0) return

  try {
    const fixed = db.prepare(`
      UPDATE agent_events
      SET timestamp = CAST(ROUND((julianday(timestamp) - 2440587.5) * 86400000) AS INTEGER)
      WHERE typeof(timestamp) = 'text' AND julianday(timestamp) IS NOT NULL
    `).run()
    if (fixed.changes > 0) {
      console.log(`[schema v43] agent_events: converted ${fixed.changes} ISO text timestamps → epoch-ms`)
    }
    const unparseable = (db.prepare(
      "SELECT COUNT(*) AS c FROM agent_events WHERE typeof(timestamp) = 'text'"
    ).get() as { c: number }).c
    if (unparseable > 0) {
      console.warn(`[schema v43] agent_events: ${unparseable} unparseable text timestamps left as-is`)
    }
  } catch (err) {
    console.warn(`[schema v43] timestamp backfill skipped: ${err instanceof Error ? err.message : String(err)}`)
  }

  db.exec("DROP INDEX IF EXISTS idx_agent_events_node")
}

/**
 * schema v44 (task-exec-tree): ux_exec_task_active 的谓词从「parent_id = '0'」放宽到
 * 「parent_id = '0' OR phase_index IS NOT NULL」。v4 轮次自此链式挂在上一轮下
 * (外层执行树 = 一棵树),但链式轮仍是任务实例 —— 不加回谓词,第二轮起单实例闩锁
 * 形同虚设。composite 子单元臂 (parent != '0' 且 phase_index IS NULL) 依旧在外。
 * 幂等:旧文本不含 phase_index 才 DROP;新谓词由 schema.sql 的 CREATE IF NOT EXISTS
 * 随后补建(migrations 先于 schema.sql 执行)。
 */
function migrateExecTaskLatchV44(db: Database.Database): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_exec_task_active'",
  ).get() as { sql: string } | undefined
  if (!row) return // fresh DB — schema.sql creates the new shape directly
  if (row.sql.includes("phase_index")) return // already rebuilt (re-entrant)

  // Fail-closed pre-check: the new predicate is built on the old invariant (one live
  // instance per task — rounds used to all be roots). If any task somehow holds two
  // live instance rows, dropping the old latch would hand schema.sql a UNIQUE
  // violation and kill startup. Refuse the rebuild and say so instead.
  const dupes = (db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT task_id FROM executions
       WHERE task_id IS NOT NULL AND (parent_id = '0' OR phase_index IS NOT NULL)
         AND status NOT IN ('completed','completed_with_failures','failed','cancelled','aborted','skipped','rejected')
       GROUP BY task_id HAVING COUNT(*) > 1
    )
  `).get() as { c: number }).c
  if (dupes > 0) {
    console.warn(`[schema v44] ux_exec_task_active NOT rebuilt: ${dupes} task(s) hold two live instance rows — resolve them (abort/reap), restart to retry`)
    return
  }
  db.exec("DROP INDEX ux_exec_task_active")
  console.log("[schema v44] ux_exec_task_active: dropped roots-only latch; schema.sql rebuilds it over instances")
}

/**
 * Drop legacy linked_* columns from chat_sessions.
 * These columns were part of an earlier interaction design that has been replaced
 * by the interaction_messages table. SQLite 3.35.0+ supports ALTER TABLE DROP COLUMN.
 */
function dropLegacyColumnsFromChatSessions(db: Database.Database): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_sessions'").all()
  if (tables.length === 0) return

  const cols = db.prepare("PRAGMA table_info(chat_sessions)").all() as { name: string }[]
  const legacyColumns = ["linked_execution_id", "linked_node_id", "interaction_mode", "interaction_status"]

  for (const column of legacyColumns) {
    if (cols.some(c => c.name === column)) {
      try {
        db.exec(`ALTER TABLE chat_sessions DROP COLUMN ${column}`)
      } catch (err) {
        // SQLite < 3.35.0 doesn't support DROP COLUMN — log and continue
        console.warn(`[schema] Failed to drop chat_sessions.${column}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

function ensureColumnsForExistingTables(db: Database.Database): void {
  // Tables that need 'org' column
  const tablesNeedingOrg = [
    'workspaces',
    'executions',
    'sessions',
    'clones',
    'evolution_log',
    'experiences',
    'safety_events',
    'reports',
    'scheduled_job_executions',
    'schedule_workspaces',
    'schedules'
  ]

  for (const table of tablesNeedingOrg) {
    ensureColumn(db, table, 'org', "TEXT NOT NULL DEFAULT 'default'")
  }

  // Archive status column for workspaces
  ensureColumn(db, 'workspaces', 'archive_status', "TEXT DEFAULT NULL")

  // Clone system columns for sessions
  ensureColumn(db, 'sessions', 'scope_id', "TEXT")
  ensureColumn(db, 'sessions', 'provider_session_id', "TEXT")

  // Clone system columns for messages
  ensureColumn(db, 'messages', 'type', "TEXT NOT NULL DEFAULT 'text'")
  ensureColumn(db, 'messages', 'metadata', "TEXT")

  // Source column for memory FTS (clone memory alignment — iteration #10)
  ensureColumn(db, 'messages', 'source', "TEXT NOT NULL DEFAULT 'main'")

  // Clone system columns for clones
  ensureColumn(db, 'clones', 'type', "TEXT NOT NULL DEFAULT 'user'")

  // Archive V2 columns for workspace_archive
  ensureColumn(db, 'workspace_archive', 'name', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'workspace_archive', 'description', "TEXT")
  ensureColumn(db, 'workspace_archive', 'source', "TEXT")
  ensureColumn(db, 'workspace_archive', 'execution_count', "INTEGER DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'total_cost', "REAL DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'total_duration_ms', "INTEGER DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'created_at', "TEXT")
  ensureColumn(db, 'workspace_archive', 'metadata', "TEXT")
  ensureColumn(db, 'workspace_archive', 'extracted_experiences', "INTEGER DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'extracted_skills', "INTEGER DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'extracted_workflows', "INTEGER DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'extracted_agents', "INTEGER DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'analysis_report', "TEXT")
  ensureColumn(db, 'workspace_archive', 'file_deleted', "INTEGER DEFAULT 0")

  // Interaction metadata for executions
  ensureColumn(db, 'executions', 'interaction_metadata', "TEXT")

  // Nested execution hierarchy (sub-workflow parent tracking + loop iteration tracking)
  ensureColumn(db, 'node_executions', 'parent_node_id', "TEXT")
  ensureColumn(db, 'node_executions', 'iteration_index', "INTEGER")

  // Agent version tracking (schema version 33)
  ensureColumn(db, 'clones', 'current_version_id', "TEXT")

  // Harness columns (schema version 34)
  ensureColumn(db, 'node_executions', 'harness_status', "TEXT")
  ensureColumn(db, 'node_executions', 'harness_interventions', "TEXT")
  ensureColumn(db, 'node_token_usages', 'source', "TEXT DEFAULT 'node'")

  // Execution-level harness status (schema version 35 — harness-semantic-v2)
  ensureColumn(db, 'executions', 'harness_status', "TEXT DEFAULT NULL")
  ensureColumn(db, 'executions', 'harness_summary', "TEXT DEFAULT NULL")

  // Budget snapshot (schema version 36 — workflow-observability)
  ensureColumn(db, 'executions', 'budget_snapshot', "TEXT DEFAULT NULL")

  // Experience v2 columns (schema version 35 — harness-learning-platform)
  ensureColumn(db, 'experiences', 'scope', "TEXT NOT NULL DEFAULT 'agent'")
  ensureColumn(db, 'experiences', 'scope_ref', "TEXT DEFAULT NULL")
  ensureColumn(db, 'experiences', 'pattern_tags', "TEXT DEFAULT '[]'")
  ensureColumn(db, 'experiences', 'outcome', "TEXT DEFAULT NULL")
  ensureColumn(db, 'experiences', 'source_type', "TEXT NOT NULL DEFAULT 'session'")
  ensureColumn(db, 'experiences', 'execution_id', "TEXT DEFAULT NULL")
  ensureColumn(db, 'experiences', 'node_id', "TEXT DEFAULT NULL")

  // Run-phase + polymorphic origin columns (schema v37 → v38, ADDITIVE then DROP).
  // v37: status/claimed_at for the task-pool run lifecycle (trigger_source /
  //      source_chat_session_id were also added in v37 as the task-pool hack).
  // v38: ADD origin_type/origin_id/origin_role/assoc_meta (S2 polymorphic origin, no
  //      FK — app-level cascade-reap + orphan reaper maintain integrity).
  // v38b (ticket 06 / SG1b): DROP trigger_source + source_chat_session_id — the
  //      承重 sites are migrated to origin_type. The cols are NO LONGER
  //      ensured (removed below) and the migrateSchedulesV38DropTriggerCols
  //      migration drops them from existing dev DBs. Fresh DBs created by
  //      schema.sql still have the cols (schema.sql is 02's, not touched here);
  //      the migration runs on every applySchema and drops them idempotently.
  ensureColumn(db, 'schedules', 'status', "TEXT NOT NULL DEFAULT 'queued'")
  ensureColumn(db, 'schedules', 'claimed_at', "TEXT")

  // schema v40 (task-phase-redesign K4): executions gains the round identity
  // (phase_index/round_index, NULL = v3/generic); tasks gains its bound workspace
  // (NULL = never triggered). Additive nullable cols — no rebuild.
  ensureColumn(db, 'executions', 'phase_index', "INTEGER DEFAULT NULL")
  ensureColumn(db, 'executions', 'round_index', "INTEGER DEFAULT NULL")
  ensureColumn(db, 'tasks', 'workspace_id', "TEXT DEFAULT NULL")

  // schema v45 (billing-core-1 ticket 01) 的双币种快照列 (cost_native/cost_currency/
  // price_status) 已在 v48 (billing NEW-r2) 整体移除 —— 钱不落账本，查询时算。
  // 这里不再 ensure 这些列（ensureColumn 反而会把弃列加回来）。

  // schema v46 (billing-coverage-2 票01, KD20): llm_calls 来源维度列。以可空添加而非
  // NOT NULL DEFAULT —— 否则历史行整片焊成默认值，回填 (KD21) 就分不出「可推断」与
  // 「推不出」。新行一律经共用落账 helper 带枚举值写入。
  ensureColumn(db, 'llm_calls', 'source_path', "TEXT")
}

/**
 * schema v42 (ADR-0021 票03) — `schedules` loses the five columns that existed only to
 * bind a job definition to a task, **and the rows that were bound that way**:
 *
 *   origin_type / origin_id / origin_role  the S2 polymorphic back-reference — a schedule
 *                                          row pointed AT a task, and every 「本任务的
 *                                          信封在哪」 query walked it
 *   assoc_meta                             set by exactly zero callers, ever
 *   scheduled_at                           the envelope's one-shot due time, superseded
 *                                          by tasks.next_fire_at in v41
 *
 * Deleting the `origin_type='task'` rows is part of this migration, not an extra: an
 * envelope without its columns is still a row in the jobs table, and on a real dev DB
 * every one of them was enabled (see the body). Dev-phase DBs are disposable, so the
 * rule is "no compat layer" — but a migration that leaves zombie rows behind is not
 * "no compat layer", it is a broken DB.
 *
 * `status` and `claimed_at` stay: they are the pump's own run-state for cron/agent jobs
 * (manual trigger, aborting a live fire, the stale sweep). Removing those means moving
 * that state onto `schedule_executions`, which is a separate change with its own risk
 * surface — and after this migration nothing task-shaped reads them.
 *
 * Order matters twice. The two indexes that reference these columns must go first (SQLite
 * refuses to drop an indexed column), and this runs after ensureColumnsV41 so an existing
 * dev DB converges without a wipe. SQLite < 3.35 has no DROP COLUMN: it logs and leaves
 * an unread column behind, which is harmless.
 */
export function migrateSchedulesV42DropOriginCols(db: Database.Database): void {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'",
  ).all()
  if (tables.length === 0) return // fresh DB: schema.sql creates it without the cols

  db.exec("DROP INDEX IF EXISTS idx_schedules_origin")
  db.exec("DROP INDEX IF EXISTS idx_schedules_due")

  const cols = db.prepare("PRAGMA table_info(schedules)").all() as { name: string }[]

  // The envelope ROWS go with the columns. This is not a compat layer — it is deleting
  // rows whose meaning no longer exists. Measured on a real developer DB (v40) that had
  // never seen 票03: 7 rows with origin_type='task', **all enabled=1**, three parked at
  // status='draft' — a value the narrowed ScheduleStatus no longer admits. Dropping the
  // columns alone leaves those seven as enabled phantom JOBS in 系统调度, which is precisely
  // the opposite of what 票05 promises the page to be ("只见作业").
  //
  // The one fact still worth keeping is which task a workspace belongs to. That used to be
  // source_schedule_id → origin_id; it moves into workspaces.task_id (added by v41, which
  // runs first) before the rows go, so the delete costs nothing the UI still reads.
  if (cols.some((c) => c.name === "origin_type")) {
    const envelopeIds = "SELECT id FROM schedules WHERE origin_type = 'task'"
    const wsHasTask = (db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[])
      .some((c) => c.name === "task_id")
    // origin_id is what names the task, but a DB can legitimately lack it: v42 drops
    // column-by-column and an old SQLite (<3.35) fails some and not others, so a later
    // boot sees a half-migrated table. The rebind is skipped when the source column is
    // missing — the purge below does not need it.
    const hasOriginId = cols.some((c) => c.name === "origin_id")
    if (wsHasTask && hasOriginId) {
      const bound = db.prepare(
        `UPDATE workspaces SET task_id =
           (SELECT s.origin_id FROM schedules s WHERE s.id = workspaces.source_schedule_id)
         WHERE task_id IS NULL AND source_schedule_id IN (${envelopeIds})`,
      ).run()
      if (bound.changes > 0) {
        console.log(`[schema] v42: rebound ${bound.changes} workspace(s) to their task via workspaces.task_id`)
      }
    }
    // schedule_executions has a plain FK to schedules (no cascade), so its rows must go
    // first or the DELETE throws; schedule_workspaces cascades but is spelled out anyway.
    db.exec(`DELETE FROM schedule_executions WHERE schedule_id IN (${envelopeIds})`)
    db.exec(`DELETE FROM schedule_workspaces WHERE schedule_id IN (${envelopeIds})`)
    const purged = db.prepare(`DELETE FROM schedules WHERE origin_type = 'task'`).run().changes
    if (purged > 0) {
      console.log(`[schema] v42: purged ${purged} task-envelope row(s) from schedules (ADR-0021 — the envelope is gone, its rows cannot stay as jobs)`)
    }
  }
  for (const col of ['origin_type', 'origin_id', 'origin_role', 'assoc_meta', 'scheduled_at']) {
    if (!cols.some((c) => c.name === col)) continue // already dropped, or never added
    try {
      db.exec(`ALTER TABLE schedules DROP COLUMN ${col}`)
      // eslint-disable-next-line no-console
      console.log(`[schema] Dropped schedules.${col} (v42 / ADR-0021 票03)`)
    } catch (err) {
      console.warn(
        `[schema] Failed to drop schedules.${col}: ${err instanceof Error ? err.message : String(err)} (non-fatal — no code reads it any more)`,
      )
    }
  }
}


/**
 * schema v41 (task-scheduler-decouple / ADR-0021) — additive columns only.
 *
 * MUST run AFTER migrateTasksStatusCheckV40: that migration rebuilds `tasks` from a
 * hard-coded column list, so anything ensured before it gets eaten by the swap (the
 * v40 re-entrancy test in acceptance-dao.test.ts is what pins this ordering).
 *
 *   tasks       WHEN the task wants to run is now the task's own data (before v41 the
 *               due time lived on a private parked `schedules` row — see ADR-0021).
 *   executions  states directly which task it serves; the board used to reach a
 *               task's executions only by joining through schedules.
 *   workspaces  direct task ownership (replaces the source_schedule_id→
 *               schedules.origin_id reverse lookup composite walked).
 *
 * The trigger_mode CHECK is fresh-DB only (a CHECK on an existing table would need a
 * rebuild, and dev DBs are disposable — spec §"无迁移"); code-level validation is the
 * authority. next_fire_at is what schema.sql's idx_tasks_due indexes, hence this must
 * run before the schema.sql exec — which applySchema does.
 */
function ensureColumnsV41(db: Database.Database): void {
  ensureColumn(db, 'tasks', 'trigger_mode', "TEXT NOT NULL DEFAULT 'manual'")
  ensureColumn(db, 'tasks', 'trigger_at', "TEXT DEFAULT NULL")
  ensureColumn(db, 'tasks', 'cron_expression', "TEXT DEFAULT NULL")
  ensureColumn(db, 'tasks', 'cron_timezone', "TEXT NOT NULL DEFAULT 'Asia/Shanghai'")
  ensureColumn(db, 'tasks', 'trigger_enabled', "INTEGER NOT NULL DEFAULT 1")
  ensureColumn(db, 'tasks', 'next_fire_at', "TEXT DEFAULT NULL")
  ensureColumn(db, 'tasks', 'last_fired_at', "TEXT DEFAULT NULL")
  ensureColumn(db, 'executions', 'task_id', "TEXT DEFAULT NULL")
  ensureColumn(db, 'workspaces', 'task_id', "TEXT DEFAULT NULL")
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  // Check if table exists
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(table)
  if (tables.length === 0) return // Table doesn't exist yet, will be created by schema.sql

  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

/**
 * Migrate session_memory_fts to include source column.
 * FTS5 virtual tables don't support ALTER TABLE, so we drop and recreate.
 * Schema.sql will recreate the table with the new schema (IF NOT EXISTS).
 */
function migrateFtsTableWithSource(db: Database.Database): void {
  try {
    // Check if the FTS table exists
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_memory_fts'").all()
    if (tables.length === 0) return // Will be created by schema.sql

    // Check if source column exists by trying to query it
    try {
      db.prepare("SELECT source FROM session_memory_fts LIMIT 1").get()
      return // Already has source column
    } catch {
      // Source column missing — drop table, schema.sql will recreate it
      db.exec("DROP TABLE IF EXISTS session_memory_fts")
      // eslint-disable-next-line no-console
      console.log("[schema] Dropped old session_memory_fts (missing source column), will recreate")
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[schema] FTS migration check failed:", err instanceof Error ? err.message : String(err))
  }
}

/**
 * Blue-green migration for experiences_fts → v2 content-sync mode.
 *
 * Strategy:
 *   1. Check if old (non-content-sync) FTS table exists
 *   2. If yes: create experiences_fts_v2, populate from experiences, swap names
 *   3. If no: schema.sql will create it fresh
 *
 * This prevents data loss that would occur with a simple DROP + CREATE.
 * After migration, schema.sql's CREATE VIRTUAL TABLE IF NOT EXISTS is a no-op
 * because the table already exists (renamed from v2).
 */
function migrateExperiencesFtsV2(db: Database.Database): void {
  try {
    // Check if the old FTS table exists
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='experiences_fts'"
    ).all()
    if (tables.length === 0) return // Will be created by schema.sql

    // Check if the FTS table already has the v2 columns (scope, scope_ref, pattern_tags)
    // FTS5 virtual tables show up in table_info, so we can check columns
    try {
      const cols = db.prepare("PRAGMA table_info(experiences_fts)").all() as { name: string }[]
      const hasScope = cols.some(c => c.name === "scope")
      if (hasScope) return // Already migrated to v2
    } catch {
      // table_info might fail on virtual tables in some SQLite versions — proceed with migration
    }

    // Check if experiences table has the new columns (they should, via ensureColumn above)
    const expCols = db.prepare("PRAGMA table_info(experiences)").all() as { name: string }[]
    const hasScopeCol = expCols.some(c => c.name === "scope")
    if (!hasScopeCol) {
      // experiences table doesn't have new columns yet — skip FTS migration,
      // the columns will be added by ensureColumn and FTS will be created fresh by schema.sql
      return
    }

    // Blue-green migration: create v2 → populate → swap
    // eslint-disable-next-line no-console
    console.log("[schema] Starting experiences_fts blue-green migration to v2...")

    db.exec("DROP TABLE IF EXISTS experiences_fts_v2")

    db.exec(`
      CREATE VIRTUAL TABLE experiences_fts_v2 USING fts5(
        skill_name, content, scope, scope_ref, pattern_tags
      )
    `)

    // Populate from experiences table (which now has the new columns via ensureColumn)
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM experiences").get() as { cnt: number }).cnt
    if (count > 0) {
      db.exec(`
        INSERT INTO experiences_fts_v2 (rowid, skill_name, content, scope, scope_ref, pattern_tags)
        SELECT id, skill_name, content, scope, scope_ref, pattern_tags FROM experiences
      `)
    }

    // Atomic swap
    db.exec("DROP TABLE IF EXISTS experiences_fts")
    db.exec("ALTER TABLE experiences_fts_v2 RENAME TO experiences_fts")

    // eslint-disable-next-line no-console
    console.log(`[schema] experiences_fts migrated to v2 (${count} rows populated)`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[schema] experiences_fts v2 migration failed:", err instanceof Error ? err.message : String(err))
    // Non-fatal — FTS will be recreated by schema.sql if needed
    try { db.exec("DROP TABLE IF EXISTS experiences_fts_v2") } catch { /* ignore */ }
  }
}

/**
 * schema v37: schedules — drop NOT NULL on cron_expression.
 *
 * SQLite cannot remove a NOT NULL constraint in place. The columns added in
 * ensureColumnsForExistingTables (status, trigger_source, source_chat_session_id,
 * claimed_at) are already present on existing DBs. The remaining task is making
 * cron_expression nullable: detect the old constraint and rename the table to
 * a backup, letting schema.sql recreate schedules fresh with the new shape.
 *
 * Existing rows are preserved in schedules_old_schema_backup_v37 for manual
 * inspection — matching the execution_archive migration pattern. New active
 * table starts empty. Acceptable for rapid-iteration dev DBs.
 */
function migrateSchedulesV37(db: Database.Database): void {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'"
  ).all()
  if (tables.length === 0) return // Will be created by schema.sql

  const cols = db.prepare("PRAGMA table_info(schedules)").all() as {
    name: string
    notnull: number
    type: string
  }[]

  const cronCol = cols.find(c => c.name === 'cron_expression')
  if (!cronCol || cronCol.notnull === 0) return // Already nullable

  const count = (db.prepare("SELECT COUNT(*) as cnt FROM schedules").get() as { cnt: number }).cnt
  db.exec("ALTER TABLE schedules RENAME TO schedules_old_schema_backup_v37")
  // eslint-disable-next-line no-console
  console.log(`[schema] Renamed old schedules (${count} rows) → schedules_old_schema_backup_v37; schema.sql will recreate with nullable cron_expression`)

  // ponytail: SQLite FK targets are name-bound — when schedules was renamed,
  // schedule_executions and schedule_workspaces FKs now point to the backup table,
  // not the new active schedules. Rename them too so schema.sql recreates with FK
  // on the new schedules table. Without this, every INSERT into schedule_executions
  // fails with "FOREIGN KEY constraint failed" because schedule_id exists in new
  // schedules but FK validates against the backup table. T-6 E2E caught this.
  for (const dep of ['schedule_executions', 'schedule_workspaces', 'schedule_audit_logs']) {
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).all(dep)
    if (exists.length > 0) {
      const depCount = (db.prepare(`SELECT COUNT(*) as cnt FROM ${dep}`).get() as { cnt: number }).cnt
      db.exec(`ALTER TABLE ${dep} RENAME TO ${dep}_old_schema_backup_v37`)
      // eslint-disable-next-line no-console
      console.log(`[schema] Renamed ${dep} (${depCount} rows) → ${dep}_old_schema_backup_v37; schema.sql will recreate with FK on new schedules`)
    }
  }
}

/**
 * schema v38b (ticket 06 / SG1b): DROP the task-pool hack cols `trigger_source`
 * and `source_chat_session_id` from `schedules`.
 *
 * These cols were added in v37 as the task-pool hack (storing task drafts inside
 * the cron scheduler). v2 (task-domain-redesign) replaces them with the
 * first-class `tasks` table + S2 polymorphic `origin_type`/`origin_id`/`origin_role`
 * cols (added additively in v38). The 3 承重 sites (scheduler-engine failed-
 * promotion gate + checkQueuedTasks filter + task-dispatch-service child creation)
 * are migrated to `origin_type` in the same ticket, so dropping the cols is safe.
 *
 * CONSTRAINT: schema.sql (02's file, off-limits to this ticket) defines
 * `idx_schedules_status ON schedules(status, trigger_source)` — an index that
 * REFERENCES trigger_source. SQLite cannot DROP a column that's part of an index
 * ("error in index ... after drop column"). So the migration must:
 *   1. DROP the index (so the column is no longer indexed)
 *   2. DROP the column
 *   3. RECREATE the index on just `status` (trigger_source is gone)
 * After step 3, schema.sql's `CREATE INDEX IF NOT EXISTS idx_schedules_status
 * ON schedules(status, trigger_source)` is a no-op (index already exists) and
 * does NOT validate column references — so it doesn't break on the missing col.
 *
 * Fresh DBs (1st applySchema): migration runs before schema.sql creates the
 * table → no-op. schema.sql then creates table + index WITH the cols. So the
 * cols exist after the 1st applySchema. On the 2nd+ applySchema (idempotent
 * test, dev DB restart), the migration drops them. Code never reads/writes them
 * regardless (ScheduleRow type has them removed; insertSchedule doesn't write
 * them), so the lingering cols on 1st-applySchema DBs are harmless.
 *
 * Wrapped in try-catch per col so a failure on one is non-fatal (the col stays,
 * code is type-clean + doesn't use it).
 */
function migrateSchedulesV38DropTriggerCols(db: Database.Database): void {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'"
  ).all()
  if (tables.length === 0) return // Will be created by schema.sql (with the cols; next run drops them)

  // The index referencing trigger_source must be dropped first (SQLite can't
  // drop a column that's part of an index). Recreate it on just `status` after.
  const hasStatusIdx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_schedules_status'",
  ).get() as { name: string } | undefined

  for (const col of ['trigger_source', 'source_chat_session_id']) {
    const cols = db.prepare("PRAGMA table_info(schedules)").all() as { name: string }[]
    if (!cols.some((c) => c.name === col)) continue // already dropped
    try {
      // Drop the status index before dropping trigger_source (it references it).
      // For source_chat_session_id the index isn't affected, but dropping it once
      // for the first col is enough; the recreate below re-adds it on `status`.
      if (col === 'trigger_source' && hasStatusIdx) {
        db.exec("DROP INDEX IF EXISTS idx_schedules_status")
      }
      db.exec(`ALTER TABLE schedules DROP COLUMN ${col}`)
      // eslint-disable-next-line no-console
      console.log(`[schema] Dropped schedules.${col} (v38b / ticket 06 SG1b — migrated to origin_type)`)
    } catch (err) {
      // SQLite < 3.35.0 doesn't support DROP COLUMN, or other failure — log + continue.
      // The col stays but code no longer reads/writes it (type-clean); the orphan
      // col is harmless on legacy DBs.
      console.warn(
        `[schema] Failed to drop schedules.${col}: ${err instanceof Error ? err.message : String(err)} (non-fatal — col is no longer used)`,
      )
    }
  }

  // Recreate the status index on just `status` (trigger_source is gone). Use
  // IF NOT EXISTS so this is idempotent + so schema.sql's later
  // `CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status, trigger_source)`
  // is a no-op (the index already exists → no column-reference validation).
  if (hasStatusIdx) {
    try {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status) WHERE deleted_at IS NULL",
      )
    } catch (err) {
      console.warn(
        `[schema] Failed to recreate idx_schedules_status: ${err instanceof Error ? err.message : String(err)} (non-fatal)`,
      )
    }
  }
}

/**
 * schema v40 (task-phase-redesign K3): tasks.status CHECK gains 'awaiting_review'
 * + 'archiving' (the v4 gate states). SQLite cannot alter a CHECK in place, so
 * existing DBs need a rebuild: create the new-shape table, copy rows, swap names.
 *
 * Data-preserving by design — unlike the v37 rename-to-backup (dev-only empty
 * recreate), `tasks` holds real user kanban data; dropping it silently would be
 * destructive. The copy uses the explicit column list (v40 shape); every existing
 * dev DB has at least the v38 set + workspace_id (added by
 * ensureColumnsForExistingTables immediately before this migration runs).
 *
 * Safety notes:
 *   - No table has `FOREIGN KEY … REFERENCES tasks` (verified via grep) — the
 *     DROP+RENAME can't strand child FKs (the v37 pitfall). The new table's own
 *     FK (source_chat_session_id→sessions) is created by DDL text regardless.
 *   - foreign_keys is toggled OFF around the swap so orphaned
 *     source_chat_session_id rows (sessions deleted without cascade) can't abort
 *     the copy; it is restored in `finally`.
 *   - Old idx_tasks_* indexes are dropped with the old table; schema.sql's
 *     CREATE INDEX IF NOT EXISTS (which runs after handleSchemaMigrations)
 *     recreates them on the rebuilt table.
 *
 * Re-entrancy: detection is a DDL-text check (`awaiting_review` present →
 * already migrated), so 2nd+ applySchema runs no-op. Fresh DBs skip entirely
 * (table doesn't exist yet; schema.sql creates it with the v40 CHECK).
 */
function migrateTasksStatusCheckV40(db: Database.Database): void {
  const tbl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'",
  ).get() as { sql: string } | undefined
  if (!tbl) return // Will be created by schema.sql with the v40 CHECK
  if (tbl.sql.includes("awaiting_review")) return // Already migrated

  const count = (db.prepare("SELECT COUNT(*) as cnt FROM tasks").get() as { cnt: number }).cnt
  // Keep this DDL in sync with the tasks CREATE TABLE in schema.sql (v40 shape).
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE tasks_v40_rebuild (
        id TEXT PRIMARY KEY,
        org TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','running','awaiting_review','archiving','done','failed','aborted')),
        source_chat_session_id TEXT,
        task_spec TEXT NOT NULL DEFAULT '{}',
        authoring_resources TEXT NOT NULL DEFAULT '[]',
        resources TEXT NOT NULL DEFAULT '[]',
        skills TEXT NOT NULL DEFAULT '[]',
        project_ids TEXT NOT NULL DEFAULT '[]',
        workflow_ref TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        workspace_id TEXT DEFAULT NULL,
        FOREIGN KEY (source_chat_session_id) REFERENCES sessions(id)
      )
    `)
    const cols = [
      "id", "org", "name", "status", "source_chat_session_id", "task_spec",
      "authoring_resources", "resources", "skills", "project_ids",
      "workflow_ref", "version", "deleted_at", "created_at", "updated_at",
      "completed_at", "workspace_id",
    ]
    db.exec(`
      INSERT INTO tasks_v40_rebuild (${cols.join(", ")})
      SELECT ${cols.join(", ")} FROM tasks
    `)
    db.exec("DROP TABLE tasks")
    db.exec("ALTER TABLE tasks_v40_rebuild RENAME TO tasks")
  })

  const fkWasOn = db.pragma("foreign_keys", { simple: true }) as number
  db.pragma("foreign_keys = OFF")
  try {
    rebuild()
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON")
  }
  // eslint-disable-next-line no-console
  console.log(`[schema] Rebuilt tasks with v40 status CHECK (awaiting_review/archiving added, failed kept for v3; ${count} rows preserved)`)
}
