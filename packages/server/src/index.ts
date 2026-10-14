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
  TaskDAO, WikiArticleDAO,
} from "./db/dao"
import { ArchiveDraftDAO } from "./db/dao/archive-draft-dao"
import { InteractionMessageDAO } from "./db/dao/interaction-message-dao"
import { AgentVersionDAO } from "./db/dao/agent-version-dao"
import { HarnessDAO } from "./db/dao/harness-dao"
import { createIngestRoutes } from "./routes/ingest"
import { createKnowledgeReadRoutes } from "./routes/knowledge-read"
import { RawIngestService } from "./services/knowledge/raw"
import { createWikiCompileRoutes } from "./routes/wiki-compile"
import { createWikiPackRoutes } from "./routes/wiki-pack"
import { MaterialPackOpsService } from "./services/knowledge/pack-ops"
import type { KcMaterialPackCardData } from "@octopus/shared"
// P3 票03：判例自动提取+入档（case-archive 第八类 opKind + 判例卡 + 退役路由）
import { CaseExtractService } from "./services/knowledge/case-extract-service"
import { createProductionCaseExtractor } from "./services/knowledge/case-extract-llm"
import { createWikiCaseRoutes } from "./routes/wiki-case"
import type { KcCaseCardData } from "@octopus/shared"
import { createWikiRevertRoutes } from "./routes/wiki-revert"
import { RevertTaskService } from "./services/knowledge/wiki/revert"
import { createCompileQueueRoutes } from "./routes/wiki-queue"
import { CompileQueue } from "./services/knowledge/wiki/compile-queue"
import { WikiLock } from "./services/knowledge/wiki/wiki-lock"
import { resolveGlobalWikiRoot, resolveGlobalKnowledgeRoot } from "./services/knowledge/global-paths"
import { CuratorCompileService } from "./services/knowledge/wiki/curator"
import { CuratorTaskService } from "./services/knowledge/wiki/curator-task"
import { createProductionCuratorLLM } from "./services/knowledge/wiki/curator-llm"
import { WikiPatrolService } from "./services/knowledge/patrol"
import { knowledgePatrolHandlerFor, createKnowledgeSessionReporter, appendKnowledgeSessionCards } from "./services/knowledge/patrol-job"
import { FindingOpsService } from "./services/knowledge/findings"
import { BackfillService } from "./services/knowledge/backfill"
import { createFindingsRoutes } from "./routes/findings"
import { ArchiveIngestService } from "./services/tasks/archive-ingest-service"
import { createProductionArchiveSummarizer } from "./services/tasks/archive-ingest-llm"
import { createWikiRoutes } from "./routes/wiki"
import { createWikiMigrateRoutes } from "./routes/wiki-migrate"
import { createWikiGlobalMoveRoutes } from "./routes/wiki-global-move"
import { WikiGlobalMigrator } from "./services/knowledge/wiki/global-move"
import { createWikiRedistillRoutes } from "./routes/wiki-redistill"
import { WikiRedistillMigrator } from "./services/knowledge/wiki/redistill"
import { InitialCompileMigrator } from "./services/knowledge/wiki/migrate"
import { createReviewRoutes } from "./routes/review"
import { createArchiveRoutes } from "./routes/archive"
import { createResourceRoutes } from "./routes/resource"
import { getResourceRegistry } from "./services/resource-registry"
import { ReviewService } from "./services/knowledge/review"
import { createProductionRuleFormJudge } from "./services/knowledge/wiki/rule-form-judge"
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
import { eventRoutes } from "./routes/events"
import scheduleRoutes, { setScheduleService } from "./routes/schedule"
import { createSchedulerRoutes } from "./routes/scheduler"
import { createTasksRoutes } from "./routes/tasks"
import { createTaskChatRoutes } from "./routes/task-chat"
import { TaskDoerService } from "./services/tasks/task-doer-service"
import { RoundEvidenceService } from "./services/tasks/round-evidence-service"
import { TestInstanceRegistry } from "./services/tasks/test-instance-registry"
import { createWorkflowPresetsRoutes } from "./routes/workflow-presets"
import { createSkillGroupsRoutes } from "./routes/skill-groups"
import { createAgentRoutes } from "./routes/agent"
import { createCloneSessionRoutes } from "./routes/clone"
import { finalizeOrphanStreamPartials } from "./routes/clone/stream-partials"
import { createCloneFilesRoutes } from "./routes/agent/clone-files"
import { createVersionRoutes, createMainAgentVersionRoutes } from "./routes/agent/version-routes"
import cronRoutes from "./routes/cron"
import { createInteractionRoutes } from "./routes/interaction"
import { createWorkflowOpsRoutes } from "./routes/workflow-ops"
import { InteractionService } from "./services/interaction"
import { SSEService } from "./services/sse"
import { RepoSyncService } from "./services/tasks/repo-sync-service"
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
import { TasksService } from "./services/tasks/tasks-service"
import { TaskHomeService } from "./services/tasks/task-home-service"
import { PluginMaterializer } from "./services/tasks/plugin-materializer"
import { AssistWorkflowService } from "./services/tasks/assist-workflow-service"
import { WorkflowPresetsService } from "./services/workflow-presets-service"
import { BuiltInWorkflowService } from "./services/builtin-workflow"
import { WorkflowExecutor } from "./services/scheduler/executors/workflow-executor"
import { AgentExecutor } from "./services/scheduler/executors/agent-executor"
import { CodeJobExecutor } from "./services/scheduler/executors/code-job-executor"
import { registerAndSeedBuiltinCodeJobs } from "./services/scheduler/builtin-jobs"
import { taskLifecycleHandlerFor } from "./services/tasks/task-lifecycle-service"
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
import { initAgentVersionService, publishVersionedBuiltinClones } from "./services/agent/agent-version-service"
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
  wikiArticle: WikiArticleDAO
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
    wikiArticle: new WikiArticleDAO(db),
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
// repo-sync (2026-09-08, 特性A): 项目镜像同步状态机 —— createTask 触发同步、
// task-author chat 新鲜度门、trigger 预建前等待都吃这一个实例（进程内，无 DB）。
const repoSyncService = new RepoSyncService({ sse })

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
  initSessionCompressService(daos.agentSession, daos.tokenUsage)
  initAgentService(daos.agentSession, daos.safety)

  // "关闭不丢失" stream-resume: sweep orphan streaming partials left by a
  // crash/restart mid-turn (finalize them as interrupted). Runs before any
  // route can register a stream, so every streaming row found is an orphan.
  try { finalizeOrphanStreamPartials(daos.agentSession) } catch (err) {
    console.error('[startup] orphan stream-partial sweep failed (non-fatal):', err)
  }

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
    // LLM-WIKI 票 09: built-in clones marked config.versioned (workflow-operator)
    // get their initial agent_versions publish right after the dual-track landing,
    // so the existing octopus_agent snapshot resolution (VersionResolver over
    // listAllPublished, set above) can resolve 'latest' / pinned identities.
    // Idempotent + non-fatal (see publishVersionedBuiltinClones).
    const seeded = publishVersionedBuiltinClones(daos.agentVersion)
    if (seeded.length > 0) {
      console.log(`[server] versioned built-in clones published: ${seeded.join(', ')} at ${'1.0.0'}`)
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
  wikiArticle: lazyDAO(WikiArticleDAO),
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
    initSessionCompressService(d.agentSession, d.tokenUsage)
    initAgentService(d.agentSession, d.safety)
    try { initAgentVersionService(d.agentVersion) } catch { /* ignore */ }
    setAgentAuthOrgDAO(d.org)
    setYjsWorkspaceDAO(d.workspace)
    try { initArchiveService(d.archive, d.execution, getDb(), getDomainEventBus()) } catch { /* db not ready yet */ }
    try { setHarnessDependencies(d.harness) } catch { /* db not ready yet */ }
  } catch { /* ignore */ }
}

app.route("/api/orgs", createOrgRoutes(d.org))
app.route("/api/workspaces", createWorkspaceRoutes(wsSvc, d.org, d.workspace, d.execution))
app.route("/api/workspaces/:id/workflows", createWorkflowOpsRoutes(d.workspace))
app.route("/api/workspaces/:id/workflows", createWorkflowRoutes(d.workspace, () => resourceRegistry.get()))
app.route("/api/workspaces/:id/executions", executionRoutes)
app.route("/api/workspaces/:id/harness", harnessRoutes)
app.route("/api/workspaces/:id/analytics", createAnalyticsLogRoutes(d.workspace, getLogAnalysisService({ tokenDao: d.tokenUsage, execDao: d.execution }) ?? new (require('./services/log-analysis').LogAnalysisService)(d.tokenUsage, d.execution)))
app.route("/api/dashboard", createDashboardRoutes(wsSvc, lbSvc, d.execution, d.tokenUsage, d.archive))
app.route("/api/workspaces/:id/chat", chatRoutes(sse, chatSvc, wsSvc))
app.route("/api/chat/global", globalChatRoutes(sse, chatSvc, d.tokenUsage))
app.route("/api/workspaces/:id/interactions", createInteractionRoutes(interactionSvc, d.workspace, d.execution))
app.route("/api/workspaces/:id/files", createFileRoutes(d.workspace))
app.route("/api/workspaces/:id/events", eventRoutes(sse))
app.route("/api/workspaces/:id/schedules", scheduleRoutes)
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
  // billing-coverage-2 票03: Main Agent 统一入口/委托链入账。
  tokenUsageDao: d.tokenUsage,
}))

// Clone session routes — direct entry for Web UI pages
app.route("/api/clones", createCloneSessionRoutes({
  sessionDAO: d.agentSession,
  // 04: task-author autosave seam (v2-D6) — fires at turn-end for
  // cloneName === 'task-author'. Optional dep; no-op when absent.
  taskDAO: d.task,
  // repo-sync chat 门 (2026-09-08): v4 task-author 每轮开工前等待项目镜像同步。
  repoSyncService,
  // billing-coverage-2 票02: 分身聊天入账 —— result chunk 经共用落账 helper 写 llm_calls。
  tokenUsageDao: d.tokenUsage,
}))

// Clone file tree and operations API
app.route("/api", createCloneFilesRoutes())

// Agent version management API
app.route("/api/clones", createVersionRoutes())
app.route("/api/agents/main", createMainAgentVersionRoutes())

app.route("/api/workflows/built-in", createBuiltInWorkflowRoutes(() => resourceRegistry.get()))

// Knowledge system routes — org is resolved per-request from the query
// string (`?org=<name>`), so the server no longer pins a default org.
// 知识中心票09（spec「审批废除与写入闸门」）：审批链 server 侧全删——'wiki-split'/
// 'wiki-edit'/词条形态 'rule' 的策展分发与 WikiCurateService/WikiSplitService 执行器、
// auto_approve 概念全部物理删除（「人批入库」轨废除）。pending_review **表本体保留**
// 给 skill 草案等非 wiki 用途（物理清表属 P3），/api/review 只剩状态结案流转；
// 对话驱动编译轨（票12，走 compile-queue 唯一写闸）与此无关、互不侵犯。
// L6 生产编译时判定（spec §增长约束 L6：warn + 给改写稿，非阻塞）：
// knowledge/llm 的 callHaiku 适配器——离线/禁用 ⇒ 零 issues（rule-form-judge.ts 双保险）。
const ruleFormJudge = createProductionRuleFormJudge()

const reviewService = new ReviewService(d.pendingReview)
// 知识中心票02/05：投喂通道（URL 抓取/粘贴/本地文件 → raw 落盘即冻结）。
// 落 raw 本身不入队（spec §全局写串行语义）；`?compile=true` 显式开启票05 编译投递，
// 投喂成功后返回 compileTask 回执（异步任务：queued→compiling→committed/failed）。
// 知识中心票05：策展编译管线 CuratorCompileService.compileRaw = 单次编译原子入口
// （SCHEMA 必读→raw 全文→LLM 抽取→多页编译单 commit→矛盾 finding 只产不裁）。
// 知识中心票06：全局写串行两级机制落位——进程内 FIFO 编译队列（唯一写闸整包）
// + wiki 根锁文件（跨进程保底，PID+心跳）。一切 wiki 写操作统一
// `wikiWriteQueue.enqueue(opKind, fn)`（kind 单源 compile-queue.WRITE_OP_KINDS：
// 投喂/归档/对话修订/lint 自纠/finding 修复/revert/重蒸馏；票07/10/12/13 经此入队，
// 旁路写 wiki = 违规）。队列深度进健康条（queueDepth，票11 冻结形状只换值）。
const wikiWriteQueue = new CompileQueue({
  lock: new WikiLock({ wikiRoot: () => resolveGlobalWikiRoot() }),
})
const curatorTasks = new CuratorTaskService({
  queue: wikiWriteQueue,
  run: async (rawPath) => {
    const curator = new CuratorCompileService({ db: getDb(), llm: createProductionCuratorLLM() })
    return curator.compileRaw(curator.resolveRawPointer(rawPath))
  },
})
const ingestCompileTrigger = (rawPath: string): { taskId: string; status: string } => {
  const task = curatorTasks.submit(rawPath)
  return { taskId: task.id, status: task.status }
}
// 知识中心票13：语义巡检（五查 findings）+ 裁决即编译（finding-fix 经全局队列）+ 回填。
// patrol 单例供 ①即时触发（POST /api/knowledge/patrol）②夜巡作业 handler ③路由列表同源。
// db 依赖面**惰性构造**（票14 代修 revertTasks 同轨教训：顶层 new …({db: getDb()}) 在
// initDb() 前 import 即崩 import 级测试）。
let knowledgePatrolInstance: WikiPatrolService | undefined
const getKnowledgePatrol = () => (knowledgePatrolInstance ??= new WikiPatrolService({ db: getDb() }))
let findingOpsInstance: FindingOpsService | undefined
const getFindingOps = () => (findingOpsInstance ??= new FindingOpsService({
  db: getDb(),
  queue: wikiWriteQueue,
  llm: createProductionCuratorLLM(),
  // Lane A 回执：裁决即编译完成后 finding 卡终态 + diff 卡跟随，沉淀进知识中心会话
  reportReceipt: (events, finding) => {
    appendKnowledgeSessionCards(getDb(), `✅ finding 裁决回执（采纳修订已编译）：${finding.title} → resolved`, events)
  },
}))
const knowledgeBackfill = new BackfillService({ trigger: ingestCompileTrigger })
app.route("/api/knowledge", createIngestRoutes(new RawIngestService(), ingestCompileTrigger))
// 知识中心票05：编译任务 API（POST /compile 显式触发 + GET /compile/task/:id 状态可查）。
app.route("/api/knowledge/wiki", createWikiCompileRoutes(curatorTasks))
// P3 票02：素材包路由——GET /pack/:taskId（manifest 件清单视图 + 旧单文件 legacy 兼容读）；
// POST /pack/:taskId/recompile（剔除某件/焦点指令 → 全局串行队列 archive-compile 重编译，
// 禁直写 wiki 红线2；剔除=人裁素材源不是审批红线3）。db 面惰性（curator 在队列内构造）。
const packOps = new MaterialPackOpsService({
  root: resolveGlobalKnowledgeRoot(),
  queue: wikiWriteQueue,
  compilePack: async (taskId, opts) => {
    const curator = new CuratorCompileService({ db: getDb(), llm: createProductionCuratorLLM() })
    return curator.compilePack(taskId, opts ?? {})
  },
})
app.route("/api/knowledge/wiki", createWikiPackRoutes(packOps))
// P3 票03：判例自动提取+入档。CaseExtractService（惰性 db 构造，getFindingOps 同轨）：
// 归档链第⑤步读素材包（exec-jsonl-excerpt/phase-rejections）产五段草案 →
// **case-archive 第八类 opKind 入全局串行队列**（红线2 判例唯一写通道）→ 编译进
// cases/ 后判例卡经 Lane A 沉淀知识中心会话（先存后知，红线3 无审批态）。
// POST /case/retire：退役钮执行面（superseded 仍经同一 case-archive 队列通道）。
let caseExtractInstance: CaseExtractService | undefined
const getCaseExtract = () => (caseExtractInstance ??= new CaseExtractService({
  db: getDb(),
  queue: wikiWriteQueue,
  extract: createProductionCaseExtractor(),
  announceCase: (event) => {
    const d = event.data as KcCaseCardData
    appendKnowledgeSessionCards(
      getDb(),
      `⚖️ 判例${d.action === "retired" ? "退役" : d.action === "merged" ? "并档" : "自动入档"}：${d.symptom}（occurrences=${d.occurrences} · ${d.path} · 事后纠通道=对话退役/改写）`,
      [event],
    )
  },
}))
app.route("/api/knowledge/wiki", createWikiCaseRoutes({
  retireCase: (caseId) => getCaseExtract().retireCase(caseId),
}))
// 知识中心票12：回滚 API（POST /revert → 全局队列 opKind="revert" → git revert 单
// commit + INDEX/LOG/FTS 重同步 + LOG revert 行；GET /revert/task/:id 状态可查）。
// 票14 merger 代修（票12 集成红）：原顶层 new RevertTaskService({ db: getDb() … })
// 在 initDb() 前 import 即抛 "Database not initialized"（崩 7 个 import 级测试）；
// 改惰性构造——首次 revert 请求才 new，与下方迁移器工厂（(apply)=>new …）同轨。
let revertTasksInstance: RevertTaskService | undefined
const getRevertTasks = () => (revertTasksInstance ??= new RevertTaskService({ db: getDb(), queue: wikiWriteQueue }))
app.route("/api/knowledge/wiki", createWikiRevertRoutes({
  revert: (commit) => getRevertTasks().revert(commit),
  get: (id) => getRevertTasks().get(id),
}))
// 知识中心票06：队列可观测 API（GET /queue 深度+每任务位次 #N、GET /queue/task/:id）——
// UI 票12「排队中 #N → 编译中 → 已提交」卡片消费面；只读。
app.route("/api/knowledge/wiki", createCompileQueueRoutes(wikiWriteQueue))
// 知识中心票11：/knowledge 读面最小补口——raw 列表/单文件（穿越拒绝）、LOG 时间线、
// 健康条聚合（页数按类/raw 源数/本周 ingest/队列深度=票06 实值/findings=票13 实值/
// 最近编译/git HEAD，无「待审核」字段；只换值不换形）。
app.route("/api/knowledge", createKnowledgeReadRoutes({ articles: d.wikiArticle }, {
  getQueueDepth: () => wikiWriteQueue.depth(),
  getOpenFindings: () => getFindingOps().countOpen(),
}))
// 知识中心票13：findings 列表/裁决 API（adopt/ignore/fix-task）+ 即时体检（POST /patrol）
// + 回填（POST /backfill）。[讨论]=纯对话零端点。
app.route("/api/knowledge", createFindingsRoutes({
  ops: {
    list: status => getFindingOps().list(status),
    get: id => getFindingOps().get(id),
    ignore: id => getFindingOps().ignore(id),
    adopt: id => getFindingOps().adopt(id),
    getTask: id => getFindingOps().getTask(id),
  },
  patrolNow: () => getKnowledgePatrol().patrol(),
  backfill: input => knowledgeBackfill.backfill(input),
}))
app.route("/api/review", createReviewRoutes(reviewService, d.pendingReview))

// Archive routes — execution result summarization + rule proposal
const stateDir = path.join(process.env.HOME ?? "~", ".octopus", "state")
app.route("/api/archive", createArchiveRoutes(d.pendingReview, stateDir, d.archive, d.archiveDraft))

// LLM-WIKI 票01: wiki 只读 API（tree/article；search 属票03）。写路径唯一入口 = WikiCompileService。
// 知识中心票03：org 参数容错保留，DB 语义钉 'global'；fs 读搬家窗口兼容（见 routes/wiki.ts）。
app.route("/api/knowledge/wiki", createWikiRoutes(d.wikiArticle))
// 知识中心票03: wiki 全局化搬家命令（单入口幂等，真数据唯一执行面）。默认 dry-run 列计划，
// ?apply=true 才动手（顺序：wiki 连 .git 搬家 → DB re-key/FTS 重建 → 偏好归档+知识根迁入）。
// 真跑前主控按报告 backupHint 先 VACUUM INTO 备份；两步各自 git/备份可回滚。
app.route("/api/knowledge/wiki", createWikiGlobalMoveRoutes(
  (apply) => new WikiGlobalMigrator({ db: getDb(), apply }),
))
// 知识中心票07: v2→v3 重蒸馏迁移命令（单入口幂等，真数据唯一执行面）。默认 dry-run 列映射计划，
// ?apply=true 才动手（写 v3 五类页/旧页整迁 _retired/v2/ + LOG 换行格式 + INDEX 重建 + DB re-key，
// 全部落盘收口为一个 git commit，整体 revert 可还原；重跑 diff 为空）。
// 前置 = 票03 真搬家已执行（全局根 + org 钉 global）；真跑前主控按报告 backupHint 先 VACUUM INTO 备份。
// 票06 写串行：apply 经全局 FIFO 队列 kind "redistill" 入队 + wiki 根锁（dry-run 零写盘不入队）。
app.route("/api/knowledge/wiki", createWikiRedistillRoutes(
  (apply) => new WikiRedistillMigrator({ db: getDb(), apply, queue: wikiWriteQueue }),
))
// LLM-WIKI 票05: 初始编译迁移命令（幂等、可重跑；每源文件一个独立 commit，
// 全部写入仍经唯一闸门 compileEntry）。glossaryPath 可选覆盖 GLOSSARY-MAP.md 源。
app.route("/api/knowledge/wiki", createWikiMigrateRoutes(
  (org, opts) => new InitialCompileMigrator({ db: getDb(), org, glossaryMapPath: opts.glossaryMapPath, ruleFormJudge }),
))
// 知识中心票09：LLM-WIKI 票07 蒸馏路由（POST /distill → pending_review wiki-edit 候选）
// 随审批链全删——候选的落盘面（approveItem→curate）已物理删除，入队即死档。
// v2→v3 换代由票07 重蒸馏（/wiki/redistill）承接；新素材入库走 /knowledge 投喂编译。

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

    // keep-alive 竞态加固（2026-09-09「Failed to fetch」修复）：Node 默认
    // keepAliveTimeout=5s 短于浏览器（Chrome ~60s）的空闲连接保留窗 —— 服务端先
    // FIN 关掉池内连接、浏览器恰把新请求派到这条连接时拿到 RST，fetch 直接
    // reject "Failed to fetch"（SpecPanel 的 batch-tree 风暴最先中招）。令
    // 服务端空闲窗大于浏览器侧（70s），永不出现「先关的一方」竞态。
    // headersTimeout 必须 > keepAliveTimeout（Node 校验）。
    server.keepAliveTimeout = 70_000
    server.headersTimeout = 75_000

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

      // 测试实例 startup sweep（2026-09-24 实例注册协议）：清点重启前遗留的
      // 存活测试实例（~/.octopus/instances/）。只标记不自动杀 —— up 本就是
      // detached 设计，"用户故意留着继续验"与"残留待收尸"无法安全区分；
      // 任务验收面板（GET /api/tasks/:id/instances）提供一键回收。
      try {
        const instanceRegistry = new TestInstanceRegistry()
        let liveInstances = 0
        for (const t of instanceRegistry.listTaskIds()) {
          liveInstances += instanceRegistry.listEntries(t).filter((e) => e.status === "alive").length
        }
        if (liveInstances > 0) {
          console.log(`[server] Startup sweep: ${liveInstances} 个存活测试实例（可能来自重启前）— 任务验收面板可回收`)
        }
      } catch (err: unknown) {
        console.warn("[server] instance startup sweep failed:", err instanceof Error ? err.message : err)
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
      // 票03 (ADR-0021): the TaskScheduleStatusListener and its three injection points
      // are gone. Its whole job was mirroring a schedule row's status onto the parent
      // task's status — a translation that existed only because a task HAD a schedule
      // row. Task status is now written by the task-lifecycle job that owns the runs;
      // a job's status stays a job's business.
      const schedulerService = new SchedulerService(
        daos!.scheduleConfig, daos!.scheduleRun, sse,
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
      // task-workflow-handoff (ADR-0013): BuiltInWorkflowService for the
      // workflow_ref resolver (bind/ready/view). Wraps the global registry so
      // the resolution set = installed built-ins ∪ task-home workflows/.
      const builtInWorkflowService = new BuiltInWorkflowService(resourceRegistry.get())
      const tasksService = new TasksService(
        db, sse, daos!.agentSession, taskHomeService, pluginMaterializer, builtInWorkflowService,
        // repo-sync + trigger-prebuild (2026-09-08): 尾参装配 —— 镜像同步状态机
        // 与 workspace 单例（触发执行当场建 workspace+worktree 用）。
        repoSyncService, workspaceService,
      )
      // 知识中心票10 建链，P3 票02 升级素材包链：task 进入 archiving 态即组包
      // （raw/archives/task-{id}/ 六件+manifest，件级冻结契约同票02）→ 总结读包 →
      // 编译读包（manifest 先行按需下钻）经票06 全局串行队列（kind=archive-compile，
      // 状态可查 GET /api/knowledge/wiki/queue/task/arc-{id}）。素材包卡经 Lane A
      // 沉淀进知识中心会话（appendKnowledgeSessionCards 先例；无会话诚实降级）。
      // P3 票03 第⑤步：素材包冻结+入队后判例提取（读包内 exec-jsonl-excerpt/
      // phase-rejections 产五段草案，case-archive 队列入档，判例卡先存后知）。
      // 失败不阻塞 done：投喂链与 K11 归档编排正交（beginArchiving fire-and-forget）。
      const archiveIngest = new ArchiveIngestService({
        db,
        taskHomeService,
        rawIngest: new RawIngestService(),
        queue: wikiWriteQueue,
        compilePack: async (taskId, opts) => {
          const curator = new CuratorCompileService({ db: getDb(), llm: createProductionCuratorLLM() })
          return curator.compilePack(taskId, opts ?? {})
        },
        summarize: createProductionArchiveSummarizer(),
        extractCases: (taskId) => getCaseExtract().extractAndEnqueue(taskId),
        announcePack: (event) => {
          const d = event.data as KcMaterialPackCardData
          appendKnowledgeSessionCards(
            getDb(),
            `📦 归档素材包 task-${d.taskId}（${d.items.length} 件已冻结入 raw，含 hash 可对质；编译已入串行队列，可逐件剔除重编译）：`,
            [event],
          )
        },
      })
      tasksService.setArchiveIngestHook((taskId) => {
        void archiveIngest.ingestTask(taskId)
      })
      const assistService = new AssistWorkflowService(db, sse)
      // 验货台 (acceptance v2)：实物 round-diff + 当场复检 — 4th optional arg
      // (tests that build the route factory without it get 501 on those 5 endpoints).
      const roundEvidence = new RoundEvidenceService(db, sse, tasksService, workspaceService!, taskHomeService)
      // taskboard-modal-v2 票01 (ADR-0025, S1): the task-level doer chat seam —
      // GET/POST /api/tasks/:id/chat (+ the /chat/messages alias from the spec
      // wording). Separate route factory on the same prefix; all behavior lives in
      // TaskDoerService (lazy doer session + ws-chat relay + [quick-edit] commits).
      const taskDoerService = new TaskDoerService({
        db, sse, tasksService,
        chatService: chatSvc,
        workspaceService: wsSvc,
        taskHomeService,
      })
      // 票08: takeover 聚合端点的会话就绪半（5th optional arg —— ensureSession 单源
      // 仍是 TaskDoerService，这里只是把它接到 tasks 路由上）。
      app.route('/api/tasks', createTasksRoutes(tasksService, sse, assistService, roundEvidence, taskDoerService))
      app.route('/api/tasks', createTaskChatRoutes(taskDoerService))
      // task-workflow-presets (T3): preset catalog API
      const workflowPresetsService = new WorkflowPresetsService()
      app.route('/api/workflow-presets', createWorkflowPresetsRoutes(() => workflowPresetsService))
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
        ))
        executors.set('agent', new AgentExecutor(
          daos!.scheduleRun, daos!.execution, undefined,
        ))
        // ADR-0021: third job type — a registered TypeScript handler, for the system's
        // own periodic duties. Seeded rows must exist before start(), so the first tick
        // never resolves a built-in job to a missing handler.
        executors.set('job', new CodeJobExecutor(daos!.scheduleRun))
        // The composition root is the ONLY place the two domains meet: it hands the
        // built-in job's handler (task domain) to the scheduler's registry, so the
        // scheduler fires task lifecycle code without ever importing the task domain.
        const seeded = registerAndSeedBuiltinCodeJobs(
          daos!.scheduleConfig,
          '',
          taskLifecycleHandlerFor(tasksService.taskLifecycle),
          // 票13：知识夜巡（五查 findings 报对话）——与 task-lifecycle 同款组合根注入，
          // scheduler 不 import 知识域
          knowledgePatrolHandlerFor(getKnowledgePatrol(), { report: createKnowledgeSessionReporter(getDb()) }),
        )
        if (seeded.created.length || seeded.repaired.length) {
          console.log(
            `[scheduler] built-in jobs: ${seeded.created.length} created, ${seeded.repaired.length} repaired`,
          )
        }

        const schedulerEngine = new SchedulerEngine(
          daos!.scheduleConfig, daos!.scheduleRun, scheduleService, executors, sse,
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
        // 票03: the task domain no longer needs the engine's wake() — triggering a task
        // arms and claims through the lifecycle job synchronously, so a user pressing
        // 触发 never waits on a cron minute. wake() stays for the scheduler's own rows.
        ;(global as any).__octopus_scheduler = schedulerEngine
        ;(global as any).__octopus_schedule_service = scheduleService
        const jobCount = schedulerEngine['cronJobs']?.size ?? 0
        // Three types now, and the parenthetical used to name two — which read as "the
        // built-in task-lifecycle row isn't one of these" to whoever debugs a boot.
        console.log(`[scheduler] Started with ${jobCount} active cron jobs (workflow / agent / job)`)
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