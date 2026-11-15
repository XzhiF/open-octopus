'use client'

// 绑定项目（plan §6.3 / design 17 §3.2 · 舱籍第三轮 2026-11-15）：
// 与 TaskProjectChip 的关键差别 —— **跨 org 聚合、切 org 不清空**。
// 三件东西：搜索（打开即聚焦、命中高亮）· 已选条（可单个移除）·
// 两张来源分组：本地目录（建舱时映射，置顶）+ ORG 注册项目。
// 语义写在面板底部：项目是关联关系，不搬代码；ORG 主仓只读。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { fetchManifestRepos } from '@/lib/api-client'
import { scanLocalProjects, type LocalProjectCandidate } from '@/lib/cabin-api'
import { useOrgs } from '@/hooks/useOrgs'
import { projectKey, type CabinProjectRef } from '@/lib/cabin-draft'
import './CabinCreateHero.css'

interface ProjectOption extends CabinProjectRef {
  /** ORG 分组名（本地项为 LOCAL_GROUP）。 */
  group: string
}

const LOCAL_GROUP = '本地目录 · 建舱时映射'
const LOCAL_TAG = '本地'

const CACHE_TTL = 60_000
const cache = new Map<string, { at: number; repos: CabinProjectRef[] }>()
const localCache = new Map<string, { at: number; projects: LocalProjectCandidate[] }>()

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
      repos.push({ source: 'org', org, repo: item.name })
    }
  }
  cache.set(org, { at: Date.now(), repos })
  return repos
}

async function loadLocalProjects(dirPath: string): Promise<LocalProjectCandidate[]> {
  const hit = localCache.get(dirPath)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.projects
  const projects = await scanLocalProjects(dirPath)
  localCache.set(dirPath, { at: Date.now(), projects })
  return projects
}

function localToRef(p: LocalProjectCandidate): CabinProjectRef {
  return { source: 'local', repo: p.name, localPath: p.local_path }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface CabinProjectBinderProps {
  selected: CabinProjectRef[]
  onChange: (next: CabinProjectRef[]) => void
  /** 目录原来有项目时的回显说明。 */
  echoHint?: string | null
  /** 当前工作目录：给了才扫描本地项目（置顶分组）。 */
  dirPath?: string | null
  /** 深度 1 的本地项目是否默认勾上（建舱 = true；舱内绑定 = false）。 */
  autoSelectLocal?: boolean
}

export function CabinProjectBinder({
  selected, onChange, echoHint, dirPath, autoSelectLocal = true,
}: CabinProjectBinderProps) {
  const { orgs, loading: orgsLoading } = useOrgs()
  const [options, setOptions] = useState<ProjectOption[]>([])
  const [locals, setLocals] = useState<LocalProjectCandidate[]>([])
  const [localsLoading, setLocalsLoading] = useState(false)
  const [localsTouched, setLocalsTouched] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failedOrgs, setFailedOrgs] = useState<string[]>([])
  const [externalOpen, setExternalOpen] = useState(false)
  const [externalPath, setExternalPath] = useState('')
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
          next.push({ ...repo, group: result.org })
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

  // 本地目录扫描：目录确定后拉一次；深度 1 的仓库默认勾上（用户意图就是
  // 「目录下的项目」），深度 2 的留给用户自己选。
  useEffect(() => {
    if (!dirPath) {
      setLocals([])
      return
    }
    let alive = true
    setLocalsLoading(true)
    void loadLocalProjects(dirPath)
      .then((projects) => {
        if (!alive) return
        setLocals(projects)
        setLocalsLoading(false)
        if (localsTouched || !autoSelectLocal) return
        const depthOne = projects.filter((p) => !p.local_path.includes('/'))
        if (depthOne.length === 0) return
        const known = new Set(selected.map(projectKey))
        const add = depthOne.map(localToRef).filter((ref) => !known.has(projectKey(ref)))
        if (add.length > 0) onChange([...selected, ...add])
      })
      .catch(() => {
        if (alive) { setLocals([]); setLocalsLoading(false) }
      })
    return () => {
      alive = false
    }
    // selected/onChange 变化不应重新扫描；只跟目录走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirPath])

  useEffect(() => {
    const timer = window.setTimeout(() => searchRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [])

  const selectedKeys = useMemo(() => new Set(selected.map(projectKey)), [selected])
  const needle = query.trim().toLowerCase()

  const localHits = useMemo(() => {
    if (!needle) return locals
    return locals.filter(
      (p) => p.name.toLowerCase().includes(needle) || p.local_path.toLowerCase().includes(needle),
    )
  }, [locals, needle])

  const hits = useMemo(() => {
    if (!needle) return options
    return options.filter(
      (p) => p.repo.toLowerCase().includes(needle) || (p.org ?? '').toLowerCase().includes(needle),
    )
  }, [options, needle])

  const perOrg = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of hits) map.set(p.group, (map.get(p.group) ?? 0) + 1)
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

  const toggle = (ref: CabinProjectRef) => {
    const key = projectKey(ref)
    onChange(
      selectedKeys.has(key)
        ? selected.filter((p) => projectKey(p) !== key)
        : [...selected, ref],
    )
  }

  const toggleLocal = (p: LocalProjectCandidate) => {
    setLocalsTouched(true)
    toggle(localToRef(p))
  }

  const remove = (target: CabinProjectRef) => {
    const key = projectKey(target)
    onChange(selected.filter((p) => projectKey(p) !== key))
  }

  const addExternal = () => {
    const raw = externalPath.trim()
    if (!raw) return
    const repo = raw.split('/').filter(Boolean).pop() ?? raw
    const ref: CabinProjectRef = { source: 'local', repo, absolutePath: raw, external: true }
    if (!selectedKeys.has(projectKey(ref))) onChange([...selected, ref])
    setExternalPath('')
    setExternalOpen(false)
  }

  const totalLabel = loading
    ? '读取仓库清单…'
    : `共 ${options.length + locals.length} 个`

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
              <b>{p.source === 'local' ? (p.external ? '外部' : '本地') : p.org}</b>
              <button
                type="button"
                title="移除"
                aria-label={`移除 ${p.source === 'local' ? p.repo : `${p.org}/${p.repo}`}`}
                onClick={() => remove(p)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="cc-list" data-testid="cabin-project-list">
        {loading && localsLoading ? (
          <div className="cc-none flex items-center gap-2">
            <Loader2 className="size-3 animate-spin" /> 读取仓库清单…
          </div>
        ) : localHits.length === 0 && hits.length === 0 ? (
          <div className="cc-none">
            {needle ? `没有匹配「${query.trim()}」的项目` : '还没有可绑定的项目'}
          </div>
        ) : (
          <>
            {(localHits.length > 0 || localsLoading) && (
              <div className="cc-group" data-testid="cabin-project-local-group">
                <div className="cc-org">
                  {LOCAL_GROUP} <span className="n">{localHits.length}</span>
                  {localsLoading && <Loader2 className="cc-spin size-3 animate-spin" />}
                </div>
                {localHits.map((p) => {
                  const ref = localToRef(p)
                  const key = projectKey(ref)
                  const on = selectedKeys.has(key)
                  return (
                    <button
                      key={`local-${key}`}
                      type="button"
                      className="cc-it"
                      data-on={on ? 'true' : 'false'}
                      data-project-key={key}
                      data-local="true"
                      onClick={() => toggleLocal(p)}
                    >
                      <span className="cc-p">{highlight(p.name)}</span>
                      <span className="cc-sub">{p.local_path}{p.branch ? ` · ${p.branch}` : ''}{p.dirty ? ' · 有改动' : ''}</span>
                      <span className="cc-tag">{LOCAL_TAG}</span>
                      <span className="cc-ck" />
                    </button>
                  )
                })}
                {!localsLoading && localHits.length === 0 && (
                  <div className="cc-none cc-none-sm">这个目录下没有发现本地项目</div>
                )}
              </div>
            )}
            {hits.length > 0 && (
              <ProjectGroups
                hits={hits}
                perOrg={perOrg}
                selectedKeys={selectedKeys}
                onToggle={toggle}
                highlight={highlight}
              />
            )}
          </>
        )}
      </div>

      {/* 舱外目录：显式登记，只读引用。 */}
      <div className="cc-ext">
        {externalOpen ? (
          <div className="cc-ext-row">
            <input
              className="cc-ext-input"
              data-testid="cabin-project-external-input"
              value={externalPath}
              onChange={(e) => setExternalPath(e.target.value)}
              placeholder="/abs/path/to/repo"
              aria-label="其他目录的仓库绝对路径"
            />
            <button type="button" className="cc-ext-ok" onClick={addExternal}>登记</button>
            <button type="button" className="cc-ext-cancel" onClick={() => setExternalOpen(false)}>取消</button>
          </div>
        ) : (
          <button
            type="button"
            className="cc-ext-btn"
            data-testid="cabin-project-external-open"
            onClick={() => setExternalOpen(true)}
          >
            ＋ 引入其他目录的仓库
          </button>
        )}
      </div>

      {echoHint && <div className="cc-echo" data-testid="cabin-project-echo">{echoHint}</div>}
      {failedOrgs.length > 0 && (
        <div className="cc-note" data-testid="cabin-project-failed">
          注册表读取失败：{failedOrgs.join('、')} —— 可稍后再绑，不挡创建。
        </div>
      )}
      <div className="cc-note">
        项目是关联关系，不搬代码 —— ORG 主仓只读（只拉主线），本地/外部只登记路径。
      </div>
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
    if (option.group !== lastOrg) {
      lastOrg = option.group
      rows.push(
        <div key={`org-${option.group}`} className="cc-org">
          {option.group} <span className="n">{perOrg.get(option.group) ?? 0}</span>
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