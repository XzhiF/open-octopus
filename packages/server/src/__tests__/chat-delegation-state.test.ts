/**
 * 委派 doer 的回合生命周期接线（2026-11-25 用户）。
 *
 * 之前委派状态只会被两件事改：AskUserQuestion / 决策转达（bridge）和
 * cabin_delegation_done（工具）。doer 如果用一条普通回复跟人说话（问问题 /
 * 交阶段结论但没调工具），回合结束后 state 永远停在 running —— 编队一直显示
 * 「作战中」，秒表空转，而会话其实已经回复了人。
 *
 * 现在由 /chat 路由驱动：回合开始 → markRunning（等你答 → 作战中）；
 * 回合收尾还没交结论 → markWaitingInput（作战中 → 等你答）。这套测试钉住
 * 三种流转：首次回合收尾、人再说话回到作战中、交结论后不被收尾覆盖。
 *
 * Anti-fake-run：真 better-sqlite3 + applySchema + 真 CabinDelegationService +
 * Hono app.request，只在 SDK 边界（getProvider）与舱视图服务上打桩。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { CabinDAO } from "../db/dao/cabin-dao"
import { CabinDelegationDAO } from "../db/dao/cabin-delegation-dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { createChatRoutes } from "../routes/agent/chat-routes"
import { initAgentService } from "../services/agent/agent-service"
import { getConfigManager } from "../services/agent/config-manager"
import { CabinDelegationService } from "../services/cabin/cabin-delegation-service"
import { setCabinToolsProvider } from "../services/chat/cabin-tools"
import * as providers from "@octopus/providers"

const ORG = "E2E_TEST_chat_delegation_state"
const SESSION = "s-doer-1"
const CABIN = "c-del"
const DELEGATION = "d-1"
const ROOT = path.join(os.tmpdir(), `chat-delegation-state-${Date.now()}`)
const HOME = path.join(ROOT, "octopus")
const CLAUDE_DIR = path.join(ROOT, "claude")
const AGENT_DIR = path.join(HOME, "agent")

let db: Database.Database
let sessionDAO: AgentSessionDAO
let delegationDAO: CabinDelegationDAO
let delegations: CabinDelegationService

function stateOf(id: string): string | undefined {
  return delegationDAO.getById(id)?.state
}

function installProvider(onBeforeResult?: () => void) {
  vi.spyOn(providers, "getProvider").mockImplementation((() => ({
    sendQuery: async function* () {
      yield { type: "text_delta", content: "好的。" }
      onBeforeResult?.()
      yield { type: "result", content: "好的。", sessionId: "sdk-del-1" }
    },
  })) as never)
}

function app() {
  const a = new Hono()
  a.route(
    "/api/agent",
    createChatRoutes({
      sessionDAO,
      safetyDAO: { insertSafetyEvent: vi.fn() } as never,
      scheduleConfigDAO: {} as never,
      tokenUsageDao: new TokenUsageDAO(db),
    }),
  )
  return a
}

function chat(message: string) {
  return app().request(`/api/agent/sessions/${SESSION}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ message }),
  })
}

function insertSession(id: string, cabinId: string | null) {
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id,
    title: "D · 委派",
    clone_name: null,
    session_type: "main",
    cabin_id: cabinId,
    created_at: now,
    updated_at: now,
  })
}

function insertDelegation(delegationId: string, doerSessionId: string) {
  const now = new Date().toISOString()
  delegationDAO.insert({
    id: delegationId,
    cabin_id: CABIN,
    title: "项目 wiki 迁移",
    intent_text: "把项目 wiki 整理进全局知识中心",
    brief: null,
    autonomy: "checkpoint",
    state: "running",
    doer_session_id: doerSessionId,
    result_summary: null,
    created_at: now,
    updated_at: now,
    ended_at: null,
  })
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  sessionDAO = new AgentSessionDAO(db)
  delegationDAO = new CabinDelegationDAO(db)
})

beforeEach(() => {
  fs.mkdirSync(path.join(AGENT_DIR, "memory"), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "experiences"), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "skills"), { recursive: true })
  fs.mkdirSync(path.join(CLAUDE_DIR, "projects"), { recursive: true })
  process.env.OCTOPUS_HOME = HOME
  process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR
  getConfigManager().clearCache()

  for (const table of [
    "messages", "sessions", "session_prompt_snapshots", "session_expert_rosters",
    "session_role_states", "llm_calls", "cabin_delegations",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run()
  }

  installProvider()
  initAgentService(sessionDAO, { insertSafetyEvent: vi.fn() } as never)

  // 真委派服务（状态迁移是真的落库）；舱视图 / 唤醒走空壳 —— 路由只用到
  // notifyViewChanged，buildCabinSummaryReminder 自带 try/catch 会静默降级。
  delegations = new CabinDelegationService({
    cabin: new CabinDAO(db),
    delegations: delegationDAO,
    service: {
      notifyViewChanged: vi.fn(),
      getView: () => { throw new Error("no cabin in this test") },
      listWorkView: () => [],
    } as never,
    comm: {} as never,
  })
  setCabinToolsProvider(() => ({
    service: {
      notifyViewChanged: vi.fn(),
      getView: () => { throw new Error("no cabin in this test") },
      listWorkView: () => [],
    },
    comm: {},
    delegations,
  }) as never)
})

afterEach(() => {
  setCabinToolsProvider(null)
  delete process.env.OCTOPUS_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  vi.restoreAllMocks()
})

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* non-fatal */
  }
  db.close()
})

describe("委派 doer 的回合 → 状态机", () => {
  it("回合收尾未交结论 → 等你答；人再说话 → 回合中回到作战中", async () => {
    insertSession(SESSION, CABIN)
    insertDelegation(DELEGATION, SESSION) // 初始 running

    // 第一轮：doer 普通回复（没调交结论工具）→ 状态从 running 落到 waiting_input。
    await (await chat("继续")).text()
    expect(stateOf(DELEGATION)).toBe("waiting_input")

    // 人再说话：回合开始必须把状态拉回 running（编队回「作战中」），收尾再回等你答。
    const seenDuringTurn: string[] = []
    const realMarkRunning = delegations.markRunning.bind(delegations)
    vi.spyOn(delegations, "markRunning").mockImplementation((id: string) => {
      realMarkRunning(id)
      seenDuringTurn.push(`${id}:${stateOf(id)}`)
    })

    await (await chat("按表执行")).text()
    expect(seenDuringTurn).toEqual([`${DELEGATION}:running`])
    expect(stateOf(DELEGATION)).toBe("waiting_input")
  })

  it("doer 调了 cabin_delegation_done（done）→ 收尾不再把状态改回等你答", async () => {
    insertSession(SESSION, CABIN)
    insertDelegation(DELEGATION, SESSION)
    // 模拟回合内工具调用：provider 在 result 之前交结论。
    vi.restoreAllMocks()
    installProvider(() => { delegations.finish(DELEGATION, "结论：已迁移", true) })

    await (await chat("收尾")).text()

    expect(stateOf(DELEGATION)).toBe("done")
    expect(delegationDAO.getById(DELEGATION)?.ended_at).toBeTruthy()
  })

  it("普通会话（不是委派 doer）不碰委派状态机", async () => {
    insertSession(SESSION, null)
    insertDelegation(DELEGATION, "s-other")

    const running = vi.spyOn(delegations, "markRunning")
    const waiting = vi.spyOn(delegations, "markWaitingInput")

    await (await chat("随便聊聊")).text()

    expect(running).not.toHaveBeenCalled()
    expect(waiting).not.toHaveBeenCalled()
    expect(stateOf(DELEGATION)).toBe("running")
  })
})
