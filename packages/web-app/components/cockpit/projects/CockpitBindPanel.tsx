'use client'

// 舱内「绑定项目」面板（v22 原型 · 2026-11-24 用户 #2）：
// 两个页签 —— ORG 注册项目 / 本地 Git 仓库。
//   · ORG：manifest 里的注册仓库，按 org 分组、可搜（项目名 / org）；已绑的行带 git 读数。
//   · 本地：真目录浏览（/api/agent/fs/browse）+ 扫描（/api/cabins/local-projects，
//     当前目录自身 + 深度 ≤2，只看 .git）。
// 保存 = 与现有条目求差集 → addCabinRepo / removeCabinRepo；只动 config，不搬代码。
// 「已绑」行的身份用服务端 key（entry.key），新增行用来源 + 名字 / 绝对路径 ——
// 客户端不自己拼 local: 的 key（external 条目的 server key 是 `local:<name>`，
// 与 main_path 不同构，按路径比对才不会把已绑的看成新增）。
// 卡片高度固定（原型 800×660）：切页签只换内容，不缩放。

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { browseDirectories, type BrowseResult } from '@/lib/api-client'
import {
  addCabinRepo,
  removeCabinRepo,
  scanLocalProjects,
  type CabinRepoEntry,
  type LocalProjectCandidate,
} from '@/lib/cabin-api'
import { loadOrgRepos } from '@/lib/org-repos'
import { useOrgs } from '@/hooks/useOrgs'
import { formatDateTime } from '@/lib/format'
import { invalidateCabinProjects } from './use-cabin-projects'

type BindTab = 'org' | 'local'

/** 面板内的一条选择：已绑条目带 `entry`（保存时据此算差集），新增项没有。 */
interface BindItem {
  /** 面板内稳定键（已绑 = 服务端 projectKey；新增 = 来源 + 名字 / 绝对路径）。 */
  key: string
  source: 'org' | 'local'
  name: string
  org?: string
  /** 本地项目绝对路径（已绑条目 = main_path）。 */
  absPath?: string
  entry?: CabinRepoEntry
}

interface OrgRow {
  org: string
  name: string
}

const SCAN_TTL = 60_000
const scanCache = new Map<string, { at: number; projects: LocalProjectCandidate[] }>()

async function loadScan(dir: string): Promise<LocalProjectCandidate[]> {
  const hit = scanCache.get(dir)
  if (hit && Date.now() - hit.at < SCAN_TTL) return hit.projects
  const projects = await scanLocalProjects(dir)
  scanCache.set(dir, { at: Date.now(), projects })
  return projects
}

/** 清扫描缓存（测试 / 需要在同一会话里看到新仓库时）。 */
export function clearLocalScanCache(): void {
  scanCache.clear()
}

/** Windows 盘符路径大小写不敏感；posix 保持原样。 */
function normPath(value: string): string {
  const next = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(next) ? next.toLowerCase() : next
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normPath(a) === normPath(b)
}

/** 目录 + 扫描结果里的相对路径（`.` = 目录自身）。 */
function joinPath(dir: string, rel: string): string {
  if (!rel || rel === '.') return dir
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${rel.replace(/^[\\/]+/, '')}`
}

/** 绝对路径 → 面包屑（每段可点）。盘符段保持 `C:\`。 */
export function crumbsOf(dir: string): Array<{ label: string; path: string }> {
  const sep = dir.includes('\\') ? '\\' : '/'
  const posix = dir.startsWith('/')
  const parts = dir.split(/[\\/]+/).filter(Boolean)
  const out: Array<{ label: string; path: string }> = []
  let acc = ''
  for (const part of parts) {
    if (acc === '') acc = posix ? `/${part}` : (/^[A-Za-z]:$/.test(part) ? `${part}${sep}` : part)
    else acc = `${acc.replace(/[\\/]+$/, '')}${sep}${part}`
    out.push({ label: part, path: acc })
  }
  return out
}

function entryToItem(entry: CabinRepoEntry): BindItem {
  return {
    key: entry.key,
    source: entry.source,
    name: entry.name,
    org: entry.org ?? entry.group ?? undefined,
    absPath: entry.main_path ?? undefined,
    entry,
  }
}

const ORG_GROUP = 'ORG 注册项目'
const LOCAL_GROUP = '本地 Git 仓库'

export interface CockpitBindPanelProps {
  cabinId: string
  cabinName: string
  cabinPath: string | null
  projects: CabinRepoEntry[]
  onClose: () => void
  onSaved: () => void
}

export function CockpitBindPanel({
  cabinId, cabinName, cabinPath, projects, onClose, onSaved,
}: CockpitBindPanelProps) {
  const { orgs, loading: orgsLoading } = useOrgs()
  const [tab, setTab] = useState<BindTab>('org')
  const [items, setItems] = useState<BindItem[]>(() => projects.map(entryToItem))
  const [saving, setSaving] = useState(false)

  // ── ORG 清单 ──────────────────────────────────────────────────────
  const [orgRows, setOrgRows] = useState<OrgRow[]>([])
  const [orgLoading, setOrgLoading] = useState(true)
  const [orgFailed, setOrgFailed] = useState<string[]>([])
  const orgNames = useMemo(() => orgs.map((o) => o.name).join('|'), [orgs])

  useEffect(() => {
    if (orgsLoading) return
    const names = orgNames ? orgNames.split('|') : []
    if (names.length === 0) {
      setOrgRows([])
      setOrgFailed([])
      setOrgLoading(false)
      return
    }
    let alive = true
    setOrgLoading(true)
    setOrgFailed([])
    void Promise.all(
      names.map(async (org) => {
        try {
          const repos = await loadOrgRepos(org)
          return { org, repos, failed: false as const }
        } catch {
          return { org, repos: [], failed: true as const }
        }
      }),
    ).then((results) => {
      if (!alive) return
      const rows: OrgRow[] = []
      const failed: string[] = []
      for (const result of results) {
        if (result.failed) failed.push(result.org)
        for (const repo of result.repos) rows.push({ org: result.org, name: repo.repo })
      }
      setOrgRows(rows)
      setOrgFailed(failed)
      setOrgLoading(false)
    })
    return () => {
      alive = false
    }
  }, [orgNames, orgsLoading])

  // ── 本地目录浏览 + 扫描 ───────────────────────────────────────────
  const [dirReq, setDirReq] = useState<string | null>(cabinPath)
  /** 「重试」用：同一个 dirReq 再拨一次 tick，强制重跑浏览 effect。 */
  const [dirTick, setDirTick] = useState(0)
  const [browse, setBrowse] = useState<BrowseResult | null>(null)
  const [dirLoading, setDirLoading] = useState(false)
  const [dirError, setDirError] = useState<string | null>(null)
  const [scan, setScan] = useState<LocalProjectCandidate[]>([])
  const [scanLoading, setScanLoading] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  useEffect(() => {
    if (tab !== 'local') return
    let alive = true
    setDirLoading(true)
    setDirError(null)
    void browseDirectories(dirReq ?? undefined)
      .then((next) => {
        if (alive) setBrowse(next)
      })
      .catch((err: unknown) => {
        if (!alive) return
        // 失败时清掉旧目录：面包屑跟 dirReq 走，扫描也跟 dirReq 走。
        setBrowse(null)
        setDirError(err instanceof Error ? err.message : '目录读取失败')
      })
      .finally(() => {
        if (alive) setDirLoading(false)
      })
    return () => {
      alive = false
    }
  }, [tab, dirReq, dirTick])

  // 扫描与浏览分开：/api/cabins/local-projects 没有目录白名单，而 /api/agent/fs/browse
  // 会挡住 ~/.octopus 这类敏感目录 —— 舱目录（~/.octopus/workspaces/…）不能浏览，
  // 但仍然可以直接扫描并把仓库绑进来。
  const scanDir = browse?.path ?? dirReq
  useEffect(() => {
    if (tab !== 'local' || !scanDir) return
    let alive = true
    setScanLoading(true)
    setScanError(null)
    void loadScan(scanDir)
      .then((projects) => {
        if (alive) setScan(projects)
      })
      .catch((err: unknown) => {
        if (alive) {
          setScan([])
          setScanError(err instanceof Error ? err.message : '扫描失败')
        }
      })
      .finally(() => {
        if (alive) setScanLoading(false)
      })
    return () => {
      alive = false
    }
  }, [tab, scanDir])

  const searchRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (tab !== 'org') return
    const timer = window.setTimeout(() => searchRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [tab])

  // ── 选择 ─────────────────────────────────────────────────────────
  const itemByKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items])

  const orgItemFor = (org: string, name: string): BindItem | undefined =>
    items.find((i) => i.source === 'org' && i.name === name && (!i.org || !org || i.org === org))
  const localItemFor = (absPath: string): BindItem | undefined =>
    items.find((i) => i.source === 'local' && samePath(i.absPath, absPath))

  const toggleItem = (item: BindItem) => {
    setItems((prev) => (
      prev.some((i) => i.key === item.key)
        ? prev.filter((i) => i.key !== item.key)
        : [...prev, item]
    ))
  }

  const removeItem = (key: string) => {
    setItems((prev) => prev.filter((i) => i.key !== key))
  }

  const terms = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  )
  const orgHits = useMemo(() => {
    if (terms.length === 0) return orgRows
    return orgRows.filter((row) => {
      const text = `${row.name} ${row.org}`.toLowerCase()
      return terms.every((term) => text.includes(term))
    })
  }, [orgRows, terms])

  const orgCount = items.filter((i) => i.source === 'org').length
  const localCount = items.length - orgCount

  // ── 保存（差集）──────────────────────────────────────────────────
  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      const keep = new Set(items.filter((i) => i.entry).map((i) => i.entry!.key))
      const removed = projects.filter((p) => !keep.has(p.key))
      const added = items.filter((i) => !i.entry)
      // 先加后删：新增失败时不动已有绑定（解绑失败由服务端 409 兜底）。
      for (const item of added) {
        if (item.source === 'org') {
          if (!item.org) throw new Error(`ORG 项目缺归属 org：${item.name}`)
          await addCabinRepo(cabinId, { source: 'org', name: item.name, org: item.org })
        } else {
          if (!item.absPath) throw new Error(`本地项目缺绝对路径：${item.name}`)
          await addCabinRepo(cabinId, {
            source: 'local',
            name: item.name,
            absolutePath: item.absPath,
            // external 只是「舱外路径需显式登记」这道门的开关；舱内 / 舱外由服务端
            // 按 realpath 判定（客户端比盘符大小写 / 短路径 / 符号链接都会猜错）。
            external: true,
          })
        }
      }
      for (const entry of removed) {
        await removeCabinRepo(cabinId, entry.name)
      }
      invalidateCabinProjects(cabinId)
      toast.success(`已保存 · +${added.length} / −${removed.length} · 舱籍 ${items.length} 项目`)
      onSaved()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="ck12-bind-panel" data-testid="cockpit-bind-panel">
      <div className="ck12-bind-tabs" role="tablist" aria-label="项目来源">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'org'}
          className="ck12-bind-tab"
          data-on={tab === 'org' ? 'true' : undefined}
          data-testid="cockpit-bind-tab-org"
          onClick={() => setTab('org')}
        >
          {ORG_GROUP} <b>{orgCount}</b>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'local'}
          className="ck12-bind-tab"
          data-on={tab === 'local' ? 'true' : undefined}
          data-testid="cockpit-bind-tab-local"
          onClick={() => setTab('local')}
        >
          {LOCAL_GROUP} <b>{localCount}</b>
        </button>
      </div>

      <div className="ck12-bind-body">
        {tab === 'org' ? (
          <OrgPane
            searchRef={searchRef}
            query={query}
            onQuery={setQuery}
            loading={orgsLoading || orgLoading}
            failed={orgFailed}
            rows={orgHits}
            total={orgRows.length}
            itemFor={orgItemFor}
            itemByKey={itemByKey}
            onToggle={toggleItem}
          />
        ) : (
          <LocalPane
            dir={browse?.path ?? dirReq}
            cabinPath={cabinPath}
            browse={browse}
            dirLoading={dirLoading}
            dirError={dirError}
            onGoto={setDirReq}
            onRetry={() => setDirTick((t) => t + 1)}
            scan={scan}
            scanLoading={scanLoading}
            scanError={scanError}
            itemFor={localItemFor}
            itemByKey={itemByKey}
            onToggle={toggleItem}
          />
        )}
      </div>

      <div className="ck12-bind-foot">
        <div className="ck12-bind-sel" data-testid="cockpit-bind-selected">
          {items.length === 0 ? (
            <span className="ck12-bind-sel-empty">还没选项目 · 从上面勾选（ORG 或本地 Git 仓库）</span>
          ) : (
            items.map((item) => (
              <span key={item.key} className="ck12-bind-chip" data-source={item.source}>
                <span className="nm" title={item.absPath ?? `${item.org ?? ''}/${item.name}`}>{item.name}</span>
                <i>{item.source === 'org' ? item.org ?? 'ORG' : '本地'}</i>
                <button
                  type="button"
                  aria-label={`移除 ${item.name}`}
                  onClick={() => removeItem(item.key)}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
        <div className="ck12-bind-acts">
          <span className="ck12-bind-count">已选 <b>{items.length}</b></span>
          <button type="button" className="ck12-bind-btn" onClick={onClose}>取消</button>
          <button
            type="button"
            className="ck12-bind-btn primary"
            data-testid="cockpit-bind-save"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── ORG 页签 ─────────────────────────────────────────────────────────

function OrgPane({
  searchRef,
  query,
  onQuery,
  loading,
  failed,
  rows,
  total,
  itemFor,
  itemByKey,
  onToggle,
}: {
  searchRef: React.RefObject<HTMLInputElement | null>
  query: string
  onQuery: (next: string) => void
  loading: boolean
  failed: string[]
  rows: OrgRow[]
  total: number
  itemFor: (org: string, name: string) => BindItem | undefined
  itemByKey: Map<string, BindItem>
  onToggle: (item: BindItem) => void
}) {
  const groups: Array<{ org: string; rows: OrgRow[] }> = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (last && last.org === row.org) last.rows.push(row)
    else groups.push({ org: row.org, rows: [row] })
  }

  return (
    <div className="ck12-bind-org">
      <div className="ck12-bind-q">
        <Search className="size-3 shrink-0 text-pop-dim" strokeWidth={2} />
        <input
          ref={searchRef}
          data-testid="cockpit-bind-search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={`搜项目名 / org…（共 ${total} 个）`}
          aria-label="搜索 ORG 项目"
        />
        {query && (
          <button
            type="button"
            className="ck12-bind-clr"
            onClick={() => {
              onQuery('')
              searchRef.current?.focus()
            }}
          >
            清空
          </button>
        )}
      </div>

      {loading ? (
        <div className="ck12-bind-empty">
          <Loader2 className="size-3 animate-spin" /> 读取仓库清单…
        </div>
      ) : rows.length === 0 ? (
        <div className="ck12-bind-empty">
          <b aria-hidden="true">⌕</b>
          {query.trim() ? `没有匹配「${query.trim()}」的项目` : '还没有注册的 ORG 仓库'}
          <span>仓库清单来自 ~/.octopus/orgs/&lt;org&gt;/repos/manifest.json</span>
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.org} className="ck12-bind-group">
            <div className="ck12-bind-group-h">
              {group.org} <b>{group.rows.length}</b>
            </div>
            {group.rows.map((row) => {
              const bound = itemFor(row.org, row.name)
              const on = Boolean(bound && itemByKey.has(bound.key))
              const item: BindItem = bound ?? {
                key: `org:${row.org}/${row.name}`,
                source: 'org',
                name: row.name,
                org: row.org,
              }
              const git = bound?.entry?.git ?? null
              return (
                <button
                  key={`${row.org}/${row.name}`}
                  type="button"
                  className="ck12-bind-row"
                  data-on={on ? 'true' : 'false'}
                  data-org-row={row.name}
                  data-bound={bound ? 'true' : undefined}
                  aria-pressed={on}
                  title={`${row.org}/${row.name}`}
                  onClick={() => onToggle(item)}
                >
                  <span className="ck12-bind-ck" aria-hidden="true">✓</span>
                  <span className="ck12-bind-main">
                    <span className="ck12-bind-line">
                      <span className="ck12-bind-name">{row.name}</span>
                      <span className="ck12-bind-tag">ORG</span>
                      {bound && <span className="ck12-bind-tag is-bound">已绑</span>}
                      <span className="ck12-bind-where">{row.org}</span>
                    </span>
                  </span>
                  <span className="ck12-bind-git">
                    {git ? (
                      <>
                        <span className="br" title={git.branch}>⎇ {git.branch}</span>
                        <span className="hd">{git.commit}</span>
                        <span className="at">{formatDateTime(git.at)}</span>
                      </>
                    ) : (
                      <span className="at">未绑定</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        ))
      )}

      {failed.length > 0 && (
        <div className="ck12-bind-note">清单读取失败：{failed.join('、')} —— 可稍后再绑，不挡保存。</div>
      )}
      <div className="ck12-bind-hint">
        ORG 主仓只读 · 只能拉主线（ff-only）；绑的是<b>关联关系</b>，不搬代码。
      </div>
    </div>
  )
}

// ── 本地页签 ─────────────────────────────────────────────────────────

function LocalPane({
  dir,
  cabinPath,
  browse,
  dirLoading,
  dirError,
  onGoto,
  onRetry,
  scan,
  scanLoading,
  scanError,
  itemFor,
  itemByKey,
  onToggle,
}: {
  dir: string | null
  cabinPath: string | null
  browse: BrowseResult | null
  dirLoading: boolean
  dirError: string | null
  onGoto: (path: string | null) => void
  onRetry: () => void
  scan: LocalProjectCandidate[]
  scanLoading: boolean
  scanError: string | null
  itemFor: (absPath: string) => BindItem | undefined
  itemByKey: Map<string, BindItem>
  onToggle: (item: BindItem) => void
}) {
  const crumbs = useMemo(() => (dir ? crumbsOf(dir) : []), [dir])
  const rows = useMemo(() => {
    if (!dir) return []
    return scan.map((p) => ({
      ...p,
      absPath: joinPath(dir, p.local_path),
      depth: p.local_path === '.' ? 0 : p.local_path.split(/[\\/]/).length,
    }))
  }, [scan, dir])
  /** 目录栏里带 `git` 角标的子目录（扫描结果的相对路径第一段）。 */
  const gitChildren = useMemo(() => {
    const set = new Set<string>()
    for (const p of scan) {
      if (p.local_path === '.') continue
      const [head] = p.local_path.split(/[\\/]/)
      if (head) set.add(head)
    }
    return set
  }, [scan])

  return (
    <div className="ck12-bind-local">
      <div className="ck12-bind-dirbar">
        <button
          type="button"
          className="ck12-bind-up"
          aria-label="上级目录"
          data-testid="cockpit-bind-up"
          disabled={!browse?.parent || dirLoading}
          onClick={() => browse?.parent && onGoto(browse.parent)}
        >
          <ArrowUp className="size-3.5" />
        </button>
        <span className="ck12-bind-crumb" title={dir ?? undefined} data-testid="cockpit-bind-dir-path">
          {crumbs.length === 0 ? (
            <span className="seg">{dirLoading ? '读取中…' : '未选择目录'}</span>
          ) : (
            crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1
              return (
                <span key={crumb.path} className="seg">
                  {last ? (
                    <b>{crumb.label}</b>
                  ) : (
                    <button type="button" onClick={() => onGoto(crumb.path)}>{crumb.label}</button>
                  )}
                  {!last && <span className="sep">/</span>}
                </span>
              )
            })
          )}
        </span>
        {dirLoading && <Loader2 className="ck12-bind-spin size-3 animate-spin" />}
      </div>

      <div className="ck12-bind-roots">
        <button
          type="button"
          className="ck12-bind-root"
          data-on={browse && dir === browse.home ? 'true' : undefined}
          onClick={() => onGoto(null)}
        >
          Home
        </button>
        {cabinPath && (
          <button
            type="button"
            className="ck12-bind-root"
            data-on={dir === cabinPath ? 'true' : undefined}
            title={cabinPath}
            onClick={() => onGoto(cabinPath)}
          >
            舱目录
          </button>
        )}
        {(browse?.roots ?? []).filter((root) => root.path !== browse?.home).map((root) => {
          const active = dir === root.path
          const label = root.path === '/' ? '根目录' : root.name
          return (
            <button
              key={root.path}
              type="button"
              className="ck12-bind-root"
              data-on={active ? 'true' : undefined}
              onClick={() => onGoto(root.path)}
            >
              {label}
            </button>
          )
        })}
      </div>

      <div className="ck12-bind-cols">
        <div className="ck12-bind-pane" data-testid="cockpit-bind-dirs">
          <div className="ck12-bind-pane-h">目录 · {browse?.dirs.length ?? 0}</div>
          {dirError ? (
            <div className="ck12-bind-empty is-sm">
              <span className="err">{dirError}</span>
              <span className="ck12-bind-pane-acts">
                <button type="button" className="ck12-bind-retry" onClick={onRetry}>重试</button>
                <button type="button" className="ck12-bind-retry" onClick={() => onGoto(null)}>回到 Home</button>
              </span>
            </div>
          ) : dirLoading && !browse ? (
            <div className="ck12-bind-empty is-sm">
              <Loader2 className="size-3 animate-spin" /> 读取目录…
            </div>
          ) : !browse || browse.dirs.length === 0 ? (
            <div className="ck12-bind-empty is-sm">没有子目录</div>
          ) : (
            browse.dirs.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="ck12-bind-dir"
                data-dir-entry={entry.name}
                title={entry.path}
                onClick={() => onGoto(entry.path)}
              >
                <span className="ic" aria-hidden="true">▸</span>
                <span className="nm">{entry.name}</span>
                {gitChildren.has(entry.name)
                  ? <span className="git">git</span>
                  : <span className="go">进入</span>}
              </button>
            ))
          )}
        </div>

        <div className="ck12-bind-pane" data-testid="cockpit-bind-scan">
          <div className="ck12-bind-pane-h">
            扫描结果 · {scanLoading ? '扫描中…' : `${rows.length} 个 Git 仓库`}
            <span className="sub">（深度 ≤2 · 跳过 node_modules / 隐藏目录）</span>
          </div>
          {scanError ? (
            <div className="ck12-bind-empty is-sm">
              <span className="err">{scanError}</span>
            </div>
          ) : scanLoading && rows.length === 0 ? (
            <div className="ck12-bind-empty is-sm">
              <Loader2 className="size-3 animate-spin" /> 扫描 .git…
            </div>
          ) : rows.length === 0 ? (
            <div className="ck12-bind-empty">
              <b aria-hidden="true">◇</b>
              这个目录下没有发现 Git 仓库
              <span>走进子目录，或换一个目录</span>
            </div>
          ) : (
            rows.map((row) => {
              const bound = itemFor(row.absPath)
              const on = Boolean(bound && itemByKey.has(bound.key))
              const item: BindItem = bound ?? {
                key: `local:${row.absPath}`,
                source: 'local',
                name: row.name,
                absPath: row.absPath,
              }
              return (
                <button
                  key={row.absPath}
                  type="button"
                  className="ck12-bind-row"
                  data-on={on ? 'true' : 'false'}
                  data-local-row={row.name}
                  data-bound={bound ? 'true' : undefined}
                  aria-pressed={on}
                  title={row.absPath}
                  onClick={() => onToggle(item)}
                >
                  <span className="ck12-bind-ck" aria-hidden="true">✓</span>
                  <span className="ck12-bind-main">
                    <span className="ck12-bind-line">
                      <span className="ck12-bind-name">{row.name}</span>
                      <span className="ck12-bind-tag is-local">LOCAL</span>
                      {bound && <span className="ck12-bind-tag is-bound">已绑</span>}
                      <span className="ck12-bind-where">{row.absPath}</span>
                    </span>
                    <span className="ck12-bind-line">
                      <span className="ck12-bind-where">
                        {row.depth === 0 ? '当前目录自身就是 Git 仓库' : `扫描到 · 深度 ${row.depth}`}
                      </span>
                    </span>
                  </span>
                  <span className="ck12-bind-git">
                    <span className="br">{row.branch ? `⎇ ${row.branch}` : '⎇ （无分支）'}</span>
                    <span className="at">{row.dirty ? 'dirty' : 'clean'}</span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>

      <div className="ck12-bind-hint">
        只登记路径、不搬代码；目录里没有 <b>.git</b> 就不会出现在扫描结果里。
        勾选进入下方「已选」，保存时统一提交。
      </div>
    </div>
  )
}
