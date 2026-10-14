/**
 * 卡片协议（知识中心票12「协议=结构化事件→渲染」、票13 finding/回填卡；
 * spec §知识中心 UI、原型 Tab④ 卡片目录）。
 *
 * 单一来源（CODING_STANDARDS #1）：本文件是卡片协议的规范源——**shared 侧**，
 * 因为 Lane A 生产者横跨两端：web-app 渲染走
 * `@/lib/knowledge-center/card-protocol`（re-export 垫片，票12 导入路径零改动），
 * server 夜巡/裁决回执写会话正文走本模块直接 import（票13）。
 *
 * ── 事件模型 ──
 * 一次知识操作 = 一个结构化事件 `KcCardEvent`：`{ id, kind, ts, data }`。
 * kind 十一类（票12 六类 + 票13 finding/回填 + P3 票02 material-pack + P3 票03 case
 * + P3 票04 skill-draft）；
 * 追加新卡类：新增 kind 字符串 +
 * data 接口 + `registerKcCardRenderer(kind, Comp)` 一条注册（web 侧
 * components/knowledge-center/cards/registry.tsx）——渲染分发走注册表，
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

import type { SkillGrantReceipt } from "../types/skill-draft"

export const KC_CARD_KINDS = [
  "ingest",
  "source-summary",
  "compile-diff",
  "archive-compile",
  "page-mini",
  "guard",
  "finding",
  "backfill",
  "material-pack",
  "case",
  "skill-draft",
] as const

export type KcKnownCardKind = (typeof KC_CARD_KINDS)[number]
/** 开放 kind：后续票追加新卡类无需改本类型联合（注册即用）。 */
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
  /**
   * D-kc15-1（票07）编译态镜像：投喂后随编译任务轮询回灌（queued→running→committed/failed）。
   * `failed` 时卡面挂「重试编译」入口——重试 = POST /wiki/compile 同 rawPath，
   * 经全局串行队列（ingest-compile 通道复用），禁直写 wiki（红线2）。
   * Lane A 沉淀旧卡无此字段（可选面兼容，零迁移）。
   */
  compile?: {
    taskId: string
    status: "queued" | "running" | "committed" | "failed"
    position?: number | null
    error?: { code: string; message: string }
  }
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

// ── P3 票02 素材包卡（件清单 + 剔除某件→重编译钮；spec §卡片与 UI 逐字）──

/** 素材包单件视图（manifest 投影：名/类/大小）。 */
export interface KcMaterialPackItemView {
  /** acceptance-ledger | phase-rejections | exec-jsonl-excerpt | pr-diff | matt-artifacts | adr-context-notes | archive-summary */
  kind: string
  /** 人读名（验收台账 / phase 打回记录 / …） */
  name: string
  /** 知识根相对路径（raw/archives/task-{id}/NN-….md） */
  path: string
  bytes: number
  /** 件 payload sha256（冻结契约对质凭据；卡面可短显） */
  sha256?: string
  /** 已剔除（人裁素材源；红线3：这是策展事实记录，不是审批态） */
  excluded?: boolean
}

/** 素材包卡上的剔除重编译任务流状态（Lane B 覆盖层回灌；id=队列任务 arc-{taskId}-rcN）。 */
export interface KcMaterialPackRecompileState {
  taskId: string
  status: "queued" | "running" | "committed" | "failed"
  position?: number | null
  excludePath?: string | null
  focus?: string | null
  error?: { code: string; message: string }
}

/**
 * 📦 P3 素材包卡（票02）：task 归档素材包冻结通知——件清单（名/类/大小）+
 * 每件 [剔除重编译] 钮（经全局串行队列，禁直写 wiki）。卡 id 约定 `mdp-<taskId>`。
 */
export interface KcMaterialPackCardData {
  taskId: string
  /** raw/archives/task-{id} */
  packPath: string
  items: KcMaterialPackItemView[]
  /** 总结件是否已入包（LLM 离线 ⇒ false：包在、无编译任务） */
  summaryIncluded: boolean
  /** 首轮归档编译队列 id（arc-{taskId}） */
  queueTaskId?: string
  /**
   * 链尾编译结果镜像（aa-fix 项9·spec L81 聚合面「素材清单+编译结果+判例数」）：
   * 归档卡发布时刻的队列任务快照（票06 队列 view 形态）。可选=Lane A 旧卡零迁移
   * （无此位 ⇒ 卡走旧「编译已入队」措辞）。
   */
  compile?: {
    taskId: string
    status: "queued" | "running" | "committed" | "failed"
    position?: number | null
    error?: { code: string; message: string }
  }
  /** 链尾判例提取入队草案数（case-archive 通道；缺席=提取件缺席/失败/无产出=诚实缺席） */
  caseCount?: number
  /** 剔除重编译任务流状态（Lane B 轮询回灌） */
  recompile?: KcMaterialPackRecompileState
}

// ── P3 票03 判例卡（五段预览 + source 指针 + 退役钮；spec §卡片与 UI 逐字）──

/** 判例卡五段预览（键序=CBR 叙事序；单源对齐 shared WIKI_CASE_SECTIONS）。 */
export interface KcCaseCardSections {
  现场: string
  诊断: string
  根因: string
  修复: string
  教训: string
}

/**
 * ⚖️ P3 判例卡（票03）：判例自动入档（先存后知）的事后通知——五段预览 + source 指针 +
 * 退役钮（superseded 经 case-archive 队列通道，红线2 禁直写 cases/；红线3 无审批态）。
 * 字段名对齐 web 侧 KcCaseFields（knowledge-center-api：symptom/tags/severity/
 * occurrences/ruleRef/status）。卡 id 约定 `cse-<caseId>`（重放同 id：Lane A 沉淀
 * 终态卡与首见卡同址，finding 终态卡先例同律）。
 */
export interface KcCaseCardData {
  caseId: string
  /** wiki 相对路径（cases/{YYYY-MM-DD}-{slug}.md；右栏跟随目标） */
  path: string
  symptom: string
  severity: string
  tags: string[]
  occurrences: number
  ruleRef?: string | null
  /** open | distilled | superseded（WikiCaseStatusValues 单源） */
  status: string
  /** 可定位溯源指针（exec:/task: 前缀族；openRaw/回指面） */
  source: string
  sections: KcCaseCardSections
  /** 提取来源任务（指针面，可空=手工/对话通道产卡时缺省） */
  taskId?: string
  /** 入档队列任务 id（caw-…/car-…；GET /wiki/queue/task/:id 可查面） */
  queueTaskId?: string
  /** 自动提取入档 or 并档（occurrences+1）or 退役——卡面动作记号 */
  action?: "created" | "merged" | "retired"
  /**
   * 退役钮任务流状态（Lane B 轮询回灌，与 finding fix/素材包 recompile 同构）：
   * POST /case/retire → car-… 队列任务（case-archive opKind，唯一写通道）。
   * committed 后终态卡（action=retired）由 Lane A 沉淀覆盖（先存后知）。
   */
  retire?: KcCaseRetireState
}

/** 判例卡退役任务流状态（位次口径同队列卡；红线3：事后纠即时执行，无审批态）。 */
export interface KcCaseRetireState {
  taskId: string
  status: "queued" | "running" | "committed" | "failed"
  position?: number | null
  error?: { code: string; message: string }
}

// ── P3 票04 skill 草案卡（SKILL.md 完整渲染 + 来源指针可点；spec §卡片与 UI 逐字）──

/** 草案来源指针单项（openRaw 走 pack:/raw 件路径；openPage 走判例页；exec: 仅展示形）。 */
export interface KcSkillDraftSourceRef {
  kind: "pack" | "case" | "exec"
  /** pack=知识根相对件路径（raw/archives/…）；case=wiki 相对页路径；exec=exec: 指针 */
  pointer: string
  label: string
}

/**
 * 🧪 P3 skill 草案卡（票04）：检测三路产出的待授予过程资产预览——
 * SKILL.md 完整渲染（name/description/触发条件/步骤/纪律）+ 来源指针可点
 * （openRaw/右栏跟随）。**本票零授予**：卡上没有授予钮、data 没有目标分身字段
 * （红线4——授予/撤销 UI 与回执是票05 在 kind 同址上的扩展位）。
 * status 三态 draft|granted|revoked（无 pending——红线3：草案人裁是授予治理，
 * 不是入库审批）。卡 id 约定 `skl-<draftName>`（重放同 id：改写后新卡顶旧预览）。
 */
export interface KcSkillDraftCardData {
  draftName: string
  /** 草案描述（front-matter description 单行） */
  description: string
  /** draft | granted | revoked（granted/revoked 只可能由票05 写入，本票产卡恒 draft） */
  status: string
  /** sequence-similar | case-procedural | curator-proposal（检测三路标记） */
  origin: string
  /** front-matter 来源指针原样串（可溯源，spec 故事 24） */
  source: string
  /** drafts/skills/{name}/SKILL.md（知识根相对——非 wiki 路径，右栏 openRaw 可达性由路由白名单定） */
  skillPath: string
  /** SKILL.md 正文（## 触发条件/## 步骤/## 纪律——票面「完整渲染」的渲染源） */
  content: string
  /** 来源指针可点面（openRaw/openPage/展示三类） */
  sourceRefs: KcSkillDraftSourceRef[]
  /** front-matter name（SDK 技能名；授予落目录同名） */
  skillName?: string
  taskId?: string
  caseId?: string
  ruleRef?: string
  similarity?: number
  /**
   * P3 票05 扩展位：已授予目标清单（分身名 ∪ `*`；granted 态非空）。
   * 卡面「目标分身选择器/撤销钮可用性」的数据源（重发卡的 status 位由服务端
   * drafts 文件真相回填）。
   */
  grantedTo?: string[]
  /** P3 票05 版本回执面（分身名/版本号/预置源同步结果——spec 故事 23 逐字） */
  receipt?: SkillGrantReceipt
  /**
   * P3 票05 Lane B 覆盖层（use-kc-grants 注入，同构判例 retireStates/素材包 recompile）：
   * 钮点击即时态（pending 在途 / receipt=刚完成的本地回执 / error=失败显形不伪造）。
   * Lane A 沉淀卡重发后 data.receipt 即真相，本位只是点击到重发之间的即时显形。
   */
  grant?: { pending?: boolean; receipt?: SkillGrantReceipt | null; error?: string | null }
  /** 产卡动作记号（created=首见 / revised=对话改写后刷新预览 / retired=退役终态 / granted|revoked=授予撤销回执） */
  action?: "created" | "revised" | "retired" | "granted" | "revoked"
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

/** finding 卡上采纳修订（裁决即编译）的任务流状态——与回滚态同构，复用队列位次口径。 */
export interface KcFindingFixState {
  taskId: string
  status: "queued" | "running" | "committed" | "failed"
  position?: number | null
  /** committed 后的修订 commit */
  commit?: string
  error?: { code: string; message: string }
}

/**
 * ⚠️ finding 卡（票13）：编译期矛盾 / 巡检发现（矛盾/stale/孤儿/缺页/缺引用）。
 * 三钮 = [采纳修订]（服务端生成修订稿入串行队列，diff 回执跟随）/ [忽略]（记录在案
 * 不再扰）/ [讨论]（对话继续，零状态变更）。原型 Tab④ finding 卡逐字段。
 */
export interface KcFindingCardData {
  /** findings 表主键（内容寻址 fnd-…）；卡 id = 同串（card-protocol id 约定 fnd-<findingId>） */
  findingId: string
  /** contradiction | stale | orphan | missing-page | missing-xref | …开放 */
  kind: string
  title: string
  /** 断言对立证据（矛盾卡双栏；其余 kind 缺省） */
  claims?: { old: string; new: string }
  /** 涉及页（wiki 相对路径；右栏跟随首项） */
  pages: string[]
  /** 回指 raw / 归属页指针 */
  rawRef: string
  /** 产出通道：compile（编译期矛盾）| patrol（巡检） */
  source: string
  /** 裁决态（列表 API 真值；卡渲染终态徽标与钮可用性） */
  status: "open" | "resolved" | "ignored"
  /** [采纳修订] 任务流状态（Lane B 轮询回灌；终态回执沉淀走 Lane A diff 卡） */
  fix?: KcFindingFixState
}

/**
 * 🗄️ 页退役卡（票08 清理账 · 故事32）：策展对话「退役 <页>」→ POST /retire →
 * 队列 opKind="page-retire"：页迁 `_retired/` + front-matter 注 superseded + 四路摘除 +
 * 单 commit。数据面回显退役去向 + commit（回执卡）。开放 kind，不改 KcCardKind 联合。
 */
export interface KcPageRetireCardData {
  status: "queued" | "running" | "committed" | "failed"
  position?: number | null
  /** 被退役页原相对路径 */
  pagePath: string
  /** 迁入的 `_retired/<…>` 相对路径（committed 后有值） */
  to?: string
  /** 退役 commit（committed 后有值） */
  commit?: string
  error?: { code: string; message: string }
}

/**
 * ↩️ 回填卡（票13）：策展人对话中的有价值合成答案 → [编进 wiki] → 对话摘录落 raw
 * （票02 冻结契约，origin=chat:〈session〉）→ 编译新页。[不用] = 纯前端弃卡零请求。
 * 窄口纪律：执行中 agent 的产出永不自动回填——本卡只由知识中心对话显式触发。
 */
export interface KcBackfillCardData {
  /** 对话摘录正文（提交后原样落 raw） */
  excerpt: string
  title?: string
  sessionId?: string
  status: "ready" | "submitted" | "committed" | "failed"
  rawPath?: string
  hash?: string
  /** 触发的编译任务 id（crt-…；diff 卡跟随由 use-kc-feed 挂链） */
  taskId?: string
  commit?: string
  error?: { code: string; message: string }
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
    | KcFindingCardData
    | KcBackfillCardData
    | KcMaterialPackCardData
    | KcCaseCardData
    | KcSkillDraftCardData
    | KcPageRetireCardData
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
    case "finding": {
      // 票13：对话点到 finding，右栏落涉事首页（原型交互纪律④同律）
      const d = event.data as KcFindingCardData
      return (d.pages ?? []).slice(0, 1)
    }
    case "case": {
      // P3 票03：判例卡右栏落判例页（cases/…；openPage 解析走既有树）
      const d = event.data as KcCaseCardData
      return d.path ? [d.path] : []
    }
    case "skill-draft": {
      // P3 票04：判例来源的草案右栏落判例页（草案本体在 drafts 区非知识页，不跟随——
      // 预览长卡上，溯源靠 sourceRefs 点击）
      const d = event.data as KcSkillDraftCardData
      const caseRef = (d.sourceRefs ?? []).find(r => r.kind === "case")
      return caseRef ? [caseRef.pointer] : []
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
  /** diff/revert/retire 卡复用同一条流转，动词不同（票08 加 retire） */
  verb?: "compile" | "revert" | "retire"
}): string {
  const compiling = input.verb === "revert" ? "回滚中" : input.verb === "retire" ? "退役中" : "编译中"
  const committed = input.verb === "revert" ? "已回滚" : input.verb === "retire" ? "已退役" : "已提交"
  const failedVerb = input.verb === "revert" ? "回滚" : input.verb === "retire" ? "退役" : "编译"
  switch (input.status) {
    case "queued":
      return typeof input.position === "number" ? `排队中 #${input.position}` : "排队中"
    case "running":
      return `⚙️ ${compiling}…`
    case "committed":
      return `✓ ${committed}${input.hash ? ` ${shortHash(input.hash)}` : ""}`
    case "failed":
      return `✕ ${failedVerb}失败`
  }
}

/** commit hash → 短形态（卡面/LOG 行一致取 7 位）。 */
export function shortHash(hash: string | undefined | null): string {
  return hash ? hash.slice(0, 7) : "—"
}
