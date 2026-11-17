'use client'

// v21（design 31 §3.5 poses）：动作图鉴 —— 12 卡（缩略图 + 中英名 + 描述）。
// 点卡 playPose：关面板就地演（姿态事件 → 帧播放器 + 粒子 + 台词 + toast）；
// 当前姿态金边（state.pose 由 CockpitCrew 上报）。缩略图 = 单帧 pose-*.png。
// 12 套立绘 2026-11-17 重绘，动画 sheet 待补：当前为单帧静图，帧播放器就绪。

import { toast } from 'sonner'
import { useCockpitState } from '../state/CockpitStateProvider'
import { POSE_META, POSE_ORDER, POSE_THUMBS, type PoseKey } from '../crew/pose-model'
import { CockpitPanelShell } from './CockpitPanelShell'

export function CockpitPosesPanel() {
  const { pose, closePanel } = useCockpitState()

  const play = (key: PoseKey) => {
    closePanel()
    window.dispatchEvent(new CustomEvent('octopus:crew-pose', { detail: { pose: key, ms: 2600 } }))
    toast.success(`汐音 · ${POSE_META[key].cn}：${POSE_META[key].line}`)
  }

  return (
    <CockpitPanelShell kind="poses" title="动作图鉴" en="POSE GALLERY · 12" wide>
      <div className="ck12-poses" data-testid="cockpit-poses-gallery">
        {POSE_ORDER.map((key) => {
          const meta = POSE_META[key]
          return (
            <button
              key={key}
              type="button"
              className={`ck12-pose-card${pose === key ? ' is-on' : ''}`}
              data-testid={`cockpit-pose-card-${key}`}
              onClick={() => play(key)}
              title={`${meta.cn} · ${meta.desc} · ${meta.fps}fps`}
            >
              <span className="ck12-pose-thumb">
                <img src={POSE_THUMBS[key]} alt="" loading="lazy" />
              </span>
              <b>{meta.cn} <small>{meta.en}</small></b>
              <span className="ck12-pose-desc">{meta.desc} · {meta.fps}fps</span>
            </button>
          )
        })}
      </div>
      <div className="ck12-ops-foot">
        12 套单帧立绘（1024×1536 透明底）· 动作由真实状态驱动 · 粒子层随姿态切换 ·
        reduced-motion 静帧 · 动画 sheet 待 VideoGen 补齐后自动切 12 帧
      </div>
    </CockpitPanelShell>
  )
}
