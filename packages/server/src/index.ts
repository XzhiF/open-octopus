import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { bodyLimit } from "hono/body-limit"
import http from "http"
import fs from "fs"
import os from "os"
import path from "path"
import { createYjsWebSocketServer, setYjsWorkspaceDAO } from "./routes/yjs-ws"
import { initDb, getDb, getDbPath } from "./db/connection"
import { applySchema } from "./db/schema"
import {
  WorkspaceDAO, ExecutionDAO, TokenUsageDAO, ScheduleConfigDAO,
  ScheduleRunDAO, ChatDAO, OrgDAO, AgentSessionDAO, EvolutionDAO,
  CloneDAO, SafetyDAO,
  PendingReviewDAO, KnowledgeEffectivenessDAO, ArchiveDAO,
  TaskDAO,
} from "./db/dao"
import { ArchiveDraftDAO } from "./db/dao/archive-draft-dao"
import { InteractionMessageDAO } from "./db/dao/interaction-message-dao"
import { AgentVersionDAO } from "./db/dao/agent-version-dao"
import { HarnessDAO } from "./db/dao/harness-dao"
import { createKnowledgeRoutes } from "./routes/knowledge"
import { createReviewRoutes } from "./routes/review"
import { createArchiveRoutes } from "./routes/archive"
import { createResourceRoutes } from "./routes/resource"
import { getResourceRegistry } from "./services/resource-registry"
import { ReviewService } from "./services/knowledge/review"
import { ObservabilityService } from "./services/observability"
import { PrivacyFilter } from "./services/privacy-filter"
import { createWorkspaceRoutes } from "./routes/workspace"
import { createWorkflowRoutes } from "./routes/workflow"
import executionRoutes, { setExecutionDependencies } from "./routes/execution"
import harnessRoutes, { setHarnessDependencies } from "./routes/harness"
import { createDashboardRoutes } from "./routes/dashboard"
import { chatRoutes } from "./routes/chat"
import { globalChatRoutes } from "./routes/global-chat"
import { createFileRoutes } from "./routes/file-routes"
import { createOrgRoutes } from "./routes/org"
import { createBuiltInWorkflowRoutes } from "./routes/builtin-workflow"
import { createAnalyticsLogRoutes, createAnalyticsRoutes } from "./routes/analytics"
import { eventRoutes, taskpoolEventRoutes } from "./routes/events"
import { createPipelineRoutes } from "./routes/pipeline"
import chainRoutes from "./routes/chain-routes"
import scheduleRoutes, { setScheduleService } from "./routes/schedule"
import { createSchedulerRoutes } from "./routes/scheduler"
import { createTasksRoutes } from "./routes/tasks"
import { createSkillGroupsRoutes } from "./routes/skill-groups"
import { createAgentRoutes } from "./routes/agent"
import { createCloneSessionRoutes } from "./routes/clone"
import { createCloneFilesRoutes } from "./routes/agent/clone-files"
import { createVersionRoutes, createMainAgentVersionRoutes } from "./routes/agent/version-routes"
import cronRoutes from "./routes/cron"
import { createInteractionRoutes } from "./routes/interaction"
import { createWorkflowOpsRoutes } from "./routes/workflow-ops"
import { InteractionService } from "./services/interaction"
import { SSEService } from "./services/sse"
import { migrateOrgDirs, syncOrgsFromFilesystem } from "./services/org"
import { ExecutionService } from "./services/execution"
import { errorHandler } from "./middleware/error"
import { agentAuthMiddleware, setAgentAuthOrgDAO } from "./routes/agent/middleware"
import { installGlobalErrorHandlers, logInfo, getLogFilePath } from "./file-logger"
import { registerProvider, ClaudeSDKProvider, PiAgentProvider } from "@octopus/providers"
import { isPortInUse, findPidOnPort, killPid, waitForPort } from "./port-utils"
import { globalErrorTracker, setupDataRetention } from "./services/error-tracker"
import { initExecutionServiceRegistry, getExecutionService } from "./services/execution-service-registry"
import { WorkspaceScheduleService } from "./services/schedule"
import { SchedulerService } from "./services/scheduler/scheduler-service"
import { SchedulerEngine } from "./services/scheduler/scheduler-engine"
import { TaskScheduleStatusListener } from "./services/scheduler/schedule-status-listener"
import { TasksService } from "./services/tasks/tasks-service"
import { TaskHomeService } from "./services/tasks/task-home-service"
import { PluginMaterializer } from "./services/tasks/plugin-materializer"
import { AssistWorkflowService } from "./services/tasks/assist-workflow-service"
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
import { initAgentVersionService } from "./services/agent/agent-version-service"
import { getFlag } from "./config/feature-flags"
import { ActuatorService } from "./services/actuator/actuator-service"
import { SecretMasker } from "./services/actuator/secret-masker"
import { EventLoopMonitor } from "./services/actuator/event-loop-monitor"
import { createActuatorRoutes } from "./routes/actuator"
import { createSystemRoutes } from "./routes/system"
import { createReposRoutes } from "./routes/repos"
import { getRecoveryService } from "./services/agent/recovery-service"
import { initArchiveService } from "./services/archive/archive-service"
import { getDomainEventBus } from "./services/agent/domain-event-bus"

// Install global error handlers early — catches uncaughtException / unhandledRejection
if (!process.env.VITEST) {
  installGlobalErrorHandlers()
}

// ── Host Isolation: inject OCTOPUS_HOST_PID + OCTOPUS_HOST_PORTS ─────
// These must be on process.env so that Claude SDK tool calls (Bash, etc.)
// inherit them. buildHostEnv() in @octopus/engine handles direct bash/python
// spawns, but agent nodes run via the provider SDK which reads process.env.
if (!process.env.OCTOPUS_HOST_PID) {
  process.env.OCTOPUS_HOST_PID = String(process.pid)
}
if (!process.env.OCTOPUS_HOST_PORTS) {
  const _serverPort = parseInt(process.env.PORT ?? "3001", 10)
  process.env.OCTOPUS_HOST_PORTS = `${_serverPort},${_serverPort - 1}`
}

// ── DAO Factory: Create all 11 DAOs from DB connection ─────────────────────
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
    pendingReview: new PendingReviewDAO(db),
    knowledgeEffectiveness: new KnowledgeEffectivenessDAO(db),
    archive: new ArchiveDAO(db),
    archiveDraft: new ArchiveDraftDAO(db),
    interactionMessage: new InteractionMessageDAO(db),
    agentVersion: new AgentVersionDAO(db),
    harness: new HarnessDAO(db),
    task: new TaskDAO(db),
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

  observability = new ObservabilityService(daos.execution, daos.tokenUsage, new PrivacyFilter())
  setExecutionDependencies(sse, observability, daos.execution, daos.tokenUsage)
  setHarnessDependencies(daos.harness)
  initExecutionServiceRegistry(daos.execution as any, sse, observability, {
    executionDAO: daos.execution,
    workspaceDAO: daos.workspace,
  })
  registerProvider('claude', () => new ClaudeSDKProvider())

  // Pi Provider registration — always available (lazy-loaded, SDK imported on first query)
  registerProvider('pi', () => new PiAgentProvider())

  // Initialize agent service singletons
  initSessionService(daos.agentSession)
  initMemoryService(daos.agentSession)
  initEvolutionService(daos.evolution)
  initRecoveryService(daos.agentSession, daos.execution)
  initSessionCompressService(daos.agentSession)
  initAgentService(daos.agentSession, daos.safety)

  // Initialize agent version service
  initAgentVersionService(daos.agentVersion)

  // Auto-init built-in clones (filesystem + DB registration)
  try {
    const { getCloneInitService } = require('./services/agent/clone-init-service')
    const cloneInitService = getCloneInitService()
    const defaultOrg = daos.org.findAll()[0]?.name ?? 'default'
    const initResult = cloneInitService.initBuiltInClones(defaultOrg, daos.clone)
    if (initResult.dirsCreated.length > 0 || initResult.dbRegistered.length > 0) {
      console.log(`[server] Built-in clones initialized: ${initResult.dbRegistered.length} registered, ${initResult.dirsCreated.length} dirs created`)
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[server] Built-in clone init failed: ${msg}`)
  }

  // Initialize archive service singleton
  initArchiveService(daos.archive, daos.execution, db, getDomainEventBus())

  // ── Scheduler seed: auto-create system:daily-archive task ────────────
  // Idempotent — only inserts if no schedule named 'system:daily-archive' exists.
  try {
    const existingSeed = daos.scheduleConfig.findByName('system:daily-archive')
    if (!existingSeed) {
      daos.scheduleConfig.insertSchedule({
        id: 'system:daily-archive',
        org: 'system',
        name: 'system:daily-archive',
        cron_expression: '0 3 * * *',
        timezone: 'Asia/Shanghai',
        job_type: 'agent',
        config: JSON.stringify({
          prompt: 'Archive yesterday daily memory and refine long-term memory',
        }),
        enabled: 1,
        description: 'System-seeded daily archive task (auto-created on server startup)',
      })
      console.log('[server] Scheduler seed: system:daily-archive task created')
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[server] Scheduler seed failed: ${msg}`)
  }

  // One-time migration: if config.yaml has archive_cron_hour != 3 (default),
  // update the system:daily-archive cron expression
  try {
    const fs = require('fs')
    const yaml = require('js-yaml')
    const { getAgentConfigPath } = require('./services/agent/paths')
    const configPath = getAgentConfigPath()
    if (fs.existsSync(configPath)) {
      const raw = yaml.load(fs.readFileSync(configPath, 'utf-8'), { schema: yaml.JSON_SCHEMA }) as any
      const archiveHour = raw?.memory?.archive_cron_hour
      if (archiveHour !== undefined && archiveHour !== 3) {
        const existingJob = daos.scheduleConfig.findByName('system:daily-archive')
        if (existingJob) {
          const newCron = `0 ${archiveHour} * * *`
          daos.scheduleConfig.updateSchedule(existingJob.id, {
            cron_expression: newCron,
            version: existingJob.version + 1,
          })
          console.log(`[migration] Updated system:daily-archive cron to "${newCron}" from config.yaml archive_cron_hour`)
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[server] archive_cron_hour migration failed: ${msg}`)
  }

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
  origin: (origin) => isTrustedOrigin(origin) ? (origin ?? "*") : undefined,
  credentials: true,
  allowHeaders: ["Content-Type", "Authorization", "If-Match"],
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
  pendingReview: lazyDAO(PendingReviewDAO),
  knowledgeEffectiveness: lazyDAO(KnowledgeEffectivenessDAO),
  archive: lazyDAO(ArchiveDAO),
  archiveDraft: lazyDAO(ArchiveDraftDAO),
  interactionMessage: lazyDAO(InteractionMessageDAO),
  agentVersion: lazyDAO(AgentVersionDAO),
  harness: lazyDAO(HarnessDAO),
  // 03 (v2-D1): tasks table DAO. Added to the lazy fallback so `d.task` works
  // in test mode (VITEST) where `daos` is null and the lazy proxy branch is used.
  // 04's task-author autosave seam + TasksService both consume it.
  task: lazyDAO(TaskDAO),
}

const wsSvc = workspaceService ?? new WorkspaceService(d.workspace)
const chatSvc = chatService ?? new ChatService(d.chat, sse)
const lbSvc = leaderboardService ?? new LeaderboardService(d.tokenUsage)
const schedSvc = new SchedulerService(d.scheduleConfig, d.scheduleRun, sse)
const interactionSvc = new InteractionService(d.interactionMessage, d.tokenUsage, d.execution, sse, async (workspaceId, execId, nodeId, summary, varsUpdate, providerSessionId) => {
  const entry = getExecutionService(workspaceId)
  if (entry) {
    // Save provider session ID to execution's global_session_id for context continuity
    if (providerSessionId) {
      d.execution.updateExecution(execId, { global_session_id: providerSessionId } as any)
    }
    await entry.service.completeInteraction(execId, nodeId, summary, varsUpdate)
  }
})

// In test mode, also initialize agent singletons with lazy proxy DAOs
if (!daos) {
  try {
    initSessionService(d.agentSession)
    initMemoryService(d.agentSession)
    initEvolutionService(d.evolution)
    initRecoveryService(d.agentSession, d.execution)
    initSessionCompressService(d.agentSession)
    initAgentService(d.agentSession, d.safety)
    try { initAgentVersionService(d.agentVersion) } catch { /* ignore */ }
    setAgentAuthOrgDAO(d.org)
    setYjsWorkspaceDAO(d.workspace)
    try { initArchiveService(d.archive, d.execution, getDb(), getDomainEventBus()) } catch { /* db not ready yet */ }
    try { setHarnessDependencies(d.harness) } catch { /* db not ready yet */ }
  } catch { /* ignore */ }
}

app.route("/api/orgs", createOrgRoutes(d.org))
app.route("/api/workspaces", createWorkspaceRoutes(wsSvc, d.org, d.workspace))
app.route("/api/workspaces/:id/workflows", createWorkflowOpsRoutes(d.workspace))
app.route("/api/workspaces/:id/workflows", createWorkflowRoutes(d.workspace, () => resourceRegistry.get()))
app.route("/api/workspaces/:id/executions", executionRoutes)
app.route("/api/workspaces/:id/harness", harnessRoutes)
app.route("/api/workspaces/:id/analytics", createAnalyticsLogRoutes(d.workspace, getLogAnalysisService({ tokenDao: d.tokenUsage, execDao: d.execution }) ?? new (require('./services/log-analysis').LogAnalysisService)(d.tokenUsage, d.execution)))
app.route("/api/dashboard", createDashboardRoutes(wsSvc, lbSvc, d.execution, d.tokenUsage, d.archive))
app.route("/api/workspaces/:id/chat", chatRoutes(sse, chatSvc, wsSvc))
app.route("/api/chat/global", globalChatRoutes(sse, chatSvc))
app.route("/api/workspaces/:id/interactions", createInteractionRoutes(interactionSvc, d.workspace, d.execution))
app.route("/api/workspaces/:id/files", createFileRoutes(d.workspace))
app.route("/api/workspaces/:id/events", eventRoutes(sse))
app.route("/api/scheduler/events", taskpoolEventRoutes(sse))
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
  cloneDAO: d.clone,
  schedulerService: schedSvc,
}))

// Clone session routes — direct entry for Web UI pages
app.route("/api/clones", createCloneSessionRoutes({
  sessionDAO: d.agentSession,
  // 04: task-author autosave seam (v2-D6) — fires at turn-end for
  // cloneName === 'task-author'. Optional dep; no-op when absent.
  taskDAO: d.task,
}))

// Clone file tree and operations API
app.route("/api", createCloneFilesRoutes())

// Agent version management API
app.route("/api/clones", createVersionRoutes())
app.route("/api/agents/main", createMainAgentVersionRoutes())

app.route("/api/workflows/built-in", createBuiltInWorkflowRoutes(() => resourceRegistry.get()))

// Knowledge system routes — org is resolved per-request from the query
// string (`?org=<name>`), so the server no longer pins a default org.
const reviewService = new ReviewService(d.pendingReview)
app.route("/api/knowledge", createKnowledgeRoutes(d.knowledgeEffectiveness, d.pendingReview))
app.route("/api/review", createReviewRoutes(reviewService, d.pendingReview))

// Archive routes — execution result summarization + rule proposal
const stateDir = path.join(process.env.HOME ?? "~", ".octopus", "state")
app.route("/api/archive", createArchiveRoutes(d.pendingReview, stateDir, d.archive, d.archiveDraft))

// Resource management — unified resource lifecycle (install/uninstall/verify/audit)
const resourceRegistry = getResourceRegistry()
app.route("/api/resources", createResourceRoutes(() => resourceRegistry.get()))

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

// ── System management: model config + connectivity test ─────────────
app.route("/api/system", createSystemRoutes())

// ── Repos management: read manifest data for org ─────────────────────
app.route("/api/repos", createReposRoutes())

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

    server.listen(port, "0.0.0.0", () => {
      const localIP = (() => {
        for (const ifaces of Object.values(os.networkInterfaces())) {
          for (const iface of ifaces || []) {
            if (iface.family === "IPv4" && !iface.internal) return iface.address
          }
        }
        return "localhost"
      })()
      console.log(`Octopus Server running on http://0.0.0.0:${port} (LAN: http://${localIP}:${port}) (PID: ${process.pid})`)
      console.log(`WebSocket ready on ws://0.0.0.0:${port}`)
      console.log(`Log file: ${getLogFilePath()}`)
      logInfo(`Server started`, {
        pid: process.pid,
        port,
        node: process.version,
        branch: process.env.OCTOPUS_BRANCH ?? "main",
        dbPath: getDbPath(),
      })

      // Read host PIDs file written by dev.mjs (contains server + web + dev.mjs parent PIDs)
      try {
        const pidFile = path.join(os.homedir(), ".octopus", "host-pids.json")
        if (fs.existsSync(pidFile)) {
          const data = JSON.parse(fs.readFileSync(pidFile, "utf-8"))
          if (Array.isArray(data.pids) && data.pids.length > 0) {
            process.env.OCTOPUS_HOST_PIDS = data.pids.join(",")
            console.log(`[server] Host PIDs: ${data.pids.join(", ")} (from ${pidFile})`)
          }
        }
      } catch {
        // PID file not available (e.g. prod mode, direct start) — fall back to own PID only
      }

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
      // 03 (SG2): TaskScheduleStatusListener injected into the scheduler service
      // (covers enqueueJob→queued + abortJob→aborted), the engine (claim/rollback/
      // retry-cap-failed), and the workflow executor (running/done/failed). The
      // listener self-filters by origin_type='task' so non-task schedules no-op.
      const scheduleStatusListener = new TaskScheduleStatusListener(
        daos!.task,
        daos!.scheduleConfig,
        sse,
      )
      const schedulerService = new SchedulerService(
        daos!.scheduleConfig, daos!.scheduleRun, sse, scheduleStatusListener,
      )
      const dashboardService = new DashboardService(daos!.scheduleConfig, daos!.scheduleRun)
      const exportService = new ExportService(daos!.scheduleConfig)
      app.route('/api/scheduler', createSchedulerRoutes(schedulerService, dashboardService, exportService, daos!.agentSession))
      ;(global as any).__octopus_scheduler_service = schedulerService

      // ★ Initialize Tasks Service (always available, not gated by feature flag)
      // 03: first-class tasks domain — /api/tasks CRUD + spec-field + ready
      // (dispatch seam) + abort + /events SSE.
      // 04: TaskHomeService + PluginMaterializer injected so a v3 task creation
      // (task_type set) materializes the per-task plugin dir (ADR-0010). The
      // materializer wraps the global ResourceManager singleton (registry is the
      // source of truth for skill groups, D3). /api/skill-groups is the
      // template-page data source (registry skill aggregation + default marker).
      // 07: assist-workflow routes (POST/GET /:id/assist-workflows) — service
      // owns temp-workspace creation + execution trigger + output parsing.
      const taskHomeService = new TaskHomeService()
      const pluginMaterializer = new PluginMaterializer(resourceRegistry.get())
      const tasksService = new TasksService(db, sse, daos!.agentSession, taskHomeService, pluginMaterializer)
      const assistService = new AssistWorkflowService(db, sse)
      app.route('/api/tasks', createTasksRoutes(tasksService, sse, assistService))
      app.route('/api/skill-groups', createSkillGroupsRoutes(resourceRegistry.get()))
      ;(global as any).__octopus_tasks_service = tasksService

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
          scheduleStatusListener,
        ))
        executors.set('agent', new AgentExecutor(
          daos!.scheduleRun, daos!.execution, undefined,
        ))

        const schedulerEngine = new SchedulerEngine(
          daos!.scheduleConfig, daos!.scheduleRun, scheduleService, executors, sse,
          scheduleStatusListener,
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