'use client'

// S4 owns this file —— attention-only 行（无 job_id 的 attention）的面。
//
// 只展示真实字段：阶段徽章、awaiting、title/question/detail、repo/wt。
// CTA 只在有真实去处时出现：
//   · task_id → octopus:open-task（在聊天里打开该任务；stage==='review' 带
//     view:'acceptance'，与舱内「待路由」同一条协议）；
//   · finding:* / 其余 deep_link 目前没有可深链的应用路由 → 只展示事实、不放按钮。
// 时间：CabinAttentionItem 没有时间字段 —— 省略，不编一个。

import { ArrowRight, X } from 'lucide-react'
import type { CabinAttentionItem } from '@octopus/shared'
import { cn } from '@/lib/utils'
import { openTaskInChat } from '@/components/cabin/modules/ui'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'

const STAGE_LABEL: Record<CabinAttentionItem['stage'], string> = {
  review: '待验收',
  answer: '待回答',
  adjudicate: '待裁决',
  approval: '待审批',
  blocked: '受阻',
}

const AWAITING_LABEL: Record<CabinAttentionItem['awaiting'], string> = {
  person: '等你',
  working: '进行中',
  idle: '空闲',
  ended: '已结束',
}

export interface CockpitAttentionFaceProps {
  cabinId: string
  attentionId: string
  /** 关闭 = 收面（select(null)）。 */
  onClose: () => void
}

export function CockpitAttentionFace({ attentionId, onClose }: CockpitAttentionFaceProps) {
  const { rows } = useCockpitFleet()

  // attention 可能挂在 job 行上（job_id 命中）；CockpitFace 已优先解析成 job 面，
  // 这里兜底再找一次，避免 URL 深链进来时白屏。
  const attentionRow = rows.find((row) => row.kind === 'attention' && row.item.id === attentionId)
  const jobRow = rows.find((row) => row.kind === 'job' && row.attention?.id === attentionId)
  const item =
    (attentionRow && attentionRow.kind === 'attention' ? attentionRow.item : null) ??
    (jobRow && jobRow.kind === 'job' ? jobRow.attention ?? null : null)

  if (!item) {
    return (
      <>
        <div className="ck12-jh" data-testid="cockpit-face-attention">
          <div className="ck12-jh-h1">
            <button
              type="button"
              className="ck12-jh-x"
              data-testid="cockpit-attn-close"
              aria-label="收起作业面"
              title="收起（Esc）"
              onClick={onClose}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
            <h2 className="ck12-jh-title">这条待办已经处理掉了</h2>
          </div>
        </div>
        <div className="ck12-face-body">
          <div className="ck12-face-empty">编队里已经没有这条 attention。</div>
        </div>
      </>
    )
  }

  const repo = [item.repo, item.wt].filter(Boolean).join(' · ')
  const taskId = item.task_id

  return (
    <>
      <div className="ck12-jh" data-testid="cockpit-face-attention">
        <div className="ck12-jh-h1">
          <button
            type="button"
            className="ck12-jh-x"
            data-testid="cockpit-attn-close"
            aria-label="收起作业面"
            title="收起（Esc）"
            onClick={onClose}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
          <span className={cn('ck12-stage-badge', `is-${item.stage}`)}>
            {STAGE_LABEL[item.stage]}
          </span>
          <h2 className="ck12-jh-title" title={item.title}>{item.title}</h2>
          <span className="ck12-jh-status is-wait">{AWAITING_LABEL[item.awaiting]}</span>
          <span className="ck12-jh-spacer" />
        </div>
        {(repo || item.task_id) && (
          <div className="ck12-jh-h2">
            <div className="ck12-jh-segs">
              {repo && <span className="ck12-jh-seg ck12-jh-who" title={repo}>{repo}</span>}
            </div>
            <span className="ck12-jh-spacer" />
            <span className="ck12-jh-acts">
              {taskId && (
                <button
                  type="button"
                  className="ck12-jh-go"
                  data-testid="cockpit-attn-open-task"
                  onClick={() =>
                    openTaskInChat(
                      taskId,
                      item.stage === 'review' ? 'acceptance' : undefined,
                    )
                  }
                >
                  去处理 <ArrowRight className="ck12-jh-go-arrow" aria-hidden="true" />
                </button>
              )}
            </span>
          </div>
        )}
      </div>

      <div className="ck12-face-body" data-testid="cockpit-attn-body">
        {item.question && (
          <div className="ck12-attn-card">
            <div className="ck12-attn-label">要你定的事</div>
            <div className="ck12-attn-text">{item.question}</div>
          </div>
        )}
        {item.detail && (
          <div className="ck12-attn-card">
            <div className="ck12-attn-label">现场</div>
            <div className="ck12-attn-text">{item.detail}</div>
          </div>
        )}
        {!item.question && !item.detail && (
          <div className="ck12-face-empty">这条待办没有更多现场描述。</div>
        )}
        {item.deep_link && (
          <div className="ck12-attn-fact">
            <span className="ck12-attn-label">来源</span>
            <span className="ck12-attn-mono" title={item.deep_link}>{item.deep_link}</span>
          </div>
        )}
        {repo && (
          <div className="ck12-attn-fact">
            <span className="ck12-attn-label">位置</span>
            <span className="ck12-attn-mono">{repo}</span>
          </div>
        )}
      </div>
    </>
  )
}
