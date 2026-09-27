/**
 * P1-B1 数据搬迁器（scripts/pg-migrate/migrate-data.mjs）全链路测试。
 *
 * 用最小合成 SQLite 库（含交付票点名的全部坑位：ISO-Z 串 / 无标记 UTC 串 / epoch-ms
 * 整数 / 非法 JSON 混存 jsonb 列 / 带原 id 的 IDENTITY / FK 孤儿级联）对着 harness
 * 随机测试库跑：灌 → 对账 → 重灌幂等。
 *
 * 无 OCTOPUS_PG_TEST_URL 即 skip（与 db/pg/__tests__ 同纪律）；只碰随机测试库，
 * 绝不触碰 octopus 真库。CLI 以子进程真实调起（测的是交付物本体，不是内部函数复刻）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error better-sqlite3 无类型声明（基线债）—— 此处抑制以免给 tsc ratchet 添新行
import Database from 'better-sqlite3'
import { pgTestEnabled, createTestDatabase, type PgTestDatabase } from '../db/pg/__tests__/harness'

if (!pgTestEnabled) {
  // eslint-disable-next-line no-console
  console.warn('[pg-migrate-test] OCTOPUS_PG_TEST_URL not set — migration e2e tests are SKIPPED. See packages/server/src/db/pg/README.md')
}
const describePg = pgTestEnabled ? describe : describe.skip

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const CLI = path.join(REPO, 'scripts', 'pg-migrate', 'migrate-data.mjs')

interface CliResult { code: number; out: string; err: string }
function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d: Buffer) => { out += d.toString() })
    p.stderr.on('data', (d: Buffer) => { err += d.toString() })
    p.on('error', reject)
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }))
  })
}

// ── 合成 SQLite 库：只建被测表；NOT NULL 无默认列必须全给（migrator 读 PG 元数据为准）──
function buildFixture(dir: string): string {
  const file = path.join(dir, 'fixture.sqlite')
  const db = new Database(file)
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, org TEXT NOT NULL, path TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE executions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_ref TEXT NOT NULL,
      workflow_name TEXT NOT NULL, org TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      input_values TEXT, rollback_on_error INTEGER DEFAULT 0, duration INTEGER, started_at TEXT);
    CREATE TABLE node_executions (
      id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, node_id TEXT NOT NULL, node_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending', outputs TEXT, started_at TEXT, duration INTEGER);
    CREATE TABLE agent_events (
      node_execution_id TEXT NOT NULL, event_order INTEGER NOT NULL, turn_index INTEGER NOT NULL,
      event_type TEXT NOT NULL, timestamp INTEGER NOT NULL, content TEXT, tool_result TEXT,
      PRIMARY KEY (node_execution_id, event_order));
    CREATE TABLE orgs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE llm_calls (
      id TEXT PRIMARY KEY, node_execution_id TEXT, turn_index INTEGER NOT NULL, call_index INTEGER NOT NULL,
      timestamp INTEGER NOT NULL, duration_ms INTEGER NOT NULL, model TEXT);
  `)
  const W = 'INSERT INTO workspaces VALUES (?,?,?,?,?,?)'
  db.prepare(W).run('wsA', 'A', 'xzf', '/ws/a', '2026-09-27T10:00:00.000Z', '2026-09-27T10:00:00.000Z') // ISO-Z
  db.prepare(W).run('wsB', 'B', 'xzf', '/ws/b', '2026-09-27 10:00:00', '2026-09-27 10:00:00')           // datetime('now') 无标记
  const E = 'INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, org, created_at, updated_at, input_values, rollback_on_error, duration, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  // e1 全干净：jsonb 合法 + 布尔 1 + epoch 时长 + 无标记 started_at
  db.prepare(E).run('e1', 'wsA', 'wf/x', 'X', 'xzf', '2026-09-26T00:00:01.000Z', '2026-09-26T00:00:01.000Z',
    '{"k":"v"}', 1, 12345, '2026-09-26 23:59:59')
  // e2 非法 JSON → json-col-unparseable（其子行级联成孤儿）
  db.prepare(E).run('e2', 'wsB', 'wf/y', 'Y', 'xzf', '2026-09-26T00:00:02.000Z', '2026-09-26T00:00:02.000Z',
    'not-json{', 0, 1, null)
  // e3 孤儿：引用不存在的 workspace
  db.prepare(E).run('e3', 'ghost-ws', 'wf/z', 'Z', 'xzf', '2026-09-26T00:00:03.000Z', '2026-09-26T00:00:03.000Z',
    null, 0, 2, null)
  // e4 布尔域外
  db.prepare(E).run('e4', 'wsA', 'wf/w', 'W', 'xzf', '2026-09-26T00:00:04.000Z', '2026-09-26T00:00:04.000Z',
    null, 5, 3, null)
  const N = 'INSERT INTO node_executions (id, execution_id, node_id, node_type, status, outputs, started_at, duration) VALUES (?,?,?,?,?,?,?,?)'
  db.prepare(N).run('n1', 'e1', 'step-1', 'agent', 'done', '{"deep":{"a":[1,2]}}', '2026-09-26T00:00:00.000Z', 9)
  db.prepare(N).run('n2', 'e2', 'step-2', 'bash', 'done', '{}', null, 0) // 级联孤儿（父 e2 被隔离）
  db.prepare(N).run('n3', 'ghost-exec', 'step-3', 'bash', 'done', '{}', null, 0) // 直接孤儿
  const A = 'INSERT INTO agent_events (node_execution_id, event_order, turn_index, event_type, timestamp, content, tool_result) VALUES (?,?,?,?,?,?,?)'
  db.prepare(A).run('n1', 0, 0, 'text', 1759000000123, 'line1\nline2\ttabbed back\\slash 🎯', null)
  db.prepare(A).run('n1', 1, 0, 'tool_result', 1759000000124, null, 'plain text not json') // text 列混存合法
  db.prepare(A).run('n2', 0, 0, 'text', 1759000000125, 'cascade-me', null) // 级联孤儿
  const O = 'INSERT INTO orgs (id, name, path, created_at) VALUES (?,?,?,?)'
  db.prepare(O).run(3, 'alpha', '/o/3', '2026-09-01 08:00:00')
  db.prepare(O).run(7, 'beta', '/o/7', '2026-09-02T08:00:00.000Z')
  db.prepare(O).run(42, 'gamma', '/o/42', '2026-09-03 08:00:00')
  const L = 'INSERT INTO llm_calls (id, node_execution_id, turn_index, call_index, timestamp, duration_ms, model) VALUES (?,?,?,?,?,?,?)'
  db.prepare(L).run('l1', 'n1', 0, 0, 1759000000999, 4200, 'claude')
  db.prepare(L).run('l2', 'n2', 0, 0, 1759000000998, 100, 'claude') // 级联孤儿
  db.prepare(L).run('l3', 'ghost-node', 0, 0, 1759000000997, 100, 'claude') // 直接孤儿
  db.prepare(L).run('l4', 'n1', 3000000000, 0, 1759000000996, 100, 'claude') // turn_index 超 int4（真库 agent_events.event_order 同款事故）
  db.close()
  return file
}

const cliBase = (sqlite: string, pgUrl: string) => ['--db', sqlite, '--pg', pgUrl]

describePg('P1-B1 migrate-data.mjs — 全链路：灌 → 对账 → 重灌幂等', () => {
  let tmpDir: string
  let sqliteFile: string
  let pgdb: PgTestDatabase
  let reportDir: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1mig-test-'))
    sqliteFile = buildFixture(tmpDir)
    reportDir = path.join(tmpDir, 'reports')
    fs.mkdirSync(reportDir)
    pgdb = await createTestDatabase()
  }, 180_000)

  afterAll(async () => {
    await pgdb?.close()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const counts = async (table: string): Promise<number> => {
    const rows = await pgdb.sql.unsafe(`SELECT count(*)::bigint AS c FROM "${table}"`)
    return Number(rows[0].c)
  }

  it('dry-run 零写入，报告含预演清单', async () => {
    const r = await runCli([...cliBase(sqliteFile, pgdb.config.url), '--dry-run',
      '--report', path.join(reportDir, 'dry.md')])
    expect(r.code, `dry-run 应 exit 2（有脏数据预演）:\n${r.out}\n${r.err}`).toBe(2)
    const md = fs.readFileSync(path.join(reportDir, 'dry.md'), 'utf8')
    expect(md).toContain('dry-run（零写入预演）')
    expect(md).toContain('json-col-unparseable')     // e2
    expect(md).toContain('fk-orphan')                 // e3/n3/l3 及级联 n2/(n2,0)/l2
    expect(md).toContain('bool-col-not-01')           // e4
    expect(md).toContain('int-col-out-of-range')      // ← 真库同款坑的合成复刻？见下一条
    await expect(counts('executions')).resolves.toBe(0)
    await expect(counts('orgs')).resolves.toBe(1) // 未写入证明：只剩 applyPgSchema 的 xzf 种子行
  })

  it('严格模式遇脏即中止（exit 1，零写入）', async () => {
    const r = await runCli(cliBase(sqliteFile, pgdb.config.url))
    expect(r.code).toBe(1)
    expect(r.out + r.err).toContain('中止')
    await expect(counts('executions')).resolves.toBe(0)
  })

  it('--quarantine 实灌：对账全等 + 原 id + setval + 时区/JSON/转义往返', async () => {
    const r = await runCli([...cliBase(sqliteFile, pgdb.config.url), '--quarantine',
      '--report', path.join(reportDir, 'run1.md')])
    const both = r.out + r.err
    expect(r.code, `期望 exit 2（带隔离完成）:\n${both}`).toBe(2)
    expect(both).toContain('mismatches=0')

    // 逐表行数：隔离位精确命中（级联孤儿：n2/(n2,0)/l2 引用被隔离的 e2/n2）
    await expect(counts('workspaces')).resolves.toBe(2)
    await expect(counts('executions')).resolves.toBe(1)
    await expect(counts('node_executions')).resolves.toBe(1)
    // agent_events 在 PG schema 无 FK→node_executions（B0 原样）→ 级联不覆盖：3 行全进（含 (n2,0)）
    await expect(counts('agent_events')).resolves.toBe(3)
    await expect(counts('llm_calls')).resolves.toBe(1)
    await expect(counts('orgs')).resolves.toBe(3)

    // 带原 id + setval：max(id)=42 → 下一条自动生成 43
    const org = await pgdb.sql`SELECT id FROM orgs WHERE name='alpha'`
    expect(Number(org[0].id)).toBe(3)
    await pgdb.sql`INSERT INTO orgs (name, path, created_at) VALUES ('auto', '/o/auto', now())`
    const auto = await pgdb.sql`SELECT id FROM orgs WHERE name='auto'`
    expect(Number(auto[0].id)).toBe(43)

    // 时区坑：无标记串按 UTC 解读（datetime('now') 纪律）；带 Z 串往返相等
    const t = await pgdb.sql`SELECT started_at, created_at FROM executions WHERE id='e1'`
    expect((t[0].started_at as Date).getTime()).toBe(Date.UTC(2026, 8, 26, 23, 59, 59))
    expect((t[0].created_at as Date).getTime()).toBe(Date.parse('2026-09-26T00:00:01.000Z'))
    const wsb = await pgdb.sql`SELECT created_at FROM workspaces WHERE id='wsB'`
    expect((wsb[0].created_at as Date).getTime()).toBe(Date.UTC(2026, 8, 27, 10, 0, 0))

    // jsonb 往返 + epoch-ms 直传 + 布尔 0/1→bool + 文本转义往返
    const ex = await pgdb.sql`SELECT input_values, rollback_on_error, duration FROM executions WHERE id='e1'`
    expect(ex[0].input_values).toEqual({ k: 'v' })
    expect(ex[0].rollback_on_error).toBe(true)
    expect(Number(ex[0].duration)).toBe(12345)
    const ne = await pgdb.sql`SELECT outputs FROM node_executions WHERE id='n1'`
    expect(ne[0].outputs).toEqual({ deep: { a: [1, 2] } })
    const ev = await pgdb.sql`SELECT timestamp, content FROM agent_events WHERE node_execution_id='n1' AND event_order=0`
    expect(Number(ev[0].timestamp)).toBe(1759000000123)
    expect(String(ev[0].content)).toBe('line1\nline2\ttabbed back\\slash 🎯')

    // 隔离清单 JSON：8 行脏（e2 json / e3,e4,n2,n3,l2,l3 各一 / l4 int 越界）
    const jq = JSON.parse(fs.readFileSync(path.join(reportDir, 'run1.quarantine.json'), 'utf8'))
    expect(jq.problems.length).toBe(8)
    expect(jq.problems.some((p: { kind: string }) => p.kind === 'json-col-unparseable')).toBe(true)
    expect(jq.problems.some((p: { kind: string; table: string; pk: string }) =>
      p.kind === 'fk-orphan' && p.table === 'node_executions' && p.pk === 'n2')).toBe(true) // 级联孤儿
    expect(jq.problems.some((p: { kind: string }) => p.kind === 'int-col-out-of-range')).toBe(true)
  }, 120_000)

  it('幂等重跑：再 --quarantine 一次，结果与首轮逐表一致', async () => {
    const r = await runCli([...cliBase(sqliteFile, pgdb.config.url), '--quarantine',
      '--report', path.join(reportDir, 'run2.md')])
    expect(r.code).toBe(2)
    await expect(counts('workspaces')).resolves.toBe(2)
    await expect(counts('executions')).resolves.toBe(1)
    await expect(counts('node_executions')).resolves.toBe(1)
    // agent_events 在 PG schema 无 FK→node_executions（B0 原样）→ 级联不覆盖：3 行全进（含 (n2,0)）
    await expect(counts('agent_events')).resolves.toBe(3)
    await expect(counts('llm_calls')).resolves.toBe(1)
    await expect(counts('orgs')).resolves.toBe(3) // 上一用例插入的 auto 行被 TRUNCATE 清掉 → 回到 3
  }, 120_000)

  it('对账器独立可用：--verify-only 现状核验通过', async () => {
    const r = await runCli([...cliBase(sqliteFile, pgdb.config.url), '--verify-only'])
    expect(r.code, r.out + r.err).toBe(2) // 仍有隔离（脏数据仍在源里）→ 2；mismatches 必须 0
    expect(r.out).toContain('mismatches=0')
  }, 120_000)
})
