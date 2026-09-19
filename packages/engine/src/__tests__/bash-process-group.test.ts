// 进程组语义（2026-09-18 活体验证抓到的 bug 的回归锁）。
//
// killProcessTree 的主路径是 `process.kill(-pid)`（按进程组杀），但这要求被 spawn
// 的子进程是组长 —— 之前 BashExecutor/PythonExecutor 的 spawn 没有 detached，组不
// 存在，杀节点退化成只杀外层 bash：`mvn package && java -jar` 这类「孙进程常驻」的
// 命令在 abort/timeout 后把 java 留成孤儿（实测预览 stop 后 18081 端口仍在服务）。
//
// 本文件真 spawn（不 mock child_process）锁两件事：
//  ① abort 后整组死透 —— 前台子进程 `sleep <marker>` 一并消失；
//  ② skipHarness 让 down 类命令的 pkill 真的生效（harness 别名会把 pkill 变成拒绝桩）。
import { describe, it, expect } from "vitest"
import { execFileSync } from "child_process"
import { BashExecutor } from "../executors/bash"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"

const POSIX = process.platform !== "win32"

function pgrepCount(pattern: string): number {
  try {
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf-8" })
    return out.split("\n").filter(Boolean).length
  } catch {
    return 0 // pgrep rc1 = 无匹配
  }
}

describe.skipIf(!POSIX)("BashExecutor 进程组语义", () => {
  it("abort 杀死整个进程组（孙进程不留孤儿）", async () => {
    const marker = `octopus-pgrp-${Date.now()}`
    const controller = new AbortController()
    // 子 bash 的 argv 里带 marker（sleep 40 后接注释），外层 bash 的 -c 串同样含 ——
    // abort 后若只杀外层（旧行为），marker 仍可在 pgrep 里查到，测试即红。
    const node: NodeDef = {
      id: "pgrp-abort",
      type: "bash",
      bash: `bash -c "sleep 40; : ${marker}" & wait`,
      timeout: 60,
    }
    const ex = new BashExecutor(node, new VarPool(), { signal: controller.signal })
    const p = ex.execute()
    // 等子进程起来
    for (let i = 0; i < 50 && pgrepCount(marker) === 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(pgrepCount(marker)).toBeGreaterThan(0)

    controller.abort()
    // BashExecutor 把 Abort 捕获成 failed 结果（execute 不 reject），语义不变
    const r = await p
    expect(r.status).toBe("failed")
    // SIGTERM 到组是异步的，给 2s 收敛窗口；只杀组长时孙进程会活满 40s
    const t0 = Date.now()
    while (pgrepCount(marker) > 0 && Date.now() - t0 < 2000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(pgrepCount(marker)).toBe(0)
  }, 15_000)

  it("skipHarness: pkill 不被 harness 别名桩掉，down 能杀掉 setsid 的 daemon", async () => {
    const marker = `octopus-down-${Date.now()}`
    // daemon 起法不依赖本执行器（nohup + disown 式后台），命令行带 marker
    const spawnDaemon = new BashExecutor(
      { id: "daemon-up", type: "bash", bash: `nohup bash -c 'sleep 40; : ${marker}' >/dev/null 2>&1 & echo started`, timeout: 20 },
      new VarPool(),
    )
    const up = await spawnDaemon.execute()
    expect(up.status).toBe("completed")
    for (let i = 0; i < 50 && pgrepCount(marker) === 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(pgrepCount(marker)).toBeGreaterThan(0)

    // 带 harness：pkill → safe_pkill 桩（rc1，被 || true 吞）→ daemon 存活
    const warded = new BashExecutor(
      { id: "down-warded", type: "bash", bash: `pkill -f '${marker}' || true`, timeout: 20 },
      new VarPool(),
    )
    await warded.execute()
    await new Promise((r) => setTimeout(r, 300))
    expect(pgrepCount(marker)).toBeGreaterThan(0) // harness 别名生效 = 现状回归点

    // skipHarness：平台自有生命周期收尾，pkill 直通 → daemon 收尸
    const down = new BashExecutor(
      { id: "down-raw", type: "bash", bash: `pkill -f '${marker}' || true`, timeout: 20 },
      new VarPool(),
      { skipHarness: true },
    )
    const res = await down.execute()
    expect(res.status).toBe("completed")
    const t0 = Date.now()
    while (pgrepCount(marker) > 0 && Date.now() - t0 < 2000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(pgrepCount(marker)).toBe(0)
  }, 15_000)
})
