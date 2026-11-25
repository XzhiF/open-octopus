'use client'

// S4 owns this file —— 作业面 chrome + 选中解析（job / task / attention 三型）。
// 五页签主体在 components/cabin/job-face.tsx；CockpitTaskFace 承载合成 task 行；
// CockpitAttentionFace 承载无 job_id 的 attention。
//
// chrome 只做四件事：
//   1. `.ck12-face` 容器（原型 .panel：居中 760 玻璃 dossier + .pscrim 背幕）；
//   2. 从 useCockpitFleet().rows 找选中行，拿 cabinName / attention / 项目名；
//   3. 关闭 = select(null)，并注册进 layer（priority 最低 → Esc 最后才收面）；
//   4. v21 五轮：原型 .pwin / .pgrip 的窗口化 —— 标题栏拖动、右下拖拽缩放、
//      双击标题栏或 ⛶ 全屏；几何会话内保留（与原型 state.panelGeo 同口径）。
//
// 2026-11-15：全域只含入口舱，跨舱查看 / `?cabin=` 已退役 —— 工作区 / 版本 /
// 主会话直接从入口舱的 CabinProvider 拿，不再按选中项另拉一次舱详情。

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { JobFace } from '@/components/cabin/job-face'
import { cn } from '@/lib/utils'
import { useCockpitState } from '../state/CockpitStateProvider'
import { cockpitRefKey, defaultTabForRef, type CockpitRef } from '../state/cockpit-state'
import { openFleetChat } from '../chat/open-fleet-window'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { groupOf, type CockpitRow } from '../fleet/fleet-model'
import { CockpitAttentionFace } from './CockpitAttentionFace'
import { CockpitTaskFace } from './CockpitTaskFace'
import { CockpitSessionFace } from './CockpitSessionFace'
import { CockpitManifestFace } from '../projects/CockpitManifestFace'
import { CockpitProjectFace } from '../projects/CockpitProjectFace'
import { PROJECT_ROSTER_ID, projectNameFromKey } from '../projects/project-model'
import { DossierWindowContext } from './dossier-window'
import { CockpitTreeWindow } from './CockpitTreeWindow'
import { CockpitTreeContext, type CockpitTreeApi, type CockpitTreeScope } from './tree-window'

/** 作业详情的 Esc 层 id / 优先级。
 *  v21 三轮：详情是覆盖在通讯台之上的模态 dossier —— Esc 必须先收它
 *  （priority 65：压过通讯台 60，低于问答窗 75 / 模态面板 85）。 */
export const FACE_LAYER_ID = 'cockpit-face'
export const FACE_LAYER_PRIORITY = 65

/** 原型 .panel 的窗口几何（state.panelGeo / state.panelMax）：会话内保留，
 *  关掉再开仍回到上次的位置与尺寸 —— 与原型同口径。 */
interface DossierGeo {
  x: number
  y: number
  w: number
  h: number
}
let savedGeo: DossierGeo | null = null
let savedMax = false

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

export interface CockpitFaceProps {
  /** 入口舱（全域单舱化后 = selection.cabinId；保留给 JobFace 的投递门禁）。 */
  entryCabinId: string
}

/** 编队行 → 面 ref。2026-11-25：委派（会话）也有详情面。 */
function refOfRow(row: CockpitRow): CockpitRef | null {
  if (row.kind === 'job') return { kind: 'job', cabinId: row.cabinId, id: row.job.id }
  if (row.kind === 'task') return { kind: 'task', cabinId: row.cabinId, id: row.task.id }
  if (row.kind === 'delegation') return { kind: 'delegation', cabinId: row.cabinId, id: row.delegation.id }
  if (row.kind === 'attention') return { kind: 'attention', cabinId: row.cabinId, id: row.item.id }
  return null
}

function rowMatches(row: CockpitRow, ref: CockpitRef): boolean {
  if (row.cabinId !== ref.cabinId) return false
  if (ref.kind === 'job') return row.kind === 'job' && row.job.id === ref.id
  if (ref.kind === 'task') return row.kind === 'task' && row.task.id === ref.id
  if (ref.kind === 'delegation') return row.kind === 'delegation' && row.delegation.id === ref.id
  return row.kind === 'attention' && row.item.id === ref.id
}

/** 编队行已有的作业摘要 → 作业面载入态的头部（不必等详情接口）。 */
function hintOf(row: CockpitRow | null) {
  if (!row || row.kind !== 'job') return null
  return { title: row.job.title, kind: row.job.kind, status: row.job.status }
}

export function CockpitFace({ entryCabinId }: CockpitFaceProps) {
  const {
    selection, tab, setTab, select, layer, inboxOpen, inboxSel, detailSource, wins, chatWindow, threads: threadApi,
  } = useCockpitState()
  const { rows, counts, error, refetch } = useCockpitFleet()
  const cabinCtx = useCabinOptional()
  // counts !== null = 编队至少成功接过一次真值（FleetProvider 契约）。
  const loadedOnce = counts !== null

  const row = useMemo(
    () => (selection ? rows.find((entry) => rowMatches(entry, selection)) ?? null : null),
    [rows, selection],
  )

  // attention 选中：优先纯 attention 行；若它其实挂在某条 job 上（job_id 命中），
  // 直接落到那条 job 的面（那里才有完整五页签）。
  const attentionOnJob = useMemo(() => {
    if (selection?.kind !== 'attention' || row) return null
    return rows.find((entry) => entry.kind === 'job' && entry.attention?.id === selection.id) ?? null
  }, [rows, selection, row])

  const close = useCallback(() => select(null), [select])

  /** v22 #5：详情头「💬 对话」—— 打开这条作战的独立 chat 窗并收起详情。
   *  线程 key = 编队行 key（与 threadsFromRows 同命名）；没有会话就没有这扇窗。 */
  const chatRow = row ?? attentionOnJob
  const chatThreadKey = useMemo(() => {
    if (!chatRow) return null
    if (chatRow.kind === 'job') return chatRow.job.session_id ? chatRow.key : null
    if (chatRow.kind === 'task') return chatRow.task.doer_session_id ? chatRow.key : null
    if (chatRow.kind === 'delegation') return chatRow.delegation.doer_session_id ? chatRow.key : null
    return null
  }, [chatRow])
  const openChat = useCallback(() => {
    if (!chatThreadKey) return
    if (openFleetChat(wins, threadApi, chatThreadKey, chatWindow)) select(null)
  }, [chatThreadKey, wins, threadApi, chatWindow, select])

  // ── 窗口化（原型 .pwin / .pgrip / bindPanelWin）─────────────────────────
  const faceRef = useRef<HTMLDivElement | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const [geo, setGeo] = useState<DossierGeo | null>(savedGeo)
  const [maxed, setMaxed] = useState(savedMax)
  /** v22.3：从「要我处理」打开 = 固定让到浮层左侧（aside）。
   *  不受会话内保存的拖拽几何影响 —— 否则拖过一次之后，inbox 打开的详情
   *  又会回到居中（用户反馈：只有编队点开的才该居中）。 */
  const asideInbox = detailSource === 'inbox' && !maxed
  /** 每次「新开一条面」时：inbox 来源要回到 aside —— 上一次全屏记住的 savedMax
   *  不能把这一条也顶成全屏（用户规则：只有编队点开的才居中/全屏）。 */
  const openedKeyRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const key = selection ? cockpitRefKey(selection) : null
    if (!key) { openedKeyRef.current = null; return }
    if (openedKeyRef.current === key) return
    openedKeyRef.current = key
    if (detailSource === 'inbox' && maxed) {
      savedMax = false
      setMaxed(false)
    }
  }, [selection, detailSource, maxed])
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1600 : window.innerWidth,
    h: typeof window === 'undefined' ? 900 : window.innerHeight,
  }))

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 拖拽/缩放挂在 window 上：关面时一并摘掉，不留悬挂回调。
  useEffect(() => () => { dragCleanupRef.current?.() }, [])

  const toggleMax = useCallback(() => {
    if (!maxed) {
      const el = faceRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        const snapshot = {
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        }
        savedGeo = snapshot
        setGeo(snapshot)
      }
      savedMax = true
      setMaxed(true)
    } else {
      savedMax = false
      setMaxed(false)
    }
  }, [maxed])

  // 标题栏拖动：原型 bindPanelWin 的 clamp 逐字照搬。
  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // aside 是自动落位（贴浮层左侧），不接受手动拖拽；拖了就失去并排语义。
    if (maxed || asideInbox) return
    const target = event.target as HTMLElement
    if (target.closest('button, textarea, input, select, a, [data-no-drag]')) return
    // 原型 #panel .ph 可拖；项目/舱籍面走旧 chrome 的 .ck12-jh-h1，同样可拖。
    if (!target.closest('.ck12-dh, .ck12-jh-h1')) return
    const el = faceRef.current
    if (!el) return
    event.preventDefault()
    const r = el.getBoundingClientRect()
    const start = { x: r.left, y: r.top, w: r.width, h: r.height }
    const sx = event.clientX
    const sy = event.clientY
    const move = (ev: PointerEvent) => {
      const next: DossierGeo = {
        x: clamp(start.x + ev.clientX - sx, 4, Math.max(4, window.innerWidth - start.w - 4)),
        y: clamp(start.y + ev.clientY - sy, 52, Math.max(52, window.innerHeight - start.h - 4)),
        w: start.w,
        h: start.h,
      }
      savedGeo = next
      setGeo(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      dragCleanupRef.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    dragCleanupRef.current = up
  }, [maxed, asideInbox])

  // 右下角缩放：最小 420×300，右/下留 8px（原型 .pgrip）。
  const startResize = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    if (maxed || asideInbox) return
    event.preventDefault()
    event.stopPropagation()
    const el = faceRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const start = { x: r.left, y: r.top, w: r.width, h: r.height }
    const sx = event.clientX
    const sy = event.clientY
    const move = (ev: PointerEvent) => {
      const next: DossierGeo = {
        x: start.x,
        y: start.y,
        w: clamp(start.w + ev.clientX - sx, 420, Math.max(420, window.innerWidth - start.x - 8)),
        h: clamp(start.h + ev.clientY - sy, 300, Math.max(300, window.innerHeight - start.y - 8)),
      }
      savedGeo = next
      setGeo(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      dragCleanupRef.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    dragCleanupRef.current = up
  }, [maxed, asideInbox])

  // 双击标题栏 = 全屏 / 还原（原型 dblclick，按钮与输入控件除外）。
  const onHeaderDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, textarea, input, select, a')) return
    if (!target.closest('.ck12-dh, .ck12-jh-h1')) return
    toggleMax()
  }, [toggleMax])

  const winApi = useMemo(() => ({ maximized: maxed, toggleMax }), [maxed, toggleMax])

  // 目录树窗口（v21 六轮）：项目页签点一行 → 在本面之上再弹一层。
  // 选中项一变（换作业 / 收面）就一并收窗 —— 树只属于打开它的那条作战。
  const [treeScope, setTreeScope] = useState<CockpitTreeScope | null>(null)
  const treeApi = useMemo<CockpitTreeApi>(() => ({ open: (scope) => setTreeScope(scope) }), [])
  const selectionKey = selection ? cockpitRefKey(selection) : null
  useEffect(() => { setTreeScope(null) }, [selectionKey])

  const panelStyle: CSSProperties | undefined = maxed
    ? {
      left: 5,
      top: 52,
      width: Math.max(360, viewport.w - 10),
      height: Math.max(260, viewport.h - 58),
      transform: 'none',
    }
    : geo
      ? { left: geo.x, top: geo.y, width: geo.w, height: geo.h, transform: 'none' }
      : undefined

  // 副行的「项目」段：编队行 project_keys 派生（task 行没有锚点 → null）。
  const projectName = useMemo(
    () => (row?.kind === 'job' && (row.job.project_keys?.length ?? 0) > 0
      ? projectNameFromKey(row.job.project_keys![0])
      : null),
    [row],
  )

  // 关闭注册进唯一 Esc 栈（最外层：只收面，不退出路由）。
  useEffect(() => {
    if (!selection) return
    return layer.register(FACE_LAYER_ID, FACE_LAYER_PRIORITY, () => select(null))
  }, [selection, layer, select])

  // 验收通过/打回后落下一行「需要你」（plans §1.3）。用当前快照挑：当前行
  // 一定被排除，剩下的 need 行就是 refetch 后仍然成立的那一批。
  const advance = useCallback((from: CockpitRef) => {
    const key = cockpitRefKey(from)
    const next = rows.find((row) => {
      if (groupOf(row) !== 'need') return false
      const ref = refOfRow(row)
      return ref !== null && cockpitRefKey(ref) !== key
    })
    const nextRef = next ? refOfRow(next) : null
    // 验收通过后落下一行：保持在同一种落位（inbox 开的继续在左侧，编队开的居中）。
    if (nextRef) select(nextRef, defaultTabForRef(nextRef), detailSource)
  }, [rows, select, detailSource])

  if (!selection) return null

  const selectedCabin = cabinCtx?.cabin ?? null
  const cabinName = row?.cabinName ?? attentionOnJob?.cabinName ?? null

  const body = (() => {
    // 舱籍 / 项目面不依赖编队：项目数据自己拉，先渲染。
    if (selection.kind === 'project') {
      return selection.id === PROJECT_ROSTER_ID
        ? <CockpitManifestFace cabinId={selection.cabinId} onClose={close} />
        : <CockpitProjectFace cabinId={selection.cabinId} projectKey={selection.id} onClose={close} />
    }

    // 编队还没接过真值：不挂作业面（JobFace/CockpitTaskFace 会立刻拉详情）。
    // 深链里的 job/task 可能已经删了 —— 先等编队回来校验，避免一串注定 404
    // 的请求（随后 CockpitUrlSync 才把 URL 改写掉）。
    if (!loadedOnce) {
      // 编队加载失败时不能一直写「载入编队…」——给出原因和重试。
      if (error) {
        return (
          <div className="ck12-face-empty" data-testid="cockpit-face-error">
            编队加载失败 · {error}
            <button type="button" className="ck12-rail-retry" onClick={refetch}>重试</button>
            {error.includes('超时') && (
              <span className="ck12-face-hint">
                超时多半是浏览器连接被占满（同时开着多个页面/窗口）。关掉其它页面后点重试。
              </span>
            )}
          </div>
        )
      }
      return <div className="ck12-face-empty">载入编队…</div>
    }

    // 选中项不在当前编队（已结束且被 done 截断 / 已删除）：URL 同步会立刻
    // 回退到有效行；这段窗口里不发任何请求，也不闪一张假的作业面。
    if (!row && !attentionOnJob) {
      return (
        <div className="ck12-face-empty" data-testid="cockpit-face-stale">
          这件作业已不在编队 · 正在切到下一件…
        </div>
      )
    }

    if (attentionOnJob && attentionOnJob.kind === 'job') {
      return (
        <JobFace
          cabinId={attentionOnJob.cabinId}
          workspaceId={selectedCabin?.workspace_id ?? null}
          jobId={attentionOnJob.job.id}
          variant="cockpit"
          entryCabinId={entryCabinId}
          mainSessionId={selectedCabin?.main_session_id ?? null}
          onMutated={refetch}
          cockpit={{
            cabinName,
            projectName,
            attention: attentionOnJob.attention ?? null,
            hint: hintOf(attentionOnJob),
            tab,
            onTabChange: setTab,
            onClose: close,
            onOpenChat: chatThreadKey ? openChat : null,
            onAcceptanceMutated: () => advance(selection),
          }}
        />
      )
    }

    if (selection.kind === 'job') {
      return (
        <JobFace
          cabinId={selection.cabinId}
          workspaceId={selectedCabin?.workspace_id ?? null}
          jobId={selection.id}
          variant="cockpit"
          entryCabinId={entryCabinId}
          mainSessionId={selectedCabin?.main_session_id ?? null}
          onMutated={refetch}
          cockpit={{
            cabinName,
            projectName,
            attention: row?.kind === 'job' ? row.attention ?? null : null,
            hint: hintOf(row),
            tab,
            onTabChange: setTab,
            onClose: close,
            onOpenChat: chatThreadKey ? openChat : null,
            onAcceptanceMutated: () => advance(selection),
          }}
        />
      )
    }

    if (selection.kind === 'task') {
      return (
        <CockpitTaskFace
          cabinId={selection.cabinId}
          taskId={selection.id}
          entryCabinId={entryCabinId}
          cabinName={cabinName}
          projectName={projectName}
          tab={tab}
          onTabChange={setTab}
          onClose={close}
          onMutated={refetch}
          onAcceptanceMutated={() => advance(selection)}
          onOpenChat={chatThreadKey ? openChat : null}
        />
      )
    }

    // 会话（delegation）：六页签详情面（2026-11-25 用户）。
    if (selection.kind === 'delegation') {
      const delegationRow = row?.kind === 'delegation' ? row : null
      return (
        <CockpitSessionFace
          cabinId={selection.cabinId}
          delegation={delegationRow?.delegation ?? null}
          cabinName={cabinName}
          tab={tab}
          onTabChange={setTab}
          onClose={close}
          onOpenChat={chatThreadKey ? openChat : null}
        />
      )
    }

    return (
      <CockpitAttentionFace
        cabinId={selection.cabinId}
        attentionId={selection.id}
        onClose={close}
      />
    )
  })()

  return (
    <>
      {/* 原型 .pscrim：作业详情是覆盖舱面的玻璃 dossier，不是把舞台撑满的窗口。
          v22.3：从 inbox 打开的 aside 不压右侧 —— scrim 透明且不吃点击，
          浮层与详情真正并排可操作。 */}
      <div
        className={cn('ck12-face-scrim', asideInbox && 'is-aside-inbox')}
        data-testid="cockpit-face-scrim"
        onClick={close}
        aria-hidden="true"
      />
      <div
        ref={faceRef}
        className={cn(
          'ck12-face',
          (maxed || (geo && !asideInbox)) && 'is-geo',
          // 从「要我处理」里开详情：固定让到 inbox 左侧（不遮挡、不居中）。
          // 单栏 378 / 两栏 764，由 data-inbox-two 区分。
          asideInbox && 'is-aside-inbox',
        )}
        data-inbox-two={inboxOpen && inboxSel ? '1' : undefined}
        style={asideInbox ? undefined : panelStyle}
        data-testid="cockpit-face"
        data-entry-cabin={entryCabinId}
        data-selected-cabin={selection.cabinId}
        data-maximized={maxed ? '1' : undefined}
        onPointerDownCapture={startDrag}
        onDoubleClick={onHeaderDoubleClick}
      >
        <DossierWindowContext.Provider value={winApi}>
          <CockpitTreeContext.Provider value={treeApi}>
            {body}
          </CockpitTreeContext.Provider>
        </DossierWindowContext.Provider>
        {/* 原型 .pgrip：右下角拖拽缩放（全屏时不给拖）。 */}
        <span
          className="ck12-pgrip"
          data-testid="cockpit-dossier-grip"
          title="拖拽调整大小"
          aria-hidden="true"
          onPointerDown={startResize}
        />
      </div>
      {treeScope && (
        <CockpitTreeWindow scope={treeScope} onClose={() => setTreeScope(null)} />
      )}
    </>
  )
}
