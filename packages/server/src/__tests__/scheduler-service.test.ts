import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { SchedulerService } from '../services/scheduler/scheduler-service'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../db/dao'

const ORG = 'test'

describe('SchedulerService', () => {
  let db: Database.Database
  let service: SchedulerService

  beforeAll(() => {
    db = new Database(':memory:')
    applySchema(db)

    service = new SchedulerService(new ScheduleConfigDAO(db), new ScheduleRunDAO(db))
  })

  afterAll(() => {
    db.close()
  })

  it('instantiates with database', () => {
    expect(service).toBeDefined()
  })

  it('creates a workflow job', () => {
    const job = service.createJob({
      name: 'test-workflow',
      org: ORG,
      job_type: 'workflow',
      cron_expression: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      config: {
        schema_version: '2.0',
        type: 'workflow',
        workspace_spec: {
          org: ORG,
          branch_prefix: 'sched',
          projects: [{ name: 'proj', source_path: '/tmp/proj' }],
        },
        workflow_chain: [{ workflow_ref: 'test.yaml', input_values: {} }],
        max_retain: 10,
      },
    })

    expect(job.id).toBeDefined()
    expect(job.name).toBe('test-workflow')
    expect(job.job_type).toBe('workflow')
    expect(job.enabled).toBe(true)
    expect(job.version).toBe(1)
  })

  it('creates an agent job', () => {
    const job = service.createJob({
      name: 'test-agent',
      org: ORG,
      job_type: 'agent',
      cron_expression: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      config: {
        schema_version: '1.0',
        type: 'agent',
        prompt: 'Test prompt',
        model: 'claude-sonnet-4-20250514',
        timeout_seconds: 300,
      },
    })

    expect(job.job_type).toBe('agent')
    expect(job.name).toBe('test-agent')
  })

  it('rejects duplicate name in same org', () => {
    expect(() => {
      service.createJob({
        name: 'test-workflow',
        org: ORG,
        job_type: 'workflow',
        cron_expression: '0 10 * * *',
        timezone: 'Asia/Shanghai',
        config: {
          schema_version: '2.0',
          type: 'workflow',
          workspace_spec: {
            org: ORG,
            branch_prefix: 'sched',
            projects: [{ name: 'proj', source_path: '/tmp/proj' }],
          },
          workflow_chain: [{ workflow_ref: 'other.yaml', input_values: {} }],
          max_retain: 10,
        },
      })
    }).toThrow()
  })

  it('lists jobs for org', () => {
    const result = service.listJobs({ org: ORG })
    expect(result.items).toBeDefined()
    expect(Array.isArray(result.items)).toBe(true)
    expect(result.total).toBeGreaterThanOrEqual(2)
  })

  it('toggles job enabled status', () => {
    const result = service.listJobs({ org: ORG })
    const job = result.items[0]
    const toggled = service.toggleJob(job.id)
    expect(toggled.enabled).toBe(!job.enabled)
  })

  it('updates job with correct version', () => {
    const result = service.listJobs({ org: ORG })
    const job = result.items[0]
    const updated = service.updateJob(job.id, {
      name: job.name,
      cron_expression: '0 10 * * *',
      timezone: 'Asia/Shanghai',
      config: job.config,
    }, job.version)
    expect(updated.version).toBe(job.version + 1)
  })

  it('rejects update with stale version (409 Conflict)', () => {
    const result = service.listJobs({ org: ORG })
    const job = result.items[0]
    expect(() => {
      service.updateJob(job.id, {
        name: job.name,
        cron_expression: '0 11 * * *',
        timezone: 'Asia/Shanghai',
        config: job.config,
      }, 1) // stale version
    }).toThrow()
  })

  it('records audit logs for operations', () => {
    const result = service.listJobs({ org: ORG })
    const job = result.items[0]
    const logs = service.getAuditLogs(job.id)
    expect(logs).toBeDefined()
    expect(logs.items).toBeDefined()
    expect(Array.isArray(logs.items)).toBe(true)
    expect(logs.items.length).toBeGreaterThanOrEqual(1)
  })

  it('soft deletes job', () => {
    const result = service.listJobs({ org: ORG })
    const countBefore = result.total
    const lastJob = result.items[result.items.length - 1]
    service.deleteJob(lastJob.id)
    const after = service.listJobs({ org: ORG })
    expect(after.total).toBe(countBefore - 1)
  })
})
