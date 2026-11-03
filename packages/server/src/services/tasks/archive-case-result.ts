// packages/server/src/services/tasks/archive-case-result.ts
//
// 归档判例入档回执（2026-11-03 归档台 v2「知识落点」补全）——判例走独立的
// case-archive 队列，结果只发知识中心判例卡、不落任务 home；归档窗口要展示
// 「新建 / 并档 / 失败」就必须自己留一份。
//
// 纪律：
//   * CaseExtractService 在队列执行体里算出结果后经 recordCaseResult 回调写入
//     `{task home}/archive/case-result.json`（追加式，按 queue_task_id 去重）；
//   * 写失败只 stderr，绝不影响判例入档本身（与 wiki-result 同律）；
//   * 读侧容忍缺失/损坏（旧任务 = 空数组），最多保留 50 条。

import fs from "fs"
import path from "path"

/** 判例入档回执文件名（`{home}/archive/` 下）。 */
export const ARCHIVE_CASE_RESULT_FILE = "case-result.json"

/** 单任务保留上限（一次归档通常 1–3 条；防止重试/异常刷爆）。 */
const MAX_CASE_RESULTS = 50

export interface ArchiveCaseResult {
  queue_task_id: string
  /** created = 新判例；merged = 同症状并档；failed = 入档失败（队列会回滚）。 */
  action: "created" | "merged" | "failed"
  symptom: string
  /** 落盘页（失败时 null）。 */
  case_path: string | null
  /** 并档时的 occurrence 前后值；新建 = 0 → 1；失败 = null。 */
  occurrences_before: number | null
  occurrences_after: number | null
  finished_at: string
  error?: { code: string; message: string }
}

export function archiveCaseResultPath(home: string): string {
  return path.join(home, "archive", ARCHIVE_CASE_RESULT_FILE)
}

function sanitizeRecord(raw: unknown): ArchiveCaseResult | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.queue_task_id !== "string" || rec.queue_task_id === "") return null
  if (rec.action !== "created" && rec.action !== "merged" && rec.action !== "failed") return null
  if (typeof rec.symptom !== "string") return null
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
  const error =
    rec.error && typeof rec.error === "object" &&
    typeof (rec.error as Record<string, unknown>).code === "string" &&
    typeof (rec.error as Record<string, unknown>).message === "string"
      ? {
          code: (rec.error as { code: string }).code,
          message: (rec.error as { message: string }).message,
        }
      : undefined
  return {
    queue_task_id: rec.queue_task_id,
    action: rec.action,
    symptom: rec.symptom,
    case_path: str(rec.case_path),
    occurrences_before: num(rec.occurrences_before),
    occurrences_after: num(rec.occurrences_after),
    finished_at: typeof rec.finished_at === "string" ? rec.finished_at : "",
    ...(error ? { error } : {}),
  }
}

/** 读回执；文件缺失/损坏/形状不对 ⇒ 空数组（旧任务诚实缺席）。 */
export function readArchiveCaseResults(home: string): ArchiveCaseResult[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(archiveCaseResultPath(home), "utf-8")) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(sanitizeRecord)
      .filter((r): r is ArchiveCaseResult => r !== null)
  } catch {
    return []
  }
}

/**
 * 追加/更新一条回执（按 queue_task_id 去重，原子替换）。
 * 同一队列任务重放（失败后重试）会覆盖旧结果，不会留下两条矛盾记录。
 */
export function upsertArchiveCaseResult(home: string, result: ArchiveCaseResult): void {
  const current = readArchiveCaseResults(home).filter((r) => r.queue_task_id !== result.queue_task_id)
  const next = [...current, result].slice(-MAX_CASE_RESULTS)
  const file = archiveCaseResultPath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8")
  fs.renameSync(tmp, file)
}
