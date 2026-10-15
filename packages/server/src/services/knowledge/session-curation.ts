import type { KcCardEvent, KcCompileDiffCardData, KcIngestCardData } from "@octopus/shared"
import { shortHash } from "@octopus/shared"
import { IngestError, type IngestResult, type RawIngestService, type RawPointer } from "./raw"
import type { CompileTaskRecord } from "./wiki/curator-task"

/**
 * 票10 · 投喂泛化服务（spec §投喂泛化，故事 19-21）——任意会话意图路由后的策展接线板。
 *
 * 链路（**零平行机制**，红线1）：
 *   curate() 穿打**同一个** RawIngestService 实例（票02 冻结契约：抓取/paste/文件三形态、
 *   hash 去重、不可变落盘）→ **同一个**编译投递 seam（生产 = curatorTasks.submit 经全局
 *   FIFO 队列 ingest-compile opKind，零新 kind）→ Lane A 卡片经 `appendCardsToSession`
 *   泛化原语回流**发起会话**（切片1 落位）。
 *
 * 最近先例 = BackfillService（backfill.ts:41）：sessionId 一等参数流入投喂链、
 * text 形态 origin=chat:〈session〉 信道纪律逐字继承。URL/文件形态 origin 保持
 * 票02 原生指针（url:/file: 溯源），会话归属记在任务记录与卡片链上。
 *
 * 卡片两拍形态（announcePack 链尾回填 + 判例终态卡同址重发先例）：
 *  - 首拍（curate 同步）：抓取卡 `ing-<hash8>`（done + 编译态镜像 queued #N）
 *    + diff 卡 `dif-<taskId>`（队列快照 queued）；
 *  - 终拍（onCompileSettled，编译异步落定）：同 id `dif-<taskId>` 重发终态
 *    （committed 带 commit/触及页/ftsOk，failed 带错误码——不伪造）。
 * 回流失败（DB 炸/会话已删）⇒ 诚实降级 cardsPosted=false，不吞投喂成果（报对话同律）。
 *
 * 零回归边界：onCompileSettled 只处理带 sessionId 的任务——知识中心/归档/重试等
 * 既有来源编译终态**不写任何会话消息**（Lane B 覆盖层形态保持）。
 */

export type CurationMode = "url" | "text" | "file"

export interface CurationInput {
  /** 发起会话 id（回流落点 + text 形态 origin 信道） */
  sessionId: string
  mode: CurationMode
  url?: string
  text?: string
  path?: string
  title?: string
}

export interface CurationReceipt {
  mode: CurationMode
  deduped: boolean
  raw: RawPointer
  title: string
  compileTask: { taskId: string; status: string } | null
  /** Lane A 卡片是否落进发起会话（诚实显形：false=回流失败/会话不可达，投喂成果仍在） */
  cardsPosted: boolean
  /** cardsPosted=false 时的降级说明 */
  postReason?: string
}

/** 编译投递上下文（票10 ADDITIVE 面：curatorTasks.submit 第二参）。 */
export interface CurationCompileCtx {
  sessionId?: string
}

/** 编译投递 seam（生产 = curatorTasks.submit 包装；形状兼容 routes/ingest.ts CompileTrigger——单参可赋值）。 */
export type CurationTrigger = (rawPath: string, ctx?: CurationCompileCtx) => { taskId: string; status: string }

/** 卡片回流 seam（生产 = appendCardsToSession 包装；测试 = 捕获）。 */
export type CurationAnnouncer = (
  sessionId: string,
  header: string,
  events: KcCardEvent[],
) => { posted: boolean; reason?: string }

export interface SessionCurationDeps {
  raw: RawIngestService
  trigger: CurationTrigger
  announce: CurationAnnouncer
  /** 队列位次快照（生产 = wikiWriteQueue.get(taskId)?.position；缺省 null=位次未知） */
  positionOf?: (taskId: string) => number | null | undefined
  now?: () => Date
}

export class SessionCurationService {
  private readonly raw: RawIngestService
  private readonly trigger: CurationTrigger
  private readonly announce: CurationAnnouncer
  private readonly positionOf?: (taskId: string) => number | null | undefined
  private readonly now: () => Date

  constructor(deps: SessionCurationDeps) {
    this.raw = deps.raw
    this.trigger = deps.trigger
    this.announce = deps.announce
    this.positionOf = deps.positionOf
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * 会话投喂执行面：三形态穿打既有 RawIngestService（与 POST /api/knowledge/ingest
   * 同一实现——错误码面原样上抛，调用方按 ingest.ts 头注码集映射）。
   */
  async curate(input: CurationInput): Promise<CurationReceipt> {
    let result: IngestResult
    switch (input.mode) {
      case "url":
        result = await this.raw.ingestUrl({ url: input.url ?? "", title: input.title })
        break
      case "text":
        // Backfill 信道纪律：对话正文来源记 chat:〈session〉（sources 语义即 chat:session）
        result = this.raw.ingestText({ text: input.text ?? "", title: input.title, origin: `chat:${input.sessionId}` })
        break
      case "file":
        result = this.raw.ingestFile({ path: input.path ?? "", title: input.title })
        break
      default:
        throw new IngestError("INVALID_PARAM", `mode must be one of: "url", "text", "file"`, 400)
    }

    const compileTask = this.trigger(result.raw.path, { sessionId: input.sessionId })
    const position = this.positionOf?.(compileTask.taskId) ?? null
    const ts = this.now().toISOString()
    const events: KcCardEvent[] = [
      {
        id: `ing-${result.raw.hash.slice(0, 8)}`,
        kind: "ingest",
        ts,
        data: {
          status: "done",
          rawPath: result.raw.path,
          bytes: result.raw.bytes,
          hash: result.raw.hash,
          origin: result.raw.origin,
          title: result.title,
          compile: { taskId: compileTask.taskId, status: "queued", position },
        } satisfies KcIngestCardData,
      },
      {
        id: `dif-${compileTask.taskId}`,
        kind: "compile-diff",
        ts,
        data: {
          taskId: compileTask.taskId,
          status: "queued",
          position,
          rawPath: result.raw.path,
          rawTitle: result.title,
          touched: [],
        } satisfies KcCompileDiffCardData,
      },
    ]

    let cardsPosted = false
    let postReason: string | undefined
    try {
      const out = this.announce(
        input.sessionId,
        `📥 会话投喂入库：${result.title || result.raw.path}（已落 raw · 编译排队中${position != null ? ` #${position}` : ""}）`,
        events,
      )
      cardsPosted = out.posted
      postReason = out.reason
    } catch (err) {
      // 回流失败不吞投喂成果（raw 已落盘、编译已入队）——显形进 receipt（报对话同律）
      process.stderr.write(`[session-curation] announce failed: ${err instanceof Error ? err.message : String(err)}\n`)
      cardsPosted = false
      postReason = err instanceof Error ? err.message : String(err)
    }

    return {
      mode: input.mode,
      deduped: result.deduped,
      raw: result.raw,
      title: result.title,
      compileTask: { taskId: compileTask.taskId, status: compileTask.status },
      cardsPosted,
      ...(postReason ? { postReason } : {}),
    }
  }

  /**
   * 编译终态回流（CuratorTaskService.attachSettledListener 消费）：
   * 仅带 sessionId 上下文的任务回写 Lane A 终态 diff 卡（同 id 重发=判例/final
   * 终态卡先例）；其余来源零动作。异常吞进 stderr——钩子炸不得改编译任务态。
   */
  onCompileSettled(rec: CompileTaskRecord): void {
    if (!rec.sessionId) return
    if (rec.status !== "committed" && rec.status !== "failed") return
    const data: KcCompileDiffCardData = {
      taskId: rec.id,
      status: rec.status === "committed" ? "committed" : "failed",
      rawPath: rec.rawPath,
      rawTitle: rec.result?.rawTitle,
      touched: rec.result?.touched ?? [],
      created: rec.result?.created,
      updated: rec.result?.updated,
      contradictions: rec.result?.contradictions,
      commit: rec.result?.commit ?? undefined,
      ftsOk: rec.result ? rec.result.warnings.length === 0 : undefined,
      ...(rec.error ? { error: rec.error } : {}),
    }
    const header = rec.status === "committed"
      ? `⚙️ 会话投喂编译已提交 ${shortHash(rec.result?.commit ?? null)}（新 ${rec.result?.created ?? 0} 页 / 触及 ${rec.result?.touched.length ?? 0} 页 · 卡上可回滚）`
      : `✕ 会话投喂编译失败：${rec.error?.code ?? "COMPILE_FAILED"}（重试=卡上重试编译钮，同 ingest-compile 队列通道）`
    const event: KcCardEvent = { id: `dif-${rec.id}`, kind: "compile-diff", ts: this.now().toISOString(), data }
    try {
      this.announce(rec.sessionId, header, [event])
    } catch (err) {
      process.stderr.write(`[session-curation] settled announce failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}
