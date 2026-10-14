'use client'

import { CardShell, CardRow, CardBtnRow, KcBtn } from './card-shell'
import { kcTaskStateLabel, type KcMaterialPackCardData } from '@/lib/knowledge-center/card-protocol'
import type { KcCardViewProps } from './registry'

/**
 * 📦 素材包卡（P3 票02；spec §卡片与 UI「素材包卡（件清单+剔除重编译钮）」）。
 *
 * 件清单 = 名/类/大小（manifest 投影，sha256 短显供对质）；每素材件挂
 * [剔除重编译]：POST pack/recompile → **全局串行队列**（archive-compile，红线2），
 * 队列位次/终态经宿主覆盖层回灌（排队中 #N→编译中→已提交）。
 * 剔除=人裁素材源（红线3：即时生效的策展事实，非审批态——已剔件划线留审计，不退场）。
 * 「对策展人说」把焦点重编译意图灌进取号器（故事4 对话链的确定性入口之外的对话入口）。
 */

/** kind → 类图标（卡面「类」列；开放 kind 兜底 📎）。 */
const KIND_ICON: Record<string, string> = {
  'acceptance-ledger': '🧾',
  'phase-rejections': '↩️',
  'exec-jsonl-excerpt': '🧵',
  'pr-diff': '🔀',
  'matt-artifacts': '🧰',
  'adr-context-notes': '📐',
  'archive-summary': '📝',
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function MaterialPackCard({ event, ctx }: KcCardViewProps) {
  const d = event.data as KcMaterialPackCardData
  const rc = d.recompile
  const busy = rc?.status === 'queued' || rc?.status === 'running'

  const status = rc
    ? rc.status === 'failed'
      ? `重编译失败 ${rc.error?.code ?? ''}`
      : `重编译 ${kcTaskStateLabel({ status: rc.status, position: rc.position })}`
    : d.summaryIncluded
      ? `已冻结 ${d.items.length} 件 · 编译已入队`
      : `已冻结 ${d.items.length} 件 · 无总结件（LLM 缺席）`

  const tone = rc?.status === 'failed' ? 'danger' : d.summaryIncluded ? 'ok' : 'warn'

  return (
    <CardShell testId="material-pack" title={`📦 素材包卡 · task-${d.taskId}`} status={status} tone={tone}>
      <CardRow k="包" v={d.packPath} tone="muted" />
      <div className="mt-1 space-y-0.5" data-testid="kc-pack-items">
        {d.items.map(item => {
          const excluded = item.excluded === true || rc?.excludePath === item.path
          return (
            <div
              key={item.path}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-relaxed"
              data-testid={`kc-pack-item-${item.kind}`}
            >
              <span className={excluded ? 'text-pop-dim line-through' : 'text-pop-ink'}>
                {KIND_ICON[item.kind] ?? '📎'} {item.name}（{item.kind}）
              </span>
              <span className="text-pop-dim">{sizeText(item.bytes)}</span>
              {item.sha256 && <span className="text-pop-dim">sha {item.sha256.slice(0, 8)}…</span>}
              {excluded && <span className="font-bold text-pop-amber">已剔除</span>}
              {!excluded && item.kind !== 'archive-summary' && (
                <KcBtn
                  tone="no"
                  disabled={busy}
                  onClick={() => ctx.recompilePack(d.taskId, { excludePath: item.path })}
                  testId={`kc-pack-exclude-${item.kind}`}
                >
                  剔除重编译
                </KcBtn>
              )}
            </div>
          )
        })}
      </div>
      {rc?.status === 'failed' && (
        <CardRow k="错误" v={`${rc.error?.code ?? 'FAILED'}: ${rc.error?.message ?? ''}`} tone="danger" />
      )}
      <CardBtnRow>
        <KcBtn
          tone="pri"
          disabled={busy}
          onClick={() => ctx.sayToCurator(`重新编译 task-${d.taskId}，重点看 phase-2 打回那段`)}
          testId="kc-pack-ask-curator"
        >
          对策展人说（焦点重编译）
        </KcBtn>
      </CardBtnRow>
      {rc?.status === 'committed' && (
        <div className="mt-2 text-[11px] text-pop-dim" data-testid="kc-pack-recompile-done">
          {rc.focus ? '焦点重编译已提交（同包再提炼）' : '剔除生效，已按剩余素材件重编译（git LOG 为审计真相）'}
        </div>
      )}
    </CardShell>
  )
}
