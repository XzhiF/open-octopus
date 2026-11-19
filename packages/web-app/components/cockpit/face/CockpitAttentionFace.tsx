'use client'

// S4 owns this file —— attention-only 行（无 job_id 的 attention）的面。
//
// 只展示真实字段：阶段徽章、awaiting、title/question/detail、repo/wt。
// v21 五轮：头部换成 dossier 通用 `.ck12-dh`（右上只有 ⛶，不再挤动作按钮）；
// CTA 从头部移到正文底部（与项目面同一种文字按钮），只在有真实去处时出现：
//   · task_id → 打开该任务（stage==='review' 带 view:'acceptance'，与舱内
//     「待路由」同一条协议）；
//   · answer + ask: 深链 → 开浮窗并在主对话里滚到对应作答卡；
//   · 其余 deep_link 目前没有可深链的应用路由 → 只展示事实、不放按钮。
// 时间：CabinAttentionItem 没有时间字段 —— 省略，不编一个。

import type { CabinAttentionItem } from '@octopus/shared'
import { openAuthorAskInChat, openTaskInChat } from '@/components/cabin/modules/ui'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { CockpitFaceHead } from './CockpitFaceHead'

const STAGE_LABEL: Record<CabinAttentionItem['stage'], string> = {
  review: '待验收',
  answer: '待回答',
  adjudicate: '待裁决',
  approval: '待审批',
  blocked: '受阻',
  start: '待放行',
  notice: '已完成',
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
        <CockpitFaceHead
          testId="cockpit-face-attention"
          closeTestId="cockpit-attn-close"
          glyph="❗"
          title="这条待办已经处理掉了"
          onClose={onClose}
          closeLabel="收起作业面"
        />
        <div className="ck12-face-body">
          <div className="ck12-face-empty">编队里已经没有这条 attention。</div>
        </div>
      </>
    )
  }

  const repo = [item.repo, item.wt].filter(Boolean).join(' · ')
  const taskId = item.task_id
  const canAnswerInline = item.stage === 'answer' && item.deep_link?.startsWith('ask:')

  return (
    <>
      <CockpitFaceHead
        testId="cockpit-face-attention"
        closeTestId="cockpit-attn-close"
        glyph="❗"
        title={item.title}
        sub={[STAGE_LABEL[item.stage], AWAITING_LABEL[item.awaiting], repo]
          .filter(Boolean)
          .join(' · ')}
        onClose={onClose}
        closeLabel="收起作业面"
      />

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

        {(canAnswerInline || taskId) && (
          <div className="ck12-pcard-acts" style={{ marginTop: 10 }}>
            {canAnswerInline && (
              <button
                type="button"
                data-testid="cockpit-attn-answer-inline"
                onClick={() => openAuthorAskInChat(item.deep_link!.slice(4), taskId)}
              >
                在对话里回答 →
              </button>
            )}
            {taskId && (
              <button
                type="button"
                data-testid="cockpit-attn-open-task"
                onClick={() =>
                  openTaskInChat(taskId, item.stage === 'review' ? 'acceptance' : undefined)
                }
              >
                去任务对话 →
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}
