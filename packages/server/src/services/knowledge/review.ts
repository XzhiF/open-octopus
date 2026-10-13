import { PendingReviewDAO, type PendingReviewRow } from "../../db/dao"
import { generateRuleId } from "./file-ops"

/**
 * wiki 通道审核执行器（票02 起）：approve 按 item.type 分发——
 * 'wiki-split' → 拆分执行器（hub 目录落地）；
 * 'wiki-edit' / 词条形态的 'rule' → 策展编译通道（票06，WikiCurateService，异步
 * ——compileEntry 是 Promise，本服务因此自票06 起 approve 必须 await）。
 * 由 server index.ts 注入（ReviewService 不依赖 wiki 服务，避免环引用）。
 */
export interface WikiReviewHandlers {
  applyWikiSplit?: (item: PendingReviewRow, org?: string) => void
  applyWikiCurate?: (item: PendingReviewRow, org?: string) => Promise<unknown>
  /**
   * 「真正 wiki 词条形态」判式（生产由 index.ts 注入 curate.isGenuineWikiTarget：
   * scope='wiki' 或词条已在 wiki 根盘上）。注入后，非真词条的 rule/wiki-edit 行
   * 不进策展闸——票08 起这些旧形态行只结案状态（旧知识文件 append 轨已剔除），
   * 不再落任何文件。未注入 ⇒ 回退票06 宽松前缀判式（无 wiki 根可查的旧部署）。
   */
  isWikiEntryTarget?: (item: PendingReviewRow, org?: string) => boolean
}

/** 票06：target_file 的 wiki 形态宽松前缀判式（域目录开头）。现仅作
 *  isWikiEntryTarget 未注入时的回退（无 wiki 根可查的旧部署零改动）——
 *  生产闸门走注入判式（真词条才进场）。与 wiki/curate.ts 同一前缀集合，
 *  此处独立内联：保持 ReviewService 对 wiki 模块零 import（环引用纪律）。 */
const WIKI_TARGET_PATH_RE = /^(?:projects|workflows|business|research|cases)\//
/** user_preference.md 任何形态的 target 都先进策展闸 fail-closed（写权保护，蓝图双钉）。 */
const USER_PREFERENCE_RE = /(^|[\\/])user_preference\.md$/i

export class ReviewService {
  constructor(
    private pendingReviewDAO: PendingReviewDAO,
    private wikiHandlers?: WikiReviewHandlers,
  ) {}

  /** target 是否真 wiki 词条形态：注入判式优先（生产=scope='wiki' 或词条在盘）；
   *  未注入回退宽松前缀判式（旧部署零改动）。 */
  private isWikiTargeted(item: PendingReviewRow, org?: string): boolean {
    if (this.wikiHandlers?.isWikiEntryTarget) return this.wikiHandlers.isWikiEntryTarget(item, org)
    return WIKI_TARGET_PATH_RE.test(item.target_file ?? "")
  }

  /**
   * Approve a pending item: dispatch by type, then record the approval status.
   * For 'wiki-split' items (票02), dispatches to the injected wiki split applier.
   * 票06: 'wiki-edit' 与真词条形态的 'rule' 走策展编译通道。
   * 知识中心票 08（spec「注入链与旧库硬废」）：旧知识文件追加轨道（P1 影子双轨的
   * 注入侧腿）已物理删除 —— approve 此后只结案状态，不再写 org knowledge 任何
   * 文件；org knowledge 目录/数据归档属票09，审核队列本体亦属票09。
   * 评审修复：是否「真词条形态」由 isWikiTargeted 裁决（见上）。
   *
   * `org` is passed per-request so a single ReviewService instance can
   * serve multiple orgs; an undefined value means "global" scope.
   */
  async approveItem(id: string, org?: string): Promise<{ ok: true; ruleId: string }> {
    const item = this.pendingReviewDAO.getById(id)
    if (!item) throw new Error("NOT_FOUND")
    if (item.status === "approved") return { ok: true, ruleId: id } // idempotent

    if (item.type === "wiki-split") {
      if (!this.wikiHandlers?.applyWikiSplit) {
        throw new Error("NO_WIKI_SPLIT_APPLIER: 服务端未接线 wiki 拆分执行器")
      }
      this.wikiHandlers.applyWikiSplit(item, org)
      this.pendingReviewDAO.updateStatus(id, "approved")
      return { ok: true, ruleId: item.source_ref }
    }

    if (item.type === "wiki-edit") {
      if (!this.wikiHandlers?.applyWikiCurate) {
        throw new Error("NO_WIKI_CURATE_APPLIER: 服务端未接线策展编译通道")
      }
      // 回归修复：只有真 wiki 词条形态（注入判式；未注入回退宽松前缀）才进策展通道。
      // 非真词条形态的 wiki-edit 旧行/手工行 → 票08 后无旧追加轨道，仅结案状态。
      if (this.isWikiTargeted(item, org)) {
        await this.wikiHandlers.applyWikiCurate(item, org)
        this.pendingReviewDAO.updateStatus(id, "approved")
        return { ok: true, ruleId: item.source_ref }
      }
    }

    // 票06 写闸（评审修复后）：真 wiki 词条形态的 rule 先过策展编译通道
    // （lint + 合并 + 带审核引用的 git commit）；user_preference.md 形态同样先进闸
    // ——策展通道对它拒绝自动改写（写权保护）。
    // 真词条被拒 ⇒ 整个 approve 失败、状态留 pending——单一闸门无旁路。
    // 票08：闸后不再落旧 append —— org knowledge 文件轨道已剔除。
    // 注意：此闸先于一切结案执行（user_preference 写权保护必须给专错
    // CURATE_REFUSED_USER_PREFERENCE，不允许先落状态再报错）。
    const wikiRuleGate = item.type === "rule" && this.wikiHandlers?.applyWikiCurate !== undefined
      && (USER_PREFERENCE_RE.test(item.target_file ?? "") || this.isWikiTargeted(item, org))
    if (wikiRuleGate) {
      await this.wikiHandlers!.applyWikiCurate!(item, org)
    }

    const ruleId = item.status === "pending" || item.status === "deferred"
      ? generateRuleId((item.target_file || "projects/unknown.md").replace(".md", ""))
      : id
    this.pendingReviewDAO.updateStatus(id, "approved")

    return { ok: true, ruleId }
  }

  rejectItem(id: string, userNotes?: string): { ok: true } {
    const item = this.pendingReviewDAO.getById(id)
    if (!item) throw new Error("NOT_FOUND")
    this.pendingReviewDAO.updateStatus(id, "rejected", userNotes)
    return { ok: true }
  }

  deferItem(id: string): { ok: true } {
    const item = this.pendingReviewDAO.getById(id)
    if (!item) throw new Error("NOT_FOUND")
    this.pendingReviewDAO.updateStatus(id, "deferred")
    return { ok: true }
  }

  editItem(id: string, newContent: string): { ok: true } {
    const item = this.pendingReviewDAO.getById(id)
    if (!item) throw new Error("NOT_FOUND")
    this.pendingReviewDAO.updateContent(id, newContent)
    // Keep status as-is (pending) — editing content doesn't change review state
    return { ok: true }
  }

  async batchApprove(ids: string[], org?: string): Promise<{ succeeded: number; failed: number; details: Array<{ id: string; status: string; error?: string }> }> {
    const details: Array<{ id: string; status: string; error?: string }> = []
    let succeeded = 0
    let failed = 0
    for (const id of ids) {
      try {
        await this.approveItem(id, org)
        details.push({ id, status: "ok" })
        succeeded++
      } catch (err) {
        details.push({ id, status: "error", error: err instanceof Error ? err.message : String(err) })
        failed++
      }
    }
    return { succeeded, failed, details }
  }

  batchReject(ids: string[]): void {
    this.pendingReviewDAO.batchUpdateStatus(ids, "rejected")
  }

  getPendingSummary(): { rules: number; skills: number; wiki: number; total: number } {
    return this.pendingReviewDAO.countPendingByType()
  }

  /**
   * Resolve review strategy based on source and agent config.
   */
  resolveReviewStrategy(source: string, agentConfig?: { review_strategy?: string }): string {
    if (source === "recurring_pitfall") return "auto_approve"
    if (source === "agent_conversation") return "inline"
    if (source === "scheduler") return "background"
    return agentConfig?.review_strategy ?? "auto"
  }
}
