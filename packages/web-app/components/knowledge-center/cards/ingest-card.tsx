'use client'

import { CardShell, CardRow, CardBtnRow, KcBtn } from './card-shell'
import { formatBytes } from '@/lib/format'
import type { KcCardViewProps } from './registry'
import type { KcIngestCardData } from '@/lib/knowledge-center/card-protocol'

/** 📥 抓取卡 — 对话投喂抓取完成（原型 Tab④：raw 路径/大小/hash；AC2/AC3）。 */
export function IngestCard({ event, ctx }: KcCardViewProps) {
  const d = event.data as KcIngestCardData
  if (d.status === 'fetching') {
    return (
      <CardShell testId="ingest" title="📥 抓取卡" status="抓取中…">
        <CardRow k="状态" v="正在抓取并冻结到 raw/…" tone="muted" />
      </CardShell>
    )
  }
  if (d.status === 'failed') {
    return (
      <CardShell testId="ingest" title="📥 抓取卡" status={`抓取失败 ${d.error?.code ?? ''}`} tone="danger">
        <CardRow k="错误" v={d.error?.message ?? '未知错误'} tone="danger" />
      </CardShell>
    )
  }
  return (
    <CardShell
      testId="ingest"
      title={<>📥 抓取卡 · <span className={d.compile?.status === 'failed' ? 'text-pop-amber' : 'text-pop-green'}>{d.compile?.status === 'failed' ? '已落 raw · 编译失败' : '已落 raw（不可变）'}</span></>}
      tone={d.compile?.status === 'failed' ? 'danger' : 'ok'}
    >
      <CardRow k="raw 路径" v={d.rawPath ?? '—'} />
      <CardRow k="大小 / hash" v={`${formatBytes(d.bytes)} · ${d.hash?.slice(0, 6) ?? '—'}…`} />
      {d.origin && <CardRow k="来源" v={d.origin} tone="muted" />}
      {d.compile && d.compile.status !== 'committed' && (
        <CardRow
          k="编译"
          v={d.compile.status === 'failed'
            ? `失败 ${d.compile.error?.code ?? ''}：${d.compile.error?.message ?? ''}`
            : d.compile.status === 'queued' ? `排队中${typeof d.compile.position === 'number' ? ` #${d.compile.position}` : ''}` : '编译中…'}
          tone={d.compile.status === 'failed' ? 'danger' : 'muted'}
        />
      )}
      <CardBtnRow>
        <KcBtn tone="cy" onClick={() => d.rawPath && ctx.openRaw(d.rawPath)} testId="kc-ingest-open-raw">看 raw</KcBtn>
        {d.compile?.status === 'failed' && d.rawPath && (
          <KcBtn tone="no" onClick={() => ctx.retryCompile(event.id, d.rawPath!)} testId="kc-ingest-retry-compile">重试编译</KcBtn>
        )}
      </CardBtnRow>
    </CardShell>
  )
}
