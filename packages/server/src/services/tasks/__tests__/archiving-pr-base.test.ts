// packages/server/src/services/tasks/__tests__/archiving-pr-base.test.ts
//
// 归档 PR 落点（2026-11-24）：PrContext.base → `gh pr create --base`；
// 已有开放 PR → `gh pr edit <url> --base` 纠正（旧代码只出 PR 不管落点）。
// 观察面是 gh 的 argv —— 不发网络请求。

import { describe, it, expect } from "vitest"
import { defaultPrHandler } from "../archiving-service"
import type { CommandRunner } from "../archive-delta"

interface Call {
  cmd: string
  args: string[]
}

function makeRun(opts: { openUrl?: string; editCode?: number } = {}): {
  run: CommandRunner
  calls: Call[]
} {
  const calls: Call[] = []
  const run: CommandRunner = (cmd, args) => {
    calls.push({ cmd, args })
    if (cmd === "git" && args[0] === "remote") {
      return { code: 0, stdout: "git@github.com:xzf/demo.git\n", stderr: "" }
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
      return {
        code: opts.openUrl ? 0 : 1,
        stdout: opts.openUrl ? `${opts.openUrl}\n` : "",
        stderr: "",
      }
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
      return { code: 0, stdout: "https://github.com/xzf/demo/pull/7\n", stderr: "" }
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
      return { code: opts.editCode ?? 0, stdout: "", stderr: opts.editCode ? "boom" : "" }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { run, calls }
}

const ctx = {
  project: "demo",
  worktreePath: "/tmp/demo",
  branch: "feat-task-20261124-120000",
  title: "chore(archive): demo syncback 20261124",
  body: "report",
}

describe("defaultPrHandler — PR 落点", () => {
  it("有 base → gh pr create 带 --base", async () => {
    const { run, calls } = makeRun()
    const res = await defaultPrHandler({ ...ctx, base: "feat/long-lived" }, run)
    expect(res.action).toBe("created")
    const create = calls.find((c) => c.cmd === "gh" && c.args[1] === "create")!
    expect(create.args).toContain("--head")
    expect(create.args).toContain("--base")
    expect(create.args[create.args.indexOf("--base") + 1]).toBe("feat/long-lived")
  })

  it("没有 base → 不带 --base（仓库默认分支兜底）", async () => {
    const { run, calls } = makeRun()
    await defaultPrHandler(ctx, run)
    const create = calls.find((c) => c.cmd === "gh" && c.args[1] === "create")!
    expect(create.args).not.toContain("--base")
  })

  it("已有开放 PR → gh pr edit 纠正 --base，不动 head 分支", async () => {
    const { run, calls } = makeRun({ openUrl: "https://github.com/xzf/demo/pull/3" })
    const res = await defaultPrHandler({ ...ctx, base: "feat/long-lived" }, run)
    expect(res).toEqual({ action: "merged-into-open", url: "https://github.com/xzf/demo/pull/3" })
    const edit = calls.find((c) => c.cmd === "gh" && c.args[1] === "edit")!
    expect(edit.args[0]).toBe("pr")
    expect(edit.args[2]).toBe("https://github.com/xzf/demo/pull/3")
    expect(edit.args[edit.args.indexOf("--base") + 1]).toBe("feat/long-lived")
  })

  it("edit 失败不抛（push 已在，归档继续）", async () => {
    const { run } = makeRun({ openUrl: "https://github.com/xzf/demo/pull/3", editCode: 1 })
    await expect(
      defaultPrHandler({ ...ctx, base: "feat/long-lived" }, run),
    ).resolves.toMatchObject({ action: "merged-into-open" })
  })

  it("非 GitHub remote → skipped（不变）", async () => {
    const run: CommandRunner = (cmd) =>
      cmd === "git"
        ? { code: 0, stdout: "git@gitea.local:xzf/demo.git\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" }
    const res = await defaultPrHandler({ ...ctx, base: "feat/x" }, run)
    expect(res.action).toBe("skipped")
  })
})
