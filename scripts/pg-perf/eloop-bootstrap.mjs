#!/usr/bin/env node
/**
 * eloop-bootstrap.mjs —— 经 `node --import` 注入被监控进程（server/dist 入口等）的
 * 事件循环采样探针。零侵入：不动 packages/server/src 任何文件，
 * 由 eloop-monitor.mjs --attach 设 NODE_OPTIONS 注入，也可手工：
 *
 *   NODE_OPTIONS="--import ./scripts/pg-perf/eloop-bootstrap.mjs" \
 *     OCTOPUS_ELOOP_OUT=/tmp/eloop.jsonl node packages/server/dist/index.js
 *
 * 每个窗口向 OCTOPUS_ELOOP_OUT 追加一行 JSON（appendFileSync，SIGKILL 也不丢已写行）：
 *   {"type":"window","pid":…,"tMs":…,"windowMs":…,"minMs":…,"meanMs":…,"p99Ms":…,"maxMs":…}
 * 注意 NODE_OPTIONS 会被子 node 进程继承 —— 多进程同写一个文件时各行带 pid，
 * 聚合端（eloop-monitor --attach）按行合并，这符合「整个进程树都不许出现 >50ms 阻塞」
 * 的判据语义；如需只监控 server，去掉 inherit 场景自行收窄命令。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import fs from 'node:fs'
import process from 'node:process'

if (process.env.OCTOPUS_ELOOP_BOOTSTRAPPED === '1') {
  // 同进程被重复 --import（NODE_OPTIONS + 显式）时只装一次
} else if (!process.env.OCTOPUS_ELOOP_OUT) {
  // 探针未指向输出文件 = 静默跳过（不能因环境变量缺失影响宿主进程）
} else {
  process.env.OCTOPUS_ELOOP_BOOTSTRAPPED = '1'
  const out = process.env.OCTOPUS_ELOOP_OUT
  const windowMs = Math.max(50, Number(process.env.OCTOPUS_ELOOP_WINDOW_MS ?? 250))
  const resolution = Math.max(1, Number(process.env.OCTOPUS_ELOOP_RESOLUTION_MS ?? 10))
  const h = monitorEventLoopDelay({ resolution })
  h.enable()
  const t0 = Date.now()
  const timer = setInterval(() => {
    const line = JSON.stringify({
      type: 'window', pid: process.pid, tMs: Date.now() - t0, windowMs,
      minMs: h.min / 1e6, meanMs: h.mean / 1e6, p99Ms: h.percentile(99) / 1e6, maxMs: h.max / 1e6,
    })
    try {
      fs.appendFileSync(out, line + '\n')
    } catch { /* 输出文件被删等极端情况：探针绝不允许拖垮宿主 */ }
    h.reset()
  }, windowMs)
  timer.unref?.()
  process.on('exit', () => {
    try { h.disable() } catch { /* ignore */ }
  })
  try {
    fs.appendFileSync(out, JSON.stringify({ type: 'hello', pid: process.pid, argv: process.argv.slice(1).join(' ').slice(0, 200), windowMs }) + '\n')
  } catch { /* ignore */ }
}
