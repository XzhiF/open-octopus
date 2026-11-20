'use client'

// v22（design 33 §4）：动作图鉴 = **13 支视频片段**（不是 12 张静图）。
//
//   · 顺序 = 用户指定顺序（旧批次 3 + 新批次 10，command/thinking/wink 各两支）；
//   · 缩略图 = 视频 1.2s 抽帧 PNG，角标 `NN · 旧/新`；
//   · 悬停/聚焦起播该支片段（preload=none，不悬停不下载），离开暂停；
//   · 点卡 playClip：关面板就地演（片段下标 + pose 事件 → 视频立绘 + 粒子 + 台词 + toast）；
//   · 当前片段金边（state.clip 由 CockpitCrew 上报，重复姿态按片段区分）。
//
// 立绘与图鉴共用同一份 CLIPS（pose-model），没有第二套资产表。

import { toast } from 'sonner'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CLIPS, POSE_META } from '../crew/pose-model'
import { clipMediaUrl } from '../crew/clip-blob'
import { CockpitPanelShell } from './CockpitPanelShell'

/** 悬停预览：pointer/focus 进 → 抓成 blob 再起播（桌面端媒体 HTTP 管线慢，
 *  见 clip-blob；同一支与立绘共用缓存），出 → 暂停。 */
function preview(card: HTMLElement | null, on: boolean, src: string) {
  const video = card?.querySelector<HTMLVideoElement>('video')
  if (!card || !video) return
  card.dataset.preview = on ? '1' : '0'
  if (on) {
    void clipMediaUrl(src).then((url) => {
      // 抓包期间指针已经离开：不要再起播。
      if (!video.isConnected || card.dataset.preview !== '1') return
      if (video.getAttribute('src') !== url) {
        video.src = url
        video.load()
      }
      try {
        const p = video.play()
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch {
        /* 自动播放被拦：停在缩略图 */
      }
    })
  } else {
    try {
      video.pause()
    } catch {
      /* jsdom */
    }
  }
}

export function CockpitPosesPanel() {
  const { clip, closePanel } = useCockpitState()

  const play = (index: number) => {
    const item = CLIPS[index]
    if (!item) return
    closePanel()
    window.dispatchEvent(new CustomEvent('octopus:crew-pose', {
      detail: { pose: item.pose, clip: index, ms: 2600 },
    }))
    toast.success(`汐音 · ${POSE_META[item.pose].cn}：${POSE_META[item.pose].line}`)
  }

  return (
    <CockpitPanelShell kind="poses" title="汐音动作视频" en={`CLIP GALLERY · ${CLIPS.length}`} wide>
      <div className="ck12-poses" data-testid="cockpit-poses-gallery">
        {CLIPS.map((item, index) => {
          const meta = POSE_META[item.pose]
          const no = String(item.no).padStart(2, '0')
          return (
            <button
              key={item.src}
              type="button"
              className={`ck12-pose-card${clip === index ? ' is-on' : ''}`}
              data-testid={`cockpit-clip-card-${item.no}`}
              data-clip={index}
              data-batch={item.batch}
              onClick={() => play(index)}
              onPointerEnter={(event) => preview(event.currentTarget, true, item.src)}
              onPointerLeave={(event) => preview(event.currentTarget, false, item.src)}
              onFocus={(event) => preview(event.currentTarget, true, item.src)}
              onBlur={(event) => preview(event.currentTarget, false, item.src)}
              title={`${no} · ${meta.cn} · ${meta.desc} · ${item.batch}批次`}
            >
              <span className="ck12-pose-thumb">
                <img src={item.thumb} alt="" loading="lazy" />
                <video
                  className="ck12-pose-video"
                  src={item.src}
                  muted
                  playsInline
                  loop
                  preload="none"
                  aria-hidden="true"
                />
                <span className="ck12-pose-badge">{no} · {item.batch}</span>
              </span>
              <b>{meta.cn} <small>{meta.en}</small></b>
              <span className="ck12-pose-desc">{meta.desc}</span>
            </button>
          )
        })}
      </div>
      <div className="ck12-ops-foot">
        {CLIPS.length} 支动作片段（768×1152 VP9 alpha · 旧批次 3 + 新批次 10）· 人物高 / 脚底 / 中轴已统一 ·
        悬停预览 · 点击就地演 · 动作由真实状态驱动 · reduced-motion 停在单帧
      </div>
    </CockpitPanelShell>
  )
}
