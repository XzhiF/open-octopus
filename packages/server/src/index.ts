import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { bodyLimit } from "hono/body-limit"
import http from "http"
import os from "os"
import { createYjsWebSocketServer, setYjsWorkspaceDAO } from "./routes/yjs-ws"
import { initDb, getDb, getDbPath } from "./db/connection"
import { applySchema } from "./db/schema"
import {
  WorkspaceDAO, ExecutionDAO, TokenUsageDAO, ScheduleConfigDAO,
  ScheduleRunDAO, ChatDAO, OrgDAO, AgentSessionDAO, EvolutionDAO,
  CloneDAO, SafetyDAO, ArchiveDAO, ExperienceDAO,
} from "./db/dao"
import { ObservabilityService } from "./services/observability"
import { PrivacyFilter } from "./services/privacy-filter"
import { createWorkspaceRoutes } from "./routes/workspace"
import { createWorkflowRoutes } from "./routes/workflow"
import executionRoutes, { setExecutionDependencies } from "./routes/execution"
import { createDashboardRoutes } from "./routes/dashboard"
import { chatRoutes } from "./routes/chat"
import { globalChatRoutes } from "./routes/global-chat"
import { createFileRoutes } from "./routes/file-routes"
import { createOrgRoutes } from "./routes/org"
import builtInWorkflowRoutes from "./routes/builtin-workflow"
import { createAnalyticsLogRoutes, createAnalyticsRoutes } from "./routes/analytics"
import { eventRoutes } from "./routes/events"
import { createPipelineRoutes } from "./routes/pipeline"
import { createArchiveRoutes } from "./routes/archive"
import chainRoutes from "./routes/chain-routes"
import scheduleRoutes, { setScheduleService } from "./routes/schedule"
import { createSchedulerRoutes } from "./routes/scheduler"
import { createAgentRoutes } from "./routes/agent"
import cronRoutes from "./routes/cron"
import { SSEService } from "./services/sse"
import { migrateOrgDirs, syncOrgsFromFilesystem } from "./services/org"
import { ExecutionService } from "./services/execution"
import { errorHandler } from "./middleware/error"
import { agentAuthMiddleware, setAgentAuthOrgDAO } from "./routes/agent/middleware"
import { installGlobalErrorHandlers, logInfo, getLogFilePath } from "./file-logger"
import { registerProvider, ClaudeSDKProvider } from "@octopus/providers"
import { isPortInUse, findPidOnPort, killPid, waitForPort } from "./port-utils"
import { globalErrorTracker, setupDataRetention } from "./services/error-tracker"
import { initExecutionServiceRegistry } from "./services/execution-service-registry"
import { WorkspaceScheduleService } from "./services/schedule"
import { SchedulerService } from "./services/scheduler/scheduler-service"
import { SchedulerEngine } from "./services/scheduler/scheduler-engine"
import { WorkflowExecutor } from "./services/scheduler/executors/workflow-executor"
import { AgentExecutor } from "./services/scheduler/executors/agent-executor"
import { DashboardService } from "./services/scheduler/dashboard-service"
import { ExportService } from "./services/scheduler/export-service"
import { WorkspaceService } from "./services/workspace"
import { ChatService } from "./services/chat"
import { LeaderboardService } from "./services/leaderboard"
import { getLogAnalysisService } from "./services/log-analysis"
import { initSessionService } from "./services/agent/session-service"
import { initMemoryService } from "./services/agent/memory-service"
import { initEvolutionService } from "./services/agent/evolution-service"
import { initRecoveryService } from "./services/agent/recovery-service"
import { initSessionCompressService } from "./services/agent/session-compress-service"
import { initAgentService, getAgentService } from "./services/agent/agent-service"
import { getFlag } from "./config/feature-flags"
import { ActuatorService } from "./services/actuator/actuator-service"
import { SecretMasker } from "./services/actuator/secret-masker"
import { EventLoopMonitor } from "./services/actuator/event-loop-monitor"
import { createActuatorRoutes } from "./routes/actuator"
import { getRecoveryService } from "./services/agent/recovery-service"

// Install global error handlers early — catches uncaughtException / unhandledRejection
if (!process.env.VITEST) {
  installGlobalErrorHandlers()
}

// ── DAO Factory: Create all 13 DAOs from DB connection ─────────────────────
interface AllDAOs {
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
  archive: ArchiveDAO
  experience: ExperienceDAO
}

function createAllDAOs(db: ReturnType<typeof initDb>): AllDAOs {
  return {
    workspace: new WorkspaceDAO(db),
    execution: new ExecutionDAO(db),
    tokenUsage: new TokenUsageDAO(db),
    scheduleConfig: new ScheduleConfigDAO(db),
    scheduleRun: new ScheduleRunDAO(db),
    chat: new ChatDAO(db),
    org: new OrgDAO(db),
    agentSession: new AgentSessionDAO(db),
    evolution: new EvolutionDAO(db),
    clone: new CloneDAO(db),
    safety: new SafetyDAO(db),
    archive: new ArchiveDAO(db),
    experience: new ExperienceDAO(db),
  }
}

const db = process.env.VITEST ? null : initDb()
let daos: AllDAOs | null = null
if (db) {
  applySchema(db)

  // Create all DAO instances at startup — fail-fast if DAO initialization fails
  try {
    daos = createAllDAOs(db)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[server] FATAL: Failed to initialize DAOs: ${msg}`)
    process.exit(1)
  }

  ExecutionService.recoverInterruptedExecutions(db)
  migrateOrgDirs()
  syncOrgsFromFilesystem(daos.org)
  const cleanupRetention = setupDataRetention(db)
  // Store cleanup for graceful shutdown
  ;(global as any).__octopus_cleanupRetention = cleanupRetention

  // Auto-init agent directories (global, shared across all orgs)
  try {
    const { getInitService } = require('./services/agent/init-service')
    const initService = getInitService()
    initService.initAgent()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[server] Agent auto-init failed: ${msg}`)
  }
}

const sse = new SSEService()
let observability: ObservabilityService | undefined

// ── Services (created once at startup with pre-built DAOs) ──────────
let workspaceService: WorkspaceService | undefined
let chatService: ChatService | undefined
let leaderboardService: LeaderboardService | undefined

if (!process.env.VITEST && daos) {
  // Create services with DAOs
  workspaceService = new WorkspaceService(daos.workspace)
  chatService = new ChatService(daos.chat, sse)
  leaderboardService = new LeaderboardService(daos.tokenUsage)

  // P1: Register ArchiveService singleton
  try {
    const { ArchiveService } = require('./services/archive/archive-service')
    const { setArchiveService } = require('./services/archive/archive-registry')
    const archiveService = new ArchiveService(daos.archive, daos.execution, daos.tokenUsage, daos.workspace, daos.experience)
    setArchiveService(archiveService)

    // P1.7: Schedule recovery jobs (every 6 hours)
    const SIX_HOURS = 6 * 60 * 60 * 1000
    setInterval(() => {
      try {
        archiveService.retryCleanup()
        archiveService.recoverStuckArchiving()
      } catch (err) {
        console.warn('[server] Archive recovery failed:', err)
      }
    }, SIX_HOURS).unref()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[server] ArchiveService init failed: ${msg}`)
  }

  observability = new ObservabilityService(daos.execution, daos.tokenUsage, new PrivacyFilter())
  setExecutionDependencies(sse, observability, daos.execution)
  initExecutionServiceRegistry(daos.execution as any, sse, observability, {
    executionDAO: daos.execution,
    workspaceDAO: daos.workspace,
  })
  registerProvider('claude', () => new ClaudeSDKProvider())

  // Initialize agent service singletons
  initSessionService(daos.agentSession)
  initMemoryService(daos.agentSession)
  initEvolutionService(daos.evolution)
  initRecoveryService(daos.agentSession, daos.execution)
  initSessionCompressService(daos.agentSession)
  initAgentService(daos.agentSession, daos.safety)

  // Set DAOs for middleware and yjs-ws
  setAgentAuthOrgDAO(daos.org)
  setYjsWorkspaceDAO(daos.workspace)
}

const app = new Hono()

// CORS: allow localhost, env-configured origins, and any local network IP.
const LOCAL_IPS = new Set(
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => i != null)
    .map((i) => i.address)
)

function isTrustedOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const { hostname } = new URL(origin)
    if (hostname === "localhost" || hostname === "127.0.0.1" || LOCAL_IPS.has(hostname)) return true
    if (process.env.OCTOPUS_FRONTEND_URL && origin === process.env.OCTOPUS_FRONTEND_URL) return true
  } catch { /* ignore */ }
  return false
}

app.use("*", cors({
  origin: (origin) => origin ?? "*",
  credentials: true,
  allowHeaders: ["Content-Type", "Authorization", "If-Match", "X-Octopus-Org"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
}))
app.use("*", logger())
app.use("*", bodyLimit({ maxSize: 1024 * 1024 })) // 1MB body size limit

// Security headers
app.use("*", async (c, next) => {
  await next()
  c.res.headers.set("X-Content-Type-Options", "nosniff")
  c.res.headers.set("X-Frame-Options", "DENY")
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
})

// ── Route Registration ─────────────────────────────────────────
// Routes are always registered. In test mode (VITEST), daos is null
// but getDb() works at request time (tests init DB in beforeAll).
// We use Proxy DAOs that lazily create the real DAO on first method call.
function lazyDAO<T>(Ctor: new (db: any) => T): T {
  let real: T | null = null
  return new Proxy({} as any, {
    get(_, prop) {
      if (!real) real = new Ctor(getDb())
      const val = (real as any)[prop]
      return typeof val === 'function' ? val.bind(real) : val
    },
  }) as T
}

const d = daos ?? {
  workspace: lazyDAO(WorkspaceDAO),
  execution: lazyDAO(ExecutionDAO),
  tokenUsage: lazyDAO(TokenUsageDAO),
  scheduleConfig: lazyDAO(ScheduleConfigDAO),
  scheduleRun: lazyDAO(ScheduleRunDAO),
  chat: lazyDAO(ChatDAO),
  org: lazyDAO(OrgDAO),
  agentSession: lazyDAO(AgentSessionDAO),
  evolution: lazyDAO(EvolutionDAO),
  clone: lazyDAO(CloneDAO),
  safety: lazyDAO(SafetyDAO),
  archive: lazyDAO(ArchiveDAO),
  experience: lazyDAO(ExperienceDAO),
}

const wsSvc = workspaceService ?? new WorkspaceService(d.workspace)
const chatSvc = chatService ?? new ChatService(d.chat, sse)
const lbSvc = leaderboardService ?? new LeaderboardService(d.tokenUsage)
const schedSvc = new SchedulerService(d.scheduleConfig, d.scheduleRun)

// In test mode, also initialize agent singletons with lazy proxy DAOs
if (!daos) {
  try {
    initSessionService(d.agentSession)
    initMemoryService(d.agentSession)
    initEvolutionService(d.evolution)
    initRecoveryService(d.agentSession, d.execution)
    initSessionCompressService(d.agentSession)
    initAgentService(d.agentSession, d.safety)
    setAgentAuthOrgDAO(d.org)
    setYjsWorkspaceDAO(d.workspace)
  } catch { /* ignore */ }
}

app.route("/api/orgs", createOrgRoutes(d.org))
app.route("/api/workspaces", createWorkspaceRoutes(wsSvc, d.org, d.workspace))
app.route("/api/workspaces/:id/workflows", createWorkflowRoutes(d.workspace))
app.route("/api/workspaces/:id/executions", executionRoutes)
app.route("/api/workspaces/:id/analytics", createAnalyticsLogRoutes(d.workspace, getLogAnalysisService({ tokenDao: d.tokenUsage, execDao: d.execution }) ?? new (require('./services/log-analysis').LogAnalysisService)(d.tokenUsage, d.execution)))
app.route("/api/dashboard", createDashboardRoutes(wsSvc, lbSvc, d.execution, d.tokenUsage))
app.route("/api/workspaces/:id/chat", chatRoutes(sse, chatSvc, wsSvc))
app.route("/api/chat/global", globalChatRoutes(sse, chatSvc))
app.route("/api/workspaces/:id/files", createFileRoutes(d.workspace))
app.route("/api/workspaces/:id/events", eventRoutes(sse))
app.route("/api/workspaces", createPipelineRoutes(d.workspace))
app.route("/api/workspaces", chainRoutes)
app.route("/api/workspaces/:id/schedules", scheduleRoutes)
app.route("/api/cron", cronRoutes)
app.route("/api/schedules/cron", cronRoutes)
app.route("/api", createAnalyticsRoutes(d.execution, d.tokenUsage, d.workspace, globalErrorTracker))
app.route("/api/agent", createAgentRoutes({
  workspaceDAO: d.workspace,
  sessionDAO: d.agentSession,
  evolutionDAO: d.evolution,
  safetyDAO: d.safety,
  scheduleConfigDAO: d.scheduleConfig,
  executionDAO: d.execution,
  schedulerService: schedSvc,
  archiveDAO: d.archive,
}))
app.route("/api/workflows/built-in", builtInWorkflowRoutes)
app.route("/api/archive", createArchiveRoutes({ archiveDAO: d.archive, experienceDAO: d.experience }))

// P3: GitHub webhook route
try {
  const { createWebhookRoutes } = require('./routes/webhooks')
  const { ExperienceLifecycleService } = require('./services/experience/lifecycle-service')
  const { KnowledgeFiles } = require('./services/archive/knowledge-files')
  const knowledgeFiles = new KnowledgeFiles(d.experience)
  const lifecycleService = new ExperienceLifecycleService(d.experience, knowledgeFiles)
  app.route("/webhooks", createWebhookRoutes({
    lifecycleService,
    githubSecret: process.env.GITHUB_WEBHOOK_SECRET,
  }))

  // P3.6: Experience decay scheduled task (weekly)
  const ONE_WEEK = 7 * 24 * 60 * 60 * 1000
  setInterval(() => {
    lifecycleService.decayStale().then((count: number) => {
      if (count > 0) console.log(`[experience-decay] ${count} items marked obsolete`)
    }).catch((err: any) => console.warn('[experience-decay] Failed:', err))
  }, ONE_WEEK).unref()
} catch (err) {
  if (!process.env.VITEST) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[server] Webhook routes init failed: ${msg}`)
  }
}

// P6: Telegram webhook route — /api/agent/telegram/webhook
try {
  const { createTelegramWebhookRoute } = require('./routes/webhooks')
  app.route("/api/agent/telegram", createTelegramWebhookRoute({
    archiveDAO: d.archive,
    experienceDAO: d.experience,
    executionDAO: d.execution,
  }))
} catch (err) {
  if (!process.env.VITEST) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[server] Telegram webhook init failed: ${msg}`)
  }
}

// P6: Agent schedule register route — /api/agent/schedules/register
try {
  const { createScheduleRegisterRoutes } = require('./routes/agent/schedule-register')
  app.route("/api/agent", createScheduleRegisterRoutes({
    scheduleConfigDAO: d.scheduleConfig,
    schedulerService: schedSvc,
  }))
} catch (err) {
  if (!process.env.VITEST) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[server] Schedule register routes init failed: ${msg}`)
  }
}

// Set scheduler on agent service
try { getAgentService().setSchedulerService(schedSvc) } catch {}

// ── Actuator: operational diagnostics endpoints ──────────────────
let actuatorService: ActuatorService | null = null
try {
  const serverStartedAt = new Date(Date.now() - process.uptime() * 1000)
  const serverBranch = process.env.OCTOPUS_BRANCH ?? null
  const serverPort = parseInt(process.env.PORT ?? "3001", 10)
  const serverMode = serverBranch ? "isolated" : "default"
  const secretMasker = new SecretMasker()
  const eventLoopMonitor = new EventLoopMonitor()
  if (!process.env.VITEST) eventLoopMonitor.enable()
  const schedulerEngineInstance = ((global as any).__octopus_scheduler as import('./services/scheduler/scheduler-engine').SchedulerEngine | undefined) ?? null

  actuatorService = new ActuatorService({
    db: getDb(),
    executionDAO: d.execution,
    workspaceDAO: d.workspace,
    tokenUsageDAO: d.tokenUsage,
    scheduleConfigDAO: d.scheduleConfig,
    scheduleRunDAO: d.scheduleRun,
    schedulerService: schedSvc,
    schedulerEngine: schedulerEngineInstance,
    observability: observability ?? new ObservabilityService(d.execution, d.tokenUsage, new PrivacyFilter()),
    secretMasker,
    errorTracker: globalErrorTracker,
    eventLoopMonitor,
    getRecoveryService: (org: string) => getRecoveryService(org) as any,
    getSubsystemProbes: () => {
      const probes: Record<string, boolean> = {
        workflow_engine: false, workspace_service: false,
        scheduler_service: false, notify_subsystem: false, claude_provider: false,
      }
      try { probes.workflow_engine = typeof require('@octopus/engine').WorkflowEngine === 'function' } catch {}
      try { probes.workspace_service = d.workspace.countAll() >= 0 } catch {}
      try { probes.scheduler_service = typeof schedSvc.listJobs === 'function' } catch {}
      try { probes.notify_subsystem = typeof require('./services/notification').getNotificationService().sendNotification === 'function' } catch {}
      try { probes.claude_provider = typeof require('@octopus/providers').getProvider('claude')?.sendQuery === 'function' } catch {}
      return probes
    },
    getSafeMode: () => {
      try { return require('./services/agent/config-manager').getConfigManager().getConfig('default').safe_mode?.enabled ?? false } catch { return false }
    },
    getRecoveryNeeded: () => {
      try { return getRecoveryService('default').needsRecovery() } catch { return false }
    },
    startedAt: serverStartedAt,
    port: serverPort,
    mode: serverMode,
    branch: serverBranch,
  })
  app.route("/api/actuator", createActuatorRoutes(actuatorService))
} catch (err) {
  // DB not yet available (test mode) — actuator routes won't be mounted
  if (!process.env.VITEST) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[server] Actuator setup failed: ${msg}`)
  }
}

app.onError(errorHandler)

export default app

const shouldServe = !process.env.VITEST && !process.env.NODE_TEST
if (shouldServe) {
  // Lazy workspace initialization: workspaces are initialized on-demand when
  // the user opens them via WebSocket (yjs-ws.ts initWorkspaceRoom).
  // This avoids opening ~1000 FDs per workspace at startup.
  const activeWorkspaceIds = daos!.workspace.findActiveIds()
  console.log(`[yjs] ${activeWorkspaceIds.length} active workspaces (lazy init on first access)`)

  const portArg = process.argv.find(a => a.startsWith("--port="))
  const port = parseInt(portArg?.split("=")[1] ?? process.env.PORT ?? "3001", 10)

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host ?? "localhost"
    const proto = req.headers["x-forwarded-proto"] ?? "http"
    const url = `${proto}://${host}${req.url}`

    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks)

    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).reduce((h, [k, v]) => {
        if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v)
        return h
      }, new Headers()),
      body: body.length > 0 ? body : undefined,
    })

    const response = await app.fetch(request)
    const headers: Record<string, string> = {}
    response.headers.forEach((v, k) => { headers[k] = v })
    res.writeHead(response.status, headers)
    if (response.body) {
      const reader = response.body.getReader()
      const stream = () => {
        reader.read().then(({ done, value }) => {
          if (done) { res.end(); return }
          res.write(value)
          stream()
        })
      }
      stream()
    } else {
      res.end()
    }
  })
  createYjsWebSocketServer(server)

  const forceRestart = process.argv.includes("--force")

  async function startServer() {
    const portBusy = await isPortInUse(port)

    if (portBusy) {
      const pids = findPidOnPort(port)
      const pidLabel = pids.length > 0 ? ` (PID: ${pids.join(", ")})` : ""

      if (forceRestart && pids.length > 0) {
        console.log(`[server] Port ${port} occupied${pidLabel}, --force specified — killing stale process...`)
        for (const pid of pids) {
          killPid(pid)
        }
        const freed = await waitForPort(port)
        if (!freed) {
          console.error(`[server] Port ${port} still occupied after 5s. Manual cleanup needed.`)
          process.exit(1)
        }
        console.log(`[server] Port ${port} freed, starting server...`)
      } else {
        console.error(`\n[server] Port ${port} is already in use${pidLabel}.`)
        console.error(`  Possible causes:`)
        console.error(`    - Another Octopus server is running`)
        console.error(`    - A previous server didn't shut down cleanly (stale process)`)
        console.error(`\n  To fix:`)
        console.error(`    node dist/index.js --force    # Kill stale process and start`)
        if (pids.length > 0 && process.platform === "win32") {
          console.error(`    taskkill /PID ${pids[0]} /F   # Kill manually`)
        } else if (pids.length > 0) {
          console.error(`    kill ${pids[0]}               # Kill manually`)
        }
        console.error(`\n  Tip: always use Ctrl+C to stop the server cleanly.\n`)
        process.exit(1)
      }
    }

    server.listen(port, () => {
      console.log(`Octopus Server running on http://localhost:${port} (PID: ${process.pid})`)
      console.log(`WebSocket ready on ws://localhost:${port}`)
      console.log(`Log file: ${getLogFilePath()}`)
      logInfo(`Server started`, {
        pid: process.pid,
        port,
        node: process.version,
        branch: process.env.OCTOPUS_BRANCH ?? "main",
        dbPath: getDbPath(),
      })

      // Consume deferred agent hooks now that providers are fully initialized
      ExecutionService.consumePendingHooks(db).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[server] Failed to consume pending hooks: ${msg}`)
      })

      // ★ Auto-resume any pending_resume executions (crash recovery)
      ExecutionService.resumePendingExecutions(db).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[server] Failed to resume pending executions: ${msg}`)
      })

      // ★ Initialize Scheduler Service (always available, not gated by feature flag)
      // Pattern A (Singleton): Services created once with pre-built DAOs
      const schedulerService = new SchedulerService(daos!.scheduleConfig, daos!.scheduleRun)
      const dashboardService = new DashboardService(daos!.scheduleConfig, daos!.scheduleRun)
      const exportService = new ExportService(daos!.scheduleConfig)
      app.route('/api/scheduler', createSchedulerRoutes(schedulerService, dashboardService, exportService))
      ;(global as any).__octopus_scheduler_service = schedulerService

      // ★ Initialize Scheduler Engine with executors
      if (getFlag('scheduler')) {
        const scheduleService = new WorkspaceScheduleService(
          sse, daos!.scheduleConfig, daos!.scheduleRun, daos!.execution,
        )
        setScheduleService(scheduleService)

        // Create executor registry for engine — executors share pre-built DAOs
        const executors = new Map<string, import('./services/scheduler/executors/executor-interface').Executor>()
        executors.set('workflow', new WorkflowExecutor(
          sse, daos!.scheduleConfig, daos!.scheduleRun, daos!.execution, workspaceService!,
        ))
        executors.set('agent', new AgentExecutor(
          daos!.scheduleRun, daos!.execution, undefined,
        ))

        const schedulerEngine = new SchedulerEngine(
          daos!.scheduleConfig, daos!.scheduleRun, scheduleService, executors,
        )
        scheduleService.setOnScheduleChange(() => schedulerEngine.reload())

        // Wire service → engine: reload on CRUD, dispatch on manual trigger.
        // Late-bound via setCallbacks so the service can be constructed before
        // the engine exists.
        schedulerService.setCallbacks({
          onScheduleChange: () => schedulerEngine.reload(),
          onTrigger: (scheduleId, executionId) => schedulerEngine.triggerManual(scheduleId, executionId),
        })

        schedulerEngine.start()
        ;(global as any).__octopus_scheduler = schedulerEngine
        ;(global as any).__octopus_schedule_service = scheduleService
        const jobCount = schedulerEngine['cronJobs']?.size ?? 0
        console.log(`[scheduler] Started with ${jobCount} active cron jobs (workflow + agent)`)
      } else {
        // Engine not running — manual triggers and cron won't execute.
        // Surface this clearly so users don't see perpetual 'triggered' rows.
        console.warn('[scheduler] scheduler feature flag OFF — jobs will not execute (CRUD API still available)')
      }
    })

    // Graceful shutdown on Ctrl+C / SIGTERM
    const shutdown = (signal: string) => {
      console.log(`\n[server] Received ${signal}, shutting down gracefully...`)
      logInfo(`Server shutting down`, { signal, pid: process.pid })
      observability?.shutdown()
      const scheduler = (global as any).__octopus_scheduler as SchedulerEngine | undefined
      scheduler?.stop()
      if ((global as any).__octopus_cleanupRetention) {
        ;(global as any).__octopus_cleanupRetention()
      }
      server.close(() => {
        console.log(`[server] HTTP server closed.`)
        try {
          const { closeDb } = require("./db/connection")
          closeDb()
          console.log(`[server] Database closed.`)
        } catch {}
        process.exit(0)
      })
      // Force exit after 3s if graceful shutdown stalls
      setTimeout(() => {
        console.error(`[server] Graceful shutdown timed out, forcing exit.`)
        process.exit(1)
      }, 3000)
    }
    process.on("SIGINT", () => shutdown("SIGINT"))
    process.on("SIGTERM", () => shutdown("SIGTERM"))
  }

  startServer()
}