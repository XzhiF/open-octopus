// packages/server/src/services/execution/cross-exec-primer.ts
//
// [P1 B5 票5B · plan §9 最大人判项「同步→异步涟漪」裁决记录]
// shared/engine 的变量替换链（ExecutionLookup → CrossExecResolver → substituteVars/
// expression.resolveRefs → 全部 executor）是**同步字符串替换**接缝。把整链 async 化
// 会波及 engine/shared/web-app 三个包的生产基线（≈100 个调用点 + web-app 消费面），
// 超出票5B「server 生产侧归零」的作业面，留给票6/B6 专票裁决。
//
// 本文件采用**引擎创建期预取**：ExecutionDAO 迁 PG 后行读是异步的，但在 engine 构造
// 时刻（createEngine/start，均为 async）扫描 workflow 定义文本，把 $parent/$ancestor
// 将要用到的祖先链行与节点输出一次性经 PG 异步预取进 Map，随后喂给 shared 的同步
// ExecutionLookup 接口。缓存未命中 = 旧「查不到该行」语义（原样保留 token，不崩引擎）。
// $ref: 交叉输出同理（primeRefCache）。
import type { ExecutionLookup } from "@octopus/shared"
import type { ExecutionDAO } from "../../db/dao/execution-dao"

const PARENT_POOL_RE = /\$(?:parent|ancestor\[(\d+)\])\.(?:var_pool|input_values)\.\w+/g
const PARENT_OUT_RE = /\$parent\.\$([\w-]+)\.outputs\.\w+/g
const ANCESTOR_OUT_RE = /\$ancestor\[(\d+)\]\.\$([\w-]+)\.outputs\.\w+/g

/**
 * 预取 $parent/$ancestor 需要的行与节点输出，返回可直接喂给 CrossExecResolver 的
 * 同步 ExecutionLookup（数据来自 PG 异步预取，调用期零 DB 往返）。
 *
 * @param dao   ExecutionDAO（PG）
 * @param startExecId 当前执行 id（链的起点）
 * @param texts 需要扫描 token 的文本（workflow content / YAML 序列化即可）
 */
export async function primeCrossExecLookup(
  dao: ExecutionDAO,
  startExecId: string,
  texts: string[],
): Promise<ExecutionLookup> {
  const rows = new Map<string, { parent_id?: string | null; var_pool?: string | null; input_values?: string | null } | null>()
  const outputs = new Map<string, Record<string, unknown> | null>()

  const blob = texts.join("\n")

  // 1) 需要的祖先深度与 (level → nodeId) 集合
  let maxLevel = 0
  let hasChainRef = false
  for (const m of blob.matchAll(PARENT_POOL_RE)) {
    hasChainRef = true
    if (m[1] !== undefined) maxLevel = Math.max(maxLevel, parseInt(m[1], 10))
  }
  const nodeIdsByLevel = new Map<number, Set<string>>() // level 0 = parent
  for (const m of blob.matchAll(PARENT_OUT_RE)) {
    hasChainRef = true
    if (!nodeIdsByLevel.has(0)) nodeIdsByLevel.set(0, new Set())
    nodeIdsByLevel.get(0)!.add(m[1])
  }
  for (const m of blob.matchAll(ANCESTOR_OUT_RE)) {
    hasChainRef = true
    const lvl = parseInt(m[1], 10)
    maxLevel = Math.max(maxLevel, lvl)
    if (!nodeIdsByLevel.has(lvl)) nodeIdsByLevel.set(lvl, new Set())
    nodeIdsByLevel.get(lvl)!.add(m[2])
  }

  if (hasChainRef) {
    // 2) 沿 parent_id 链异步上溯，缓存 depth 0..maxLevel+1 的行
    //    （getById 会被用于当前行、父行、以及每一跳的中间行）
    let currentId: string | null = startExecId
    for (let hop = 0; hop <= maxLevel + 1 && currentId; hop++) {
      if (!rows.has(currentId)) {
        const r = await dao.findExecutionForLookup(currentId)
        rows.set(currentId, r ? { parent_id: r.parent_id, var_pool: r.var_pool, input_values: r.input_values } : null)
      }
      const row = rows.get(currentId)
      currentId = row?.parent_id && row.parent_id !== "0" ? row.parent_id : null
    }

    // 3) 对每个 (level, nodeId) 解析目标 id 并预取节点输出
    for (const [lvl, nodeIds] of nodeIdsByLevel) {
      // ancestor[lvl] = 上溯 lvl+1 跳（0-based: level 0 = parent）
      let id: string | null = startExecId
      for (let hop = 0; hop <= lvl && id; hop++) {
        let row = rows.get(id)
        if (row === undefined) {
          const r = await dao.findExecutionForLookup(id)
          row = r ? { parent_id: r.parent_id, var_pool: r.var_pool, input_values: r.input_values } : null
          rows.set(id, row)
        }
        id = row?.parent_id && row.parent_id !== "0" ? row.parent_id : null
      }
      if (!id) continue
      for (const nid of nodeIds) {
        const key = `${id}|${nid}`
        if (!outputs.has(key)) outputs.set(key, await dao.findNodeOutputs(id, nid))
      }
    }
  }

  return {
    getById: (eid: string) => rows.get(eid) ?? null,
    getNodeOutputs: (executionId: string, nodeId: string) => outputs.get(`${executionId}|${nodeId}`) ?? null,
  }
}

const REF_RE = /\$ref:([a-zA-Z0-9_.-]+)/g

/**
 * 预取 $ref:workflowRef.nodeId.outputKey 交叉输出 → 同步 resolver（engine.setRefResolver 接缝）。
 * 解析规则与 ExecutionLifecycle.createRefResolver 旧闭包逐字对齐。
 */
export async function primeRefResolver(
  dao: ExecutionDAO,
  workspaceDbId: string,
  texts: string[],
): Promise<(refPath: string) => any> {
  const cache = new Map<string, Record<string, any>>()

  for (const text of texts) {
    for (const m of text.matchAll(REF_RE)) {
      const refPath = m[1]
      const lastDot = refPath.lastIndexOf(".")
      if (lastDot === -1) continue
      const rest = refPath.slice(0, lastDot)
      const secondLastDot = rest.lastIndexOf(".")
      if (secondLastDot === -1) continue
      const nodeId = rest.slice(secondLastDot + 1)
      const workflowRef = rest.slice(0, secondLastDot)
      if (!workflowRef || !nodeId) continue
      const cacheKey = `${workflowRef}.${nodeId}`
      if (cache.has(cacheKey)) continue
      const row = await dao.findCrossExecOutputs(workflowRef, nodeId, workspaceDbId)
      if (row?.outputs) {
        try { cache.set(cacheKey, JSON.parse(row.outputs)) } catch { /* 坏 JSON 与旧闭包一致：视为未命中 */ }
      } else {
        cache.set(cacheKey, {})
      }
    }
  }

  return (refPath: string): any => {
    const lastDot = refPath.lastIndexOf(".")
    if (lastDot === -1) return undefined
    const rest = refPath.slice(0, lastDot)
    const secondLastDot = rest.lastIndexOf(".")
    if (secondLastDot === -1) return undefined
    const nodeId = rest.slice(secondLastDot + 1)
    const workflowRef = rest.slice(0, secondLastDot)
    if (!workflowRef || !nodeId) return undefined
    const outputs = cache.get(`${workflowRef}.${nodeId}`)
    if (outputs === undefined) return undefined
    const key = refPath.slice(lastDot + 1)
    return outputs[key]
  }
}
