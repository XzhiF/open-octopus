'use client'

// 非作业面的 dossier 头（项目 / 舱籍）：与作业面共用原型 .ph 的样子 ——
// ✕ 左置 + 标题 / 副行 + 右侧只有 ⛶（v21 五轮：右上不再放动作按钮）。
// 窗口化（拖拽 / 缩放 / 全屏）由 CockpitFace 统一持有，这里只消费 ⛶ 开关。

import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { useDossierWindow } from './dossier-window'

export interface CockpitFaceHeadProps {
  /** 整块头的 testid（默认无）。 */
  testId?: string
  /** 关闭钮的 testid（默认无；作业面用 cockpit-job-close）。 */
  closeTestId?: string
  /** 标题前的字形（原型 T 表：⬡ / ⧉ 等）。 */
  glyph?: string
  title: ReactNode
  /** 副行（拿不到的段整段省略）。 */
  sub?: ReactNode
  /** 标题右侧的局部动作（项目面的「← 舱籍总览」）；不传就只剩 ⛶。 */
  actions?: ReactNode
  onClose: () => void
  closeLabel?: string
}

export function CockpitFaceHead({
  testId,
  closeTestId,
  glyph,
  title,
  sub,
  actions,
  onClose,
  closeLabel = '收起',
}: CockpitFaceHeadProps) {
  const win = useDossierWindow()
  return (
    <div className="ck12-jh" data-testid={testId}>
      <div className="ck12-dh">
        <button
          type="button"
          className="ck12-jh-x"
          data-testid={closeTestId}
          aria-label={closeLabel}
          title="收起（Esc）"
          onClick={onClose}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
        <span className="ck12-dh-pt">
          <b>{glyph ? `${glyph} ` : ''}{title}</b>
          {sub && <span>{sub}</span>}
        </span>
        <span className="ck12-dh-sp" />
        {actions}
        {win && (
          <button
            type="button"
            className="ck12-pwin"
            data-testid="cockpit-dossier-max"
            aria-label={win.maximized ? '还原面板' : '全屏面板'}
            title="全屏 / 还原（也可双击标题栏）"
            onClick={win.toggleMax}
          >
            {win.maximized ? '⤡' : '⛶'}
          </button>
        )}
      </div>
    </div>
  )
}
