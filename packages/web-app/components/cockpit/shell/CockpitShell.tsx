'use client'

// 全域座舱壳（cockpit-v12）。构图：
//   CabinProvider → CockpitProvider → CockpitStateProvider → CockpitLayerStack
//     → CockpitFleetProvider → [HUD / 编队 / 作业面 / 底栏 / 舰桥 / 立绘 / 简报 / 特效]
//
// 这一层是 S1 的壳：S2–S8 的组件已经全部建好空壳并在此一次性 import，
// 后续 Step 只改各自目录里的文件，**永远不需要再动这个壳**。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from '@/lib/app-navigation'
import type { CabinDetail } from '@/lib/cabin-api'
import { CabinProvider, useCabinContext } from '@/components/cabin/cabin-provider'
import { CockpitProvider } from '@/components/cabin/CockpitProvider'
import { CockpitStateProvider, useCockpitState } from '../state/CockpitStateProvider'
import { CockpitLayerStack } from '../state/CockpitLayerStack'
import { CockpitUrlSync } from '../entry/use-cockpit-url-sync'
import { CockpitShortcuts } from '../entry/CockpitShortcuts'
import { CockpitFleetProvider, useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { CockpitHud } from './CockpitHud'
import { CockpitNotesWindow } from './CockpitNotesWindow'
import { CockpitSettings } from './CockpitSettings'
import { CockpitStarfield } from './CockpitStarfield'
import { useCockpitCloseGuard } from './use-cockpit-close-guard'
import { CockpitScene } from '../scene/CockpitScene'
import { AskWindowsProvider, useAskWindows } from '@/components/cabin/asks/ask-windows-provider'
import { AskWindowLayer } from '@/components/cabin/asks/ask-window-layer'
import { CockpitFleetRail } from '../rail/CockpitFleetRail'
import { CockpitRightRail } from '../rail/CockpitRightRail'
import { CockpitActivityProvider } from '../rail/activity-feed'
import { CockpitActivityWindow } from '../rail/CockpitActivityWindow'
import { CockpitFace } from '../face/CockpitFace'
import { CockpitCabinTree } from '../face/CockpitCabinTree'
import { CockpitCabinChanges } from '../face/CockpitCabinChanges'
import { CockpitDocWindow } from '../face/CockpitDocWindow'
import { CockpitKnowledgeWindow } from '../face/CockpitKnowledgeWindow'
import { CockpitChatHost } from '../chat/CockpitChatHost'
import { CockpitChatWindow } from '../chat/CockpitChatWindow'
import { CockpitDock } from '../chat/CockpitDock'
import { CockpitPopWindows } from '../chat/CockpitPopWindows'
import { CockpitWinBar } from '../chat/CockpitWinBar'
import { CockpitThreadActivity } from '../chat/CockpitThreadActivity'
import { CockpitCrew } from '../crew/CockpitCrew'
import { CockpitCrewSettingsLayer } from '../crew/CockpitCrewSettings'
import { CockpitBootLayer } from './CockpitBootLayer'
import { CLIPS, poseClip, ENTRY_CLIP } from '../crew/pose-model'
import { clipMediaUrl } from '../crew/clip-blob'
import { CockpitBrief } from '../fx/CockpitBrief'
import { CockpitEffects } from '../fx/CockpitEffects'
import { CockpitWarpScheduler } from '../fx/CockpitWarpScheduler'
import { CockpitSim } from '../fx/CockpitSim'
import { CockpitPanels } from '../panels/CockpitPanels'

export function CockpitShell({ cabinId }: { cabinId: string }) {
  // 2026-11-20 用户：进舱 4–5s 看不到汐音。立绘要等 blob 抓包 + 解码，而舱详情
  // 还在加载时立绘组件还没挂载 —— 先在壳层预热：出场片（动作 01）最先，其次
  // 待命 / 有待办两种最可能的首拍；等 CockpitGate 放行时字节已在路上。
  useEffect(() => {
    if (!cabinId || cabinId === 'new') return
    void clipMediaUrl(CLIPS[ENTRY_CLIP]!.src)
    void clipMediaUrl(CLIPS[poseClip('ready')]!.src)
    void clipMediaUrl(CLIPS[poseClip('idle')]!.src)
    void clipMediaUrl(CLIPS[poseClip('alert')]!.src)
  }, [cabinId])

  if (!cabinId) {
    return <CockpitMissing message="缺少舱 id" detail="全域座舱需要一个已存在的舱。" />
  }
  if (cabinId === 'new') {
    return (
      <CockpitMissing
        message="新建舱还没有全域视图"
        detail="先完成初始化，再从作战舱进入全域。"
      />
    )
  }
  return (
    // key = 舱 id：深链换舱整舱重挂，选择/浮窗/特效状态不跨舱。
    <CabinProvider cabinId={cabinId} key={cabinId}>
      <CockpitGate />
    </CabinProvider>
  )
}

function CockpitGate() {
  const { cabin, loading, error } = useCabinContext()
  const failed = !loading && !cabin

  // boot 立绘与门禁分支并列：loading → 舱面这段切换里**不重挂**，
  // 否则换分支时 video 重来一遍，交接处会闪空档（见 CockpitBootLayer）。
  return (
    <>
      {loading ? (
        <CockpitSkeleton />
      ) : !cabin ? (
        <CockpitMissing
          message="舱不在了"
          detail={error === 'not-found' ? '舱不存在或已被删除。' : (error ?? '舱加载失败。')}
        />
      ) : (
        <CockpitProvider>
          <CockpitStateProvider entryCabinId={cabin.id}>
            <CockpitLayerStack>
              <CockpitFleetProvider>
                <CockpitUrlSync />
                <CockpitShortcuts />
                <CockpitSurface cabin={cabin} />
              </CockpitFleetProvider>
            </CockpitLayerStack>
          </CockpitStateProvider>
        </CockpitProvider>
      )}
      <CockpitBootLayer gateOpen={!loading} gateFailed={failed} />
    </>
  )
}

function CockpitSurface({ cabin }: { cabin: CabinDetail }) {
  const { entryCabinId, selection, layer } = useCockpitState()
  const { view } = useCabinContext()
  // 用户 #18：本舱有 agent 在跑时，关浏览器 / 窗口先确认，确认后先停流再走。
  useCockpitCloseGuard()

  // 背景漂浮粒子（原型 seedParticles：24 颗，随机时长/相位）。
  const particles = useMemo(
    () =>
      Array.from({ length: 24 }, () => ({
        left: `${Math.random() * 100}%`,
        duration: `${9 + Math.random() * 14}s`,
        delay: `${-Math.random() * 20}s`,
      })),
    [],
  )

  return (
    <AskWindowsProvider attention={view?.attention ?? null}>
    {/* v22 十四轮：右栏「活动」的数据源（汐音主会话的子代理 + 后台作业）。
        包住右栏与详情窗 —— 按钮徽标 / 列表 / 详情共用同一次轮询。 */}
    <CockpitActivityProvider>
    <CockpitAskDeepLink />
    <div className="ck12-app" data-testid="cockpit-shell">
      <div className="ck12-bg" aria-hidden="true">
        <CockpitScene />
        <div className="ck12-nebula ck12-n1" />
        <div className="ck12-nebula ck12-n2" />
        <div className="ck12-nebula ck12-n3" />
        <CockpitStarfield />
        <div className="ck12-floor" />
        <div className="ck12-horizon" />
        <div className="ck12-scan" />
        <div className="ck12-particles">
          {particles.map((particle, index) => (
            <span
              key={index}
              className="ck12-p"
              style={{
                left: particle.left,
                animationDuration: particle.duration,
                animationDelay: particle.delay,
              }}
            />
          ))}
        </div>
      </div>

      <CockpitEffects />

      <CockpitHud />
      <CockpitStatusBanner cabin={cabin} />
      {/* v21（design 31 §3.2/§3.3）：右栏紧凑待办 + 主按钮组。 */}
      <CockpitRightRail />

      <main className="ck12-stage">
        <CockpitFleetRail />
        <section
          id="ck12-arena"
          className={`ck12-arena${selection ? ' is-open' : ''}`}
          data-testid="cockpit-arena"
        >
          <CockpitCrew />
        </section>
      </main>

      {/* v21 三轮：作业详情是覆盖整舱的玻璃 dossier（原型 .panel/.pscrim）。
          必须挂在 arena 之外 —— arena 自带 z-index:2 的层叠上下文，放在里面
          会永远压在通讯台（共享 z 栈 31+）下面。 */}
      <CockpitFace entryCabinId={entryCabinId} />

      {/* v22 九轮：右栏「目录」= 本舱 cwd 只读目录窗（详情面没开也能开）。 */}
      <CockpitCabinTree cabinId={entryCabinId} />

      {/* v22 十三轮（问题 #1）：右栏「变更」= 本舱 cwd 的工作区改动（只读）。 */}
      <CockpitCabinChanges cabinId={entryCabinId} />

      {/* v22 十四轮：右栏「活动」二级大窗（贴在一级浮层左侧，只读）。 */}
      <CockpitActivityWindow />

      {/* 2026-11-19 用户 #4：聊天正文里的产物绝对路径点开 → 只读文档窗。 */}
      <CockpitDocWindow />

      {/* 2026-11-23 用户 #7：知识中心窗（classic knowledge 换皮搬进全舱）。 */}
      <CockpitKnowledgeWindow />

      {/* 2026-11-23 用户 #3：便签窗（classic 快速便签迁入）。HUD 最右「✎ 便签」开合。 */}
      <CockpitNotesWindow />

      {/* 原型没有屏幕级底栏：输入框在通讯台内（.con-in）。这里不再留 footer，
          通讯台底缘按视口 − 56 量（geometry 的 fallback）。 */}

      <CockpitChatHost entryCabinId={entryCabinId} />
      <CockpitChatWindow />
      {/* v20：用户自开弹出窗 + WINDOWS 切换条 + 通讯台停靠 pill + 线程活动接线。 */}
      <CockpitPopWindows />
      <CockpitWinBar />
      <CockpitDock />
      <CockpitThreadActivity />
      {/* 任务模块窗（运行 / YAML / 子代理）的挂载层：与 app 同大、z 高于聊天浮窗。
          pointer-events:none —— 空层不吃点击，窗本身自带事件。见 chat/CockpitChatHost.tsx。 */}
      <div id="ck12-layer-root" className="ck12-layerroot" />
      <CockpitBrief />
      <CockpitPanels />
      <CockpitSettings />
      {/* 2026-11-19 用户 #7：「更多 → ♡ 汐音」= 她的 AGENT 档案 + 既有在场设置。 */}
      <CockpitCrewSettingsLayer />
      <CockpitWarpScheduler />
      <CockpitSim />

      <div className="ck12-vignette" aria-hidden="true" />
    </div>
    </CockpitActivityProvider>
    {/* 问答窗 portal 到 body；Esc 走 CockpitLayerStack（priority 75）。 */}
    <AskWindowLayer mode="cockpit" escLayer={layer} />
    </AskWindowsProvider>
  )
}

/** 深链 `?attn=ask:<askId>`：attention 到齐后打开对应问答窗（design 26 §3.4）。
 *
 *  只读挂载时的 location 一次：`ask:<askId>` 是 deep_link 的词法，不是 attention
 *  行 id（行 id 是 `ask-<askId>`），所以不参与 selection / URL 回写；窗开出来后
 *  URL 是否保留该参数由既有的 url-sync 决定（打开即生效，不依赖回写）。
 *  `?job=` / `?task=` 优先：同时带作业深链时不开窗。 */
function CockpitAskDeepLink() {
  const { asks, open } = useAskWindows()
  const [target] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    const params = new URLSearchParams(window.location.search)
    if (params.get('job') || params.get('task')) return null
    const attn = params.get('attn')
    return attn?.startsWith('ask:') ? attn.slice('ask:'.length) : null
  })
  const openedRef = useRef(false)

  useEffect(() => {
    if (!target || openedRef.current) return
    const hit = asks.find((ask) => ask.askId === target)
    if (!hit) return // attention 还没到 / 已答：等下一次 asks 变化再判
    openedRef.current = true
    open(hit)
  }, [asks, open, target])

  return null
}

/** 载入 / 草稿·初始化 / 无主会话 —— 只做渲染层提示，聊天禁用态留给 S5。
 *  v21：编队已有行时不再显示草稿文案（9 条作业还挂着「没有编队」的横幅
 *  是假消息）；只有真的空编队才提示去初始化。 */
function CockpitStatusBanner({ cabin }: { cabin: CabinDetail }) {
  const router = useRouter()
  const { rows, loading } = useCockpitFleet()
  const hasFleet = rows.length > 0

  if (cabin.status === 'draft' || cabin.status === 'initializing') {
    if (hasFleet || loading) return null
    return (
      <div className="ck12-banner" role="status" data-testid="cockpit-status-banner">
        <span className="ck12-banner-dot" aria-hidden="true" />
        {cabin.status === 'draft'
          ? '舱还是草稿 · 全域视图暂时没有编队'
          : '舱正在初始化 · 编队稍后出现'}
        <button type="button" onClick={() => router.push(`/cabin/${cabin.id}`)}>
          去初始化 →
        </button>
      </div>
    )
  }

  if (cabin.main_session_id == null) {
    return (
      <div className="ck12-banner ck12-banner-quiet" role="status" data-testid="cockpit-status-banner">
        <span className="ck12-banner-dot" aria-hidden="true" />
        该舱还没有主会话 · 聊天暂不可用
      </div>
    )
  }

  return null
}

function CockpitSkeleton() {
  return (
    <div className="ck12-app ck12-skel" data-testid="cockpit-loading">
      <div className="ck12-skel-hud" />
      <div className="ck12-skel-stage">
        <div className="ck12-skel-rail" />
        <div className="ck12-skel-arena">载入舱…</div>
      </div>
    </div>
  )
}

function CockpitMissing({ message, detail }: { message: string; detail: string }) {
  const router = useRouter()
  return (
    <div className="ck12-missing" data-testid="cockpit-missing">
      <div>
        <div className="ck12-missing-title">{message}</div>
        <div className="ck12-missing-sub">{detail}</div>
        <div className="ck12-missing-actions">
          <button type="button" className="ck12-missing-btn" onClick={() => router.push('/')}>
            返回桌面
          </button>
        </div>
      </div>
    </div>
  )
}
