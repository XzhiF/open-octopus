/**
 * 对话内投喂意图识别（知识中心票12 AC3；纯函数，独立真相源=票面「URL/粘贴/路径」三形态）。
 *
 * 裁决规则（按优先级，命中即 REST 投喂；未命中 = 普通策展人对话原样发送）：
 *  1. 粘贴：显式前缀 `投喂文本：…` / `投喂文本: …`，或围栏块 ` ```paste … ``` `
 *     （UI 粘贴面板注入前缀走同一条规则，零特判）。
 *  2. 本地文件路径：含 `C:\…\x.md` / `~/…x.md` / `/abs/x.md`（扩展名 md|txt|markdown）
 *     **且**带投喂动词——纯贴路径不投喂（防止讨论路径时误吞）。
 *  3. URL：http(s):// 且带投喂动词（投喂|编进|入库|收录|抓进|抓取|抓下来|存进）。
 *
 * 动词表与形态解耦：三形态共用 FEED_VERB；path/url 需要动词，paste 显式前缀自带意图。
 */

const FEED_VERB_RE = /(投喂|编进|入库|收录|抓进|抓取|抓下来|存进)/
const URL_RE = /https?:\/\/[^\s，。）】>"']+/
const FILE_RE = /(?:[A-Za-z]:[\\/][^\s，。]+|[~]\/[^\s，。]+|\/[^\s，。]+)\.(?:md|txt|markdown)(?=\s|$|，|。|[)】>])/

export type KcFeedIntent =
  | { mode: "url"; url: string }
  | { mode: "text"; text: string }
  | { mode: "file"; path: string }

export function classifyKcFeed(text: string): KcFeedIntent | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // 1) 粘贴形态——显式前缀
  const pastePrefix = /^投喂文本[:：]\s*([\s\S]+)$/.exec(trimmed)
  if (pastePrefix) return { mode: "text", text: pastePrefix[1].trim() }
  // 1b) 粘贴形态——```paste 围栏
  const pasteFence = /```paste[^\S\n]*\n([\s\S]*?)\n\s*```/.exec(trimmed)
  if (pasteFence && pasteFence[1].trim()) return { mode: "text", text: pasteFence[1].trim() }

  if (!FEED_VERB_RE.test(trimmed)) return null

  // 2) 本地路径（先于 URL：路径里可能含盘符冒号，避免被 URL 正则误咬）
  const filePath = FILE_RE.exec(trimmed)
  if (filePath) return { mode: "file", path: filePath[0] }

  // 3) URL
  const url = URL_RE.exec(trimmed)
  if (url) return { mode: "url", url: url[0] }

  // 动词在但无可投喂对象 ⇒ 不是投喂（如「上次投喂的那篇」= 对话）
  return null
}

/** 卡片 id 收口（同一事实源同 id：投喂链锚 raw.hash / dif-<taskId> / sum-<taskId>…）。 */
export function kcCardId(kind: string, anchor: string): string {
  return `${kind}-${anchor}`
}

/**
 * 页退役意图识别（票08 清理账 · 故事32；纯函数，独立真相源=票面「退役 <页>」）。
 * 与投喂解耦、`classifyKcFeed` 不动（其 6 例逐字钉死）。规则：退役动词 + 一个 wiki
 * 页相对路径 ⇒ {path}；**动词在、无路径对象 ⇒ null**（同投喂「上次投喂那篇」不吞的纪律）。
 * 命中后由宿主 POST /api/knowledge/wiki/retire（唯一写闸经队列），零前端直写。
 */
const RETIRE_VERB_RE = /(退役|下线|作废|废弃|supersede)/i
const RETIRE_PAGE_PATH_RE = /(?:entities|concepts|topics|sources)\/[A-Za-z0-9._-]+\.md/

export interface KcRetireIntent {
  path: string
}

export function classifyKcRetire(text: string): KcRetireIntent | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!RETIRE_VERB_RE.test(trimmed)) return null
  const m = RETIRE_PAGE_PATH_RE.exec(trimmed)
  return m ? { path: m[0] } : null
}

/**
 * 页恢复意图识别（P4 票09 · 故事17/AC4；纯函数，独立真相源=票面「对话"恢复 oct-XXX"」）。
 * 「对话退役一页」通道的镜像接线：恢复动词 + 口令对象 ⇒ REST POST /restore（唯一写闸
 * 经队列 page-restore），零前端直写。口令两形态：**锚点优先**（oct-XXX——通知卡的
 * 可恢复提示即此形态，原号原行回迁的身份证）；页路径次之（手工退役件也可原路恢复）。
 * 纪律同投喂/退役：动词在、无对象 ⇒ null（不吞「恢复能力你怎么看」类普通对话）。
 */
const RESTORE_VERB_RE = /(恢复|回迁|还原|找回|un-?retire|restore)/i
const RESTORE_ANCHOR_RE = /oct-[0-9A-Za-z_-]+/
const RESTORE_PAGE_PATH_RE = /(?:entities|concepts|topics|sources)\/[A-Za-z0-9._-]+\.md/

export interface KcRestoreIntent {
  anchor?: string
  path?: string
}

export function classifyKcRestore(text: string): KcRestoreIntent | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!RESTORE_VERB_RE.test(trimmed)) return null
  const anchor = RESTORE_ANCHOR_RE.exec(trimmed)
  if (anchor) return { anchor: anchor[0] }
  const path = RESTORE_PAGE_PATH_RE.exec(trimmed)
  return path ? { path: path[0] } : null
}

export function shortHash(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 6) + "…" : "—"
}
