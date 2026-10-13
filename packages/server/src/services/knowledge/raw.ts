import fs from "fs"
import path from "path"
import crypto from "crypto"
import {
  ensureKnowledgeSkeleton,
  getRawDir,
  getRawRoot,
  resolveKnowledgeRoot,
  RAW_DIRS,
  type RawDir,
} from "./global-paths"
import { extractHtmlTitle, htmlToMarkdown } from "./html-to-md"

/**
 * raw 层（三层架构层 1）写入服务 — 知识中心票02。
 *
 * 契约（spec §三层架构 + prototype Tab②/Tab③ 入口 A 步骤 1-2）：
 *   * 一切投喂落 `raw/{inbox,archives,research}`，命名 `{日期}-{slug}.md`；
 *   * 落盘即冻结：front-matter 记 origin / title / ingestedAt / bytes / hash（sha256），
 *     写用 `wx`（已存在绝不覆盖）——raw 是不可变源，本模块只新增文件、永不改写；
 *   * 同 hash 幂等：命中既有 raw 直接回指针，不再落第二份；
 *   * raw 落盘不入队（spec §全局写串行语义）——本服务零队列、零锁，编译入队属票05/06。
 *
 * 本票不做编译：返回的 raw 指针（path/hash/origin/bytes）即票05 的输入形状。
 */

export type IngestMode = "url" | "text" | "file"

/** raw 指针：path 相对知识根（POSIX 分隔），与 wiki sources 回指口径一致（prototype 行 301）。 */
export interface RawPointer {
  path: string
  /** payload 的 sha256（十六进制全串） */
  hash: string
  /** `url:<href>` / `paste` / `file:<绝对路径>` */
  origin: string
  /** payload 字节数（utf-8） */
  bytes: number
}

export interface IngestResult {
  mode: IngestMode
  dir: RawDir
  title: string
  /** true = 内容 hash 已在 raw 中，本次未落新文件，raw 指针指向既有源 */
  deduped: boolean
  raw: RawPointer
}

/**
 * 投喂失败错误。`code` 进消息首词（wiki-compile.test 的 `/INVALID_FRONTMATTER.*summary/s`
 * 断言先例：错误消息自带哨兵码），`status` 是路由层的 HTTP 码。
 * 失败语义（票面 AC4）：任何抛出都发生在落盘之前 ⇒ raw 零痕迹。
 */
export class IngestError extends Error {
  /** 不含码前缀的原文（路由层回给客户端的 message 用它，避免码在消息里重复） */
  readonly detail: string
  constructor(readonly code: string, message: string, readonly status: number) {
    super(`${code}: ${message}`)
    this.name = "IngestError"
    this.detail = message
  }
}

export interface RawIngestDeps {
  /** 知识根覆盖（测试注入 tmpdir；缺省走 resolveKnowledgeRoot：env > ~/.octopus/knowledge） */
  root?: string
  /** 时钟注入（命名里的 {日期} 与 ingestedAt 由此来；默认当前时间） */
  now?: () => Date
  /** URL 抓取挂起上限（毫秒，默认 15000） */
  fetchTimeoutMs?: number
}
/** {日期} 口径 = ISO 日期切片（同 wiki/util.ts today()，此处需按注入时钟取日期）。 */
function dateStamp(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * slug：小写、NFKD 去变音符、非 `[a-z0-9]` 串成单 `-`、限长 60、去首尾 `-`。
 * 结果逐字对齐 prototype 样例：`Karpathy LLM Wiki` → `karpathy-llm-wiki`
 * （→ `2026-10-13-karpathy-llm-wiki.md`，prototype Tab② 行 246）。
 */
export function slugify(input: string): string {
  const ascii = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return ascii.slice(0, 60).replace(/-+$/g, "")
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex")
}

/** 归一换行（CRLF → LF）；不改正文其余字节 ⇒ hash 与 bytes 对得上源文本本体。 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

/** 手写 front-matter（与 shared 的 serializeEntryMarkdown 不同域：raw 头不是词条头）。 */
function renderRawFrontMatter(t: { origin: string; title: string; ingestedAt: string; bytes: number; hash: string }): string {
  return [
    "---",
    `origin: "${t.origin}"`,
    `title: "${t.title.replace(/"/g, "'")}"`,
    `ingestedAt: "${t.ingestedAt}"`,
    `bytes: ${t.bytes}`,
    `hash: "${t.hash}"`,
    "---",
    "",
  ].join("\n")
}

const FRONT_MATTER_RE = /^---\r?\n([\S\s]*?)\r?\n---/

/** 从 raw 文件头取一个标量字段（去引号）；无头/无字段 → null。 */
function frontMatterValue(content: string, key: string): string | null {
  const m = FRONT_MATTER_RE.exec(content)
  if (!m) return null
  const line = m[1].split("\n").find(l => l.startsWith(`${key}:`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"(.*)"$/, "$1")
}

function isRawDir(dir: string): dir is RawDir {
  return (RAW_DIRS as readonly string[]).includes(dir)
}

/** 钉名单段安全名（票10）：字母数字开头、仅 [A-Za-z0-9._-]、.md 结尾——与读面 RAW_FILE_RE 同律。 */
const PINNED_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/

/** 只接 http/https（其余协议 = 参数非法，防 file:// gopher:// 之类进抓取通道）。 */
function parseHttpUrl(url: unknown): URL {
  if (typeof url !== "string" || url.trim() === "") {
    throw new IngestError("INVALID_PARAM", "url is required", 400)
  }
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new IngestError("INVALID_PARAM", `malformed url: ${url}`, 400)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new IngestError("INVALID_PARAM", `unsupported url protocol: ${parsed.protocol}`, 400)
  }
  return parsed
}

/**
 * 抓取失败的错误码分派：超时 → 504，其余（DNS/连接/中断）→ 502。
 * 超时的判定不只看抛出的错误——undici 在并发负载下常把它包成
 * `TypeError: fetch failed` + `cause: TimeoutError`，所以同时看 AbortSignal 的 reason
 * （这是真信号：是我们自己的挂起上限触发，而非连接失败）。
 */
function fetchFailure(err: unknown, href: string, signal: AbortSignal): IngestError {
  const names = [
    (err as { name?: string })?.name ?? "",
    (err as { cause?: { name?: string } })?.cause?.name ?? "",
    (signal.reason as { name?: string } | undefined)?.name ?? "",
  ]
  const texts = [
    err instanceof Error ? err.message : String(err),
    (err as { cause?: Error })?.cause?.message ?? "",
    signal.reason instanceof Error ? signal.reason.message : "",
  ].join(" ")
  const timedOut = (signal.aborted && names.includes("TimeoutError")) || /timeout|timed out|ETIMEDOUT|abort(ed)?\b/i.test(texts)
  if (timedOut) {
    return new IngestError("FETCH_TIMEOUT", `fetch timed out after ${href}`, 504)
  }
  const summary = ((err as { cause?: Error })?.cause?.message || (err instanceof Error ? err.message : String(err)) || "unknown error").slice(0, 200)
  return new IngestError("FETCH_FAILED", `fetch failed for ${href}: ${summary}`, 502)
}

/** 无标题时的兜底 slug：末段路径名（去扩展名）> 主机名点转杠。 */
function urlSlug(u: URL): string {
  const seg = u.pathname.split("/").filter(Boolean).pop() ?? ""
  const stem = seg.replace(/\.(html?|php|aspx?|jsp|md)$/i, "")
  return stem || u.hostname.replace(/\./g, "-")
}

/** 响应体上限（5MB）：抓取的正文直进不可变源，无界响应会把 server 进程吃空。 */
const MAX_FETCH_BYTES = 5 * 1024 * 1024

/** 带上限的响应读取：content-length 先判（快拒），再逐块累加（真护栏）。 */
async function readCappedText(resp: Response, href: string): Promise<string> {
  const declared = Number(resp.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
    throw new IngestError("FETCH_TOO_LARGE", `response is ${declared} bytes, over the ${MAX_FETCH_BYTES} limit: ${href}`, 413)
  }
  if (!resp.body) return await resp.text()

  const reader = resp.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_FETCH_BYTES) {
        await reader.cancel()
        throw new IngestError("FETCH_TOO_LARGE", `response exceeded the ${MAX_FETCH_BYTES} byte limit: ${href}`, 413)
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } catch (err) {
    if (err instanceof IngestError) throw err
    throw new IngestError("FETCH_FAILED", `reading the response failed for ${href}`, 502)
  }
  return Buffer.concat(chunks).toString("utf-8")
}

function toPosixRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/")
}

export class RawIngestService {
  readonly root: string
  private readonly now: () => Date
  private readonly fetchTimeoutMs: number

  constructor(deps: RawIngestDeps = {}) {
    this.root = resolveKnowledgeRoot(deps.root)
    this.now = deps.now ?? (() => new Date())
    this.fetchTimeoutMs = deps.fetchTimeoutMs ?? 15_000
  }

  /**
   * 粘贴文本投喂（prototype 入口 A 形态 2）。dir 默认 inbox（对话投喂落点）。
   *
   * 票10 追加（可选项，缺省行为逐字不变）：
   *  * `fileName` — 钉名落盘（`raw/archives/task-{id}-summary.md` 契约名，无日期前缀）。
   *    冻结三律不破：hash 查重先行；`wx` 永不覆盖；同名已存在且 hash 相同 ⇒ 视作
   *    同一源（deduped 回指针）；同名已存在但 hash 不同 ⇒ CONFLICT 抛出（不可变源
   *    的钉名位被占，绝不写第二份、绝不改写第一份）。
   *  * `origin` — 覆盖 `origin:` 字段（系统投喂标记，如 `task-archive:<id>`）。
   */
  ingestText(input: { text: string; title?: string; dir?: string; fileName?: string; origin?: string }): IngestResult {
    this.prepare()
    const dir = this.resolveDir(input.dir)
    if (typeof input.text !== "string" || input.text.trim() === "") {
      throw new IngestError("INVALID_PARAM", "text is required", 400)
    }
    if (input.fileName !== undefined && !PINNED_FILE_RE.test(input.fileName)) {
      throw new IngestError("INVALID_PARAM", `fileName must be a safe single .md name: ${input.fileName}`, 400)
    }
    const title = input.title?.trim() || "pasted-text"
    return this.freeze({
      mode: "text",
      dir,
      title,
      origin: input.origin ?? "paste",
      payload: normalizeNewlines(input.text),
      slugHint: title,
      ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
    })
  }

  /**
   * URL 抓取投喂（prototype 入口 A 形态 1「抓取 → raw/inbox/{日期}-{slug}.md 落盘冻结」）。
   * html 经零依赖转换落 md；text/markdown、text/plain 原文落。
   * 失败（非 2xx / 超时 / 非文本 / 超 5MB / 无可读正文）⇒ 抛 IngestError，
   * 且抛出点全在 freeze 之前 ⇒ raw 零落盘（票面 AC4）。
   */
  async ingestUrl(input: { url: string; title?: string; dir?: string }): Promise<IngestResult> {
    this.prepare()
    const dir = this.resolveDir(input.dir)
    const target = parseHttpUrl(input.url)

    const signal = AbortSignal.timeout(this.fetchTimeoutMs)
    let resp: Response
    try {
      resp = await fetch(target.href, { signal, redirect: "follow" })
    } catch (err) {
      throw fetchFailure(err, target.href, signal)
    }
    if (!resp.ok) {
      throw new IngestError("FETCH_FAILED", `upstream returned HTTP ${resp.status} for ${target.href}`, 502)
    }

    const contentType = (resp.headers.get("content-type") ?? "").toLowerCase()
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml")
    const isPlainText = contentType.startsWith("text/")
    if (!isHtml && !isPlainText) {
      throw new IngestError("UNSUPPORTED_CONTENT", `content-type "${contentType || "unknown"}" is not text`, 415)
    }

    const body = normalizeNewlines(await readCappedText(resp, target.href))
    const payload = isHtml ? htmlToMarkdown(body) : body
    if (payload.trim() === "") {
      throw new IngestError("EMPTY_CONTENT", `fetched document has no readable text: ${target.href}`, 422)
    }

    const title = input.title?.trim() || (isHtml ? extractHtmlTitle(body) ?? "" : "") || urlSlug(target)
    return this.freeze({
      mode: "url",
      dir,
      title,
      origin: `url:${target.href}`,
      payload,
      slugHint: title,
    })
  }

  /**
   * 本地文件复制投喂（prototype 入口 A 形态 3）。源文件不动（只复制进 raw），
   * 二进制（含 NUL）拒收，空文件拒收——均落在 freeze 之前 ⇒ 失败零落盘。
   */
  ingestFile(input: { path: string; title?: string; dir?: string }): IngestResult {
    this.prepare()
    const dir = this.resolveDir(input.dir)
    if (typeof input.path !== "string" || input.path.trim() === "") {
      throw new IngestError("INVALID_PARAM", "path is required", 400)
    }
    const abs = path.resolve(input.path.trim())
    let isFile = false
    try {
      isFile = fs.statSync(abs).isFile()
    } catch {
      throw new IngestError("NOT_FOUND", `local file not found: ${abs}`, 404)
    }
    if (!isFile) throw new IngestError("INVALID_PARAM", `not a regular file: ${abs}`, 400)

    const buf = fs.readFileSync(abs)
    if (buf.includes(0)) {
      throw new IngestError("UNSUPPORTED_CONTENT", `binary file is not a text source: ${abs}`, 415)
    }
    const payload = normalizeNewlines(buf.toString("utf-8"))
    if (payload.trim() === "") {
      throw new IngestError("EMPTY_CONTENT", `file has no readable text: ${abs}`, 422)
    }

    const stem = path.basename(abs).replace(/\.[^./\\]+$/, "")
    const title = input.title?.trim() || stem
    return this.freeze({
      mode: "file",
      dir,
      title: title || "untitled",
      origin: `file:${abs}`,
      payload,
      slugHint: title,
    })
  }

  /**
   * 幂等骨架：任一投喂入口先确保三层目录存在（ctor 不 mkdir —— server 启动期
   * import 本模块时零文件系统副作用；骨架只在真有投喂动作时落）。
   * 校验失败时骨架可能已建（空目录），但 raw 下**零文件**——票面 AC4 的口径。
   */
  private prepare(): void {
    ensureKnowledgeSkeleton(this.root)
  }

  private resolveDir(dir?: string): RawDir {
    if (dir === undefined) return "inbox"
    if (!isRawDir(dir)) {
      throw new IngestError("INVALID_PARAM", `dir must be one of ${RAW_DIRS.join(", ")}`, 400)
    }
    return dir
  }

  /**
   * 冻结落盘：查重（同 hash 回既有指针）→ 命名 → `wx` 排他写（同名不同内容加 `-2` 后缀）。
   * 所有校验/失败分支都在此之前，函数体内除最终 write 外无副作用。
   */
  private freeze(input: {
    mode: IngestMode
    dir: RawDir
    title: string
    origin: string
    payload: string
    slugHint: string
    /** 票10 钉名（单段安全 .md 文件名，无日期前缀）；缺省走 {日期}-{slug} 命名。 */
    fileName?: string
  }): IngestResult {
    const hash = sha256(input.payload)
    const bytes = Buffer.byteLength(input.payload, "utf-8")

    const existing = this.findByHash(hash)
    if (existing) {
      return {
        mode: input.mode,
        dir: existing.dir,
        title: existing.title ?? input.title,
        deduped: true,
        raw: { path: existing.relPath, hash, origin: existing.origin ?? input.origin, bytes },
      }
    }

    const targetDir = getRawDir(this.root, input.dir)

    if (input.fileName !== undefined) {
      const abs = path.join(targetDir, input.fileName)
      const body = renderRawFrontMatter({
        origin: input.origin,
        title: input.title,
        ingestedAt: this.now().toISOString(),
        bytes,
        hash,
      }) + input.payload
      try {
        fs.writeFileSync(abs, body, { flag: "wx" })
        return {
          mode: input.mode,
          dir: input.dir,
          title: input.title,
          deduped: false,
          raw: { path: toPosixRel(this.root, abs), hash, origin: input.origin, bytes },
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
        // 钉名位已被占：同 hash = 同一源（幂等回指）；异 hash = 不可变契约冲突，
        // 绝不改写第一份、绝不落第二份（CONFLICT 抛在一切写副作用之后、改写之前）。
        let current = ""
        try {
          current = fs.readFileSync(abs, "utf-8")
        } catch {
          throw new IngestError("CONFLICT", `cannot read the pinned raw slot: ${input.fileName}`, 409)
        }
        if (frontMatterValue(current, "hash") === hash) {
          return {
            mode: input.mode,
            dir: input.dir,
            title: frontMatterValue(current, "title") ?? input.title,
            deduped: true,
            raw: { path: toPosixRel(this.root, abs), hash, origin: frontMatterValue(current, "origin") ?? input.origin, bytes },
          }
        }
        throw new IngestError("CONFLICT", `pinned raw slot holds a different source: ${input.fileName}`, 409)
      }
    }

    const ts = this.now()
    const date = dateStamp(ts)
    const slug = slugify(input.slugHint) || slugify(`${input.mode}-${hash.slice(0, 8)}`) || `${input.mode}-${hash.slice(0, 8)}`
    const body = renderRawFrontMatter({
      origin: input.origin,
      title: input.title,
      ingestedAt: ts.toISOString(),
      bytes,
      hash,
    }) + input.payload

    for (let attempt = 0; attempt < 1000; attempt++) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`
      const fileName = `${date}-${slug}${suffix}.md`
      const abs = path.join(targetDir, fileName)
      try {
        fs.writeFileSync(abs, body, { flag: "wx" })
        return {
          mode: input.mode,
          dir: input.dir,
          title: input.title,
          deduped: false,
          raw: { path: toPosixRel(this.root, abs), hash, origin: input.origin, bytes },
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      }
    }
    throw new IngestError("CONFLICT", `cannot allocate a free name for ${date}-${slug}`, 409)
  }

  /**
   * 幂等查重：扫 raw 三子目录 front-matter 的 `hash` 字段（无变索引——
   * spec §全局写串行「raw 落盘不入队，新增不可变文件无共享状态」，
   * 可变 manifest 会制造共享状态，故真源即文件头）。规模判据同 Karpathy：~百源内可接受。
   */
  private findByHash(hash: string): { relPath: string; dir: RawDir; origin: string | null; title: string | null } | null {
    for (const dir of RAW_DIRS) {
      const absDir = getRawDir(this.root, dir)
      let names: string[]
      try {
        names = fs.readdirSync(absDir)
      } catch (err) {
        // 目录缺席（骨架未建）⇒ 视作无命中；其他 I/O 错误（锁盘/权限）如实抛出，
        // 不静默降级成"没有重复"（Standards #2：失败不得伪装成空态）
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
        throw err
      }
      for (const name of names) {
        if (!name.endsWith(".md")) continue
        let content: string
        try {
          content = fs.readFileSync(path.join(absDir, name), "utf-8")
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
          throw err
        }
        if (frontMatterValue(content, "hash") !== hash) continue
        return {
          relPath: `raw/${dir}/${name}`,
          dir,
          origin: frontMatterValue(content, "origin"),
          title: frontMatterValue(content, "title"),
        }
      }
    }
    return null
  }
}

// ── 票11 追加：raw 只读面（知识中心浏览模式的抓取卡溯源数据源）──────────────
// 只读纪律与写入面同律：本模块**永不改写** raw 文件。目录缺席（骨架未建）诚实
// 降级为空列表（ENOENT = 真没有——Standards #2 禁的是 catch 伪造，这里 ENOENT 是
// 判据本身）；其余 I/O 错误如实抛出。

/** raw 源元数据（front-matter 提取；path = 知识根相对 POSIX，与 RawPointer 同口径）。 */
export interface RawSourceMeta {
  path: string
  bytes: number
  hash: string
  origin: string | null
  title: string | null
  ingestedAt: string | null
}

/** front-matter 缺失/坏头时的兜底：hash 现算、bytes 全文长度——读面永不含糊。 */
function rawMetaFrom(pathRel: string, content: string): RawSourceMeta {
  const bytesRaw = frontMatterValue(content, "bytes")
  const parsed = bytesRaw === null ? NaN : Number(bytesRaw)
  return {
    path: pathRel,
    bytes: Number.isFinite(parsed) ? parsed : Buffer.byteLength(content, "utf-8"),
    hash: frontMatterValue(content, "hash") ?? sha256(content),
    origin: frontMatterValue(content, "origin"),
    title: frontMatterValue(content, "title"),
    ingestedAt: frontMatterValue(content, "ingestedAt"),
  }
}

/** 三子目录逐层扫 .md（front-matter 真源即文件头，无变索引——同 findByHash 判据）。 */
export function listRawSources(root: string): RawSourceMeta[] {
  const out: RawSourceMeta[] = []
  for (const dir of RAW_DIRS) {
    const absDir = getRawDir(root, dir)
    let names: string[]
    try {
      names = fs.readdirSync(absDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
      throw err
    }
    for (const name of names.filter(n => n.endsWith(".md")).sort()) {
      let content: string
      try {
        content = fs.readFileSync(path.join(absDir, name), "utf-8")
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
        throw err
      }
      out.push(rawMetaFrom(`raw/${dir}/${name}`, content))
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** 单段安全文件名：字母数字开头、仅 [A-Za-z0-9._-]、.md 结尾（'..'、编码残留、嵌套全拒）。 */
const RAW_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/

/**
 * 单文件读。`relFromRawRoot` = raw 根相对路径（如 `inbox/note.md`，即
 * RawPointer.path 去掉 `raw/` 前缀）。穿越拒绝三重闸：目录必须在 RAW_DIRS 契约内、
 * 文件名必须过 RAW_FILE_RE、解析后绝对路径必须落在 raw 根内。
 */
export function readRawSource(root: string, relFromRawRoot: string): RawSourceMeta & { content: string } {
  const segs = relFromRawRoot.split("/")
  if (segs.length !== 2 || !isRawDir(segs[0]) || !RAW_FILE_RE.test(segs[1])) {
    throw new IngestError(
      "INVALID_PARAM",
      `path must be one of ${RAW_DIRS.join("/")}/<name>.md under raw/, got: ${relFromRawRoot}`,
      400,
    )
  }
  const rawRoot = path.resolve(getRawRoot(root))
  const abs = path.resolve(getRawDir(root, segs[0] as RawDir), segs[1])
  if (!abs.startsWith(rawRoot + path.sep)) {
    throw new IngestError("INVALID_PARAM", `path escapes the raw root: ${relFromRawRoot}`, 400)
  }
  let content: string
  try {
    if (!fs.statSync(abs).isFile()) throw new IngestError("NOT_FOUND", `not a regular file: ${relFromRawRoot}`, 404)
    content = fs.readFileSync(abs, "utf-8")
  } catch (err) {
    if (err instanceof IngestError) throw err
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new IngestError("NOT_FOUND", `raw source not found: ${relFromRawRoot}`, 404)
    }
    throw err
  }
  return { ...rawMetaFrom(`raw/${segs[0]}/${segs[1]}`, content), content }
}
