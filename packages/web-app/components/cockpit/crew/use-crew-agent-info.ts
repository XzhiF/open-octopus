'use client'

// 汐音 · Agent 档案（2026-11-19 用户 #7）：「更多 → ♡ 汐音」面板里的只读信息。
// 三个真源，全部只读：
//   · 人格 = GET /api/clones/cabin-orchestrator/files/persona.md
//   · 技能 = GET /api/agent/skills（她是全能舱主，没有白名单，看到的就是全部共享技能）
//   · 工具 = GET /api/agent/mcp/servers（只列她主对话实际挂的三套）+ 内建工具清单
// 失败保留上一份并给 loading=false —— 不把「接口失败」画成「她没有技能 / 没有工具」。
// 60s 模块级缓存：面板开合不重复打接口。

import { useEffect, useState } from 'react'
import { getCloneFile, listMcpServers, listSkills, type McpServerMeta } from '@/lib/agent/api'

export const CREW_CLONE = 'cabin-orchestrator'

/** 汐音主对话实际挂载的 in-process MCP（与 chat-routes 的 toolServers 同源）。 */
export const CREW_MCP_SERVERS = ['octopus-cabin', 'octopus-workflow', 'octopus-memory'] as const

/** 内建工具（SDK 默认全量、无 disallowedTools）——「工具」行的事实补充。 */
export const CREW_BUILTIN_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task', 'WebFetch', 'Skill',
] as const

const TTL_MS = 60_000

interface Snapshot {
  at: number
  persona: string | null
  skills: string[]
  mcp: McpServerMeta[]
}

let cache: Snapshot | null = null
let inflight: Promise<Snapshot> | null = null

function load(): Promise<Snapshot> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache)
  if (inflight) return inflight
  inflight = Promise.all([
    getCloneFile(CREW_CLONE, 'persona.md')
      .then((res) => res.content)
      .catch(() => null),
    listSkills()
      .then((res) => (res.skills ?? res.items ?? []).map((item) => item.name))
      .catch(() => [] as string[]),
    listMcpServers()
      .then((res) =>
        (res.servers ?? []).filter((server) =>
          (CREW_MCP_SERVERS as readonly string[]).includes(server.server),
        ),
      )
      .catch(() => [] as McpServerMeta[]),
  ])
    .then(([persona, skills, mcp]) => {
      cache = { at: Date.now(), persona, skills, mcp }
      return cache
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 测试用：清掉模块级缓存。 */
export function resetCrewAgentInfoCache(): void {
  cache = null
  inflight = null
}

export interface CrewAgentInfo {
  persona: string | null
  personaLines: number
  skills: string[]
  mcp: McpServerMeta[]
  loading: boolean
}

export function useCrewAgentInfo(): CrewAgentInfo {
  const [state, setState] = useState<CrewAgentInfo>(() => ({
    persona: cache?.persona ?? null,
    personaLines: cache?.persona ? cache.persona.split('\n').length : 0,
    skills: cache?.skills ?? [],
    mcp: cache?.mcp ?? [],
    loading: !cache,
  }))

  useEffect(() => {
    let alive = true
    load().then((data) => {
      if (!alive) return
      setState({
        persona: data.persona,
        personaLines: data.persona ? data.persona.split('\n').length : 0,
        skills: data.skills,
        mcp: data.mcp,
        loading: false,
      })
    })
    return () => {
      alive = false
    }
  }, [])

  return state
}
