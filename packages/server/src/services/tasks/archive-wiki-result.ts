// packages/server/src/services/tasks/archive-wiki-result.ts
//
// 归档 wiki 编译回执（2026-11-03 归档台 v2 精简方案）——「归档在 wiki 里落了什么」
// 的持久读模型。
//
// 背景：编译在知识中心全局串行队列里异步执行；队列任务表是**进程内**的，服务重启即
// 丢失，而归档窗口需要长期如实展示「提交了哪几页 / 新建几页 / 矛盾几条 / commit」。
// 因此把 CuratorCompileResult 的展示面单独落一份 `{task home}/archive/wiki-result.json`：
//
//   * 只在归档投喂 / 重编译的 compilePack 包装里写（写失败只 stderr，绝不改编译结果）；
//   * 原子替换（tmp + rename），读侧容忍缺失/损坏（旧任务没有此文件 = null）；
//   * 形状与 GET /:id/archive 的 knowledge.wiki_result 逐字一致（单源，web 按值消费）。

import fs from "fs"
import path from "path"

/** 归档 wiki 编译回执文件名（`{home}/archive/` 下）。 */
export const ARCHIVE_WIKI_RESULT_FILE = "wiki-result.json"

export interface ArchiveWikiTouchedPage {
  /** wiki 根相对 POSIX 路径（如 `entities/ent-x.md`）。 */
  path: string
  /** entities / concepts / topics / sources …（curator 原值）。 */
  type: string
  created: boolean
}

export interface ArchiveWikiResult {
  status: "committed" | "failed"
  started_at: string
  finished_at: string
  /** git commit sha；null = 无变更 / 失败 / 快路径。 */
  commit: string | null
  /** false = 全批产物与在盘逐字节相同（compilePages 幂等判定）。 */
  changed: boolean
  /** true = 同包同焦点已编译过，快路径 no-op（未调 LLM、零副作用）。 */
  deduped: boolean
  created: number
  updated: number
  contradictions: number
  finding_ids: string[]
  touched: ArchiveWikiTouchedPage[]
  warnings: string[]
  error?: { code: string; message: string }
}

/** CuratorCompileResult 的结构投影（避免 tasks 模块反向依赖 knowledge/wiki 类型）。 */
export interface CuratorCompileResultLike {
  touched: Array<{ path: string; type: string; created: boolean }>
  created: number
  updated: number
  contradictions: number
  findingIds: string[]
  commit: string | null
  changed: boolean
  deduped: boolean
  warnings: string[]
}

export function archiveWikiResultPath(home: string): string {
  return path.join(home, "archive", ARCHIVE_WIKI_RESULT_FILE)
}

/** 成功回执投影（touched 只保留展示需要的三字段，杜绝把正文带进回执）。 */
export function toArchiveWikiResult(
  result: CuratorCompileResultLike,
  startedAt: string,
  finishedAt: string,
): ArchiveWikiResult {
  return {
    status: "committed",
    started_at: startedAt,
    finished_at: finishedAt,
    commit: result.commit,
    changed: result.changed,
    deduped: result.deduped,
    created: result.created,
    updated: result.updated,
    contradictions: result.contradictions,
    finding_ids: [...result.findingIds],
    touched: result.touched.map(p => ({ path: p.path, type: p.type, created: p.created })),
    warnings: [...result.warnings],
  }
}

/** 失败回执：队列已原子回滚，这里只记错误面（素材包与 raw 保持完好）。 */
export function toArchiveWikiFailure(
  error: unknown,
  startedAt: string,
  finishedAt: string,
): ArchiveWikiResult {
  const anyErr = error as { code?: unknown; message?: unknown }
  const code = typeof anyErr?.code === "string" ? anyErr.code : "COMPILE_FAILED"
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.startsWith(`${code}: `) ? raw.slice(code.length + 2) : raw
  return {
    status: "failed",
    started_at: startedAt,
    finished_at: finishedAt,
    commit: null,
    changed: false,
    deduped: false,
    created: 0,
    updated: 0,
    contradictions: 0,
    finding_ids: [],
    touched: [],
    warnings: [],
    error: { code, message },
  }
}

/** 原子写回执（tmp + rename）。写失败抛给调用方自行降级。 */
export function writeArchiveWikiResult(home: string, result: ArchiveWikiResult): void {
  const file = archiveWikiResultPath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), "utf-8")
  fs.renameSync(tmp, file)
}

/** 读回执；文件缺失/损坏/形状不对 ⇒ null（旧任务诚实缺席）。 */
export function readArchiveWikiResult(home: string): ArchiveWikiResult | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(archiveWikiResultPath(home), "utf-8")) as unknown
    if (!parsed || typeof parsed !== "object") return null
    const rec = parsed as Partial<ArchiveWikiResult>
    if (rec.status !== "committed" && rec.status !== "failed") return null
    return {
      status: rec.status,
      started_at: typeof rec.started_at === "string" ? rec.started_at : "",
      finished_at: typeof rec.finished_at === "string" ? rec.finished_at : "",
      commit: typeof rec.commit === "string" ? rec.commit : null,
      changed: rec.changed === true,
      deduped: rec.deduped === true,
      created: typeof rec.created === "number" ? rec.created : 0,
      updated: typeof rec.updated === "number" ? rec.updated : 0,
      contradictions: typeof rec.contradictions === "number" ? rec.contradictions : 0,
      finding_ids: Array.isArray(rec.finding_ids) ? rec.finding_ids.filter((x): x is string => typeof x === "string") : [],
      touched: Array.isArray(rec.touched)
        ? rec.touched
            .filter((p): p is ArchiveWikiTouchedPage =>
              !!p && typeof p === "object" && typeof p.path === "string" && typeof p.type === "string")
            .map(p => ({ path: p.path, type: p.type, created: p.created === true }))
        : [],
      warnings: Array.isArray(rec.warnings) ? rec.warnings.filter((x): x is string => typeof x === "string") : [],
      ...(rec.error && typeof rec.error === "object" &&
      typeof rec.error.code === "string" && typeof rec.error.message === "string"
        ? { error: { code: rec.error.code, message: rec.error.message } }
        : {}),
    }
  } catch {
    return null
  }
}
