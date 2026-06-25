import os from 'os'
import type { ExecutionDAO } from '../../db/dao/execution-dao'
import type { EventLoopMonitor } from './event-loop-monitor'

export interface SystemResponse {
  process: {
    pid: number
    uptime_seconds: number
    node_version: string
    memory: {
      rss_mb: number
      heap_used_mb: number
      heap_total_mb: number
      external_mb: number
      array_buffers_mb: number
    }
  }
  os: {
    platform: string
    arch: string
    cpus: number
    load_avg: [number, number, number]
    total_mem_mb: number
    free_mem_mb: number
  }
  event_loop: {
    lag_ms: number
    utilization_percent: number
  }
  executions: {
    total: number
    running: number
    completed: number
    failed: number
    pending: number
    cancelled: number
  }
}

function toMB(bytes: number): number {
  return Math.round(bytes / 1024 / 1024 * 100) / 100
}

export class SystemResolver {
  constructor(
    private executionDAO: ExecutionDAO,
    private eventLoopMonitor: EventLoopMonitor,
  ) {}

  getSystem(): SystemResponse {
    const mem = process.memoryUsage()
    const loadAvg = os.loadavg()

    const stats = this.executionDAO.getOverallStats()

    return {
      process: {
        pid: process.pid,
        uptime_seconds: Math.round(process.uptime()),
        node_version: process.version,
        memory: {
          rss_mb: toMB(mem.rss),
          heap_used_mb: toMB(mem.heapUsed),
          heap_total_mb: toMB(mem.heapTotal),
          external_mb: toMB(mem.external),
          array_buffers_mb: toMB(mem.arrayBuffers ?? 0),
        },
      },
      os: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        load_avg: [loadAvg[0], loadAvg[1], loadAvg[2]],
        total_mem_mb: toMB(os.totalmem()),
        free_mem_mb: toMB(os.freemem()),
      },
      event_loop: {
        lag_ms: Math.round(this.eventLoopMonitor.getLagMs() * 100) / 100,
        utilization_percent: Math.round(this.eventLoopMonitor.getUtilization() * 100) / 100,
      },
      executions: {
        total: (stats.total_executions as number) ?? 0,
        running: (stats.running as number) ?? 0,
        completed: (stats.completed as number) ?? 0,
        failed: (stats.failed as number) ?? 0,
        pending: (stats.pending as number) ?? 0,
        cancelled: (stats.cancelled as number) ?? 0,
      },
    }
  }
}
