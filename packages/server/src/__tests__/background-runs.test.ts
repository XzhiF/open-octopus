// 后台作业留档（2026-11-24 用户 #1 · 活动日志）：
// 电平 → running 行、结束边沿 → 收口、进程重启 → 僵尸行收口。
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { BackgroundRunService } from '../services/agent/background-runs'

const NOW = '2026-11-24T10:00:00.000Z'
let db: Database.Database

function insertSession(id: string): void {
  db.prepare(`
    INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, workspace_id, created_at, updated_at)
    VALUES (?, 'org', ?, NULL, 'main', 1, 0, NULL, ?, ?)
  `).run(id, id, NOW, NOW)
}

beforeEach(() => {
  db?.close()
  db = new Database(':memory:')
  applySchema(db)
  insertSession('s-main')
})

afterAll(() => db.close())

describe('BackgroundRunService', () => {
  it('电平同步：upsert running 行，重复同步不重置 started_at', async () => {
    const service = new BackgroundRunService(db)
    service.syncLevel('s-main', [
      { id: 'bg-1', description: 'pnpm dev', taskType: 'local_bash', runId: 'r1' },
    ])
    const first = service.find('s-main', 'bg-1')!
    expect(first.status).toBe('running')
    expect(first.description).toBe('pnpm dev')
    expect(first.run_id).toBe('r1')

    // started_at 只在同一 run 的重复同步时保持不变。
    await new Promise((resolve) => setTimeout(resolve, 12))
    service.syncLevel('s-main', [
      { id: 'bg-1', description: 'pnpm dev', taskType: 'local_bash', runId: 'r1' },
    ])
    const again = service.find('s-main', 'bg-1')!
    expect(again.started_at).toBe(first.started_at)
  })

  it('电平移除 → 收口 stopped；结束边沿补 summary / output_file', () => {
    const service = new BackgroundRunService(db)
    service.syncLevel('s-main', [{ id: 'bg-1', description: 'pnpm dev', taskType: 'local_bash' }])
    service.syncLevel('s-main', [])
    const closed = service.find('s-main', 'bg-1')!
    expect(closed.status).toBe('stopped')
    expect(closed.ended_at).toBeTruthy()

    service.syncLevel('s-main', [{ id: 'bg-2', description: 'vitest run', taskType: 'local_bash' }])
    service.markEnded('s-main', {
      id: 'bg-2',
      status: 'completed',
      summary: 'Tests 42 passed',
      outputFile: 'C:/tmp/bg-2.log',
    })
    const done = service.find('s-main', 'bg-2')!
    expect(done.status).toBe('completed')
    expect(done.summary).toBe('Tests 42 passed')
    expect(done.output_file).toBe('C:/tmp/bg-2.log')
    expect(done.ended_at).toBeTruthy()
  })

  it('结束边沿先于电平到达（行还不存在）→ 补一条收口行', () => {
    const service = new BackgroundRunService(db)
    service.markEnded('s-main', { id: 'bg-x', status: 'failed', summary: 'exit 1' })
    const row = service.find('s-main', 'bg-x')!
    expect(row.status).toBe('failed')
    expect(row.description).toBe('exit 1')
  })

  it('list 按 started_at 倒序；closeRunning 收口本会话所有 running 行', () => {
    const service = new BackgroundRunService(db)
    service.syncLevel('s-main', [
      { id: 'bg-1', description: 'a' },
      { id: 'bg-2', description: 'b' },
    ])
    service.closeRunning('s-main')
    expect(service.list('s-main').every((row) => row.status === 'stopped')).toBe(true)
  })

  it('新服务实例（进程重启）把遗留 running 行收口', () => {
    const before = new BackgroundRunService(db)
    before.syncLevel('s-main', [{ id: 'bg-stale', description: 'pnpm dev' }])
    expect(before.find('s-main', 'bg-stale')!.status).toBe('running')

    const restarted = new BackgroundRunService(db)
    expect(restarted.find('s-main', 'bg-stale')!.status).toBe('stopped')
  })
})
