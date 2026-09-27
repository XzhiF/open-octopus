#!/usr/bin/env node
/**
 * eloop-monitor.mjs —— P1 判据③「事件循环阻塞监控为空」的度量工具。
 *
 * 判据原文（plan.html P1 退出判据③）：事件循环阻塞监控为空 —— 异步化后不应再有
 * 任何 >50ms 的同步 DB 调用；这条同时是「漏 await」的探测器。
 * 口径落点：perf_hooks.monitorEventLoopDelay 按窗口采样，任一窗口 max > 50ms
 * 即「非空」。PASS = 阻塞窗口数 0（并打印 min/mean/p99/max 供人工核对）。
 *
 * 三种模式：
 *   --load pg          （默认）本进程内用真实异步 PG 路径（随机 perf 库 + workloads
 *                        的代表性读/写/事务 op，多 worker 并发）驱动负载并采样 ——
 *                        「harness 驱动代表性查询路径」的脚本态。
 *   --load sqlite-sync 标定/正对照：同一批路径走旧同步 better-sqlite3 形态
 *                        （整库装载放进一个同步事务）—— 探测器必须能看见阻塞；
 *                        此模式检出阻塞 = 工具可信（不代表判据失败）。
 *   --attach -- <cmd>  活体监控：把 eloop-bootstrap.mjs 经 NODE_OPTIONS --import
 *                        注入任意命令（典型：node packages/server/dist/index.js，
 *                        即起真实 server 采样），不动 packages/server/src 任何文件。
 *                        子进程退出或 --duration 到点后聚合其 JSONL 输出。
 *
 * 用法:
 *   OCTOPUS_PG_TEST_URL=postgres://octopus:octopus@127.0.0.1:5432/octopus \
 *     node scripts/pg-perf/eloop-monitor.mjs [--load pg] [--duration 12000]
 *       [--threshold 50] [--window 250] [--concurrency 8] [--scale 300] [--out-dir DIR]
 *   node scripts/pg-perf/eloop-monitor.mjs --load sqlite-sync --duration 8000
 *   node scripts/pg-perf/eloop-monitor.mjs --attach --duration 20000 -- \
 *     node packages/server/dist/index.js
 *
 * exit：pg 模式 0=监控为空（判据过）· 1=检出阻塞/失败；
 *       sqlite-sync 模式 0=探测器有效（检出阻塞）· 1=未检出（工具可疑，需加大负载）；
 *       attach 模式 0=监控为空（判据过）· 1=检出阻塞。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { spawn } from 'node:child_process'
import process from 'node:process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  die, log, createPerfDatabase, createSqliteScratch, writeJson,
  utcStamp, gitRev, percentile, round6, DEFAULT_OUT_DIR, ROOT,
} from './common.mjs'
import { OPS, buildSeedDataset, seedSqlite, seedPg, makeLoadCtx, DEFAULT_SEED } from './workloads.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BOOTSTRAP = path.join(HERE, 'eloop-bootstrap.mjs')

const HELP = `用法: node scripts/pg-perf/eloop-monitor.mjs [options] [-- <attach 命令 ...>]
  --load pg|sqlite-sync|attach  采样形态（默认 pg；给了 -- 命令时自动 attach）
  --duration <ms>               负载/采样时长（默认 12000；attach 到时 SIGTERM 子进程）
  --threshold <ms>              阻塞判据阈值（默认 50 —— 判据原文「>50ms 同步 DB 调用」）
  --window <ms>                 直方图滚动窗口（默认 250）
  --concurrency <c>             负载并发 worker（默认 8，pg/attach 的驱动侧）
  --scale <n>                   pg/sqlite-sync 种子规模（默认 300）
  --seed <n>                    PRNG 种子（默认 ${DEFAULT_SEED}）
  --pool-max <n>                PG 池上限（默认 10）
  --out-dir <dir>               报告落盘目录（默认 scripts/pg-perf/results/）
  -h, --help                    本帮助`

function parseArgs(argv) {
  const out = { load: null, duration: 12_000, threshold: 50, window: 250, concurrency: 8, scale: 300, seed: DEFAULT_SEED, poolMax: 10, outDir: DEFAULT_OUT_DIR, cmd: [] }
  const rest = []
  const dash = argv.indexOf('--')
  if (dash !== -1) { out.cmd = argv.slice(dash + 1); argv = argv.slice(0, dash) }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => { const v = argv[++i]; if (v === undefined) die(`缺少 ${a} 的参数值`); return v }
    if (a === '--load') { out.load = next(); if (!['pg', 'sqlite-sync', 'attach'].includes(out.load)) die('--load 取 pg|sqlite-sync|attach') }
    else if (a === '--duration') out.duration = posInt(a, next())
    else if (a === '--threshold') out.threshold = Number(next())
    else if (a === '--window') out.window = posInt(a, next())
    else if (a === '--concurrency') out.concurrency = posInt(a, next())
    else if (a === '--scale') out.scale = posInt(a, next())
    else if (a === '--seed') out.seed = Number(next())
    else if (a === '--pool-max') out.poolMax = posInt(a, next())
    else if (a === '--out-dir') out.outDir = path.resolve(next())
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0) }
    else die(`未知参数: ${a}（--help）`)
  }
  if (out.load === null) out.load = out.cmd.length > 0 ? 'attach' : 'pg'
  if (out.load === 'attach' && out.cmd.length === 0) die('attach 模式需要 -- <命令>（例如 -- node packages/server/dist/index.js）')
  if (!Number.isFinite(out.threshold) || out.threshold <= 0) die('--threshold 需为正数')
  return out
}
const posInt = (flag, raw) => { const n = Number(raw); if (!Number.isInteger(n) || n <= 0) die(`${flag} 需为正整数，got ${raw}`); return n }

/** 窗口直方图收割：每 window 记一次窗口 max/mean/p99，并 reset。 */
function startHistogram(windowMs) {
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  const windows = []
  const timer = setInterval(() => {
    windows.push({
      maxMs: round6(h.max / 1e6),
      meanMs: round6(h.mean / 1e6),
      p99Ms: round6(h.percentile(99) / 1e6),
    })
    h.reset()
  }, windowMs)
  return {
    stop() {
      clearInterval(timer)
      h.reset()
      h.disable()
      return windows
    },
  }
}

function summarize(windows, thresholdMs, meta) {
  const maxes = windows.map((w) => w.maxMs).sort((a, b) => a - b)
  const means = windows.map((w) => w.meanMs)
  const blocking = windows.filter((w) => w.maxMs > thresholdMs)
  const stats = maxes.length > 0
    ? { minMs: maxes[0], p99Ms: percentile(maxes, 99), maxMs: maxes[maxes.length - 1], meanOfMeansMs: round6(means.reduce((s, v) => s + v, 0) / means.length) }
    : { minMs: 0, p99Ms: 0, maxMs: 0, meanOfMeansMs: 0 }
  return { ...meta, thresholdMs, windowCount: windows.length, ...stats, blockingWindowCount: blocking.length, blockingWindowMaxes: blocking.map((w) => w.maxMs), verdict: null }
}

/** 统一打印块：判据③的可核对格式 —— 「非空阻塞窗口清单」直接决定 PASS/空。 */
function printReport(s, label) {
  console.log(`\n[${label}] 事件循环阻塞监控（monitorEventLoopDelay，窗口 max 分布；阈值 ${s.thresholdMs}ms）`)
  console.log(`  窗口数 ${s.windowCount} · 窗口max min=${s.minMs.toFixed(2)} mean=${s.meanOfMeansMs.toFixed(2)} p99=${s.p99Ms.toFixed(2)} max=${s.maxMs.toFixed(2)} ms · ops完成 ${s.opsDone ?? '—'}）`)
  console.log(`  >阈值阻塞窗口：${s.blockingWindowCount} 个${s.blockingWindowMaxes.length ? `（top: ${s.blockingWindowMaxes.slice(0, 8).map((v) => v.toFixed(1)).join(', ')} ms）` : ''}`)
}

async function loadPg(ctxOpts) {
  const dbh = await createPerfDatabase({ poolMax: ctxOpts.poolMax })
  log(`attach/pg：随机 perf 库 ${dbh.name}`)
  const dataset = buildSeedDataset(ctxOpts.scale, ctxOpts.seed)
  await seedPg(dbh.sql, dataset)
  const ctx = makeLoadCtx(dataset, 'el-pg', ctxOpts)
  const deadline = Date.now() + ctxOpts.duration
  let opsDone = 0
  let failed = false
  const hist = startHistogram(ctxOpts.window)
  const runOp = (op, i) => new Promise((resolve, reject) => {
    let r
    try {
      if (op.class === 'tx') {
        const steps = op.txStatements(ctx, i).map((s) => s.pg)
        r = dbh.sql.begin(async (tx) => { for (const s of steps) await tx.unsafe(s.sql, s.values) })
      } else if (op.steps) {
        r = (async () => { for (const s of op.pg) await dbh.sql.unsafe(s.sql, s.values(ctx, i)) })()
      } else {
        r = dbh.sql.unsafe(op.pg.sql, op.pg.values(ctx, i))
      }
    } catch (err) { reject(err); return }
    r.then(() => { opsDone++; resolve() }, reject)
  })
  const workers = Array.from({ length: ctxOpts.concurrency }, async (_, wk) => {
    try {
      let k = 0
      while (Date.now() < deadline) {
        const op = OPS[(wk * 7 + k * 3) % OPS.length]
        await runOp(op, wk * 1_000_000 + k)
        k++
      }
    } catch (err) {
      failed = true
      console.error(`[eloop] 负载 worker 失败 :: ${err instanceof Error ? err.message : err}`)
    }
  })
  await Promise.all(workers)
  const windows = hist.stop()
  await dbh.close()
  if (failed) die('pg 负载执行失败（见上方 worker 错误）')
  return summarize(windows, ctxOpts.threshold, { mode: 'pg', opsDone, randomDbName: dbh.name, concurrency: ctxOpts.concurrency, scale: ctxOpts.scale, seed: ctxOpts.seed, durationMs: ctxOpts.duration })
}

async function loadSqliteSync(ctxOpts) {
  // 正对照标定：旧路径的「同步 DB 调用」形态 —— 清库+整库装载放进单个同步事务，
  // 必然压出 >50ms 阻塞窗口；探测器若看不见，说明工具本身不可信。
  const scratch = createSqliteScratch('eloop-sync')
  const FK_ORDER = ['interaction_messages', 'agent_events', 'node_executions', 'executions', 'harness_events', 'tasks', 'workspaces']
  try {
    const hist = startHistogram(ctxOpts.window)
    const deadline = Date.now() + ctxOpts.duration
    let opsDone = 0
    let batch = 0
    while (Date.now() < deadline) {
      const dataset = buildSeedDataset(Math.max(50, Math.min(ctxOpts.scale, 200)), DEFAULT_SEED)
      const run = scratch.db.transaction(() => {
        for (const t of FK_ORDER) scratch.db.prepare(`DELETE FROM ${t}`).run()
        seedSqlite(scratch.db, dataset)
      })
      run()
      const rows = scratch.db.prepare('SELECT * FROM executions WHERE workspace_id = ? ORDER BY created_at DESC').all(dataset.rows.workspaces[0].id)
      opsDone += 1 + rows.length
      batch++
      // 让出事件循环，窗口才能各自命中同步段
      await new Promise((r) => setTimeout(r, 5))
    }
    const windows = hist.stop()
    return summarize(windows, ctxOpts.threshold, { mode: 'sqlite-sync', opsDone, batches: batch, calibrate: true, scale: ctxOpts.scale, seed: ctxOpts.seed, durationMs: ctxOpts.duration })
  } finally {
    scratch.close()
  }
}

async function runAttach(ctxOpts) {
  const outFile = path.join(os.tmpdir(), `octopus-eloop-${process.pid}-${Date.now()}.jsonl`)
  const child = spawn(ctxOpts.cmd[0], ctxOpts.cmd.slice(1), {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${BOOTSTRAP}`.trim(),
      OCTOPUS_ELOOP_OUT: outFile,
      OCTOPUS_ELOOP_WINDOW_MS: String(ctxOpts.window),
      OCTOPUS_ELOOP_RESOLUTION_MS: '10',
    },
  })
  log(`attach：子进程 pid=${child.pid} 已注入 bootstrap（${ctxOpts.cmd.join(' ')}）`)
  let stopReason = 'child-exit'
  const killer = setTimeout(() => { stopReason = 'duration'; child.kill('SIGTERM') }, ctxOpts.duration)
  const code = await new Promise((resolve) => {
    child.on('exit', (c) => { clearTimeout(killer); resolve(c) })
    child.on('error', (err) => { clearTimeout(killer); console.error(`[eloop] spawn 失败 :: ${err.message}`); resolve(-1) })
  })
  const windows = []
  if (fs.existsSync(outFile)) {
    for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'window') windows.push({ maxMs: obj.maxMs, meanMs: obj.meanMs, p99Ms: obj.p99Ms })
      } catch { /* 半行容忍 */ }
    }
    fs.rmSync(outFile, { force: true })
  }
  if (windows.length === 0) die(`子进程未产出任何窗口样本（exit=${code}，${stopReason}）—— 确认命令是 node 进程且 bootstrap 未被跳过`)
  log(`attach：收割 ${windows.length} 个窗口（${stopReason}，子进程 exit=${code}）`)
  return summarize(windows, ctxOpts.threshold, { mode: 'attach', cmd: ctxOpts.cmd, childExitCode: code, durationMs: ctxOpts.duration })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  let s
  if (opts.load === 'pg') s = await loadPg(opts)
  else if (opts.load === 'sqlite-sync') s = await loadSqliteSync(opts)
  else s = await runAttach(opts)

  printReport(s, opts.load)
  const empty = s.blockingWindowCount === 0
  if (opts.load === 'sqlite-sync') {
    s.verdict = empty ? 'CALIBRATION-FAILED' : 'CALIBRATION-OK'
    console.log(`[pg-perf] 探测器标定 → ${empty ? '未检出阻塞（工具可疑：加大 --scale/--concurrency 或缩短 --window）' : '已检出同步阻塞（探测器有效 ✓）'}`)
    console.log('  ※ sqlite-sync 是正对照模式：检出阻塞不代表判据失败，判据在 pg/attach 模式下裁决')
    process.exit(empty ? 1 : 0)
  }
  s.verdict = empty ? 'PASS' : 'FAIL'
  console.log(`[pg-perf] 判据③「事件循环阻塞监控为空」（无 >${opts.threshold}ms 窗口）→ ${s.verdict}`)
  const file = path.join(opts.outDir, `eloop-${opts.load}-${utcStamp()}.json`)
  writeJson(file, { format: 'octopus-pg-perf/v1', kind: 'eloop', generatedAt: new Date().toISOString(), gitRev: gitRev(), nodeVersion: process.version, ...s })
  process.exit(empty ? 0 : 1)
}

main().catch((err) => die(err instanceof Error ? err.stack : String(err)))
