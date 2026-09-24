// packages/server/src/services/tasks/host-guard.ts
//
// 宿主保护（2026-09-24 实例回收）：任何"按端口/PID 杀进程"的平台操作
// （reclaim、close-dev）都必须先排除 Octopus 自己的宿主树 —— dev.mjs 起的
// server/web 是本仓开发态的亲爹，误杀 = 自尽。三个信息来源叠加：
//   ① OCTOPUS_HOST_PIDS env（server 启动时读 ~/.octopus/host-pids.json 注入）；
//   ② 自身 PID 的祖先链（host-pids.json 过期/缺失时的兜底 —— dev 模式下
//      server 的父亲就是 dev.mjs，这条不依赖任何文件的时效性）；
//   ③ 宿主端口：env PORT（server）与其 -1（web 约定，同 buildHostEnv）、
//      OCTOPUS_HOST_PORTS、host-pids.json 的 ports.*。
// Windows 下祖先链要走一次 PowerShell（秒级），故结果 memoize —— env 在进程
// 生命周期内稳定，缓存永不失效是安全的。

import { existsSync, readFileSync } from "fs"
import os from "os"
import path from "path"
import { processAncestry } from "../../port-utils"

let cachedPids: Set<number> | null = null
let cachedPorts: Set<number> | null = null

function parsePidList(raw: string | undefined): number[] {
  return (raw ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0)
}

export function hostProtectedPids(): Set<number> {
  if (cachedPids) return cachedPids
  const s = new Set<number>(parsePidList(process.env.OCTOPUS_HOST_PIDS))
  s.add(process.pid)
  for (const a of processAncestry(process.pid)) s.add(a)
  cachedPids = s
  return s
}

export function hostProtectedPorts(): Set<number> {
  if (cachedPorts) return cachedPorts
  const s = new Set<number>(parsePidList(process.env.OCTOPUS_HOST_PORTS))
  const serverPort = parseInt(process.env.PORT ?? "3001", 10)
  if (Number.isInteger(serverPort) && serverPort > 0) {
    s.add(serverPort)
    s.add(serverPort - 1) // web = server-1（与 engine buildHostEnv 同一约定）
  }
  try {
    const fp = path.join(os.homedir(), ".octopus", "host-pids.json")
    if (existsSync(fp)) {
      const data = JSON.parse(readFileSync(fp, "utf-8")) as { ports?: Record<string, number> }
      for (const v of Object.values(data.ports ?? {})) {
        if (Number.isInteger(v) && v > 0) s.add(v)
      }
    }
  } catch { /* 文件缺失/损坏 = 前两道闸仍在 */ }
  cachedPorts = s
  return s
}
