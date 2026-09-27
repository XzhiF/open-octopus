/**
 * pg-perf 负载目录 —— 执行链路代表性读/写路径的两引擎等价镜像。
 *
 * 口径来源（不自创标准）：每条 op 标注它镜像的 DAO 调用点；SQLite 侧就是旧路径
 * （better-sqlite3 prepared stmt，B1/B2 前的等价物 = 基线），PG 侧就是迁移后的等价
 * 查询（列表达式按 dao/base-pg 的归一写法镜像：#>> '{}' / to_char / ::int）。
 * plan.html P1 判据②「执行链路 p99 不劣化」比的就是这组 op 的 p99。
 *
 * 数据确定性：种子数据集由固定种子的 mulberry32 生成 —— 同 scale 两次运行逐行
 * 相同，B5/B6 前后对比才可归因于引擎而非数据分布。
 */
import { mulberry32 } from './common.mjs'

export const DEFAULT_SEED = 20260928

/** scale = executions 数；其余表按 DAO 真实形态比例派生。 */
export function datasetShape(scale) {
  return {
    workspaces: Math.max(4, Math.round(scale / 25)),
    tasks: Math.max(20, Math.round(scale / 3)),
    executions: scale,
    nodeExecPerExec: 4,
    agentEventsPerNode: 6,
    messages: scale * 4,
    harnessEvents: scale * 2,
  }
}

const pad = (n, w) => String(n).padStart(w, '0')
const hex = (rng, n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rng() * 16)]).join('')

/** 定长中文混排内容样本（FTS/jsonb 都吃过的形态，取 ~240 字符）。 */
function sampleContent(rng, tag) {
  const zh = '执行链路延迟基准：节点输出回写、交互消息分页与事件循环阻塞探测。'
  const base = `[${tag}] ${zh}`
  const reps = Math.ceil(240 / base.length)
  let s = base.repeat(reps)
  s = `${s} seq=${pad(Math.floor(rng() * 100000), 5)} h=${hex(rng, 8)}`
  return s.slice(0, 260)
}

const isoAt = (baseMs, offsetMs) => new Date(baseMs + offsetMs).toISOString()

/**
 * 建种子数据集（引擎无关的中性行；bool 用 0/1，toPg 适配层翻 true/false）。
 * 返回 { shape, rows: { workspaces, tasks, executions, nodeExecutions,
 *   agentEvents, messages, harnessEvents }, ids: {...} }
 */
export function buildSeedDataset(scale, seed = DEFAULT_SEED) {
  const rng = mulberry32(seed)
  const shape = datasetShape(scale)
  const T0 = Date.UTC(2026, 8, 28, 0, 0, 0) // 固定纪元：时间戳也确定
  const ORG = 'xzf'

  const workspaces = Array.from({ length: shape.workspaces }, (_, i) => ({
    id: `ws-perf-${pad(i, 6)}`, name: `perf-ws-${i}`, org: ORG,
    path: `~/.octopus/workspaces/perf-${i}`, status: 'active', source: 'user',
    created_at: isoAt(T0, i * 60_000), updated_at: isoAt(T0, i * 60_000 + 1000),
  }))

  // tasks：40% ready（due-scan 与 listByStatus 的命中率），其余 draft/running/done 轮转
  const taskStatuses = ['ready', 'ready', 'draft', 'running', 'done', 'awaiting_review']
  const tasks = Array.from({ length: shape.tasks }, (_, i) => {
    const status = taskStatuses[i % taskStatuses.length]
    const armed = status === 'ready' && i % 3 === 0
    return {
      id: `task-perf-${pad(i, 6)}`, org: ORG, name: `perf-task-${i}（基准）`, status,
      task_spec: JSON.stringify({ phases: Array.from({ length: 3 }, (_, p) => ({ id: `p${p}`, title: `phase ${p}` })), seed: i }),
      authoring_resources: '[]', resources: '[]', skills: '[]', project_ids: `["proj-${hex(rng, 6)}"]`,
      workflow_ref: status === 'draft' ? null : `wf://perf/${i % 7}`, version: 1,
      created_at: isoAt(T0, 3_600_000 + i * 30_000), updated_at: isoAt(T0, 3_600_000 + i * 30_000 + 2000),
      completed_at: status === 'done' ? isoAt(T0, 7_200_000 + i * 1000) : null,
      workspace_id: workspaces[i % workspaces.length].id,
      trigger_mode: armed ? 'cron' : 'manual', cron_expression: armed ? '0 * * * *' : null,
      cron_timezone: 'Asia/Shanghai', trigger_enabled: armed ? 1 : 0,
      next_fire_at: armed ? isoAt(T0, 1_000) : null, last_fired_at: null,
    }
  })

  // executions：60% completed / 20% running / 15% pending(claim 靶子) / 5% failed
  const executions = []
  const nodeExecutions = []
  const agentEvents = []
  const statusPick = (i) => (i % 20 < 12 ? 'completed' : i % 20 < 16 ? 'running' : i % 20 < 19 ? 'pending' : 'failed')
  for (let i = 0; i < shape.executions; i++) {
    const status = statusPick(i)
    const ws = workspaces[i % workspaces.length]
    const started = isoAt(T0, 10_000 + i * 5_000)
    const exec = {
      id: `exec-perf-${pad(i, 8)}`, workspace_id: ws.id, parent_id: '0', child_index: 0,
      workflow_ref: `wf://perf/${i % 7}`, workflow_name: `perf-flow-${i % 7}`, status,
      gate_status: 'closed', rollback: 'none', rollback_on_error: 0,
      input_values: JSON.stringify({ branch: `feat/perf-${i % 9}`, depth: i % 3 }),
      var_pool: JSON.stringify({ vars: { idx: i, blob: sampleContent(rng, `vp-${i}`) } }),
      progress: status === 'completed' ? 100 : i % 100, triggered_by: 'manual', node_type: 'normal',
      branch: `feat/perf-${i % 9}`, start_commit_id: null, end_commit_id: null,
      name: `run-${i}`, global_session_id: null, approval_metadata: null, interaction_metadata: null,
      chain_retry_count: 0, preset_inputs: null, phase_index: i % 4 === 0 ? i % 4 : null, round_index: null,
      task_id: tasks.length > 0 && i % 5 === 0 ? tasks[i % tasks.length].id : null,
      started_at: started,
      completed_at: status === 'completed' ? isoAt(T0, 10_000 + i * 5_000 + 240_000) : null,
      duration: status === 'completed' ? 240_000 + (i % 97) * 100 : null,
      org: ORG, created_at: started, updated_at: isoAt(T0, 10_000 + i * 5_000 + 900),
    }
    executions.push(exec)
    for (let n = 0; n < shape.nodeExecPerExec; n++) {
      const node = {
        id: `node-perf-${pad(i * shape.nodeExecPerExec + n, 9)}`, execution_id: exec.id,
        node_id: `node-${n}`, node_type: ['agent', 'deterministic', 'interaction', 'loop'][n % 4],
        status: status === 'pending' ? 'pending' : 'completed',
        started_at: isoAt(T0, 10_000 + i * 5_000 + n * 1000),
        completed_at: status === 'pending' ? null : isoAt(T0, 10_000 + i * 5_000 + n * 1000 + 800),
        duration: status === 'pending' ? null : 800, exit_code: 0, error: null,
        vars_snapshot: JSON.stringify({ snapshot: sampleContent(rng, `vs-${n}`) }),
        outputs: status === 'completed' ? JSON.stringify({ result: `out-${n}`, i }) : null,
        session_id: null, parent_node_id: null, iteration_index: null,
      }
      nodeExecutions.push(node)
      for (let e = 0; e < shape.agentEventsPerNode; e++) {
        agentEvents.push({
          node_execution_id: node.id, event_order: e, turn_index: e,
          event_type: ['assistant', 'tool_call', 'tool_result', 'status'][e % 4],
          timestamp: 10_000 + i * 5_000 + n * 1000 + e * 50,
          content: sampleContent(rng, `ev-${e}`), content_length: 260,
          tool_call_id: e % 2 === 0 ? `tc-${hex(rng, 10)}` : null,
          tool_name: e % 2 === 0 ? 'bash' : null, tool_input: e % 2 === 0 ? '{"cmd":"ls"}' : null,
          tool_result: null, tool_is_error: 0, tool_duration_ms: null,
          status_value: e % 4 === 3 ? 'running' : null, error_code: null, error_message: null,
        })
      }
    }
  }

  // ux_exec_task_active 闩锁（两引擎同款部分唯一索引）：一个 task 同时最多一个
  // 非终态实例 —— 装载前把重复挂到同一 task 的活跃行改回无主（task_id NULL），
  // 与真实形态一致（多数 task 只有终态历史行）。
  const activeSeen = new Set()
  const TERMINAL = new Set(['completed', 'completed_with_failures', 'failed', 'cancelled', 'aborted', 'skipped', 'rejected'])
  for (const e of executions) {
    if (!e.task_id) continue
    if (TERMINAL.has(e.status)) continue
    if (activeSeen.has(e.task_id)) e.task_id = null
    else activeSeen.add(e.task_id)
  }

  const messages = Array.from({ length: shape.messages }, (_, m) => {
    const nodeExec = nodeExecutions[m % nodeExecutions.length]
    return {
      id: `msg-perf-${pad(m, 8)}`, execution_id: nodeExec.execution_id, node_id: nodeExec.node_id,
      role: m % 2 === 0 ? 'agent' : 'user', type: 'text', content: sampleContent(rng, `msg-${m}`),
      metadata: JSON.stringify({ turn: m % 6, source: 'perf-seed' }),
      created_at: isoAt(T0, 20_000 + m * 300),
    }
  })

  const harnessEvents = Array.from({ length: shape.harnessEvents }, (_, h) => {
    const exec = executions[h % executions.length]
    return {
      id: `hse-perf-${pad(h, 8)}`, execution_id: exec.id,
      node_id: `node-${h % shape.nodeExecPerExec}`,
      timestamp: 30_000 + h * 700, event_type: ['drift', 'budget', 'intervention', 'verdict'][h % 4],
      detector: h % 2 === 0 ? 'effectiveness-tracker' : 'budget-guard', severity: ['info', 'warn', 'critical'][h % 3],
      report_json: JSON.stringify({ metric: `m${h % 5}`, value: h / 100 }),
      action_json: h % 3 === 0 ? JSON.stringify({ action: 'intervene' }) : null,
      result_json: h % 4 === 0 ? JSON.stringify({ ok: true }) : null,
      token_usage_json: h % 5 === 0 ? JSON.stringify({ tokens: 1000 + h }) : null,
      created_at: isoAt(T0, 30_000 + h * 700),
    }
  })

  return {
    shape,
    // 固定纪元下的时间锚：dueBound 覆盖 armed 任务的 next_fire_at（T0+1s），
    // nowIso 供写 op 的时间戳参数 —— 全部确定性，两次运行逐字节可比。
    meta: { epochMs: T0, dueBound: isoAt(T0, 3_600_000), nowIso: isoAt(T0, 86_400_000) },
    rows: { workspaces, tasks, executions, nodeExecutions, agentEvents, messages, harnessEvents },
  }
}

/** 负载期写 op 的确定性内容样本（~260 字符，与种子同量级）。 */
export function loadContent(i) {
  return sampleContent(mulberry32(DEFAULT_SEED ^ (i * 0x9e3779b9)), `load-${i}`)
}

// ── 引擎适配 ─────────────────────────────────────────────────────────────────

/** better-sqlite3 不收 JS bool —— 统一把 true/false 归 1/0。 */
export function toSqliteParams(values) {
  return values.map((v) => (v === true ? 1 : v === false ? 0 : v))
}

// DAO 列表达式的两引擎镜像（读归一形态照抄已迁 DAO 的写法）
const TS = (col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const PG_TASK_COLS = `id, org, name, status, source_chat_session_id,
  task_spec #>> '{}' AS task_spec, authoring_resources #>> '{}' AS authoring_resources,
  resources #>> '{}' AS resources, skills #>> '{}' AS skills, project_ids #>> '{}' AS project_ids,
  workflow_ref, version,
  ${TS('deleted_at')} AS deleted_at, ${TS('created_at')} AS created_at,
  ${TS('updated_at')} AS updated_at, ${TS('completed_at')} AS completed_at,
  workspace_id, trigger_mode, ${TS('trigger_at')} AS trigger_at,
  cron_expression, cron_timezone, trigger_enabled::int AS trigger_enabled,
  ${TS('next_fire_at')} AS next_fire_at, ${TS('last_fired_at')} AS last_fired_at`

const SQLITE_TASK_COLS = `id, org, name, status, source_chat_session_id,
  task_spec, authoring_resources, resources, skills, project_ids,
  workflow_ref, version, deleted_at, created_at, updated_at, completed_at,
  workspace_id, trigger_mode, trigger_at, cron_expression, cron_timezone,
  trigger_enabled, next_fire_at, last_fired_at`

const PG_MSG_COLS = `id, execution_id, node_id, role, type, content, metadata #>> '{}' AS metadata, ${TS('created_at')} AS created_at`
const SQLITE_MSG_COLS = `id, execution_id, node_id, role, type, content, metadata, created_at`

// ── 测量 ctx（确定性参数源，bench / eloop 共用） ─────────────────────────────

export function makeLoadCtx(dataset, engineTag, opts) {
  const rng = mulberry32(((opts.seed ?? DEFAULT_SEED) ^ 0x5bd1e995) >>> 0)
  const ids = {
    exec: dataset.rows.executions.map((r) => r.id),
    execPending: dataset.rows.executions.filter((r) => r.status === 'pending').map((r) => r.id),
    ws: dataset.rows.workspaces.map((r) => r.id),
    task: dataset.rows.tasks.map((r) => r.id),
    taskStatus: ['ready', 'draft', 'running', 'done', 'awaiting_review'],
    node: dataset.rows.nodeExecutions.map((r) => r.id),
  }
  // 高起点：避开种子数据占用的 event_order 小值域（agent_events PK 含 event_order）
  let seqCounter = 100_000
  return {
    engineTag,
    dueBound: dataset.meta.dueBound,
    nowIso: dataset.meta.nowIso,
    seq: () => ++seqCounter,
    pick(table) {
      const pool = ids[table]
      if (!pool || pool.length === 0) {
        throw new Error(`ctx.pick(${table})：种子池为空（--scale 太小？）`)
      }
      return pool[Math.floor(rng() * pool.length)]
    },
    intAt: (bound) => Math.floor(rng() * bound),
    content: (i) => loadContent(i),
    epochMs: () => dataset.meta.epochMs + 86_400_000 + seqCounter,
  }
}

// ── 写 op 的行生成器（每次迭代唯一 id，不污染种子） ─────────────────────────

function genExecRow(ctx, i, ns = 'run') {
  const t = ctx.nowIso
  return {
    id: `exec-${ns}-${ctx.engineTag}-${pad(i, 8)}`, workspace_id: ctx.pick('ws'), parent_id: '0', child_index: 0,
    workflow_ref: 'wf://perf/load', workflow_name: 'perf-load', status: 'pending',
    gate_status: 'closed', rollback: 'none', rollback_on_error: false,
    input_values: '{"src":"perf"}', var_pool: JSON.stringify({ i, blob: `load-${i}` }),
    progress: 0, triggered_by: 'manual', node_type: 'normal', branch: 'feat/perf',
    start_commit_id: null, end_commit_id: null, name: `load-${i}`, global_session_id: null,
    approval_metadata: null, interaction_metadata: null, chain_retry_count: 0, preset_inputs: null,
    phase_index: null, round_index: null, task_id: null, started_at: t, completed_at: null, duration: null,
    org: 'xzf', created_at: t, updated_at: t,
  }
}

// ── op 目录 ──────────────────────────────────────────────────────────────────
// sql/values 成对镜像 DAO；占位：SQLite `?`，PG `$1..$n`。
// ctx: { rng, pick(table), nowIso, engineTag, rows(种子 id 数组), nextInsert }

const EXEC_INSERT_COLS = `id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
  status, gate_status, rollback, rollback_on_error, input_values, var_pool,
  progress, triggered_by, started_at, completed_at, duration, org,
  created_at, updated_at, node_type, branch, start_commit_id, end_commit_id,
  name, global_session_id, approval_metadata, interaction_metadata, chain_retry_count, preset_inputs,
  phase_index, round_index, task_id`

function execInsertValues(r) {
  return [r.id, r.workspace_id, r.parent_id, r.child_index, r.workflow_ref, r.workflow_name,
    r.status, r.gate_status, r.rollback, r.rollback_on_error, r.input_values, r.var_pool,
    r.progress, r.triggered_by, r.started_at, r.completed_at, r.duration, r.org,
    r.created_at, r.updated_at, r.node_type, r.branch, r.start_commit_id, r.end_commit_id,
    r.name, r.global_session_id, r.approval_metadata, r.interaction_metadata, r.chain_retry_count, r.preset_inputs,
    r.phase_index, r.round_index, r.task_id]
}

function placeholders(n, style) {
  return Array.from({ length: n }, (_, k) => (style === 'pg' ? `$${k + 1}` : '?')).join(', ')
}

export const OPS = [
  // ── 读路径（执行链路 + B1/B2 已迁 DAO 的等价操作） ──
  {
    id: 'read.exec_getById', class: 'read', dao: 'execution-dao.findById',
    sqlite: { sql: 'SELECT * FROM executions WHERE id = ?', values: (c) => [c.pick('exec')] },
    pg: { sql: 'SELECT * FROM executions WHERE id = $1', values: (c) => [c.pick('exec')] },
  },
  {
    id: 'read.exec_listByWorkspace', class: 'read', dao: 'execution-dao.findByWorkspace',
    sqlite: { sql: 'SELECT * FROM executions WHERE workspace_id = ? ORDER BY created_at DESC', values: (c) => [c.pick('ws')] },
    pg: { sql: 'SELECT * FROM executions WHERE workspace_id = $1 ORDER BY created_at DESC', values: (c) => [c.pick('ws')] },
  },
  {
    id: 'read.exec_findLatestTaskInstance', class: 'read', dao: 'execution-dao.findLatestTaskInstance（PG 无 rowid，镜像去掉二级排序）',
    sqlite: { sql: `SELECT * FROM executions WHERE task_id = ? AND (parent_id = '0' OR phase_index IS NOT NULL) ORDER BY created_at DESC, rowid DESC LIMIT 1`, values: (c) => [c.pick('task')] },
    pg: { sql: `SELECT * FROM executions WHERE task_id = $1 AND (parent_id = '0' OR phase_index IS NOT NULL) ORDER BY created_at DESC LIMIT 1`, values: (c) => [c.pick('task')] },
  },
  {
    id: 'read.exec_countByWorkspaceStatus', class: 'read', dao: 'execution-dao.countByWorkspaceAndStatus',
    sqlite: { sql: 'SELECT COUNT(*) as cnt FROM executions WHERE workspace_id = ? AND status = ?', values: (c) => [c.pick('ws'), 'running'] },
    pg: { sql: 'SELECT COUNT(*) as cnt FROM executions WHERE workspace_id = $1 AND status = $2', values: (c) => [c.pick('ws'), 'running'] },
  },
  {
    id: 'read.node_executionsByExec', class: 'read', dao: 'execution-dao.findNodeExecutions',
    sqlite: { sql: 'SELECT * FROM node_executions WHERE execution_id = ? ORDER BY id', values: (c) => [c.pick('exec')] },
    pg: { sql: 'SELECT * FROM node_executions WHERE execution_id = $1 ORDER BY id', values: (c) => [c.pick('exec')] },
  },
  {
    id: 'read.agent_eventsByNode', class: 'read', dao: 'execution-dao.findAgentEvents',
    sqlite: { sql: 'SELECT * FROM agent_events WHERE node_execution_id = ? ORDER BY event_order', values: (c) => [c.pick('node')] },
    pg: { sql: 'SELECT * FROM agent_events WHERE node_execution_id = $1 ORDER BY event_order', values: (c) => [c.pick('node')] },
  },
  {
    id: 'read.msg_findMessages', class: 'read', dao: 'interaction-message-dao.findMessages（LIMIT 100）',
    sqlite: { sql: `SELECT ${SQLITE_MSG_COLS} FROM interaction_messages WHERE execution_id = ? AND node_id = ? ORDER BY created_at ASC LIMIT ?`, values: (c) => [c.pick('exec'), `node-${c.intAt(4)}`, 100] },
    pg: { sql: `SELECT ${PG_MSG_COLS} FROM interaction_messages WHERE execution_id = $1 AND node_id = $2 ORDER BY created_at ASC LIMIT $3`, values: (c) => [c.pick('exec'), `node-${c.intAt(4)}`, 100] },
  },
  {
    id: 'read.msg_countMessages', class: 'read', dao: 'interaction-message-dao.countMessages',
    sqlite: { sql: 'SELECT COUNT(*) as count FROM interaction_messages WHERE execution_id = ? AND node_id = ?', values: (c) => [c.pick('exec'), `node-${c.intAt(4)}`] },
    pg: { sql: 'SELECT COUNT(*) as count FROM interaction_messages WHERE execution_id = $1 AND node_id = $2', values: (c) => [c.pick('exec'), `node-${c.intAt(4)}`] },
  },
  {
    id: 'read.harness_findEvents', class: 'read', dao: 'harness-dao.findEvents',
    sqlite: { sql: 'SELECT * FROM harness_events WHERE execution_id = ? ORDER BY timestamp ASC', values: (c) => [c.pick('exec')] },
    pg: { sql: 'SELECT * FROM harness_events WHERE execution_id = $1 ORDER BY timestamp ASC', values: (c) => [c.pick('exec')] },
  },
  {
    id: 'read.tasks_listByStatus', class: 'read', dao: 'task-dao.listByStatus（看板列）',
    sqlite: { sql: `SELECT ${SQLITE_TASK_COLS} FROM tasks WHERE status = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`, values: (c) => [c.pick('taskStatus')] },
    pg: { sql: `SELECT ${PG_TASK_COLS} FROM tasks WHERE status = $1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`, values: (c) => [c.pick('taskStatus')] },
  },
  {
    id: 'read.tasks_findDueTriggers', class: 'read', dao: 'task-dao.findDueTriggers（调度 due-scan，ADR-0021）',
    sqlite: { sql: `SELECT ${SQLITE_TASK_COLS} FROM tasks WHERE status = 'ready' AND deleted_at IS NULL AND trigger_enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at ASC, created_at ASC LIMIT ?`, values: (c) => [c.dueBound, 20] },
    pg: { sql: `SELECT ${PG_TASK_COLS} FROM tasks WHERE status = 'ready' AND deleted_at IS NULL AND trigger_enabled = true AND next_fire_at IS NOT NULL AND next_fire_at <= $1 ORDER BY next_fire_at ASC, created_at ASC LIMIT $2`, values: (c) => [c.dueBound, 20] },
  },

  // ── 写路径 ──
  {
    id: 'write.exec_insert', class: 'write', dao: 'execution-dao.insertExecution（33 列）',
    sqlite: { sql: `INSERT INTO executions (${EXEC_INSERT_COLS}) VALUES (${placeholders(33, 'sqlite')})`, values: (c, i) => execInsertValues(genExecRow(c, i)) },
    pg: { sql: `INSERT INTO executions (${EXEC_INSERT_COLS}) VALUES (${placeholders(33, 'pg')})`, values: (c, i) => execInsertValues(genExecRow(c, i)) },
  },
  {
    id: 'write.exec_claimPending', class: 'write', dao: 'execution-dao 任务实例认领（status pending→running）',
    sqlite: { sql: `UPDATE executions SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`, values: (c) => [c.nowIso, c.nowIso, c.pick('execPending')] },
    pg: { sql: `UPDATE executions SET status = 'running', started_at = $1, updated_at = $2 WHERE id = $3 AND status = 'pending'`, values: (c) => [c.nowIso, c.nowIso, c.pick('execPending')] },
  },
  {
    id: 'write.exec_updateFields', class: 'write', dao: 'execution-dao.updateExecution（progress+var_pool+updated_at）',
    sqlite: { sql: 'UPDATE executions SET progress = ?, var_pool = ?, updated_at = ? WHERE id = ?', values: (c) => [c.intAt(101), JSON.stringify({ i: c.seq(), hot: 1 }), c.nowIso, c.pick('exec')] },
    pg: { sql: 'UPDATE executions SET progress = $1, var_pool = $2, updated_at = $3 WHERE id = $4', values: (c) => [c.intAt(101), JSON.stringify({ i: c.seq(), hot: 1 }), c.nowIso, c.pick('exec')] },
  },
  {
    id: 'write.node_insertUpdate', class: 'write', steps: true,
    dao: 'execution-dao.insertNodeExecution + updateNodeExecution（完成态回写，两步各自单语句）',
    sqlite: [
      { sql: 'INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration, exit_code, error, vars_snapshot, outputs, session_id, parent_node_id, iteration_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', values: (c, i) => [`node-run-${c.engineTag}-${pad(i, 9)}`, c.pick('exec'), 'node-load', 'agent', 'running', c.nowIso, null, null, null, null, '{"a":1}', null, null, null, null] },
      { sql: "UPDATE node_executions SET status = 'completed', completed_at = ?, duration = ?, outputs = ? WHERE id = ?", values: (c, i) => [c.nowIso, 500, '{"done":true}', `node-run-${c.engineTag}-${pad(i, 9)}`] },
    ],
    pg: [
      { sql: 'INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration, exit_code, error, vars_snapshot, outputs, session_id, parent_node_id, iteration_index) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)', values: (c, i) => [`node-run-${c.engineTag}-${pad(i, 9)}`, c.pick('exec'), 'node-load', 'agent', 'running', c.nowIso, null, null, null, null, '{"a":1}', null, null, null, null] },
      { sql: 'UPDATE node_executions SET status = \'completed\', completed_at = $1, duration = $2, outputs = $3 WHERE id = $4', values: (c, i) => [c.nowIso, 500, '{"done":true}', `node-run-${c.engineTag}-${pad(i, 9)}`] },
    ],
  },
  {
    id: 'write.msg_insert', class: 'write', dao: 'interaction-message-dao.insertMessage',
    sqlite: { sql: 'INSERT INTO interaction_messages (id, execution_id, node_id, role, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', values: (c, i) => [`msg-run-${c.engineTag}-${pad(i, 8)}`, c.pick('exec'), 'node-0', 'agent', 'text', c.content(i), JSON.stringify({ turn: i % 6, source: 'perf-load' }), c.nowIso] },
    pg: { sql: 'INSERT INTO interaction_messages (id, execution_id, node_id, role, type, content, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', values: (c, i) => [`msg-run-${c.engineTag}-${pad(i, 8)}`, c.pick('exec'), 'node-0', 'agent', 'text', c.content(i), JSON.stringify({ turn: i % 6, source: 'perf-load' }), c.nowIso] },
  },
  {
    id: 'write.harness_insert', class: 'write', dao: 'harness-dao.insertEvent（created_at now() 侧差异保留各自默认写法）',
    sqlite: { sql: `INSERT INTO harness_events (id, execution_id, node_id, timestamp, event_type, detector, severity, report_json, action_json, result_json, token_usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`, values: (c, i) => [`hse-run-${c.engineTag}-${pad(i, 8)}`, c.pick('exec'), 'node-0', c.epochMs(i), 'drift', 'effectiveness-tracker', 'warn', '{"metric":"load","value":1}', null, null, null] },
    pg: { sql: `INSERT INTO harness_events (id, execution_id, node_id, timestamp, event_type, detector, severity, report_json, action_json, result_json, token_usage_json, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`, values: (c, i) => [`hse-run-${c.engineTag}-${pad(i, 8)}`, c.pick('exec'), 'node-0', c.epochMs(i), 'drift', 'effectiveness-tracker', 'warn', '{"metric":"load","value":1}', null, null, null] },
  },
  {
    id: 'write.agent_insert', class: 'write', dao: 'execution-dao.insertAgentEvent',
    sqlite: { sql: `INSERT INTO agent_events (node_execution_id, event_order, turn_index, event_type, timestamp, content, content_length, tool_call_id, tool_name, tool_input, tool_result, tool_is_error, tool_duration_ms, status_value, error_code, error_message) VALUES (${placeholders(16, 'sqlite')})`, values: (c, i) => [c.pick('node'), c.seq(), i % 6, 'assistant', c.epochMs(i), c.content(i), 260, null, null, null, null, false, null, null, null, null] },
    pg: { sql: `INSERT INTO agent_events (node_execution_id, event_order, turn_index, event_type, timestamp, content, content_length, tool_call_id, tool_name, tool_input, tool_result, tool_is_error, tool_duration_ms, status_value, error_code, error_message) VALUES (${placeholders(16, 'pg')})`, values: (c, i) => [c.pick('node'), c.seq(), i % 6, 'assistant', c.epochMs(i), c.content(i), 260, null, null, null, null, false, null, null, null, null] },
  },
  {
    id: 'write.task_updateWithVersion', class: 'write', dao: 'task-dao.updateWithVersion（乐观锁写）',
    sqlite: { sql: 'UPDATE tasks SET name = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND deleted_at IS NULL', values: (c) => [`renamed-${c.seq()}`, c.nowIso, c.pick('task'), 1] },
    pg: { sql: 'UPDATE tasks SET name = $1, updated_at = $2, version = version + 1 WHERE id = $3 AND version = $4 AND deleted_at IS NULL', values: (c) => [`renamed-${c.seq()}`, c.nowIso, c.pick('task'), 1] },
  },
  {
    id: 'write.tx_batch_exec_updates', class: 'tx', dao: 'B5 事务簇形态：单事务 4 UPDATE + 1 INSERT',
    txStatements: (c, i) => [
      {
        sqlite: { sql: 'UPDATE executions SET progress = ?, updated_at = ? WHERE id = ?', values: [c.intAt(101), c.nowIso, c.pick('exec')] },
        pg: { sql: 'UPDATE executions SET progress = $1, updated_at = $2 WHERE id = $3', values: [c.intAt(101), c.nowIso, c.pick('exec')] },
      },
      {
        sqlite: { sql: 'UPDATE executions SET progress = ?, updated_at = ? WHERE id = ?', values: [c.intAt(101) + 1, c.nowIso, c.pick('exec')] },
        pg: { sql: 'UPDATE executions SET progress = $1, updated_at = $2 WHERE id = $3', values: [c.intAt(101) + 1, c.nowIso, c.pick('exec')] },
      },
      {
        sqlite: { sql: 'UPDATE node_executions SET status = ?, completed_at = ? WHERE id = ?', values: ['completed', c.nowIso, c.pick('node')] },
        pg: { sql: 'UPDATE node_executions SET status = $1, completed_at = $2 WHERE id = $3', values: ['completed', c.nowIso, c.pick('node')] },
      },
      {
        sqlite: { sql: 'UPDATE tasks SET updated_at = ? WHERE id = ? AND deleted_at IS NULL', values: [c.nowIso, c.pick('task')] },
        pg: { sql: 'UPDATE tasks SET updated_at = $1 WHERE id = $2 AND deleted_at IS NULL', values: [c.nowIso, c.pick('task')] },
      },
      {
        sqlite: { sql: 'INSERT INTO interaction_messages (id, execution_id, node_id, role, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', values: [`msg-tx-${c.engineTag}-${pad(i, 8)}`, c.pick('exec'), 'node-0', 'agent', 'text', c.content(i), '{"tx":1}', c.nowIso] },
        pg: { sql: 'INSERT INTO interaction_messages (id, execution_id, node_id, role, type, content, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', values: [`msg-tx-${c.engineTag}-${pad(i, 8)}`, c.pick('exec'), 'node-0', 'agent', 'text', c.content(i), '{"tx":1}', c.nowIso] },
      },
    ],
  },

  {
    id: 'chain.exec_round', class: 'chain', steps: true,
    dao: 'chainSteps()：执行链一轮 = ExecutionLifecycle 形态的等价顺序串联（insert exec → claim → 2 节点 insert → 4 agent 事件 → 2 节点完成回写 → 2 交互消息 → 2 harness 事件 → exec 完成 → task 状态推进）。判据②「执行链路 p99」在链路粒度比这一行；逐语句行做诊断细节。',
    sqlite: chainSteps('sqlite'),
    pg: chainSteps('pg'),
  },
]

/**
 * chain.exec_round 的两引擎 steps 数组（同一逻辑序列、方言镜像）。
 * 一轮 = 一次「执行实例从武装到完成」的 DAO 调用面，18 条语句。
 */
function chainSteps(style) {
  const P = (n) => placeholders(n, style)
  const v = (col) => (style === 'pg' ? `$${col}` : '?')
  const steps = []
  steps.push({ sql: `INSERT INTO executions (${EXEC_INSERT_COLS}) VALUES (${P(33)})`, values: (c, i) => execInsertValues(genExecRow(c, i, 'c')) })
  steps.push({
    sql: `UPDATE executions SET status = 'running', started_at = ${v(2)}, updated_at = ${v(3)} WHERE id = ${v(1)} AND status = 'pending'`,
    values: (c, i) => [`exec-c-${c.engineTag}-${pad(i, 8)}`, c.nowIso, c.nowIso],
  })
  for (const n of [0, 1]) {
    steps.push({
      sql: `INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration, exit_code, error, vars_snapshot, outputs, session_id, parent_node_id, iteration_index) VALUES (${P(15)})`,
      values: (c, i) => [`node-${c.engineTag}-chain-${pad(i, 9)}-${n}`, `exec-c-${c.engineTag}-${pad(i, 8)}`, `node-${n}`, 'agent', 'running', c.nowIso, null, null, null, null, '{"chain":1}', null, null, null, null],
    })
  }
  for (const e of [0, 1, 2, 3]) {
    steps.push({
      sql: `INSERT INTO agent_events (node_execution_id, event_order, turn_index, event_type, timestamp, content, content_length, tool_call_id, tool_name, tool_input, tool_result, tool_is_error, tool_duration_ms, status_value, error_code, error_message) VALUES (${P(16)})`,
      values: (c, i) => [`node-${c.engineTag}-chain-${pad(i, 9)}-${e % 2}`, c.seq(), e, 'assistant', c.epochMs(), loadContent(i * 4 + e), 260, null, null, null, null, false, null, null, null, null],
    })
  }
  for (const n of [0, 1]) {
    steps.push({
      sql: `UPDATE node_executions SET status = 'completed', completed_at = ${v(2)}, duration = ${v(3)}, outputs = ${v(4)} WHERE id = ${v(1)}`,
      values: (c, i) => [`node-${c.engineTag}-chain-${pad(i, 9)}-${n}`, c.nowIso, 500, `{"done":${n}}`],
    })
  }
  for (const m of [0, 1]) {
    steps.push({
      sql: `INSERT INTO interaction_messages (id, execution_id, node_id, role, type, content, metadata, created_at) VALUES (${P(8)})`,
      values: (c, i) => [`msg-${c.engineTag}-chain-${pad(i, 9)}-${m}`, `exec-c-${c.engineTag}-${pad(i, 8)}`, `node-${m}`, 'agent', 'text', loadContent(i * 2 + m), '{"chain":1}', c.nowIso],
    })
  }
  for (const h of [0, 1]) {
    steps.push(style === 'pg'
      ? { sql: 'INSERT INTO harness_events (id, execution_id, node_id, timestamp, event_type, detector, severity, report_json, action_json, result_json, token_usage_json, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())', values: (c, i) => [`hse-${c.engineTag}-chain-${pad(i, 9)}-${h}`, `exec-c-${c.engineTag}-${pad(i, 8)}`, `node-${h}`, c.epochMs(), 'drift', 'effectiveness-tracker', 'warn', '{"chain":1}', null, null, null] }
      : { sql: "INSERT INTO harness_events (id, execution_id, node_id, timestamp, event_type, detector, severity, report_json, action_json, result_json, token_usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))", values: (c, i) => [`hse-${c.engineTag}-chain-${pad(i, 9)}-${h}`, `exec-c-${c.engineTag}-${pad(i, 8)}`, `node-${h}`, c.epochMs(), 'drift', 'effectiveness-tracker', 'warn', '{"chain":1}', null, null, null] })
  }
  steps.push({
    sql: `UPDATE executions SET status = 'completed', completed_at = ${v(2)}, duration = ${v(3)}, progress = ${v(4)}, updated_at = ${v(5)} WHERE id = ${v(1)}`,
    values: (c, i) => [`exec-c-${c.engineTag}-${pad(i, 8)}`, c.nowIso, 5000, 100, c.nowIso],
  })
  steps.push({
    sql: `UPDATE tasks SET status = CASE WHEN status = 'ready' THEN 'running' ELSE status END, updated_at = ${v(1)} WHERE id = ${v(2)} AND deleted_at IS NULL`,
    values: (c) => [c.nowIso, c.pick('task')],
  })
  return steps
}

// ── 种子装载 ─────────────────────────────────────────────────────────────────

const WS_INSERT = 'INSERT INTO workspaces (id, name, org, path, created_at, updated_at, status, source) VALUES'
const TASK_INSERT_COLS = `id, org, name, status, task_spec, authoring_resources, resources, skills, project_ids,
  workflow_ref, version, created_at, updated_at, completed_at, workspace_id,
  trigger_mode, cron_expression, cron_timezone, trigger_enabled, next_fire_at, last_fired_at`
const EXEC_INSERT = `INSERT INTO executions (${EXEC_INSERT_COLS}) VALUES`
const NODE_INSERT = `INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration, exit_code, error, vars_snapshot, outputs, session_id, parent_node_id, iteration_index) VALUES`
const AGENT_INSERT = `INSERT INTO agent_events (node_execution_id, event_order, turn_index, event_type, timestamp, content, content_length, tool_call_id, tool_name, tool_input, tool_result, tool_is_error, tool_duration_ms, status_value, error_code, error_message) VALUES`
const MSG_INSERT = 'INSERT INTO interaction_messages (id, execution_id, node_id, role, type, content, metadata, created_at) VALUES'
const HSE_INSERT = 'INSERT INTO harness_events (id, execution_id, node_id, timestamp, event_type, detector, severity, report_json, action_json, result_json, token_usage_json, created_at) VALUES'

function bool(v, style) { return style === 'pg' ? (v ? true : false) : (v ? 1 : 0) }

/** 各表的行→参数映射（style 决定 bool 形态）。 */
function seedRowsFor(style) {
  return [
    {
      head: WS_INSERT, cols: 8,
      rows: (d) => d.rows.workspaces,
      params: (r) => [r.id, r.name, r.org, r.path, r.created_at, r.updated_at, r.status, r.source],
    },
    {
      head: `INSERT INTO tasks (${TASK_INSERT_COLS}) VALUES`, cols: 21,
      rows: (d) => d.rows.tasks,
      params: (r) => [r.id, r.org, r.name, r.status, r.task_spec, r.authoring_resources, r.resources, r.skills, r.project_ids,
        r.workflow_ref, r.version, r.created_at, r.updated_at, r.completed_at, r.workspace_id,
        r.trigger_mode, r.cron_expression, r.cron_timezone, bool(r.trigger_enabled, style), r.next_fire_at, r.last_fired_at],
    },
    {
      head: EXEC_INSERT, cols: 33,
      rows: (d) => d.rows.executions,
      params: (r) => [r.id, r.workspace_id, r.parent_id, r.child_index, r.workflow_ref, r.workflow_name,
        r.status, r.gate_status, r.rollback, bool(r.rollback_on_error, style), r.input_values, r.var_pool,
        r.progress, r.triggered_by, r.started_at, r.completed_at, r.duration, r.org,
        r.created_at, r.updated_at, r.node_type, r.branch, r.start_commit_id, r.end_commit_id,
        r.name, r.global_session_id, r.approval_metadata, r.interaction_metadata, r.chain_retry_count, r.preset_inputs,
        r.phase_index, r.round_index, r.task_id],
    },
    {
      head: NODE_INSERT, cols: 15,
      rows: (d) => d.rows.nodeExecutions,
      params: (r) => [r.id, r.execution_id, r.node_id, r.node_type, r.status, r.started_at, r.completed_at,
        r.duration, r.exit_code, r.error, r.vars_snapshot, r.outputs, r.session_id, r.parent_node_id, r.iteration_index],
    },
    {
      head: AGENT_INSERT, cols: 16,
      rows: (d) => d.rows.agentEvents,
      params: (r) => [r.node_execution_id, r.event_order, r.turn_index, r.event_type, r.timestamp, r.content,
        r.content_length, r.tool_call_id, r.tool_name, r.tool_input, r.tool_result, bool(r.tool_is_error, style),
        r.tool_duration_ms, r.status_value, r.error_code, r.error_message],
    },
    {
      head: MSG_INSERT, cols: 8,
      rows: (d) => d.rows.messages,
      params: (r) => [r.id, r.execution_id, r.node_id, r.role, r.type, r.content, r.metadata, r.created_at],
    },
    {
      head: HSE_INSERT, cols: 12,
      rows: (d) => d.rows.harnessEvents,
      params: (r) => [r.id, r.execution_id, r.node_id, r.timestamp, r.event_type, r.detector, r.severity,
        r.report_json, r.action_json, r.result_json, r.token_usage_json, r.created_at],
    },
  ]
}

function chunkParams(valuesList, style, cols) {
  if (style === 'pg') {
    // $n 顺序展开（postgres.js unsafe 参数表）
    const out = []
    const groups = []
    for (const vals of valuesList) out.push(...vals)
    for (let g = 0; g < valuesList.length; g++) {
      groups.push(`(${Array.from({ length: cols }, (_, k) => `$${g * cols + k + 1}`).join(', ')})`)
    }
    return { text: groups.join(', '), params: out }
  }
  const groups = []
  for (let g = 0; g < valuesList.length; g++) groups.push(`(${Array.from({ length: cols }, () => '?').join(', ')})`)
  return { text: groups.join(', '), params: valuesList.flat() }
}

/**
 * SQLite 装载：单事务多行 VALUES 批量（500/批）。
 * 注意 tool_is_error/rollback_on_error 等 bool 已是 0/1（style=sqlite）。
 */
export function seedSqlite(db, dataset) {
  const specs = seedRowsFor('sqlite')
  const run = db.transaction(() => {
    for (const spec of specs) {
      const rows = spec.rows(dataset)
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map(spec.params)
        const { text, params } = chunkParams(chunk, 'sqlite', spec.cols)
        db.prepare(`${spec.head} ${text}`).run(...params)
      }
    }
  })
  run()
}

/**
 * PG 装载：每表一个事务（写只打随机 perf 库 —— 见 common.createPerfDatabase）。
 */
export async function seedPg(sql, dataset) {
  const specs = seedRowsFor('pg')
  for (const spec of specs) {
    const rows = spec.rows(dataset)
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map(spec.params)
      const { text, params } = chunkParams(chunk, 'pg', spec.cols)
      await sql.unsafe(`${spec.head} ${text}`, params)
    }
  }
}
