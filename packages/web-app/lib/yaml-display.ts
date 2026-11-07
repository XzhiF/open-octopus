/**
 * 工作流 YAML 窗的纯展示逻辑：语法着色、节点大纲、搜索命中、差异行。
 * 全部是纯函数，和 React/DOM 无关 —— 组件只负责把 token 画成 span。
 */

export type YamlTokenKind =
  | "plain"
  | "punct"
  | "key"
  | "str"
  | "num"
  | "bool"
  | "comment"
  | "mark"

export interface YamlToken {
  text: string
  kind: YamlTokenKind
  /** 在本行原文里的起始偏移（搜索高亮切段用）。 */
  start: number
}

export interface YamlNodeOutline {
  id: string
  type: string
  /** 1-based 行号。 */
  line: number
}

export interface YamlMatch {
  /** 0-based 行下标。 */
  line: number
  start: number
  end: number
  /** 全文命中的序号（0-based），用于「第 n/m 处」和当前命中标记。 */
  index: number
}

/** 节点类型 → 大纲圆点颜色（与 DAG 节点同色系）。 */
export const NODE_TYPE_COLORS: Record<string, string> = {
  bash: "#7EE787",
  python: "#4FD1D9",
  agent: "#D2A8FF",
  swarm: "#4FD1D9",
  condition: "#FFC857",
  loop: "#F5F5F2",
  approval: "#7EE787",
  interaction: "#D2A8FF",
  sub_workflow: "#D2A8FF",
  dynamic_sub_workflow: "#FF855C",
  octopus_agent: "#FF5C5C",
}

export function splitYamlLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n")
}

export function countYamlLines(text: string | null | undefined): number {
  if (!text) return 0
  return splitYamlLines(text).length
}

export function isBlockScalarHeader(line: string): boolean {
  return /:\s*[|>][+-]?\s*$/.test(line)
}

/** 找出行内注释起点（引号里的 # 不算）。 */
export function findCommentStart(line: string): number {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote && line[i - 1] !== "\\") quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return i
    }
  }
  return -1
}

/** 单行 YAML 着色。`inBlock` = 这一行是块标量（bash/prompt 正文）。 */
export function highlightYamlLine(line: string, inBlock: boolean): YamlToken[] {
  const tokens: YamlToken[] = []
  let offset = 0
  const push = (text: string, kind: YamlTokenKind) => {
    if (!text) return
    tokens.push({ text, kind, start: offset })
    offset += text.length
  }

  const commentAt = findCommentStart(line)
  const body = commentAt === -1 ? line : line.slice(0, commentAt)
  const comment = commentAt === -1 ? "" : line.slice(commentAt)

  const pushValue = (value: string) => {
    if (!value) return
    const lead = /^\s*/.exec(value)?.[0] ?? ""
    const rest = value.slice(lead.length)
    push(lead, "plain")
    if (!rest) return
    const core = rest.replace(/\s+$/, "")
    const tail = rest.slice(core.length)
    if (/^["']/.test(core)) push(core, "str")
    else if (/^(true|false|null|~)$/i.test(core)) push(core, "bool")
    else if (/^-?\d+(\.\d+)?$/.test(core)) push(core, "num")
    else if (/^[|>][+-]?$/.test(core)) push(core, "punct")
    else if (/^\[.*\]$/.test(core) || /^\{.*\}$/.test(core)) push(core, "punct")
    else if (core.startsWith("$")) push(core, "mark")
    else push(core, "plain")
    push(tail, "plain")
  }

  if (inBlock) {
    push(body, "plain")
  } else {
    const keyMatch = body.match(/^(\s*)(-\s+)?([A-Za-z0-9_.$\-]+)(:)(\s*)(.*)$/)
    if (keyMatch) {
      push(keyMatch[1], "plain")
      if (keyMatch[2]) push(keyMatch[2], "punct")
      push(keyMatch[3], "key")
      push(keyMatch[4], "punct")
      push(keyMatch[5], "plain")
      pushValue(keyMatch[6])
    } else {
      const itemMatch = body.match(/^(\s*)(-\s+)(.*)$/)
      if (itemMatch) {
        push(itemMatch[1], "plain")
        push(itemMatch[2], "punct")
        pushValue(itemMatch[3])
      } else {
        pushValue(body)
      }
    }
  }

  if (comment) push(comment, "comment")
  return tokens
}

/** 每种行在渲染循环里是否处于块标量正文（| / > 一直到缩进退回）。 */
export function blockScalarFlags(lines: string[]): boolean[] {
  const flags: boolean[] = []
  let blockIndent = -1
  for (const raw of lines) {
    const indent = raw.length - raw.replace(/^\s+/, "").length
    const blank = raw.trim() === ""
    if (blockIndent >= 0 && (blank || indent > blockIndent)) {
      flags.push(true)
    } else {
      blockIndent = -1
      flags.push(false)
    }
    if (!blank && isBlockScalarHeader(raw)) blockIndent = indent
  }
  return flags
}

/** 大纲：所有 `- id:` 行（含嵌套节点/loop_body），向后最多 8 行找 `type:`。 */
export function extractYamlNodes(lines: string[]): YamlNodeOutline[] {
  const items: YamlNodeOutline[] = []
  for (let i = 0; i < lines.length; i++) {
    const idMatch = lines[i].match(/^\s*-\s+id:\s*([A-Za-z0-9_.\-]+)\s*$/)
    if (!idMatch) continue
    let type = ""
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const typeMatch = lines[j].match(/^\s+type:\s*([A-Za-z0-9_\-]+)\s*$/)
      if (typeMatch) {
        type = typeMatch[1]
        break
      }
      if (/^\s*-\s+id:/.test(lines[j])) break
    }
    items.push({ id: idMatch[1], type, line: i + 1 })
  }
  return items
}

/** 全文大小写不敏感搜索，返回按行、按出现顺序的命中。 */
export function findYamlMatches(lines: string[], query: string): YamlMatch[] {
  if (!query) return []
  const needle = query.toLowerCase()
  const matches: YamlMatch[] = []
  lines.forEach((line, lineIndex) => {
    const hay = line.toLowerCase()
    let from = 0
    while (from <= hay.length - needle.length) {
      const at = hay.indexOf(needle, from)
      if (at === -1) break
      matches.push({ line: lineIndex, start: at, end: at + needle.length, index: matches.length })
      from = at + needle.length
    }
  })
  return matches
}

export interface DisplayToken extends YamlToken {
  hit?: boolean
  current?: boolean
}

/** 把 token 按命中区间切段，给 <mark> 用；未命中的部分原样保留。 */
export function applyMatchHighlights(
  tokens: YamlToken[],
  ranges: YamlMatch[],
  currentIndex: number,
): DisplayToken[] {
  if (ranges.length === 0) return tokens
  const out: DisplayToken[] = []
  for (const token of tokens) {
    const tokenEnd = token.start + token.text.length
    let cursor = token.start
    for (const range of ranges) {
      if (range.start < cursor || range.end <= token.start || range.start >= tokenEnd) continue
      const start = Math.max(range.start, token.start)
      const end = Math.min(range.end, tokenEnd)
      if (start > cursor) {
        out.push({ ...token, text: token.text.slice(cursor - token.start, start - token.start) })
      }
      out.push({
        ...token,
        text: token.text.slice(start - token.start, end - token.start),
        hit: true,
        current: range.index === currentIndex,
      })
      cursor = end
    }
    if (cursor < tokenEnd) {
      out.push({ ...token, text: token.text.slice(cursor - token.start) })
    }
  }
  return out
}

/** 两个 YAML 文本的行级差异（1-based 行号）。 */
export function diffLineNumbers(a: string, b: string): Set<number> {
  const left = splitYamlLines(a)
  const right = splitYamlLines(b)
  const diff = new Set<number>()
  const max = Math.max(left.length, right.length)
  for (let i = 0; i < max; i++) {
    if (left[i] !== right[i]) diff.add(i + 1)
  }
  return diff
}
