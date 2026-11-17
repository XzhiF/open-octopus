'use client'

// S7 知识窗（计划 S7 · 薄包装）：findings 复用生产 FindingCard + useKcFindings
// （adopt/ignore/fix 轮询全走全局 /api/knowledge 通道），列表经服务端 G4 读时
// scoping（raw origin → task.cabin_id / 舱仓库）；wiki 读复用 searchKc/getKcArticle。
// 裁决在主 chat 也能做（orchestrator 裁决知识，C3）——这里给人一个直达面。

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, BookOpen, ExternalLink, Search } from 'lucide-react'
import { toast } from 'sonner'
import { FindingCard } from '@/components/knowledge-center/cards/finding-card'
import type { KcCardActionCtx } from '@/components/knowledge-center/cards/registry'
import { useKcFindings, viewToFindingCardData } from '@/hooks/use-kc-findings'
import {
  getKcArticle, searchKc,
  type KcArticle, type KcFindingView, type KcSearchHit,
} from '@/lib/knowledge/knowledge-center-api'
import { getCabinFindings } from '@/lib/cabin-api'
import { useRouter } from '@/lib/app-navigation'
import { MarkdownPreview, MARKDOWN_TUI_CLASS } from '@/components/resource/MarkdownPreview'
import { useCabinContext } from '../cabin-provider'
import { Empty, WBtn, WbH, WbNote, WbSec } from './ui'

function articleIdOf(target: string): string {
  return (target.split('/').pop() ?? target).replace(/\.md$/, '')
}

export function CabinKnowledge() {
  const { cabinId } = useCabinContext()
  const router = useRouter()
  const [tab, setTab] = useState<'findings' | 'wiki'>('findings')
  const [findings, setFindings] = useState<KcFindingView[] | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KcSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [article, setArticle] = useState<KcArticle | null>(null)
  const [articleError, setArticleError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setFindings(await getCabinFindings(cabinId))
    } catch {
      /* 失败保留旧数据，不伪造空态 */
    }
  }, [cabinId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const timer = setInterval(() => { void load() }, 10_000)
    return () => clearInterval(timer)
  }, [load])

  const kc = useKcFindings({ autoLoad: false, onSettled: () => { void load() } })

  const openArticle = useCallback(async (target: string) => {
    setTab('wiki')
    setArticleError(null)
    try {
      setArticle(await getKcArticle(articleIdOf(target)))
    } catch (err) {
      setArticle(null)
      setArticleError(err instanceof Error ? err.message : '文章读取失败')
    }
  }, [])

  const ctx: KcCardActionCtx = {
    openPage: (target) => { void openArticle(target) },
    openRaw: () => toast('raw 源文件请在知识中心查看'),
    revert: () => toast('回滚请在知识中心操作'),
    retryCompile: () => toast('重试编译请在知识中心操作'),
    sayToCurator: (text) => {
      void navigator.clipboard.writeText(text).then(
        () => toast('讨论开头已复制 · 粘贴到舱主对话继续'),
        () => toast('复制失败 · 请手动在主对话提出讨论'),
      )
    },
    adoptFinding: (id) => { void kc.adopt(id) },
    ignoreFinding: (id) => { void kc.ignore(id) },
    backfillWiki: () => toast('回填请在知识中心操作'),
    dismissBackfill: () => {},
    recompilePack: () => toast('素材包操作请在知识中心'),
    retireCase: () => toast('判例操作请在知识中心'),
  }

  const runSearch = async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setArticle(null)
    try {
      const res = await searchKc(q, 10)
      setHits(res.results)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '搜索失败')
    } finally {
      setSearching(false)
    }
  }

  const statusOf = (f: KcFindingView): 'open' | 'resolved' | 'ignored' => {
    const override: 'resolved' | 'ignored' | undefined = kc.findingStatus[f.id]
    return override ?? f.status
  }
  const open = (findings ?? []).filter((f) => statusOf(f) === 'open')
  const settled = (findings ?? []).filter((f) => statusOf(f) !== 'open')

  return (
    <div data-testid="cabin-knowledge-body">
      <WbH icon={BookOpen} title="知识" cap="舱 scoped findings · wiki 读">
        <WBtn onClick={() => router.push('/knowledge')} title="打开完整知识中心">
          <ExternalLink className="size-3" />知识中心
        </WBtn>
      </WbH>
      <div className="mb-3 flex gap-1 border-b-[1.5px] border-pop-bd">
        {([['findings', `待裁决${open.length ? ` · ${open.length}` : ''}`], ['wiki', 'wiki 查阅']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            data-testid={`cabin-knowledge-tab-${key}`}
            onClick={() => setTab(key)}
            className={`-mb-[1.5px] border-b-2 px-3 py-1.5 text-[12px] ${
              tab === key ? 'border-pop-pink font-semibold text-pop-ink' : 'border-transparent text-pop-dim hover:text-pop-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'findings' ? (
        <>
          <WbNote className="mb-3">
            G4 读时 scoping：finding 的 raw 锚点（origin task-archive:&lt;id&gt;）反查任务 ——
            任务属本舱或仓库相交才入列；无锚点的巡检项不入舱。裁决复用全局队列（采纳即编译），
            也可在主 chat 让调度者裁决。
          </WbNote>
          {findings === null ? (
            <Empty>读取舱内 findings…</Empty>
          ) : open.length === 0 && settled.length === 0 ? (
            <Empty>舱内暂无 findings · 知识在自主沉淀</Empty>
          ) : (
            <>
              {open.length > 0 && (
                <>
                  <WbSec cap={`${open.length} 项`}>待裁决</WbSec>
                  <div className="space-y-2" data-testid="cabin-findings-open">
                    {open.map((f) => (
                      <FindingCard
                        key={f.id}
                        event={{
                          id: f.id, kind: 'finding', ts: f.createdAt,
                          data: { ...viewToFindingCardData(f), status: statusOf(f), fix: kc.fixStates[f.id] },
                        }}
                        ctx={ctx}
                      />
                    ))}
                  </div>
                </>
              )}
              {settled.length > 0 && (
                <>
                  <WbSec cap={`${settled.length} 项`}>已裁决</WbSec>
                  <div className="space-y-2 opacity-75" data-testid="cabin-findings-settled">
                    {settled.map((f) => (
                      <FindingCard
                        key={f.id}
                        event={{
                          id: f.id, kind: 'finding', ts: f.createdAt,
                          data: {
                            ...viewToFindingCardData(f),
                            status: statusOf(f),
                            fix: kc.fixStates[f.id],
                          },
                        }}
                        ctx={ctx}
                      />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch() }}
              placeholder="搜索 wiki（实体/概念/主题/判例）…"
              aria-label="搜索 wiki"
              data-testid="cabin-wiki-search"
              className="ui-font flex-1 rounded-md border border-pop-bd bg-pop-bg px-2.5 py-1.5 text-[11.5px] text-pop-ink outline-none focus:border-pop-pink"
            />
            <WBtn pri onClick={() => { void runSearch() }} disabled={searching || !query.trim()}>
              <Search className="size-3" />{searching ? '搜索中' : '搜索'}
            </WBtn>
          </div>
          {article ? (
            <div data-testid="cabin-wiki-article">
              <div className="mb-2 flex items-center gap-2">
                <WBtn onClick={() => setArticle(null)} title="返回搜索结果">
                  <ArrowLeft className="size-3" />返回
                </WBtn>
                <b className="ui-font min-w-0 truncate text-[13px] text-pop-ink">{article.title}</b>
                <span className="ml-auto shrink-0 text-[10px] text-pop-dim">{article.domain}</span>
              </div>
              {article.summary && <WbNote className="mb-2">{article.summary}</WbNote>}
              <div className="rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle p-3">
                <MarkdownPreview content={article.body} className={MARKDOWN_TUI_CLASS} />
              </div>
            </div>
          ) : articleError ? (
            <Empty>{articleError}</Empty>
          ) : hits === null ? (
            <Empty>输入关键词搜索舱外全局 wiki · 点结果内联阅读</Empty>
          ) : hits.length === 0 ? (
            <Empty>没有匹配的 wiki 页</Empty>
          ) : (
            <div className="space-y-1.5" data-testid="cabin-wiki-hits">
              {hits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => { void openArticle(h.id) }}
                  className="block w-full rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle p-2.5 text-left transition-colors hover:border-pop-pink"
                >
                  <b className="ui-font block text-[12px] text-pop-ink">{h.title}</b>
                  <span className="mt-0.5 block text-[10px] text-pop-dim">{h.domain} · {h.path}</span>
                  {h.snippet && <span className="mt-1 block text-[10.5px] leading-relaxed text-pop-dim">{h.snippet}</span>}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}