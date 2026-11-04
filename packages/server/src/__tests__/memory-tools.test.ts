/**
 * Main-chat memory tools — unit tests.
 *
 * Seams: recordDailyToMainMemory / rememberToLongTerm / the consent detectors.
 * Keeping the write logic outside the SDK harness means these tests pin file +
 * FTS-summary + safe-mode + budget behavior without booting a provider.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"

const ROOT = path.join(os.tmpdir(), `octopus-test-memory-tools-${process.pid}`)
const HOME = path.join(ROOT, "octopus")
const AGENT_DIR = path.join(HOME, "agent")
const MEMORY_DIR = path.join(AGENT_DIR, "memory")
const DAILY_DIR = path.join(MEMORY_DIR, "daily")
const LONG_TERM = path.join(MEMORY_DIR, "long-term.md")
const CONFIG = path.join(AGENT_DIR, "config.yaml")

import { initDb, closeDb, getDb } from "../db/connection"
import { AgentSessionDAO } from "../db/dao"
import { initMemoryService } from "../services/agent/memory-service"
import { getConfigManager } from "../services/agent/config-manager"
import {
  recordDailyToMainMemory,
  rememberToLongTerm,
  resolveLongTermConsent,
  isExplicitMemoryRequest,
  isAffirmative,
  RECORD_DAILY_MAX_CHARS,
  REMEMBER_MAX_CHARS,
} from "../services/chat/memory-tools"

const ORG = "test-memory-tools"
const SESSION_ID = "sess-memory-tools"

function summaryRow(sessionId: string): { content: string; source: string } | undefined {
  return getDb()
    .prepare("SELECT content, source FROM messages WHERE session_id = ? AND is_summary = 1")
    .get(sessionId) as { content: string; source: string } | undefined
}

function setConfig(yaml: string): void {
  fs.mkdirSync(AGENT_DIR, { recursive: true })
  fs.writeFileSync(CONFIG, yaml, "utf-8")
  getConfigManager().clearCache()
}

function asciiWords(n: number): string {
  return Array.from({ length: n }, () => "word").join(" ")
}

beforeEach(() => {
  if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(DAILY_DIR, { recursive: true })
  process.env.OCTOPUS_HOME = HOME
  getConfigManager().clearCache()

  initDb(":memory:")
  const dao = new AgentSessionDAO(getDb())
  initMemoryService(dao)
  const now = new Date().toISOString()
  dao.insertSession({
    id: SESSION_ID,
    title: "main chat",
    clone_name: null,
    session_type: "main",
    created_at: now,
    updated_at: now,
  })
})

afterEach(() => {
  closeDb()
  delete process.env.OCTOPUS_HOME
  getConfigManager().clearCache()
  if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true })
})

describe("consent detection", () => {
  it.each([
    "记住：我偏好 pnpm",
    "这个很重要，帮我记下来",
    "把这条记到长期记忆里",
    "记录一下今天的进展",
    "好，记吧",
    "remember this: we use pnpm",
    "keep this in mind for next time",
  ])("explicit memory request: %s", (text) => {
    expect(isExplicitMemoryRequest(text)).toBe(true)
  })

  it.each(["今天天气怎么样？", "你还记得上次那个 bug 吗", "继续"])(
    "not an explicit request: %s",
    (text) => {
      expect(isExplicitMemoryRequest(text)).toBe(false)
    },
  )

  it.each(["要", "好。", "可以呀", "ok", "Yes!", "写吧"])("affirmative: %s", (text) => {
    expect(isAffirmative(text)).toBe(true)
  })

  it.each(["要写测试", "不好", "好的，我们继续看这个设计", "继续"])(
    "not a bare affirmative: %s",
    (text) => {
      expect(isAffirmative(text)).toBe(false)
    },
  )

  it("resolves a verdict per turn", () => {
    expect(resolveLongTermConsent("记住：我用 pnpm")).toBe("explicit")
    expect(resolveLongTermConsent("要")).toBe("affirmative")
    expect(resolveLongTermConsent("继续看看实现")).toBe("none")
  })
})

describe("record_daily (main chat)", () => {
  it("writes today's daily file + a searchable summary row (source=main)", () => {
    const res = recordDailyToMainMemory({
      org: ORG,
      sessionId: SESSION_ID,
      content: "  User prefers pnpm.  ",
    })

    expect(res.ok).toBe(true)
    expect(res.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(fs.readFileSync(path.join(DAILY_DIR, `${res.date}.md`), "utf-8")).toContain(
      "User prefers pnpm.",
    )
    expect(summaryRow(SESSION_ID)).toEqual({ content: "User prefers pnpm.", source: "main" })
  })

  it("rejects empty content without writing anything", () => {
    const res = recordDailyToMainMemory({ org: ORG, sessionId: SESSION_ID, content: "   " })

    expect(res).toEqual({ ok: false, error: "INVALID_PARAM: content is required" })
    expect(fs.readdirSync(DAILY_DIR)).toHaveLength(0)
    expect(summaryRow(SESSION_ID)).toBeUndefined()
  })

  it("rejects oversized content", () => {
    const res = recordDailyToMainMemory({
      org: ORG,
      sessionId: SESSION_ID,
      content: "x".repeat(RECORD_DAILY_MAX_CHARS + 1),
    })

    expect(res.ok).toBe(false)
    expect(res.error).toContain("content exceeds")
    expect(fs.readdirSync(DAILY_DIR)).toHaveLength(0)
  })

  it("safe mode blocks the write (daily and long-term alike)", () => {
    setConfig("safe_mode:\n  enabled: true\n")

    const daily = recordDailyToMainMemory({ org: ORG, sessionId: SESSION_ID, content: "should not land" })
    expect(daily.ok).toBe(false)
    expect(daily.error).toContain("SAFE_MODE_READONLY")

    const longTerm = rememberToLongTerm({
      org: ORG,
      sessionId: SESSION_ID,
      content: "should not land either",
      consent: "explicit",
    })
    expect(longTerm.ok).toBe(false)
    expect(longTerm.error).toContain("SAFE_MODE_READONLY")

    expect(fs.readdirSync(DAILY_DIR)).toHaveLength(0)
    expect(fs.existsSync(LONG_TERM)).toBe(false)
  })
})

describe("remember (long-term)", () => {
  beforeEach(() => {
    fs.mkdirSync(MEMORY_DIR, { recursive: true })
    fs.writeFileSync(LONG_TERM, "# 长期记忆\n\n## 偏好\n- 已有条目\n", "utf-8")
  })

  it("appends under the requested section and backs up first", () => {
    const before = fs.readFileSync(LONG_TERM, "utf-8")
    const res = rememberToLongTerm({
      org: ORG,
      sessionId: SESSION_ID,
      content: "选用 SQLite（本地优先，无需运维）",
      section: "决策",
      consent: "explicit",
    })

    expect(res.ok).toBe(true)
    expect(res.section).toBe("决策")
    const after = fs.readFileSync(LONG_TERM, "utf-8")
    expect(after).toContain("## 偏好\n- 已有条目")
    expect(after).toContain("## 决策\n- 选用 SQLite（本地优先，无需运维）")
    expect(fs.readFileSync(`${LONG_TERM}.bak`, "utf-8")).toBe(before)
    expect(res.token_count).toBeGreaterThan(0)
  })

  it("refuses without consent and does not touch the file", () => {
    const before = fs.readFileSync(LONG_TERM, "utf-8")
    const res = rememberToLongTerm({
      org: ORG,
      sessionId: SESSION_ID,
      content: "模型自己觉得值得记",
      consent: "none",
    })

    expect(res.ok).toBe(false)
    expect(res.error).toContain("NEED_USER_CONFIRMATION")
    expect(fs.readFileSync(LONG_TERM, "utf-8")).toBe(before)
    expect(fs.existsSync(`${LONG_TERM}.bak`)).toBe(false)
  })

  it("writes after the human answers yes (affirmative consent)", () => {
    const res = rememberToLongTerm({
      org: ORG,
      sessionId: SESSION_ID,
      content: "用户确认写入的条目",
      consent: "affirmative",
    })

    expect(res.ok).toBe(true)
    expect(fs.readFileSync(LONG_TERM, "utf-8")).toContain("- 用户确认写入的条目")
  })

  it("is a no-op for an exact duplicate entry", () => {
    const input = {
      org: ORG,
      sessionId: SESSION_ID,
      content: "重复条目",
      section: "通用",
      consent: "explicit" as const,
    }
    expect(rememberToLongTerm(input).ok).toBe(true)
    const afterFirst = fs.readFileSync(LONG_TERM, "utf-8")

    const second = rememberToLongTerm(input)
    expect(second.ok).toBe(true)
    expect(second.duplicate).toBe(true)
    expect(fs.readFileSync(LONG_TERM, "utf-8")).toBe(afterFirst)
    expect(afterFirst.match(/重复条目/g)).toHaveLength(1)
  })

  it("rejects oversized entries", () => {
    const res = rememberToLongTerm({
      org: ORG,
      sessionId: SESSION_ID,
      content: "x".repeat(REMEMBER_MAX_CHARS + 1),
      consent: "explicit",
    })

    expect(res.ok).toBe(false)
    expect(res.error).toContain("content exceeds")
  })

  it("refuses over-budget writes and leaves the file untouched", () => {
    setConfig("memory:\n  long_term_max_tokens: 200\n")
    const before = fs.readFileSync(LONG_TERM, "utf-8")

    const res = rememberToLongTerm({
      org: ORG,
      sessionId: SESSION_ID,
      content: asciiWords(400), // ~300 tokens
      section: "通用",
      consent: "explicit",
    })

    expect(res.ok).toBe(false)
    expect(res.error).toContain("MEMORY_BUDGET_EXCEEDED")
    expect(res.max_tokens).toBe(200)
    expect(fs.readFileSync(LONG_TERM, "utf-8")).toBe(before)
  })
})
