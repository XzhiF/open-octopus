import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ArchiveScheduler } from '../archive-scheduler'
import Database from 'better-sqlite3'
import { applySchema } from '../../../db/schema'
import { ArchiveDAO } from '../../../db/dao/archive-dao'
import { ExecutionDAO } from '../../../db/dao/execution-dao'
import { ArchiveService } from '../archive-service'

// Mock getArchiveService
vi.mock('../archive-service', async () => {
  const actual = await vi.importActual<typeof import('../archive-service')>('../archive-service')
  return {
    ...actual,
    getArchiveService: vi.fn(() => null),
  }
})

// Mock config-manager
vi.mock('../../agent/config-manager', () => ({
  getConfigManager: vi.fn(() => ({
    getConfig: vi.fn(() => ({
      memory: {
        session_retention_days: 90,
        archive_cron_hour: 3,
        long_term_refine_trigger_days: 7,
        session_compress_threshold_messages: 50,
      },
    })),
  })),
}))

// Mock agent-service
vi.mock('../../agent/agent-service', () => ({
  getAgentService: vi.fn(() => ({
    archiveMemory: vi.fn().mockResolvedValue({ archived_date: '2024-01-01', essence_summary: '' }),
  })),
}))

// Mock memory-service
vi.mock('../../agent/memory-service', () => ({
  getMemoryService: vi.fn(() => ({
    refineLongTerm: vi.fn().mockReturnValue({ refined: false, before_tokens: 0, after_tokens: 0, backup_path: '' }),
  })),
}))

import { getArchiveService } from '../archive-service'

describe('ArchiveScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips when already running (isRunning flag)', async () => {
    const orgLister = vi.fn(() => ['org-a'])
    const scheduler = new ArchiveScheduler(orgLister, 2)

    // Start first run — make archiveMemoryBatch slow
    const mockBatch = vi.fn().mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ archived_count: 1 }), 1000)),
    )
    vi.mocked(getArchiveService).mockReturnValue({ archiveMemoryBatch: mockBatch } as any)

    const run1 = scheduler.run()
    // Second run should be skipped
    await scheduler.run()

    // Only one call to orgLister (second run was skipped)
    expect(orgLister).toHaveBeenCalledTimes(1)

    // Let first run finish
    vi.advanceTimersByTime(2000)
    await run1
  })

  it('calls archiveMemoryBatch for each org', async () => {
    const orgLister = vi.fn(() => ['org-a', 'org-b', 'org-c'])
    const scheduler = new ArchiveScheduler(orgLister, 2)

    const mockBatch = vi.fn().mockResolvedValue({ archived_count: 2 })
    vi.mocked(getArchiveService).mockReturnValue({ archiveMemoryBatch: mockBatch } as any)

    await scheduler.run()

    expect(mockBatch).toHaveBeenCalledTimes(3)
    expect(mockBatch).toHaveBeenCalledWith('org-a', expect.objectContaining({ session_retention_days: 90 }))
    expect(mockBatch).toHaveBeenCalledWith('org-b', expect.objectContaining({ session_retention_days: 90 }))
    expect(mockBatch).toHaveBeenCalledWith('org-c', expect.objectContaining({ session_retention_days: 90 }))
  })

  it('continues processing when one org fails', async () => {
    const orgLister = vi.fn(() => ['org-fail', 'org-ok'])
    const scheduler = new ArchiveScheduler(orgLister, 2)

    const mockBatch = vi.fn()
      .mockRejectedValueOnce(new Error('db error'))
      .mockResolvedValueOnce({ archived_count: 1 })
    vi.mocked(getArchiveService).mockReturnValue({ archiveMemoryBatch: mockBatch } as any)

    await scheduler.run()

    expect(mockBatch).toHaveBeenCalledTimes(2)
  })
})

describe('archiveMemoryBatch', () => {
  let db: Database.Database
  let service: ArchiveService

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    service = new ArchiveService(new ArchiveDAO(db), new ExecutionDAO(db), db)
  })

  afterEach(() => {
    db.close()
  })

  it('returns { archived_count: 0 } when no daily files exist', async () => {
    const result = await service.archiveMemoryBatch('test-org', {
      session_retention_days: 90,
      long_term_refine_trigger_days: 7,
    })
    expect(result).toEqual({ archived_count: 0 })
  })
})

describe('emitArchived (via archiveMemoryBatch)', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    db = new Database(':memory:')
    applySchema(db)
  })

  afterEach(() => {
    db.close()
  })

  it('fires memory.archived event when domainEventBus is provided', async () => {
    const emitSpy = vi.fn().mockResolvedValue(undefined)
    const mockBus = { emit: emitSpy } as any

    const service = new ArchiveService(new ArchiveDAO(db), new ExecutionDAO(db), db, mockBus)

    // Mock getAgentService to return a service that "archives" successfully
    const { getAgentService } = await import('../../agent/agent-service')
    vi.mocked(getAgentService).mockReturnValue({
      archiveMemory: vi.fn().mockResolvedValue({ archived_date: '2024-01-01', essence_summary: 'test' }),
    } as any)

    // Create a temp daily memory dir with an old file
    const fs = await import('fs')
    const path = await import('path')
    const { getDailyMemoryDir } = await import('../../agent/paths')
    const dailyDir = getDailyMemoryDir()
    fs.mkdirSync(dailyDir, { recursive: true })

    const oldDate = '2020-01-01'
    fs.writeFileSync(path.join(dailyDir, `${oldDate}.md`), 'old memory', 'utf-8')

    try {
      await service.archiveMemoryBatch('test-org', {
        session_retention_days: 90,
        long_term_refine_trigger_days: 7,
      })

      // Event should have been emitted
      expect(emitSpy).toHaveBeenCalledWith(
        'memory.archived',
        expect.objectContaining({ memory_id: oldDate, memory_type: 'daily_memory' }),
        expect.objectContaining({ source: 'archive-service' }),
      )
    } finally {
      // Cleanup
      try { fs.unlinkSync(path.join(dailyDir, `${oldDate}.md`)) } catch {}
      try { fs.unlinkSync(path.join(dailyDir, 'archive', `${oldDate}.md`)) } catch {}
    }
  })

  it('swallows event errors silently', async () => {
    const emitSpy = vi.fn().mockRejectedValue(new Error('bus failure'))
    const mockBus = { emit: emitSpy } as any

    const service = new ArchiveService(new ArchiveDAO(db), new ExecutionDAO(db), db, mockBus)

    const { getAgentService } = await import('../../agent/agent-service')
    vi.mocked(getAgentService).mockReturnValue({
      archiveMemory: vi.fn().mockResolvedValue({ archived_date: '2024-01-01', essence_summary: '' }),
    } as any)

    const fs = await import('fs')
    const path = await import('path')
    const { getDailyMemoryDir } = await import('../../agent/paths')
    const dailyDir = getDailyMemoryDir()
    fs.mkdirSync(dailyDir, { recursive: true })

    const oldDate = '2019-06-15'
    fs.writeFileSync(path.join(dailyDir, `${oldDate}.md`), 'old', 'utf-8')

    try {
      // Should not throw despite emit rejection
      const result = await service.archiveMemoryBatch('test-org', {
        session_retention_days: 90,
        long_term_refine_trigger_days: 7,
      })
      expect(result.archived_count).toBe(1)
    } finally {
      try { fs.unlinkSync(path.join(dailyDir, `${oldDate}.md`)) } catch {}
      try { fs.unlinkSync(path.join(dailyDir, 'archive', `${oldDate}.md`)) } catch {}
    }
  })
})
