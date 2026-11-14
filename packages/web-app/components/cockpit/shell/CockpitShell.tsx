'use client'

// 全域座舱壳（cockpit-v12）。构图：
//   CabinProvider → CockpitProvider → CockpitStateProvider → CockpitLayerStack
//     → CockpitFleetProvider → [HUD / 编队 / 作业面 / 底栏 / 舰桥 / 立绘 / 简报 / 特效]
//
// 这一层是 S1 的壳：S2–S8 的组件已经全部建好空壳并在此一次性 import，
// 后续 Step 只改各自目录里的文件，**永远不需要再动这个壳**。

import { useMemo } from 'react'
import { useRouter } from '@/lib/app-navigation'
import type { CabinDetail } from '@/lib/cabin-api'
import { CabinProvider, useCabinContext } from '@/components/cabin/cabin-provider'
import { CockpitProvider } from '@/components/cabin/CockpitProvider'
import { CockpitStateProvider, useCockpitState } from '../state/CockpitStateProvider'
import { CockpitLayerStack } from '../state/CockpitLayerStack'
import { CockpitUrlSync } from '../entry/use-cockpit-url-sync'
import { CockpitShortcuts } from '../entry/CockpitShortcuts'
import { CockpitFleetProvider } from '../fleet/CockpitFleetProvider'
import { CockpitHud } from './CockpitHud'
import { CockpitStarfield } from './CockpitStarfield'
import { CockpitQuiet } from './CockpitQuiet'
import { CockpitTicker } from './CockpitTicker'
import { CockpitFleetRail } from '../rail/CockpitFleetRail'
import { CockpitFace } from '../face/CockpitFace'
import { CockpitChatHost } from '../chat/CockpitChatHost'
import { CockpitChatWindow } from '../chat/CockpitChatWindow'
import { CockpitCommandBar } from '../chat/CockpitCommandBar'
import { CockpitBridge } from '../bridge/CockpitBridge'
import { CockpitCrew } from '../crew/CockpitCrew'
import { CockpitBrief } from '../fx/CockpitBrief'
import { CockpitEffects } from '../fx/CockpitEffects'

export function CockpitShell({ cabinId }: { cabinId: string }) {
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

  if (loading) return <CockpitSkeleton />
  if (!cabin) {
    return (
      <CockpitMissing
        message="舱不在了"
        detail={error === 'not-found' ? '舱不存在或已被删除。' : (error ?? '舱加载失败。')}
      />
    )
  }

  return (
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
  )
}

function CockpitSurface({ cabin }: { cabin: CabinDetail }) {
  const { entryCabinId, selection } = useCockpitState()

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
    <div className="ck12-app" data-testid="cockpit-shell">
      <div className="ck12-bg" aria-hidden="true">
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

      <main className="ck12-stage">
        <CockpitFleetRail />
        <section
          id="ck12-arena"
          className={`ck12-arena${selection ? ' is-open' : ''}`}
          data-testid="cockpit-arena"
        >
          <CockpitQuiet />
          <CockpitFace entryCabinId={entryCabinId} />
          <CockpitCrew />
        </section>
      </main>

      <footer className="ck12-cmd">
        <CockpitTicker />
        <CockpitBridge />
        <CockpitCommandBar entryCabinId={entryCabinId} />
      </footer>

      <CockpitChatHost entryCabinId={entryCabinId} />
      <CockpitChatWindow />
      {/* 任务模块窗（运行 / YAML / 子代理）的挂载层：与 app 同大、z 高于聊天浮窗。
          pointer-events:none —— 空层不吃点击，窗本身自带事件。见 chat/CockpitChatHost.tsx。 */}
      <div id="ck12-layer-root" className="ck12-layerroot" />
      <CockpitBrief />

      <div className="ck12-vignette" aria-hidden="true" />
    </div>
  )
}

/** 载入 / 草稿·初始化 / 无主会话 —— 只做渲染层提示，聊天禁用态留给 S5。 */
function CockpitStatusBanner({ cabin }: { cabin: CabinDetail }) {
  const router = useRouter()

  if (cabin.status === 'draft' || cabin.status === 'initializing') {
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
