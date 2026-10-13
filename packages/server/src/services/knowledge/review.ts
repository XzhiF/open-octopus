import { PendingReviewDAO, type PendingReviewRow } from "../../db/dao"

/**
 * ReviewService — pending_review 结案流转（票09 后形态）。
 *
 * 知识中心票 09「审批废除与写入闸门」（spec §Implementation Decisions）：
 * 审批链的 wiki 通道已 server 侧全删——'wiki-split' / 'wiki-edit' / 词条形态
 * 'rule' 的策展分发（approve→WikiCurateService / WikiSplitService）、写权闸与
 * auto_approve 概念随「人批入库」轨一起物理删除。质控改事后六道 + 对话驱动
 * 编译轨（票12 dialog-revise/revert，走 compile-queue，与本服务无关）。
 *
 * 边界保留（勿误删）：
 * - **pending_review 表本体保留**——skill 草案等非 wiki 用途仍在此结案流转
 *   （物理清表属 P3，spec Out of Scope）。
 * - approve/reject/defer/edit/batch 只做**状态流转**，零写盘、零编译副作用；
 *   `auto_approve` 列值不再被任何流程置 1（列本体留给 P3 清表）。
 */
export class ReviewService {
  constructor(
    private pendingReviewDAO: PendingReviewDAO,
  ) {}

  /**
   * Approve a pending item: 结案状态（票09 起不再按 type 分发执行器）。
   * 对 `status === 'approved'` 幂等直通。
   *
   * `org` 参数保留仅为路由面调用兼容（per-request 多 org 语义的历史签名）。
   */
  async approveItem(id: string, _org?: string): Promise<{ ok: true; id: string }> {
    const item = this.pendingReviewDAO.getById(id)
    if (!item) throw new Error("NOT_FOUND")
    if (item.status === "approved") return { ok: true, id } // idempotent

    this.pendingReviewDAO.updateStatus(id, "approved")
    return { ok: true, id }
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
}
