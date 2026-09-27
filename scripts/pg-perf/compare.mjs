#!/usr/bin/env node
/**
 * compare.mjs —— 判据②「执行链路 p99 不劣化」的裁决器。
 *
 * 吃两份 bench.mjs 落盘的 v1 结果（典型姿势：
 *   B5 开工前：node scripts/pg-perf/bench.mjs --engine sqlite --label B5-baseline
 *   B5/B6 收口后：node scripts/pg-perf/bench.mjs --engine pg --label B5-check
 *   总验：node scripts/pg-perf/compare.mjs --baseline <sqlite 基线> --current <pg 现值>
 * 也支持同引擎回归对比（B6 前后各跑 pg）。）
 *
 * 判据口径：plan.html 原文是「p99 不劣化」，没有放宽额度 ——
 * 默认容差 0%（current.p99 ≤ baseline.p99 即不劣化）；--tolerance 存在仅为
 * 让总验人显式决定容忍测量噪声，默认值不动。
 * 任一 op 超容差 → exit 1（FAIL）；全过 → exit 0（PASS）。
 */
import path from 'node:path'
import process from 'node:process'
import { readResult, die, log } from './common.mjs'
const HELP = `用法: node scripts/pg-perf/compare.mjs --baseline <bench结果.json> --current <bench结果.json> [--tolerance <pct>] [--class <a,b>]
  --baseline  基线文件（B5 前旧路径 = sqlite 引擎那次运行，或任一次锁定的 pg 运行）
  --current   现值文件（B5/B6 后）
  --tolerance p99 允许劣化百分比（默认 0 = 判据原文「不劣化」的严格口径）
  --class     仅对比这些 op 类别（read,write,tx,chain；默认全部）。
              跨引擎总验（sqlite 基线 → pg 现值）建议 --class chain,tx：
              「执行链路」粒度是判据②的原文所指；逐语句 read/write 行受
              嵌入式同步 vs 客户端-服务器往返的物理形态支配，作诊断细节用。
  -h, --help  本帮助
exit：0 PASS · 1 FAIL（存在 p99 劣化超容差）· 2/1 用法或文件错误`

function parseArgs(argv) {
  const out = { tolerance: 0, classes: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--baseline') out.baseline = argv[++i]
    else if (a === '--current') out.current = argv[++i]
    else if (a === '--tolerance') {
      out.tolerance = Number(argv[++i])
      if (!Number.isFinite(out.tolerance) || out.tolerance < 0) die('--tolerance 需为非负数（百分比）')
    } else if (a === '--class') {
      out.classes = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean)
      const allowed = ['read', 'write', 'tx', 'chain']
      for (const c of out.classes) if (!allowed.includes(c)) die(`--class 取值 ${c} 非法（${allowed.join('|')}）`)
    } else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0) }
    else die(`未知参数: ${a}（--help）`)
  }
  if (!out.baseline || !out.current) die('必须提供 --baseline 与 --current 两份结果文件')
  return out
}

function consistencyWarns(base, cur) {
  const warns = []
  if (base.seed?.seed !== cur.seed?.seed) warns.push(`PRNG 种子不同（${base.seed?.seed} vs ${cur.seed?.seed}）—— 数据集不等，对比仅参考`)
  if (base.seed?.scale !== cur.seed?.scale) warns.push(`scale 不同（${base.seed?.scale} vs ${cur.seed?.scale}）—— 数据量级不等，p99 不可直接比`)
  if (base.settings?.iterations !== cur.settings?.iterations || base.settings?.repeat !== cur.settings?.repeat) warns.push(`iterations/repeat 不同（${base.settings?.iterations}×${base.settings?.repeat ?? 1} vs ${cur.settings?.iterations}×${cur.settings?.repeat ?? 1}）—— 样本量影响 p99 稳定性`)
  if (base.engine === cur.engine && base.engineMeta?.concurrency !== cur.engineMeta?.concurrency) warns.push('同引擎但 concurrency 不同')
  if (base.engine !== cur.engine) {
    log(`跨引擎对比：baseline=${base.engine} → current=${cur.engine}（这正是「旧路径基线 vs 迁移后现值」的判据姿势）`)
  }
  return warns
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const base = readResult(path.resolve(opts.baseline))
  const cur = readResult(path.resolve(opts.current))
  if (base.kind !== 'bench' || cur.kind !== 'bench') die('两份输入都必须是 bench 结果（eloop 报告不参与 p99 对比）')

  const warns = consistencyWarns(base, cur)
  for (const w of warns) console.warn(`[pg-perf] ⚠ ${w}`)

  const baseById = new Map(base.ops.map((o) => [o.id, o]))
  const inClass = (op) => !opts.classes || opts.classes.includes(op.class)
  const rows = []
  const fails = []
  for (const op of cur.ops) {
    if (!inClass(op)) continue
    const b = baseById.get(op.id)
    if (!b) { console.warn(`[pg-perf] ⚠ op ${op.id} 不在基线文件中`); continue }
    if (!b.stats || !op.stats) { fails.push({ id: op.id, d99: Infinity }); continue }
    const d99 = ((op.stats.p99Ms - b.stats.p99Ms) / b.stats.p99Ms) * 100
    const d95 = ((op.stats.p95Ms - b.stats.p95Ms) / b.stats.p95Ms) * 100
    const degraded = d99 > opts.tolerance
    if (degraded) fails.push({ id: op.id, d99 })
    rows.push({ id: op.id, class: op.class, b95: b.stats.p95Ms, c95: op.stats.p95Ms, d95, b99: b.stats.p99Ms, c99: op.stats.p99Ms, d99, degraded })
  }
  const curIds = new Set(cur.ops.filter(inClass).map((o) => o.id))
  for (const [id, o] of baseById) if (inClass(o) && !curIds.has(id)) console.warn(`[pg-perf] ⚠ 基线 op ${id} 在现值文件中缺失（漏测？）`)

  console.log(`\np99 对比（基线 ${base.engine}@${base.gitRev.slice(0, 8)} → 现值 ${cur.engine}@${cur.gitRev.slice(0, 8)}；容差 ${opts.tolerance}%）`)
  console.log('  op'.padEnd(34) + 'class   基线p95   现值p95    Δp95   基线p99   现值p99    Δp99   判定')
  console.log('  ' + '-'.repeat(96))
  for (const r of rows) {
    console.log(
      `  ${r.id.padEnd(32)} ${r.class.padEnd(5)} ${r.b95.toFixed(2).padStart(8)} ${r.c95.toFixed(2).padStart(8)} ${(r.d95 >= 0 ? '+' : '') + r.d95.toFixed(1)}%`.padEnd(66) +
      ` ${r.b99.toFixed(2).padStart(8)} ${r.c99.toFixed(2).padStart(8)} ${((r.d99 >= 0 ? '+' : '') + r.d99.toFixed(1) + '%').padStart(8)}  ${r.degraded ? '✗ 劣化' : '✓'}`,
    )
  }
  console.log('\n[pg-perf] 判据②「执行链路 p99 不劣化」→ ' + (fails.length === 0 ? 'PASS' : 'FAIL'))
  if (fails.length > 0) {
    for (const f of fails) console.log(`  ✗ ${f.id}：p99 劣化 +${f.d99.toFixed(1)}%（超容差 ${opts.tolerance}%）`)
    process.exit(1)
  }
  process.exit(0)
}

main()
