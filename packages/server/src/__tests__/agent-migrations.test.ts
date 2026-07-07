import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'

describe('Unified Schema (applySchema)', () => {
  let db: Database.Database

  afterEach(() => {
    db?.close()
  })

  function createFreshDb(): Database.Database {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    return db
  }

  it('creates all main DB tables', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const tableNames = tables.map(t => t.name)

    // Core tables
    expect(tableNames).toContain('workspaces')
    expect(tableNames).toContain('executions')
    expect(tableNames).toContain('node_executions')
    expect(tableNames).toContain('node_edges')
    expect(tableNames).toContain('branch_executions')
    expect(tableNames).toContain('chat_sessions')
    expect(tableNames).toContain('chat_messages')
    expect(tableNames).toContain('orgs')
    expect(tableNames).toContain('node_token_usages')
    expect(tableNames).toContain('agent_events')
    expect(tableNames).toContain('llm_calls')
    expect(tableNames).toContain('optimization_suggestions')
    expect(tableNames).toContain('execution_summaries')
    expect(tableNames).toContain('pipeline_state')
    expect(tableNames).toContain('schedules')
    expect(tableNames).toContain('schedule_executions')
    expect(tableNames).toContain('schedule_audit_logs')
    expect(tableNames).toContain('scheduler_state')
    expect(tableNames).toContain('scheduler_audit_logs')
    expect(tableNames).toContain('schedule_workspaces')
  })

  it('creates all agent tables', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const tableNames = tables.map(t => t.name)

    expect(tableNames).toContain('sessions')
    expect(tableNames).toContain('messages')
    expect(tableNames).toContain('clones')
    expect(tableNames).toContain('evolution_log')
    expect(tableNames).toContain('experiences')
    expect(tableNames).toContain('safety_events')
    expect(tableNames).toContain('reports')
    expect(tableNames).toContain('scheduled_job_executions')
  })

  it('creates FTS5 virtual tables', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'")
      .all() as { name: string }[]
    const ftsNames = tables.map(t => t.name)

    expect(ftsNames).toContain('session_memory_fts')
    expect(ftsNames).toContain('experiences_fts')
    expect(ftsNames).toContain('reports_fts')
  })

  it('creates expected indexes', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    const indexes = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as { name: string }[]
    const indexNames = indexes.map(i => i.name)

    // Core indexes
    expect(indexNames).toContain('idx_executions_workspace')
    expect(indexNames).toContain('idx_executions_parent')
    expect(indexNames).toContain('idx_node_execs_execution')

    // Agent indexes
    expect(indexNames).toContain('idx_sessions_org')
    expect(indexNames).toContain('idx_messages_session')
    expect(indexNames).toContain('idx_clones_org')
    expect(indexNames).toContain('idx_evolution_skill')
    expect(indexNames).toContain('idx_experiences_skill')
    expect(indexNames).toContain('idx_safety_events_org')
    expect(indexNames).toContain('idx_reports_org')
    expect(indexNames).toContain('idx_sje_org')

    // Schedule indexes
    expect(indexNames).toContain('idx_schedules_org_name')
    expect(indexNames).toContain('idx_sched_execs_schedule')
  })

  it('creates triggers', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    const triggers = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as { name: string }[]
    const triggerNames = triggers.map(t => t.name)

    expect(triggerNames).toContain('prevent_audit_update')
    expect(triggerNames).toContain('prevent_audit_delete')
    expect(triggerNames).toContain('prevent_scheduler_audit_update')
    expect(triggerNames).toContain('prevent_scheduler_audit_delete')
    expect(triggerNames).toContain('messages_after_insert')
    expect(triggerNames).toContain('messages_after_delete')
  })

  it('sets user_version via PRAGMA', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    const rows = testDb.pragma('user_version') as Array<{ user_version: number }>
    expect(rows[0].user_version).toBe(26)
  })

  it('is idempotent — running twice does not error', () => {
    const testDb = createFreshDb()
    applySchema(testDb)
    expect(() => applySchema(testDb)).not.toThrow()

    const rows = testDb.pragma('user_version') as Array<{ user_version: number }>
    expect(rows[0].user_version).toBe(26)
  })

  it('seeds default org', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    const org = testDb
      .prepare("SELECT name, path FROM orgs WHERE name = 'xzf'")
      .get() as { name: string; path: string }
    expect(org).toBeDefined()
    expect(org.name).toBe('xzf')
  })

  it('seeds scheduler_state', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    const state = testDb
      .prepare("SELECT id, schema_version FROM scheduler_state WHERE id = 1")
      .get() as { id: number; schema_version: number }
    expect(state).toBeDefined()
    expect(state.schema_version).toBe(21)
  })

  it('creates sessions with correct columns', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    const columns = testDb.pragma('table_info(sessions)') as { name: string; type: string }[]
    const colNames = columns.map(c => c.name)

    expect(colNames).toContain('id')
    expect(colNames).toContain('org')
    expect(colNames).toContain('title')
    expect(colNames).toContain('clone_name')
    expect(colNames).toContain('perspective_clone_name')
    expect(colNames).toContain('session_type')
    expect(colNames).toContain('is_active')
    expect(colNames).toContain('is_deleted')
    expect(colNames).toContain('last_message_at')
    expect(colNames).toContain('created_at')
    expect(colNames).toContain('updated_at')
  })

  it('creates messages with correct columns and FK', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    const columns = testDb.pragma('table_info(messages)') as { name: string; type: string }[]
    const colNames = columns.map(c => c.name)

    expect(colNames).toContain('id')
    expect(colNames).toContain('session_id')
    expect(colNames).toContain('role')
    expect(colNames).toContain('content')
    expect(colNames).toContain('tool_calls')
    expect(colNames).toContain('is_summary')
    expect(colNames).toContain('is_compressed')
    expect(colNames).toContain('is_edited')
    expect(colNames).toContain('created_at')

    // Verify FK constraint
    const fkList = testDb.pragma('foreign_key_list(messages)') as { table: string; from: string; to: string }[]
    expect(fkList.length).toBeGreaterThan(0)
    expect(fkList[0].table).toBe('sessions')
  })

  it('FTS trigger syncs summary messages to session_memory_fts', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    // Insert a session first
    testDb.prepare(
      "INSERT INTO sessions (id, org, title, created_at, updated_at) VALUES ('s1', 'test', 'Test Session', '2024-01-01', '2024-01-01')"
    ).run()

    // Insert a summary message — should trigger FTS sync
    testDb.prepare(
      "INSERT INTO messages (id, session_id, role, content, is_summary, created_at) VALUES ('m1', 's1', 'assistant', 'Summary content here', 1, '2024-01-01')"
    ).run()

    // Query FTS table
    const ftsResults = testDb
      .prepare("SELECT session_id, summary FROM session_memory_fts WHERE session_memory_fts MATCH 'Summary'")
      .all() as { session_id: string; summary: string }[]

    expect(ftsResults.length).toBe(1)
    expect(ftsResults[0].session_id).toBe('s1')
    expect(ftsResults[0].summary).toBe('Summary content here')
  })

  it('non-summary messages do NOT trigger FTS sync', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    testDb.prepare(
      "INSERT INTO sessions (id, org, title, created_at, updated_at) VALUES ('s1', 'test', 'Test', '2024-01-01', '2024-01-01')"
    ).run()

    // Insert a regular (non-summary) message
    testDb.prepare(
      "INSERT INTO messages (id, session_id, role, content, is_summary, created_at) VALUES ('m1', 's1', 'user', 'Hello world', 0, '2024-01-01')"
    ).run()

    // FTS should be empty
    const ftsResults = testDb
      .prepare("SELECT * FROM session_memory_fts")
      .all()
    expect(ftsResults.length).toBe(0)
  })

  it('enforces foreign key constraint on messages', () => {
    const testDb = createFreshDb()
    applySchema(testDb)

    // Trying to insert a message with a non-existent session_id should fail
    expect(() => {
      testDb.prepare(
        "INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('m1', 'nonexistent', 'user', 'test', '2024-01-01')"
      ).run()
    }).toThrow()
  })
})
