'use client'

import { useCallback, useRef, useState } from 'react'
import {
  kcCompileRetry,
  kcGetCompileTask,
  kcGetQueueTask,
  kcGetRevertTask,
  kcGetRetireTask,
  kcIngest,
  kcRevert,
  kcRetire,
  type KcIngestInput,
} from '@/lib/knowledge/knowledge-center-api'
import type {
  KcCardEvent,
  KcCompileDiffCardData,
  KcIngestCardData,
  KcPageRetireCardData,
  KcRevertState,
  KcSourceSummaryCardData,
} from '@/lib/knowledge-center/card-protocol'
import { classifyKcFeed, type KcFeedIntent } from '@/lib/knowledge-center/feed-protocol'
import { kcErrFace, kcPlaceholderTaskId, useKcPoller } from './use-kc-poller'

/**
 * 投喂/回滚编排 hook（票12 AC3/AC5，Lane B 卡片 store）。
 *
 * 链路：对话文本 → classifyKcFeed → POST /ingest?compile=true（票02/05）→
 * 抓取卡落定 → compileTask 起 **diff 卡**；轮询 GET /compile/task/:id +
 * GET /queue/task/:id（票06 位次单源）合并成卡状态：排队中 #N → 编译中 →
 * 已提交 hash；committed 追加 **来源摘要卡**（touched 里的 source 回执页）。
 * 回滚：diff 卡二次确认 → POST /revert → 同卡挂 revert 状态轮询（committed →
 * 已回滚 hash；failed 显形 REVERT_CONFLICT/LOCK_HELD）。
 *
 * 事件源选**轮询**而非新 SSE：既有 SSE 基建（lib/agent/sse.ts）绑死 chat 连接形态，
 * 任务状态端点面（票05/06/12）是它的正交可承载形态（票面授权「选既有 SSE 基建能
 * 承载的形态」）；先立即一拍再按 pollMs 间隔，终态自停——拍次调度/瞬断续拍/
 * 卸载清定时器收口在共享核 `use-kc-poller`（code-review judgement，行为零改）。
 * id 锚定幂等（dif-/sum-<taskId>），宿主（chat-column）按 sessionId 侧挂
 * localStorage 完成 Lane B 沉淀（契约见 card-protocol 头注释）。
 */

export interface UseKcFeedOptions {
  /** 轮询间隔（先拍后隔；默认 800ms） */
  pollMs?: number
  /** 编译/回滚 committed 后回调（宿主刷新 tree/health） */
  onSettled?: () => void
}

export function useKcFeed(opts: UseKcFeedOptions = {}) {
  const pollMs = opts.pollMs ?? 800
  const [cards, setCards] = useState<KcCardEvent[]>([])
  /** commit → 回滚态覆盖层（revert 状态可落在 Lane A 沉淀卡上——store 里没有该卡
   *  也能回灌渲染；宿主用 `revertStates[card.commit]` 合并）。 */
  const [revertStates, setRevertStates] = useState<Record<string, KcRevertState>>({})
  const cardsRef = useRef<Map<string, KcCardEvent>>(new Map())
  const seqRef = useRef(0)
  const onSettledRef = useRef(opts.onSettled)
  onSettledRef.current = opts.onSettled
  const poller = useKcPoller(pollMs)

  const nowIso = () => new Date().toISOString()

  const upsert = useCallback((event: KcCardEvent) => {
    cardsRef.current.set(event.id, event)
    setCards([...cardsRef.current.values()])
  }, [])

  /** 宿主装载侧挂沉淀（Lane B 重hydration；live 同 id 覆盖 persisted）。 */
  const restore = useCallback((persisted: KcCardEvent[]) => {
    for (const ev of persisted) {
      if (!cardsRef.current.has(ev.id)) cardsRef.current.set(ev.id, ev)
    }
    setCards([...cardsRef.current.values()])
  }, [])

  const reset = useCallback(() => {
    poller.stopAll()
    cardsRef.current.clear()
    setCards([])
    setRevertStates({})
  }, [poller])

  // ── 编译任务轮询（queued #N → running → committed/failed）──
  /** D-kc15-1（票07）：编译态镜像回灌关联抓取卡（ingestCardId 传入时）——failed 态挂重试入口。 */
  const mirrorToIngest = useCallback((ingestCardId: string | undefined, compile: NonNullable<KcIngestCardData['compile']>) => {
    if (!ingestCardId) return
    const base = cardsRef.current.get(ingestCardId)
    if (!base || base.kind !== 'ingest') return
    upsert({ ...base, ts: nowIso(), data: { ...(base.data as KcIngestCardData), compile } })
  }, [upsert])

  const trackCompile = useCallback((taskId: string, rawPath: string, ingestCardId?: string) => {
    let misses = 0
    poller.run(async (): Promise<boolean> => {
      const [task, queue] = await Promise.all([kcGetCompileTask(taskId), kcGetQueueTask(taskId)])
      if (!task) {
        if (++misses >= 3) {
          upsert({ id: `dif-${taskId}`, kind: 'compile-diff', ts: nowIso(), data: {
            taskId, status: 'failed', touched: [], error: { code: 'TASK_LOST', message: '编译任务不可查（服务重启？git LOG 为审计真相）' },
          } satisfies KcCompileDiffCardData })
          mirrorToIngest(ingestCardId, { taskId, status: 'failed', error: { code: 'TASK_LOST', message: '编译任务不可查' } })
          return true
        }
        return false
      }
      const status: KcCompileDiffCardData['status'] = task.status === 'compiling' ? 'running' : task.status
      const prev = cardsRef.current.get(`dif-${taskId}`)
      const data: KcCompileDiffCardData = {
        taskId,
        status,
        position: queue?.state === 'queued' ? queue.position : null,
        rawPath,
        rawTitle: task.result?.rawTitle ?? (prev?.data as KcCompileDiffCardData | undefined)?.rawTitle,
        touched: task.result?.touched ?? [],
        created: task.result?.created,
        updated: task.result?.updated,
        contradictions: task.result?.contradictions,
        commit: task.result?.commit ?? undefined,
        ftsOk: task.result ? task.result.warnings.length === 0 : undefined,
        error: task.error ?? queue?.error,
        revert: (prev?.data as KcCompileDiffCardData | undefined)?.revert,
      }
      upsert({ id: `dif-${taskId}`, kind: 'compile-diff', ts: nowIso(), data })
      mirrorToIngest(ingestCardId, { taskId, status, position: data.position, ...(data.error ? { error: data.error } : {}) })
      if (task.status === 'committed') {
        const src = task.result?.touched.find(t => t.type === 'source' || t.path.startsWith('sources/'))
        if (src) {
          upsert({ id: `sum-${taskId}`, kind: 'source-summary', ts: nowIso(), data: {
            sourcePath: src.path, rawPath, hash: task.result?.rawHash, points: [],
          } satisfies KcSourceSummaryCardData })
        }
        onSettledRef.current?.()
        return true
      }
      return task.status === 'failed'
    })
  }, [poller, upsert, mirrorToIngest])

  /**
   * 投喂入口：分类后的意图 → ingest(+compile) → 卡链。
   * 抓取卡 id 锚 runId（结果落定前 hash 未知；Lane A 沉淀形态才用 hash 锚——见协议注释）。
   */
  const feed = useCallback(async (intent: KcFeedIntent): Promise<void> => {
    const runId = `r${Date.now().toString(36)}-${String(++seqRef.current).padStart(3, '0')}`
    const ingId = `ing-${runId}`
    upsert({ id: ingId, kind: 'ingest', ts: nowIso(), data: { status: 'fetching' } satisfies KcIngestCardData })
    const input: KcIngestInput =
      intent.mode === 'url' ? { mode: 'url', url: intent.url }
        : intent.mode === 'file' ? { mode: 'file', path: intent.path }
          : { mode: 'text', text: intent.text }
    try {
      const res = await kcIngest(input)
      upsert({ id: ingId, kind: 'ingest', ts: nowIso(), data: {
        status: 'done', rawPath: res.raw.path, bytes: res.raw.bytes, hash: res.raw.hash,
        origin: res.raw.origin ?? undefined, title: res.raw.title ?? undefined,
      } satisfies KcIngestCardData })
      if (res.compileTask) {
        upsert({ id: `dif-${res.compileTask.taskId}`, kind: 'compile-diff', ts: nowIso(), data: {
          taskId: res.compileTask.taskId, status: 'queued', position: null,
          rawPath: res.raw.path, rawTitle: res.title || res.raw.title || undefined, touched: [],
        } satisfies KcCompileDiffCardData })
        trackCompile(res.compileTask.taskId, res.raw.path, ingId)
      }
    } catch (err) {
      upsert({ id: ingId, kind: 'ingest', ts: nowIso(), data: { status: 'failed', error: kcErrFace(err, 'FEED_ERROR') } satisfies KcIngestCardData })
    }
  }, [trackCompile, upsert])

  /**
   * 重试编译（D-kc15-1 票07）：抓取卡 failed 态入口——POST /wiki/compile 同 rawPath，
   * **复用 ingest-compile 全局串行队列通道**（红线2 禁直写 wiki，不新增旁路）；
   * 新任务起 dif 卡并接续轮询，编译态回灌原抓取卡。
   */
  const retryCompile = useCallback(async (cardId: string, rawPath: string): Promise<void> => {
    const base = cardsRef.current.get(cardId)
    if (!base || base.kind !== 'ingest') return
    try {
      const ack = await kcCompileRetry(rawPath)
      mirrorToIngest(cardId, { taskId: ack.taskId, status: 'queued', position: null })
      upsert({ id: `dif-${ack.taskId}`, kind: 'compile-diff', ts: nowIso(), data: {
        taskId: ack.taskId, status: 'queued', position: null,
        rawPath, rawTitle: (base.data as KcIngestCardData).title ?? undefined, touched: [],
      } satisfies KcCompileDiffCardData })
      trackCompile(ack.taskId, rawPath, cardId)
    } catch (err) {
      mirrorToIngest(cardId, { taskId: kcPlaceholderTaskId('retry'), status: 'failed', error: kcErrFace(err, 'RETRY_ERROR') })
    }
  }, [mirrorToIngest, trackCompile, upsert])

  // ── 回滚（AC5：diff 卡钮 → 二次确认后调用；状态回灌原卡）──
  const trackRevert = useCallback((taskId: string, commit: string) => {
    const attach = (revert: KcRevertState) => {
      setRevertStates(prev => ({ ...prev, [commit]: revert }))
      // store 里有同 commit 的 Lane B 卡 ⇒ 也原地更新（渲染只走一条合并路径时不双源）
      const prev = [...cardsRef.current.values()].find(
        e => e.kind === 'compile-diff' && (e.data as KcCompileDiffCardData).commit === commit,
      )
      if (prev) upsert({ ...prev, ts: nowIso(), data: { ...prev.data as KcCompileDiffCardData, revert } })
    }
    poller.run(async (): Promise<boolean> => {
      const [task, queue] = await Promise.all([kcGetRevertTask(taskId), kcGetQueueTask(taskId)])
      if (!task) return true // 任务面不可查：停在当前态（不炸流）
      const status: KcRevertState['status'] = task.status
      attach({
        taskId,
        status,
        position: queue?.state === 'queued' ? queue.position : null,
        revertCommit: task.result?.revertCommit,
        error: task.error ?? queue?.error,
      })
      if (status === 'committed') { onSettledRef.current?.(); return true }
      return status === 'failed'
    })
  }, [poller, upsert])

  const revert = useCallback(async (commit: string): Promise<void> => {
    setRevertStates(prev => ({ ...prev, [commit]: { taskId: kcPlaceholderTaskId('pending'), status: 'queued', position: null } }))
    try {
      const ack = await kcRevert(commit)
      trackRevert(ack.taskId, commit)
    } catch (err) {
      setRevertStates(prev => ({ ...prev, [commit]: { taskId: kcPlaceholderTaskId('err'), status: 'failed', error: kcErrFace(err, 'FEED_ERROR') } }))
    }
  }, [trackRevert])

  // ── 页退役（票08 · 故事32：对话退役意图 → POST /retire → 队列 page-retire，Lane B 回执卡）──
  const trackRetire = useCallback((taskId: string, pagePath: string) => {
    const card = (data: KcPageRetireCardData): void => {
      upsert({ id: `ret-${taskId}`, kind: 'page-retire', ts: nowIso(), data: { pagePath, ...data } })
    }
    poller.run(async (): Promise<boolean> => {
      const [task, queue] = await Promise.all([kcGetRetireTask(taskId), kcGetQueueTask(taskId)])
      if (!task) {
        card({ status: 'failed', error: { code: 'TASK_LOST', message: '退役任务不可查（git LOG 为审计真相）' } })
        return true
      }
      card({
        status: task.status,
        position: queue?.state === 'queued' ? queue.position : null,
        to: task.result?.retiredPath,
        commit: task.result?.retireCommit,
        error: task.error ?? queue?.error,
      })
      if (task.status === 'committed') { onSettledRef.current?.(); return true }
      return task.status === 'failed'
    })
  }, [poller, upsert])

  const retire = useCallback(async (pagePath: string, reason?: string): Promise<void> => {
    const pendingId = kcPlaceholderTaskId('retire')
    upsert({ id: `ret-${pendingId}`, kind: 'page-retire', ts: nowIso(), data: { status: 'queued', position: null, pagePath } })
    try {
      const ack = await kcRetire({ path: pagePath, ...(reason ? { reason } : {}) })
      // 用 ack.taskId 重新锚定卡（替换 pending 占位）
      cardsRef.current.delete(`ret-${pendingId}`)
      trackRetire(ack.taskId, ack.path || pagePath)
    } catch (err) {
      upsert({ id: `ret-${pendingId}`, kind: 'page-retire', ts: nowIso(), data: { status: 'failed', pagePath, error: kcErrFace(err, 'RETIRE_ERROR') } })
    }
  }, [trackRetire, upsert])

  return { cards, feed, revert, retryCompile, retire, restore, reset, revertStates, trackTask: trackCompile }
}
