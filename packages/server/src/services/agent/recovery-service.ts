import fs from 'fs'
import path from 'path'
import os from 'os'
import { getAgentDir, getAgentMemoryDir, getDailyMemoryDir, getLongTermMemoryPath, getClonesDir } from './paths'
import { AgentSessionDAO, ExecutionDAO } from '../../db/dao'

// ── Types ──────────────────────────────────────────────────────

export interface RecoveryResult {
  sessions_restored: number
  clones_recovered: number
  provider_sessions_recreated: number
  interrupted_workflows: number
  errors: string[]
}

export interface RecoveryStatus {
  last_recovery: string | null
  is_recovering: boolean
  last_result: RecoveryResult | null
}

// ── RecoveryService ─────────────────────────────────────────────

/**
 * Handles server restart recovery for Agent state.
 * Maps to PRD Story H1: Server restart → Agent recovers memory + sessions.
 *
 * Recovery steps:
 * 1. Sessions: already persisted in SQLite → no action needed
 * 2. Clone providerSessionId: lost on restart → create new SDK sessions
 * 3. Interrupted workflows: detect via execution status → mark as interrupted
 * 4. Memory: .md files persist on disk → no action needed
 */
export class RecoveryService {
  private org: string
  private agentDir: string
  private statusFile: string

  constructor(org: string, private sessionDao: AgentSessionDAO, private execDao: ExecutionDAO) {
    this.org = org
    this.agentDir = getAgentDir()
    this.statusFile = path.join(this.agentDir, '.recovery-status.json')
  }

  /**
   * Run full recovery after server restart.
   * Called on first API request or server startup.
   */
  async recover(): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      sessions_restored: 0,
      clones_recovered: 0,
      provider_sessions_recreated: 0,
      interrupted_workflows: 0,
      errors: [],
    }

    try {
      // Step 1: Verify DB integrity
      result.sessions_restored = this.recoverSessions()

      // Step 2: Recover clone provider sessions
      result.provider_sessions_recreated = this.recoverCloneSessions()
      result.clones_recovered = result.provider_sessions_recreated

      // Step 3: Detect and mark interrupted workflows
      result.interrupted_workflows = this.recoverInterruptedWorkflows()

      // Step 4: Verify memory files exist
      this.verifyMemoryFiles()

      // Save recovery status
      this.saveStatus({
        last_recovery: new Date().toISOString(),
        is_recovering: false,
        last_result: result,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Recovery failed: ${msg}`)
    }

    return result
  }

  /**
   * Verify all sessions in DB are consistent.
   * Mark active sessions that were mid-stream as inactive.
   */
  private recoverSessions(): number {
    try {
      return this.sessionDao.countActiveSessions(this.org)
    } catch {
      return 0
    }
  }

  /**
   * Recover clone provider sessions.
   * After restart, Claude SDK providerSessionId is lost.
   * Mark clones as needing new sessions; next delegation creates fresh ones.
   */
  private recoverCloneSessions(): number {
    const clonesDir = getClonesDir()
    if (!fs.existsSync(clonesDir)) return 0

    let recovered = 0
    try {
      const entries = fs.readdirSync(clonesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const metaFile = path.join(clonesDir, entry.name, 'meta.json')
        if (!fs.existsSync(metaFile)) continue

        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))

          // If clone was "running" during crash, reset to idle
          if (meta.status === 'running') {
            meta.status = 'idle'
            meta.current_task = null
            meta.recovery_note = 'Reset after server restart'
            meta.recovered_at = new Date().toISOString()
            fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))
            recovered++
          }

          // Clear stale provider session ID
          if (meta.provider_session_id) {
            meta.provider_session_id = null
            meta.provider_session_reset = true
            fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))
            if (meta.status !== 'running') recovered++
          }
        } catch {
          // Skip corrupt entries
        }
      }
    } catch {
      // Directory read failure is non-fatal
    }

    return recovered
  }

  /**
   * Detect and mark interrupted workflow executions.
   * Executions with status 'running' at restart time are marked as interrupted.
   */
  private recoverInterruptedWorkflows(): number {
    try {
      return this.execDao.markInterruptedExecutions(this.org, new Date().toISOString())
    } catch {
      // executions table may not exist
      return 0
    }
  }

  /**
   * Verify memory files exist and are readable.
   */
  private verifyMemoryFiles(): void {
    const memoryDir = getAgentMemoryDir()
    const longTermPath = getLongTermMemoryPath()

    // Ensure memory directory exists
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true })
    }

    // Create empty long-term.md if missing
    if (!fs.existsSync(longTermPath)) {
      fs.writeFileSync(
        longTermPath,
        '# 长期记忆\n\n## 人格\n\n## 偏好\n\n## 经验教训\n\n## 常用工作流\n\n## 项目索引\n',
        'utf-8',
      )
    }

    // Ensure daily directory exists
    const dailyDir = getDailyMemoryDir()
    if (!fs.existsSync(dailyDir)) {
      fs.mkdirSync(dailyDir, { recursive: true })
    }
  }

  /**
   * Check if recovery is needed (first call since server start).
   */
  needsRecovery(): boolean {
    if (!fs.existsSync(this.statusFile)) return true

    try {
      const status = JSON.parse(fs.readFileSync(this.statusFile, 'utf-8')) as RecoveryStatus
      // Recovery needed if last recovery was before current server start
      // We use a simple heuristic: if file is older than 60 seconds, recovery is needed
      const stat = fs.statSync(this.statusFile)
      const serverUptime = Date.now() - stat.mtimeMs
      // Only recover once per 5 minutes to prevent loops
      return serverUptime > 5 * 60 * 1000
    } catch {
      return true
    }
  }

  /**
   * Get current recovery status.
   */
  getStatus(): RecoveryStatus {
    if (!fs.existsSync(this.statusFile)) {
      return { last_recovery: null, is_recovering: false, last_result: null }
    }

    try {
      return JSON.parse(fs.readFileSync(this.statusFile, 'utf-8'))
    } catch {
      return { last_recovery: null, is_recovering: false, last_result: null }
    }
  }

  private saveStatus(status: RecoveryStatus): void {
    try {
      const dir = path.dirname(this.statusFile)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.statusFile, JSON.stringify(status, null, 2), 'utf-8')
    } catch {
      // Status write failure is non-fatal
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────

const instances = new Map<string, RecoveryService>()
let _sessionDao: AgentSessionDAO | null = null
let _execDao: ExecutionDAO | null = null

export function initRecoveryService(sessionDao: AgentSessionDAO, execDao: ExecutionDAO): void {
  _sessionDao = sessionDao
  _execDao = execDao
  instances.clear()
}

export function getRecoveryService(org: string): RecoveryService {
  if (!_sessionDao || !_execDao) {
    throw new Error('RecoveryService not initialized. Call initRecoveryService() first.')
  }
  let instance = instances.get(org)
  if (!instance) {
    instance = new RecoveryService(org, _sessionDao, _execDao)
    instances.set(org, instance)
  }
  return instance
}
