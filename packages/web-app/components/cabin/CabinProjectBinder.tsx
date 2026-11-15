'use client'

// 绑定项目（plan §6.3 / design 17 §3.2）：
// 与 TaskProjectChip 的关键差别 —— **跨 org 聚合、切 org 不清空**。
// 四件东西：搜索（打开即聚焦、命中高亮）· 已选条（可单个移除）·
// 按 org 分组带计数 · 列表自己滚（248px）。
// 语义写在面板底部：项目是关联关系，不搬代码。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { fetchManifestRepos } from '@/lib/api-client'
import { useOrgs } from '@/hooks/useOrgs'
import { projectKey, type CabinProjectRef } from '@/lib/cabin-draft'
import './CabinCreateHero.css'

interface ProjectOption extends CabinProjectRef {
  group: string
}

const CACHE_TTL = 60_000
const cache = new Map<string, { at: number; repos: CabinProjectRef[] }>()

interface ManifestShape {
  groups?: Record<string, Array<{ name?: string; group?: string }>>
}

async function loadOrgRepos(org: string): Promise<CabinProjectRef[]> {
  const hit = cache.get(org)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.repos
  const data = (await fetchManifestRepos(org)) as ManifestShape
  const repos: CabinProjectRef[] = []
  for (const items of Object.values(data?.groups ?? {})) {
    for (const item of items ?? []) {
      if (!item?.name) continue
      // 归属 org = 被查询的那个 org（manifest 里的 group 是仓库分组，不是 org）。
      repos.push({ org, repo: item.name })
    }
  }
  cache.set(org, { at: Date.now(), repos })
  return repos
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface CabinProjectBinderProps {
  selected: CabinProjectRef[]
  onChange: (next: CabinProjectRef[]) => void
  /** 目录原来有项目时的回显说明。 */
  echoHint?: string | null
}

export function CabinProjectBinder({ selected, onChange, echoHint }: CabinProjectBinderProps) {
  const { orgs, loading: orgsLoading } = useOrgs()
  const [options, setOptions] = useState<ProjectOption[]>([])
  const [loading, setLoading] = useState(true)
  const [failedOrgs, setFailedOrgs] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)
  // 依赖用稳定的 org 名串：useOrgs 每次返回新数组时不能触发重复拉取
  // （否则 setState → 重渲染 → effect 再跑，直接死循环）。
  const orgKey = orgs.map((o) => o.name).join('|')

  useEffect(() => {
    let alive = true
    const names = orgKey ? orgKey.split('|') : []
    if (names.length === 0) {
      if (!orgsLoading) setLoading(false)
      return
    }
    setLoading(true)
    setFailedOrgs([])
    void Promise.all(
      names.map(async (org) => {
        try {
          const repos = await loadOrgRepos(org)
          return { org, repos, failed: false as const }
        } catch {
          return { org, repos: [] as CabinProjectRef[], failed: true as const }
        }
      }),
    ).then((results) => {
      if (!alive) return
      const next: ProjectOption[] = []
      const failed: string[] = []
      for (const result of results) {
        if (result.failed) failed.push(result.org)
        for (const repo of result.repos) {
          next.push({ org: repo.org || result.org, repo: repo.repo, group: result.org })
        }
      }
      setOptions(next)
      setFailedOrgs(failed)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [orgKey, orgsLoading])

  useEffect(() => {
    const timer = window.setTimeout(() => searchRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [])

  const selectedKeys = useMemo(() => new Set(selected.map(projectKey)), [selected])
  const needle = query.trim().toLowerCase()

  const hits = useMemo(() => {
    if (!needle) return options
    return options.filter(
      (p) => p.repo.toLowerCase().includes(needle) || p.org.toLowerCase().includes(needle),
    )
  }, [options, needle])

  const perOrg = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of hits) map.set(p.org, (map.get(p.org) ?? 0) + 1)
    return map
  }, [hits])

  const highlight = (text: string) => {
    if (!needle) return text
    const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, 'ig'))
    return parts.map((part, index) =>
      part.toLowerCase() === needle
        ? <mark key={`${part}-${index}`}>{part}</mark>
        : <span key={`${part}-${index}`}>{part}</span>,
    )
  }

  const toggle = (option: ProjectOption) => {
    const key = projectKey(option)
    onChange(
      selectedKeys.has(key)
        ? selected.filter((p) => projectKey(p) !== key)
        : [...selected, { org: option.org, repo: option.repo }],
    )
  }

  const remove = (target: CabinProjectRef) => {
    const key = projectKey(target)
    onChange(selected.filter((p) => projectKey(p) !== key))
  }

  const totalLabel = loading ? '读取仓库清单…' : `共 ${options.length} 个`

  return (
    <div data-testid="cabin-project-binder">
      <div className="cc-ph">绑定项目</div>

      <div className="cc-search">
        <Search className="size-3" strokeWidth={2} />
        <input
          ref={searchRef}
          data-testid="cabin-project-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`搜项目名或 org…（${totalLabel}）`}
          aria-label="搜索项目或 org"
        />
        {query && (
          <button
            type="button"
            className="cc-clr"
            data-testid="cabin-project-clear"
            onClick={() => {
              setQuery('')
              searchRef.current?.focus()
            }}
          >
            清空
          </button>
        )}
      </div>

      {selected.length > 0 && (
        <div className="cc-selbar" data-testid="cabin-project-selected">
          {selected.map((p) => (
            <span key={projectKey(p)} className="cc-sc" data-selected-project={projectKey(p)}>
              {p.repo}
              <b>{p.org}</b>
              <button type="button" title="移除" aria-label={`移除 ${p.org}/${p.repo}`} onClick={() => remove(p)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="cc-list" data-testid="cabin-project-list">
        {loading ? (
          <div className="cc-none flex items-center gap-2">
            <Loader2 className="size-3 animate-spin" /> 读取仓库清单…
          </div>
        ) : hits.length === 0 ? (
          <div className="cc-none">{needle ? `没有匹配「${query.trim()}」的项目` : '还没有可绑定的项目'}</div>
        ) : (
          <ProjectGroups
            hits={hits}
            perOrg={perOrg}
            selectedKeys={selectedKeys}
            onToggle={toggle}
            highlight={highlight}
          />
        )}
      </div>

      {echoHint && <div className="cc-echo" data-testid="cabin-project-echo">{echoHint}</div>}
      {failedOrgs.length > 0 && (
        <div className="cc-note" data-testid="cabin-project-failed">
          注册表读取失败：{failedOrgs.join('、')} —— 可稍后再绑，不挡创建。
        </div>
      )}
      <div className="cc-note">项目是关联关系，不搬代码 —— 可跨多个 org 一起绑。</div>
    </div>
  )
}

function ProjectGroups({
  hits,
  perOrg,
  selectedKeys,
  onToggle,
  highlight,
}: {
  hits: ProjectOption[]
  perOrg: Map<string, number>
  selectedKeys: Set<string>
  onToggle: (option: ProjectOption) => void
  highlight: (text: string) => React.ReactNode
}) {
  const rows: React.ReactNode[] = []
  let lastOrg = ''
  for (const option of hits) {
    if (option.org !== lastOrg) {
      lastOrg = option.org
      rows.push(
        <div key={`org-${option.org}`} className="cc-org">
          {option.org} <span className="n">{perOrg.get(option.org) ?? 0}</span>
        </div>,
      )
    }
    const key = projectKey(option)
    const on = selectedKeys.has(key)
    rows.push(
      <button
        key={`p-${key}`}
        type="button"
        className="cc-it"
        data-on={on ? 'true' : 'false'}
        data-project-key={key}
        onClick={() => onToggle(option)}
      >
        <span className="cc-p">{highlight(option.repo)}</span>
        <span className="cc-tag">{option.org}</span>
        <span className="cc-ck" />
      </button>,
    )
  }
  return <>{rows}</>
}