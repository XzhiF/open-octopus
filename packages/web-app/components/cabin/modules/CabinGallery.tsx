'use client'

// S7 汐音立绘画廊（原型 wbGallery docs/cabin-design/index.html 1595-1605）：九种
// 表情立绘，点击让汐音切换形态（瞬时 mood override 6s），悬停可导出当前立绘。
// 当前 mood 卡高亮「当前」。立绘素材 = public/cabin/xiyin-*.png（committed 形象）。

import { Download, User } from 'lucide-react'
import { toast } from 'sonner'
import { cabinAudio } from '@/lib/cabin-audio'
import { useCockpit } from '../CockpitProvider'
import { WbH } from './ui'
import { XY_FORMS, moodPortrait } from '../cockpit'

export function CabinGallery() {
  const { mood, setMoodOverride } = useCockpit()

  const pick = (k: typeof XY_FORMS[number]['k'], name: string) => {
    setMoodOverride(k, 6000)
    cabinAudio.chime()
    toast(`汐音切换为「${name}」`)
  }
  const dl = (k: typeof XY_FORMS[number]['k'], name: string) => {
    const a = document.createElement('a')
    a.href = moodPortrait(k)
    a.download = `xiyin-${k}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
    cabinAudio.blip(880, 0.08)
    toast(`已导出汐音立绘（${name}）`)
  }

  return (
    <div className="gallery" data-testid="cabin-gallery-body">
      <WbH icon={User} title="汐音 · 立绘画廊" cap={`点击表情让汐音切换形态 · 共 ${XY_FORMS.length} 种 · 悬停可导出`} />
      <div className="xy-grid">
        {XY_FORMS.map((f) => (
          <div
            key={f.k}
            className={`xy-card${f.k === mood ? ' on' : ''}`}
            title={`切换为「${f.name}」`}
            onClick={() => pick(f.k, f.name)}
            data-testid={`gallery-card-${f.k}`}
            data-on={f.k === mood ? 'true' : undefined}
          >
            <div className="xc-img">
              <img src={moodPortrait(f.k)} alt={f.name} loading="lazy" />
              <span className="xc-tag">{f.tag}</span>
              <button
                type="button" className="xc-dl" title="导出这张立绘"
                onClick={(e) => { e.stopPropagation(); dl(f.k, f.name) }}
                data-testid={`gallery-dl-${f.k}`}
              ><Download className="size-3" /></button>
            </div>
            <div className="xc-meta"><b>{f.name}</b><span>{f.desc}</span></div>
          </div>
        ))}
      </div>
    </div>
  )
}