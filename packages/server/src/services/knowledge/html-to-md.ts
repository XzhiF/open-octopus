/**
 * 零依赖 HTML → Markdown 轻量转换（知识中心票02 · URL 投喂形态）。
 *
 * 仓内既有先例核查：server/engine/core-pack 无 fetch+html→md 工具，也无
 * turndown/cheerio/DOMPParser 依赖——按票面「不引新依赖」用正则状态机做
 * **有损但可预期**的转换：保留标题层级 / 段落 / 列表 / 链接 / 强调 / 行内码 /
 * 引用块 / 代码块，丢弃脚本样式导航等非正文容器，文本实体解码。
 * 目标是让 raw 里的源文本可读、可全文编译（票05 全文读 raw），不是排版复刻。
 */

/** 非正文容器：整块丢弃（含内容）。head 另由标题提取先行处理。 */
const DROP_BLOCK_RE = /<(script|style|noscript|template|svg|canvas|iframe|form|nav|header|footer|aside|head)\b[^>]*>[\s\S]*?<\/\1>/gi
const COMMENT_RE = /<!--[\s\S]*?-->/g
const DOCTYPE_RE = /<!doctype[^>]*>/gi
const TOKEN_RE = /<(\/?)([a-z][a-z0-9]*)([^>]*)>|([^<]+)/gi
const BLOCK_TAGS = new Set(["p", "div", "section", "article", "main", "li", "ul", "ol", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "tr"])

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', middot: "·", bull: "*",
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1].toLowerCase() === "x"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named ?? whole
  })
}

/** `<title>` 优先 og:title? 简化：只取 <title>（URL 抓取命名用；票面未要求 og）。 */
export function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!m) return null
  const text = decodeEntities(m[1].replace(/<[^>]*>/g, "")).trim()
  return text || null
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s">]+))`, "i").exec(attrs)
  if (!m) return null
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "")
}

/**
 * 转换入口。`text/plain` / `text/markdown` 走原文（调用方判定后直传），
 * 这里只做 html 形态。返回以单个 `\n` 收尾的 markdown。
 */
export function htmlToMarkdown(html: string): string {
  const cleaned = html.replace(DOCTYPE_RE, "").replace(COMMENT_RE, "").replace(DROP_BLOCK_RE, " ")
  const blocks: string[] = []
  let cur = ""
  let pending = ""
  let inPre = false
  let preBuf = ""
  const listStack: Array<{ type: "ul" | "ol"; i: number }> = []
  const listBuf: string[] = []
  const linkQueue: string[] = []

  const flush = () => {
    if (inPre) return
    const text = (pending + cur).replace(/[ \t]+/g, " ").trim()
    if (text) {
      // 列表内条目并进同一块（连续行，不空行分隔），列表闭合时才成块
      if (listStack.length > 0) listBuf.push(text)
      else blocks.push(text)
    }
    cur = ""
    pending = ""
  }

  for (const match of cleaned.matchAll(TOKEN_RE)) {
    const [, slash, rawName, attrs, text] = match

    if (text !== undefined) {
      if (inPre) { preBuf += decodeEntities(text); continue }
      cur += decodeEntities(text).replace(/\s+/g, " ")
      continue
    }

    const name = rawName.toLowerCase()
    const closing = slash === "/"

    if (name === "br" && !closing) { cur += inPre ? "\n" : " "; continue }

    if (BLOCK_TAGS.has(name)) flush()

    if (closing) {
      switch (name) {
        case "pre":
          blocks.push("```\n" + preBuf.replace(/\n+$/, "") + "\n```")
          preBuf = ""
          inPre = false
          break
        case "a": {
          const href = linkQueue.pop()
          cur += href ? `](${href})` : "]"
          break
        }
        case "strong": case "b": cur += "**"; break
        case "em": case "i": cur += "*"; break
        case "code": cur += "`"; break
        case "ul": case "ol":
          listStack.pop()
          if (listStack.length === 0 && listBuf.length) {
            blocks.push(listBuf.join("\n"))
            listBuf.length = 0
          }
          break
        default: break
      }
      continue
    }

    switch (name) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        pending = `${"#".repeat(Number(name[1]))} `
        break
      case "li": {
        const top = listStack[listStack.length - 1]
        const indent = "  ".repeat(Math.max(0, listStack.length - 1))
        pending = top?.type === "ol" ? `${indent}${top.i++}. ` : `${indent}- `
        break
      }
      case "ul": listStack.push({ type: "ul", i: 0 }); break
      case "ol": listStack.push({ type: "ol", i: 1 }); break
      case "blockquote": pending = "> "; break
      case "hr": blocks.push("* * *"); break
      case "pre": inPre = true; break
      case "img": {
        const src = attr(attrs, "src")
        if (src) cur += `![${attr(attrs, "alt") ?? ""}](${src})`
        break
      }
      case "a": {
        const href = attr(attrs, "href")
        cur += "["
        if (href) linkQueue.push(href)
        break
      }
      case "strong": case "b": cur += "**"; break
      case "em": case "i": cur += "*"; break
      case "code": cur += "`"; break
      default: break
    }
  }
  flush()
  if (listBuf.length) {
    blocks.push(listBuf.join("\n"))
    listBuf.length = 0
  }
  const body = blocks.join("\n\n")
  return body ? `${body.replace(/\n{3,}/g, "\n\n")}\n` : ""
}
