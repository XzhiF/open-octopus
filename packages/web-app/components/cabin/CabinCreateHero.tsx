'use client'

// 新建作战舱 v5 · 一屏说完，直接进初始化（原型 cabin-new-v5.html）
//
// 相比 v4 只改两件事：
//   · **一屏走完**：需求（+ 可选目录 / 项目 / 舱名）选完，点「开始创建」就建，
//     直接进舱、门禁在舱里逐项跑 —— 不再有「她的提案页」和「已创建页」两个中间页。
//   · **舱名可选**：填了用你的；不填先落「未命名舱」，init 开头按需求取名
//     （服务端 cabin-naming.ts），左栏行与舱头随后一起变。
//
// 不变量（与 v4 一致）：需求是唯一必填 / 一个目录只能有一个舱 / 项目是跨 org 关联 /
// 不选目录 = 新建工作空间 / 提交前取消零请求。
// 设计：design/19-cabin-new-v5.md；上一稿：design/17 + design/18。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Container, Folder, Loader2, Tag, X } from 'lucide-react'
import { toast } from 'sonner'
import type { CabinDetail } from '@/lib/cabin-api'
import { createCabinWithResult, initCabin } from '@/lib/cabin-api'
import {
  CABIN_NAME_MAX,
  echoProjectsForDir,
  readRecentCabinDirs,
  rememberCabinDir,
  rememberDirProjects,
  type CabinDraft,
  type CabinProjectRef,
} from '@/lib/cabin-draft'
import { XiyinStage, type XiyinMood } from './XiyinStage'
import { CabinProjectBinder } from './CabinProjectBinder'
import { DirectoryBrowserDialog } from './DirectoryBrowserDialog'
import './CabinCreateHero.css'

type Phase = 'compose' | 'creating'

const GREET = '开个新舱。说说它要做什么。'
const SUBLINE = '你说说它要做什么 —— 别的我来安排。'
const CONFLICT_SUBLINE = '想进它，直接点「打开」；要开新舱，换一个目录。'

const baseName = (p: string) => p.replace(/\/+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? p

export interface CabinCreateHeroProps {
  draft: CabinDraft
  cabins: CabinDetail[]
  onChange: (patch: Partial<CabinDraft>) => void
  /** × 丢弃草稿（零请求、无二次确认）。 */
  onCancel: () => void
  /** 创建成功 / 打开已有舱 → 进入该舱（初始化在舱里跑）。 */
  onCreated: (cabinId: string) => void
}

export function CabinCreateHero({ draft, cabins, onChange, onCancel, onCreated }: CabinCreateHeroProps) {
  const [phase, setPhase] = useState<Phase>('compose')
  const [mood, setMood] = useState<XiyinMood>('greet')
  const [line, setLine] = useState(GREET)
  const [subline, setSubline] = useState(SUBLINE)
  const [sparkTick, setSparkTick] = useState(0)
  const [dirOpen, setDirOpen] = useState(false)
  const [projOpen, setProjOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [recentDirs, setRecentDirs] = useState<ReturnType<typeof readRecentCabinDirs>>([])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // 同一次创建只发一个请求（双击 / 连按回车都只落一个舱）。
  const busyRef = useRef(false)

  const clash = useMemo(
    () => (draft.path ? cabins.find((cabin) => cabin.path === draft.path) : undefined),
    [cabins, draft.path],
  )
  const lockedPaths = useMemo(() => {
    const map = new Map<string, string>()
    for (const cabin of cabins) if (cabin.path) map.set(cabin.path, cabin.name)
    return map
  }, [cabins])

  const echoHint = useMemo(() => {
    // 目录原来有项目时的回显说明（本地记忆；真实实现接 workspace 项目关联）。
    if (!draft.path) return null
    const echo = echoProjectsForDir(draft.path)
    return echo.length > 0 && draft.projects.length > 0
      ? `已从这个工作空间回显 ${draft.projects.length} 个项目 —— 可以增减，也能跨 org 再加。`
      : null
  }, [draft.path, draft.projects.length])

  useEffect(() => {
    setRecentDirs(readRecentCabinDirs())
  }, [dirOpen])

  const closePops = useCallback(() => {
    setDirOpen(false)
    setProjOpen(false)
  }, [])

  // 点击输入框之外 → 收两个下拉。列表点击会重渲染、目标节点被移除，
  // 所以用 composedPath 判断（原型同一个坑）。
  useEffect(() => {
    if (!dirOpen && !projOpen) return
    const onDown = (event: MouseEvent) => {
      const path = event.composedPath?.() ?? []
      const inside = path.some(
        (node) => node instanceof Element && node.classList?.contains('cc-composer'),
      )
      if (!inside) closePops()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [dirOpen, projOpen, closePops])

  const sparkle = useCallback((_count = 6) => setSparkTick((v) => v + 1), [])

  const selectDir = useCallback(
    (path: string | null) => {
      closePops()
      const echo = echoProjectsForDir(path)
      onChange({ path, projects: echo })
      if (path) rememberCabinDir(path)
      setRecentDirs(readRecentCabinDirs())
      const existing = path ? cabins.find((cabin) => cabin.path === path) : undefined
      if (existing) {
        setMood('think')
        setLine(`这个目录已经是「${existing.name}」了 —— 一个目录只能有一个舱。`)
        setSubline(CONFLICT_SUBLINE)
        sparkle(4)
      } else if (echo.length > 0) {
        setMood('listen')
        setLine('这个目录我认得。项目我照原来的给你绑好了。')
        setSubline(SUBLINE)
        sparkle(4)
      } else {
        setMood('listen')
        setLine('目录记下了。这里还是空的 —— 进去我先搭骨架。')
        setSubline(SUBLINE)
      }
      window.setTimeout(() => textareaRef.current?.focus(), 30)
    },
    [cabins, closePops, onChange, sparkle],
  )

  const chooseNewWorkspace = useCallback(() => {
    closePops()
    onChange({ path: null, projects: [] })
    setMood('listen')
    setLine('那就新建一个工作空间 —— 第一次创建的时候建。')
    setSubline(SUBLINE)
    window.setTimeout(() => textareaRef.current?.focus(), 30)
  }, [closePops, onChange])

  const openCabinByName = useCallback(
    (name: string) => {
      const target = cabins.find((cabin) => cabin.name === name)
      if (target) onCreated(target.id)
      else toast.error(`没找到「${name}」`)
    },
    [cabins, onCreated],
  )

  /** 一屏走完：提交 = 建 + 进舱。没有提案页、没有完成页。 */
  const submit = useCallback(async () => {
    if (phase !== 'compose' || busyRef.current) return
    // 一个目录只能有一个舱：已有舱的目录只允许打开，零写操作。
    if (clash) {
      onCreated(clash.id)
      return
    }
    const text = draft.requirements.trim()
    if (!text) return
    busyRef.current = true
    setPhase('creating')
    setMood('think')
    setLine('落舱 —— 建目录、接项目、起主会话。')
    setSubline('建完直接进舱，门禁在舱里逐项过。')
    sparkle(6)
    closePops()
    try {
      const name = draft.name.trim()
      const { cabin, created: isNew } = await createCabinWithResult({
        ...(name ? { name } : {}),
        requirements: text,
        ...(draft.path ? { path: draft.path } : {}),
        ...(draft.projects.length > 0 ? { projects: draft.projects } : {}),
      })
      rememberDirProjects(draft.path, draft.projects)
      if (!isNew) {
        // 一目录一舱：目录已经有舱 → 直接打开，不 init、不重复建。
        toast.message(`这个目录已经是「${cabin.name}」了`)
        onCreated(cabin.id)
        return
      }
      // 直接进舱；init 在后台跑 —— 门禁卡就在舱内对话里，失败可重试。
      onCreated(cabin.id)
      void initCabin(cabin.id).catch(() => {})
    } catch (err) {
      busyRef.current = false
      toast.error(err instanceof Error ? err.message : '创建失败')
      setPhase('compose')
      setMood('think')
      setLine('没落成 —— 你再看一眼，我重试。')
      setSubline(SUBLINE)
    }
  }, [
    phase, clash, draft.name, draft.requirements, draft.path, draft.projects,
    onCreated, sparkle, closePops,
  ])

  const setProjects = useCallback(
    (next: CabinProjectRef[]) => onChange({ projects: next }),
    [onChange],
  )

  // ⌘⏎ / Ctrl+⏎ = 提交；Esc 收下拉。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        void submit()
      }
      if (event.key === 'Escape') closePops()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [submit, closePops])

  const ready = (draft.requirements.trim().length > 0 || !!clash) && phase === 'compose'

  const sendLabel = phase === 'creating'
    ? '正在落舱…'
    : clash
      ? `打开「${clash.name}」`
      : '开始创建'

  const dirLabel = draft.path ? baseName(draft.path) : '新建工作空间'
  const projectSummary = draft.projects.length === 0
    ? null
    : draft.projects.length === 1
      ? draft.projects[0].repo
      : `${draft.projects[0].repo} +${draft.projects.length - 1}`

  return (
    <div className="cc-root ui-font" data-testid="cabin-create-hero">
      {/* ── 右页头（tab 条） ───────────────────────────────────────── */}
      <header className="cc-head">
        <div className="cc-tab">
          <Container className="cc-tico" strokeWidth={1.8} />
          <span data-testid="cabin-create-tab-name">新建作战舱</span>
          <span className="cc-chip" data-testid="cabin-create-chip">草稿</span>
          {phase === 'compose' && (
            <button
              type="button"
              className="cc-tx"
              title="取消（丢弃草稿）"
              aria-label="取消新建作战舱"
              data-testid="cabin-create-cancel"
              onClick={onCancel}
            >
              <X className="size-3" strokeWidth={2} />
            </button>
          )}
        </div>
        <span className="cc-crumb" data-testid="cabin-create-crumb">
          点 <b>开始创建</b> 直接建 —— 没有确认页
        </span>
      </header>

      <div className="cc-body">
        <XiyinStage
          mood={mood}
          line={line}
          subline={subline}
          sparkTick={sparkTick}
          nudgeTick={0}
        >
          <div className="cc-composer" data-testid="cabin-composer">
            <textarea
              ref={textareaRef}
              data-testid="cabin-req-input"
              value={draft.requirements}
              onChange={(e) => onChange({ requirements: e.target.value })}
              onFocus={() => { if (phase === 'compose') setMood('listen') }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
              rows={3}
              placeholder={'描述这个作战舱要做什么…说得越清楚，后面越好办。\n比如：做一个电商后台，长期维护订单、库存和结算对账'}
              aria-label="作战舱需求"
            />

            {clash && (
              <div className="cc-conflict" data-testid="cabin-conflict">
                <span aria-hidden>⚠</span>
                <span>
                  这个目录已经是 <b>「{clash.name}」</b> 了 —— <b>一个目录只能有一个舱</b>，不能在这里再建一个。
                </span>
              </div>
            )}

            <div className="cc-crow">
              <button
                type="button"
                className="cc-attach"
                data-on={draft.path ? 'true' : 'false'}
                data-testid="cabin-dir-chip"
                title={draft.path ?? '不选目录就在第一次创建时新建一个工作空间'}
                onClick={() => {
                  setProjOpen(false)
                  setDirOpen((v) => !v)
                }}
              >
                <Folder strokeWidth={1.8} />
                <span className="cc-txt" data-testid="cabin-dir-chip-text">{dirLabel}</span>
              </button>

              <button
                type="button"
                className="cc-attach"
                data-on={draft.projects.length > 0 ? 'true' : 'false'}
                data-testid="cabin-project-chip"
                title="绑定项目（可跨 org）"
                onClick={() => {
                  setDirOpen(false)
                  setProjOpen((v) => !v)
                }}
              >
                <Container strokeWidth={1.8} />
                <span className="cc-txt">{projectSummary ?? '绑定项目'}</span>
              </button>

              {/* 舱名（可选）：不填就由初始化按需求取名 */}
              <label
                className="cc-namefield"
                data-filled={draft.name.trim() ? 'true' : 'false'}
                title="舱名（可选）"
                data-testid="cabin-name-field"
              >
                <Tag strokeWidth={1.8} />
                <input
                  data-testid="cabin-name-input"
                  value={draft.name}
                  maxLength={CABIN_NAME_MAX}
                  placeholder="舱名（可选）"
                  aria-label="舱名（可选）"
                  onChange={(e) => onChange({ name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void submit()
                    }
                  }}
                />
              </label>

              <span className="cc-grow" />
              <span className="cc-hintk">⏎ 直接建 · ⇧⏎ 换行</span>
              <button
                type="button"
                className="cc-send"
                data-testid="cabin-create-submit"
                disabled={!ready}
                onClick={() => void submit()}
              >
                {phase === 'creating' && <Loader2 className="size-3.5 animate-spin" />}
                <span>{sendLabel}</span>
                <kbd>⌘⏎</kbd>
              </button>
            </div>

            {/* 目录 / 工作空间 */}
            {dirOpen && (
              <div className="cc-pop" data-testid="cabin-dir-pop">
                <div className="cc-ph">目录</div>

                <button
                  type="button"
                  className="cc-it"
                  data-on={!draft.path ? 'true' : 'false'}
                  data-testid="cabin-dir-default"
                  onClick={chooseNewWorkspace}
                >
                  <span className="cc-p" style={{ fontFamily: 'inherit', fontSize: 12 }}>新建工作空间</span>
                  <span className="cc-tag">第一次创建时建</span>
                  <span className="cc-ck" />
                </button>

                {cabins.length > 0 && (
                  <>
                    <div className="cc-ph" style={{ paddingBottom: 2 }}>已经有的舱</div>
                    {cabins.map((cabin) => (
                      <button
                        key={cabin.id}
                        type="button"
                        className="cc-it"
                        data-on={draft.path === cabin.path ? 'true' : 'false'}
                        data-cabin-dir={cabin.path}
                        onClick={() => selectDir(cabin.path)}
                      >
                        <span className="cc-p">
                          {cabin.name} <span style={{ color: 'var(--pop-dim)' }}>· {cabin.path}</span>
                        </span>
                        <span className="cc-tag">已有舱</span>
                      </button>
                    ))}
                  </>
                )}

                {recentDirs.filter((d) => !lockedPaths.has(d.path)).length > 0 && (
                  <>
                    <div className="cc-ph" style={{ paddingBottom: 2 }}>最近用过</div>
                    {recentDirs
                      .filter((d) => !lockedPaths.has(d.path))
                      .map((d) => (
                        <button
                          key={d.path}
                          type="button"
                          className="cc-it"
                          data-on={draft.path === d.path ? 'true' : 'false'}
                          onClick={() => selectDir(d.path)}
                        >
                          <span className="cc-p">{d.path}</span>
                        </button>
                      ))}
                  </>
                )}

                <div className="cc-sep" />
                <button
                  type="button"
                  className="cc-it"
                  data-testid="cabin-dir-browse"
                  onClick={() => {
                    setDirOpen(false)
                    setBrowseOpen(true)
                  }}
                >
                  <Folder className="size-3 shrink-0 text-pop-dim" strokeWidth={1.8} />
                  <span className="cc-p" style={{ fontFamily: 'inherit', fontSize: 12 }}>选择目录…</span>
                </button>
              </div>
            )}

            {/* 绑定项目 */}
            {projOpen && (
              <div className="cc-pop" style={{ width: 'min(420px,100%)' }} data-testid="cabin-project-pop">
                <CabinProjectBinder selected={draft.projects} onChange={setProjects} echoHint={echoHint} />
              </div>
            )}
          </div>

          <p className="cc-foot2">一个目录 = 一个舱 · 提交即建，直接进舱</p>
        </XiyinStage>
      </div>

      <DirectoryBrowserDialog
        open={browseOpen}
        initialPath={draft.path}
        lockedPaths={lockedPaths}
        onPick={(path) => {
          setBrowseOpen(false)
          selectDir(path)
        }}
        onOpenCabin={(name) => {
          setBrowseOpen(false)
          openCabinByName(name)
        }}
        onClose={() => setBrowseOpen(false)}
      />
    </div>
  )
}