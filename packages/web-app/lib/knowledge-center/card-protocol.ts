/**
 * 卡片协议（知识中心票12，spec §知识中心 UI「卡片协议」、原型 Tab④ 卡片目录）。
 *
 * ── 事件模型 ──
 * 一次知识操作 = 一个结构化事件 `KcCardEvent`：`{ id, kind, ts, data }`。
 * kind 首批六类（票面五类 + AC6 写保护卡）；**票13 追加 finding 卡/回填卡/写保护
 * 变体**时：新增 kind 字符串 + data 接口 + `registerKcCardRenderer(kind, Comp)`
 * 一条注册——渲染分发走注册表（components/knowledge-center/cards/registry.tsx），
 * 本文件与分发器不为新卡类改 switch。未注册 kind 的持久块渲染为通用兜底卡
 * （可读 JSON 摘要，不炸流）。
 *
 * ── 持久契约（两车道，票13/14 依赖此定义）──
 * **Lane A（正典跨设备形态）**：卡片以 fenced 块嵌入会话消息正文——
 *   ~~~
 *   ```kc-card
 *   {"v":1,"id":"dif-crt-20261013T0800-001","kind":"compile-diff","ts":"…","data":{…}}
 *   ```
 *   ~~~
 *   解析入口 `parseKcCardBlocks(content)`：合法块 → 事件 + 从纯文本展示中剥除；
 *   非法/未知形状 → 原样留在正文（显形，不静默吞）。生产者（策展人分身文本、
 *   票13 finding 裁决回执、任何要**沉淀进会话持久流**的卡）写这个格式；
 *   消息本体走既有 clone chat 通道存储（零自建聊天基建）。
 * **Lane B（前端编排态，会话侧挂）**：投喂/编译/revert 由前端直连
 *   ingest/compile/queue/revert API 驱动，卡片活在 `use-kc-feed` store，
 *   按 sessionId 侧挂 localStorage 镜像（`kc-cards:{sessionId}`），id 锚定
 *   （`dif-<taskId>`/`ing-<hash8>`…）幂等合并；任务面真相 = queue/compile API
 *   （进程内 registry 重启即失，卡片可锚 id 重建，git LOG 为最终审计真相）。
 *   同 id 事件 Lane A 优先（沉淀后取代侧挂态）。
 *
 * ── id 约定 ── `ing-<rawHash前8位>` / `sum-<taskId>` / `dif-<taskId>` /
 * `arc-<taskId>` / `pgm-<pageId>` / `grd-<targetSlug>-<ts>`；票13：`fnd-<findingId>` / `bfk-<hash8>`。
 */

export const KC_CARD_KINDS = [
  "ingest",
  "source-summary",
  "compile-diff",
  "archive-compile",
  "page-mini",
  "guard",
] as const

export type KcKnownCardKind = (typeof KC_CARD_KINDS)[number]
/** 开放 kind：票13 追加 "finding" | "backfill" 等无需改本类型联合渲染（注册即用）。 */
export type KcCardKind = KcKnownCardKind | (string & {})

// ── kind 数据面（expected 真相源：原型 Tab④ 卡片目录字段）──

/** 📥 抓取卡：raw 路径/大小/hash（AC2「确认源已不可变冻结」）。 */
export interface KcIngestCardData {
  status: "fetching" | "done" | "failed"
  rawPath?: string
  bytes?: number
  hash?: string
  origin?: string | null
  title?: string | null
  error?: { code: string; message: string }
}

/** 📄 来源摘要卡：sources/ 页 + 要点 + 回指 raw。 */
export interface KcSourceSummaryCardData {
  sourcePath: string
  rawPath: string
  hash?: string
  points: string[]
}

/** diff 卡触及页明细单项。 */
export interface KcDiffTouchedPage {
  path: string
  type?: string
  created?: boolean
}

/** diff 卡上的回滚状态（票12 AC5：二次确认后经队列）。 */
export interface KcRevertState {
  taskId: string
  status: "queued" | "running" | "committed" | "failed"
  position?: number | null
  revertCommit?: string
  error?: { code: string; message: string }
}

/** ⚙️ 编译 diff 卡：触及 N 页明细/冲突数/新页数/commit hash + 流式状态（排队中 #N→编译中→已提交）。 */
export interface KcCompileDiffCardData {
  taskId?: string
  status: "queued" | "running" | "committed" | "failed"
  /** 票06 队列位次（state=queued 时有值） */
  position?: number | null
  rawPath?: string
  rawTitle?: string
  /** committed 后的编译 commit */
  commit?: string
  touched: KcDiffTouchedPage[]
  created?: number
  updated?: number
  contradictions?: number
  /** FTS/DB 同步结果（warnings 为空 ⇒ true） */
  ftsOk?: boolean
  error?: { code: string; message: string }
  /** 本编译已被回滚 */
  revert?: KcRevertState
}

/** 📦 归档编译卡：task archiving 自动编译后（数据面同 diff 卡 + 任务标签）。 */
export interface KcArchiveCompileCardData extends KcCompileDiffCardData {
  /** 如 `task-207「actuator 增强」` */
  taskLabel: string
}

/** 📇 词条迷你卡：对话提到某页。 */
export interface KcPageMiniCardData {
  /** 页 id（解析优先）或 wiki 相对路径 */
  pageId?: string
  path?: string
  title: string
  type?: string
  isNew?: boolean
}

/** ⛔ 写保护卡：user_preference/SCHEMA 修改意图 → 建议文本 + 人工确认步骤，零自动落盘。 */
export interface KcGuardCardData {
  /** user_preference.md | SCHEMA.md */
  target: string
  intent: string
  suggestion: string
  manualSteps: string[]
}

export interface KcCardEvent {
  id: string
  kind: KcCardKind
  /** ISO 时间戳（渲染排序与沉淀序） */
  ts: string
  data:
    | KcIngestCardData
    | KcSourceSummaryCardData
    | KcCompileDiffCardData
    | KcArchiveCompileCardData
    | KcPageMiniCardData
    | KcGuardCardData
    | Record<string, unknown>
}

// ── Lane A：fenced 块编解码（会话消息正文 = 持久载体）──

const KC_BLOCK_RE = /```kc-card[^\S\n]*\n([\s\S]*?)\n\s*```/g

/** 事件 → 可沉淀文本块（策展人/票13 生产者用；前端 Lane B 卡也可导出留档）。 */
export function serializeKcCardBlock(event: KcCardEvent): string {
  return `\`\`\`kc-card\n${JSON.stringify({ v: 1, ...event })}\n\`\`\``
}

/** 校验 Lane A JSON 形状；不合返回 null（调用方按「显形留原文」处理）。 */
export function parseKcCardPayload(raw: unknown): KcCardEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== "string" || o.id.trim() === "") return null
  if (typeof o.kind !== "string" || o.kind.trim() === "") return null
  if (typeof o.ts !== "string") return null
  if (!o.data || typeof o.data !== "object" || Array.isArray(o.data)) return null
  return { id: o.id, kind: o.kind, ts: o.ts, data: o.data as KcCardEvent["data"] }
}

/**
 * 从消息正文抽取全部合法 kc-card 块：返回事件清单 + 剥除已识别块后的展示文本。
 * 非法块（JSON 坏/形状不合）保留原文——显形优先于静默（CODING_STANDARDS #2 同律）。
 */
export function parseKcCardBlocks(content: string): { events: KcCardEvent[]; rest: string } {
  const events: KcCardEvent[] = []
  const rest = content.replace(KC_BLOCK_RE, (whole, bodyJson: string) => {
    let payload: unknown
    try {
      payload = JSON.parse(bodyJson)
    } catch {
      return whole
    }
    const ev = parseKcCardPayload(payload)
    if (!ev) return whole
    events.push(ev)
    return ""
  })
  // 剥块留下的空行收一收（不改变语义空白结构）
  return { events, rest: rest.replace(/\n{3,}/g, "\n\n").trim() }
}

// ── 右栏跟随判据（原型交互纪律④：对话点到哪页，右栏渲染哪页）──

/**
 * 事件引用的页目标（id 或 wiki 相对路径，解析走调用方的 tree）。
 * 无页引用（抓取卡/写保护卡）返回空数组 ⇒ 不触发跟随。
 */
export function kcEventPageRefs(event: KcCardEvent): string[] {
  switch (event.kind) {
    case "page-mini": {
      const d = event.data as KcPageMiniCardData
      return [d.pageId ?? d.path ?? ""].filter(Boolean)
    }
    case "source-summary": {
      const d = event.data as KcSourceSummaryCardData
      return [d.sourcePath]
    }
    case "compile-diff":
    case "archive-compile": {
      const d = event.data as KcCompileDiffCardData
      // 跟随首个「新建页」，无新建取首个触及页（原型：diff 卡后右栏落新建概念页）
      const firstCreated = d.touched.find(t => t.created)?.path
      const first = firstCreated ?? d.touched[0]?.path
      return first ? [first] : []
    }
    default:
      return []
  }
}

/** 队列状态 → UI 文案（票11 故事 11 原型口径：排队中 #N → 编译中 → 已提交 hash）。 */
export function kcTaskStateLabel(input: {
  status: "queued" | "running" | "committed" | "failed"
  position?: number | null
  hash?: string
  /** revert 卡复用同一条流转，动词不同 */
  verb?: "compile" | "revert"
}): string {
  const compiling = input.verb === "revert" ? "回滚中" : "编译中"
  const committed = input.verb === "revert" ? "已回滚" : "已提交"
  switch (input.status) {
    case "queued":
      return typeof input.position === "number" ? `排队中 #${input.position}` : "排队中"
    case "running":
      return `⚙️ ${compiling}…`
    case "committed":
      return `✓ ${committed}${input.hash ? ` ${shortHash(input.hash)}` : ""}`
    case "failed":
      return `✕ ${input.verb === "revert" ? "回滚" : "编译"}失败`
  }
}

/** commit hash → 短形态（卡面/LOG 行一致取 7 位）。 */
export function shortHash(hash: string | undefined | null): string {
  return hash ? hash.slice(0, 7) : "—"
}
