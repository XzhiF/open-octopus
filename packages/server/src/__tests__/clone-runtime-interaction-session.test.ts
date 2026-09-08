// packages/server/src/__tests__/clone-runtime-interaction-session.test.ts
//
// CloneRuntime.sendWithProvider 必须给 provider 传 interactionSession: true
// （2026-09-09 修复）：缺省时 canUseTool 走 default-allow，AskUserQuestion 被
// SDK 在 headless 下"执行"成 input 原样回显 —— 模型把自己的问题当用户答案，
// 同一轮继续输出，Web 端无从作答。真 CloneRuntime + mock @octopus/providers
// 捕获 sendQuery options；HOME 指到临时目录隔离 ensureDirectories 的 mkdir。

import { describe, it, expect, beforeAll } from "vitest"
import { vi } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"

const homeTmp = path.join(os.tmpdir(), `octopus-aq-runtime-home-${Date.now()}`)

const captured = vi.hoisted(() => ({
  opts: null as Record<string, unknown> | null,
}))

vi.mock("@octopus/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octopus/providers")>()
  return {
    ...actual,
    getProvider: () => ({
      getType: () => "claude",
      sendQuery: (_p: string, _cwd: string, _resume: string | undefined, opts: Record<string, unknown>) => {
        captured.opts = opts
        return (async function* () {
          yield { type: "result", sessionId: "fake" }
        })()
      },
    }),
  }
})

import { CloneRuntime } from "../services/agent/clone-runtime"

beforeAll(() => {
  process.env.HOME = homeTmp
  process.env.USERPROFILE = homeTmp
})

describe("CloneRuntime → provider interactionSession", () => {
  it("sendQuery options 携带 interactionSession: true（AskUserQuestion 拦截开启）", async () => {
    const runtime = new CloneRuntime(
      {
        name: "e2e-aq-clone",
        displayName: "E2E AQ",
        type: "user",
        persona: "",
        skills: [],
        memoryScope: "isolated",
        config: {},
      } as never,
      "e2e-aq",
    )
    for await (const _chunk of runtime.chat("hello", "s-1", null, homeTmp)) void _chunk

    expect(captured.opts, "sendQuery 应被调用").not.toBeNull()
    expect(captured.opts!.interactionSession).toBe(true)
  })

  it("构造器 mkdir 落在 fake HOME 下（测试不污染真实 ~/.octopus）", () => {
    const cloneDir = path.join(homeTmp, ".octopus", "agent", "clones", "e2e-aq-clone")
    expect(fs.existsSync(path.join(cloneDir, "memory", "daily"))).toBe(true)
    expect(fs.existsSync(path.join(cloneDir, "skills"))).toBe(true)
  })
})
