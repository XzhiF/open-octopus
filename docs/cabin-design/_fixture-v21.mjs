// docs/cabin-design/_fixture-v21.mjs —— v21 高保真验收的固定样板舱（不入库）。
//
// 只走生产 REST，不碰 dev 库里的真实舱：
//   1) POST /api/cabins 建一个 tmpdir 下的样板舱（前缀 FID-V21-）；
//   2) 播 9 个作业（7 workflow + 2 task-kind）；
//      · task-kind 由服务端真派发建 task + 会话 → tab 条有第二条线程，行上有 pct；
//   3) 打印 { cabinId, dir, jobs }，交给 _fidelity-v21.mjs 采样；
//   4) 脚本退出时默认清理（--keep 保留，--clean <id> 只清理）。
//
// 纪律：样板舱只用于截图/断言，任何断言读数来自生产组件，不是 mock。
// 注意：task 派发会拉起 task-author agent（烧 token）。这里沿用 e2e helper 的
// 做法：按命令行里精确的 <dir>/.task 标记 SIGTERM 掉它，只保留 job/task 行。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const SERVER = process.env.OCTOPUS_SERVER_URL ?? 'http://localhost:3001'
export const WEB = process.env.OCTOPUS_WEB_URL ?? 'http://localhost:3000'

const CABIN_PREFIX = 'FID-V21-'
const DIR_PREFIX = 'octopus-fid-v21-'

/** 原型 9 条作业的标题（左栏对照用，标题长度覆盖 ellipsis）。 */
// 两个 task-kind 放最前：它们才有真实 pct（task 进度富化），默认 6 行里能看见。
const JOBS = [
  { kind: 'task', title: 'M1 · 幂等修复' },
  { kind: 'task', title: '边缘节点灰度' },
  { kind: 'workflow', title: 'M1 · 退款链路' },
  { kind: 'workflow', title: 'M2 · 限流阈值' },
  { kind: 'workflow', title: 'M2 · 结算对账' },
  { kind: 'workflow', title: '归档沉淀 · M2' },
  { kind: 'workflow', title: '合规审计 · 网关' },
  { kind: 'workflow', title: '发布脚本迁移' },
  { kind: 'workflow', title: 'M3 · 风控告警' },
]

async function post(p, data) {
  const res = await fetch(`${SERVER}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`POST ${p} → ${res.status}: ${text}`)
  return text ? JSON.parse(text) : {}
}

async function getJson(p) {
  const res = await fetch(`${SERVER}${p}`)
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${p} → ${res.status}: ${text}`)
  return text ? JSON.parse(text) : {}
}

/**
 * 给 task-kind job 写一个 v4 两阶段 spec。
 *
 * 左栏的 pct 只在任务有真实 phaseViews 时才画（不猜），而 phaseViews 由
 * task_spec.phases 派生。这里不跑任何执行（不烧 LLM）：两阶段都是 pending →
 * 行上显示 0% + 3px 空条，用来验证「有真进度时不编造、有阶段就有进度槽」的
 * 渲染契约。等真实执行接了，同一个位置会显示真实百分比。
 */
async function addPhases(taskId) {
  const task = await getJson(`/api/tasks/${taskId}`)
  const phases = [1, 2].map((index) => ({
    index,
    name: index === 1 ? '结算' : '复核',
    slug: `phase-${index}`,
    specPath: `./.scratch/20261117/phase-${index}/spec.md`,
    workflowRef: 'built-in/matt-spec-dev',
    inputValues: { batch_dir: '${phase.batch_rel}' },
  }))
  const res = await fetch(`${SERVER}/api/tasks/${taskId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': String(task.version) },
    body: JSON.stringify({ task_spec: { format: 'v4', phases } }),
  })
  if (!res.ok) throw new Error(`PUT task_spec ${taskId} → ${res.status}: ${await res.text()}`)
}

function fixtureAgentPids(cabinDir) {
  const marker = `${cabinDir}${path.sep}.task`
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5_000 })
    return out.split('\n').flatMap((line) => {
      const m = line.trim().match(/^(\d+)\s+(.*)$/)
      if (!m || !m[2].includes(marker)) return []
      const pid = Number(m[1])
      return Number.isFinite(pid) ? [pid] : []
    })
  } catch {
    return []
  }
}

export async function suppressAgents(cabinDir, waitMs = 2_500) {
  const deadline = Date.now() + waitMs
  const killed = []
  for (;;) {
    for (const pid of fixtureAgentPids(cabinDir)) {
      try {
        process.kill(pid, 'SIGTERM')
        killed.push(pid)
      } catch {
        /* already gone */
      }
    }
    if (Date.now() >= deadline) return killed
    await new Promise((r) => setTimeout(r, 250))
  }
}

/**
 * 等派生态落定：task 派发会拉起作者会话，`agent_running` = 服务端内存流仍在。
 * 进程被杀掉后流结束有个尾延迟；/jobs 轮询到全部 agent_running=false 再交给
 * 截图脚本，否则 pct（作者在跑时不画假进度）会时有时无。
 */
async function waitAgentsSettled(cabinId, dir, waitMs = 60_000) {
  const deadline = Date.now() + waitMs
  for (;;) {
    // 服务端可能在我们第一次 SIGTERM 之后才真正 spawn（唤醒是异步的）：
    // 每轮再扫一遍，晚到的作者进程也一起收掉。
    if (dir) await suppressAgents(dir, 0)
    const { jobs } = await getJson(`/api/cabins/${cabinId}/jobs`)
    if (!jobs.some((j) => j.agent_running)) return true
    if (Date.now() >= deadline) {
      console.warn('[fixture] agents still running after wait — pct may be hidden')
      return false
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

export async function seedFixture() {  const dir = fs.mkdtempSync(path.join(os.tmpdir(), DIR_PREFIX))
  const name = `${CABIN_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    const { cabin } = await post('/api/cabins', {
      name,
      path: dir,
      requirements: 'v21 fidelity fixture — safe to delete',
    })
    if (!cabin.name.startsWith(CABIN_PREFIX)) throw new Error(`seed sanity: ${cabin.name}`)

    const jobs = []
    for (const spec of JOBS) {
      const { job } = await post(`/api/cabins/${cabin.id}/jobs`, {
        kind: spec.kind,
        title: spec.title,
        prompt: 'v21 fidelity fixture',
        // inferred 让服务端走确认路径，不自动执行（仍然可能拉起作者会话）。
        ...(spec.kind === 'task' ? { mandate: { strength: 'inferred', scope: 'fidelity' } } : {}),
      })
      jobs.push({ id: job.id, kind: job.kind, title: job.title, ref_id: job.ref_id ?? null, session_id: job.session_id ?? null })
      if (spec.kind === 'task' && job.ref_id) await addPhases(job.ref_id)
    }
    await suppressAgents(dir)
    await waitAgentsSettled(cabin.id, dir)

    return { cabin, dir, jobs }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

export async function cleanupFixture(cabinId, dir) {
  if (!cabinId || !cabinId.match(/^[0-9a-f-]{36}$/i)) return
  const res = await fetch(`${SERVER}/api/cabins/${cabinId}`)
  if (res.ok) {
    const { cabin } = await res.json()
    // 只删自己播的舱：名字前缀 + tmpdir 下。
    const tmpRoot = fs.realpathSync(os.tmpdir())
    let real = path.resolve(cabin.path)
    try { real = fs.realpathSync(cabin.path) } catch { /* 目录已不在 */ }
    if (!cabin.name.startsWith(CABIN_PREFIX) || !real.startsWith(tmpRoot + path.sep)) {
      throw new Error(`refusing to delete non-fixture cabin ${cabin.id} (${cabin.name})`)
    }
    // 运行中的 task 会挡住删除：先 abort（仅 running）。
    try {
      const t = await fetch(`${SERVER}/api/tasks?cabin_id=${encodeURIComponent(cabinId)}`)
      if (t.ok) {
        const body = await t.json()
        for (const task of body.items ?? []) {
          if (task.status === 'running') await fetch(`${SERVER}/api/tasks/${task.id}/abort`, { method: 'POST' })
        }
      }
    } catch { /* best effort */ }
    const del = await fetch(`${SERVER}/api/cabins/${cabinId}`, { method: 'DELETE' })
    if (!del.ok) throw new Error(`DELETE cabin ${cabinId} → ${del.status}: ${await del.text()}`)
    await suppressAgents(cabin.path, 1_000)
    fs.rmSync(cabin.path, { recursive: true, force: true })
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
}

// ── CLI ────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  if (args[0] === '--clean') {
    await cleanupFixture(args[1], args[2])
    console.log('cleaned', args[1])
  } else {
    const seed = await seedFixture()
    console.log(JSON.stringify(seed, null, 2))
    if (!args.includes('--keep')) {
      await cleanupFixture(seed.cabin.id, seed.dir)
      console.log('cleaned (pass --keep to keep the fixture for screenshots)')
    }
  }
}
