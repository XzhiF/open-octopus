import fs from "fs"
import path from "path"
import { IngestError, isRawDir, RAW_FILE_RE } from "./raw"

/**
 * 知识根目录树只读面 — 知识中心左栏「真实目录树」改版（20261016）。
 *
 * 定位：`~/.octopus/knowledge` 文件系统的**只读投影**，与 /wiki/tree（DB 分组）互补——
 * tree 面一字不动（wiki-routes.test 严格 toEqual 钉），fs 面走本模块独立端点。
 * 三层纪律：
 *   1. **可见即可读**：raw/ 子树判据与 readRawSource 单源同律（import isRawDir/RAW_FILE_RE，
 *      禁镜像）——树上叶永不会点出 400；
 *   2. **概念防复活**（ADR-0033）：任意层级 basename 以 `user_preference` 开头 → 整棵剔除，
 *      读取同样 404（树不可见 ⇒ 读不可达，两面对称）；`.` 开头隐藏项（含 wiki/.git）同退；
 *   3. **诚实降级**：根缺席 404，不伪造空树（CODING_STANDARDS #2）。
 * 防御帽：maxDepth=8 / maxNodes=2000 / 单文件 5MB（真库实测 131 文件深 5，永不触发）。
 */

export interface FsNode {
  /** basename，不含分隔符 */
  name: string
  /** 知识根相对、POSIX 分隔、无 "."/".." 段、无前导斜杠 */
  path: string
  kind: "dir" | "file"
  /** 仅 dir 携带；空目录 = [] */
  children?: FsNode[]
}

export interface FsTree {
  tree: FsNode[]
  /** 触帽截断标记（深度或节点数） */
  truncated: boolean
  /** 已收集节点总数（含截断前） */
  total: number
}

export const FS_DEFAULT_MAX_DEPTH = 8
export const FS_DEFAULT_MAX_NODES = 2000
export const FS_MAX_FILE_BYTES = 5 * 1024 * 1024

/** 排除判据（按 basename，任意层级；见文件头纪律 2）。 */
function isExcludedName(name: string): boolean {
  return name.startsWith(".") || name.startsWith("user_preference")
}

interface Budget {
  nodes: number
  truncated: boolean
}

/** 同 listRawSources 的 name 序律：Array.prototype.sort 默认（UTF-16 码元升序）+ 目录先行。 */
function sortNodes(nodes: FsNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/**
 * 扫一个目录。abs/rel 已定为知识根内安全位置；raw/ 子树按纪律 1 收紧：
 *   - `raw/` 的直接子项只认 isRawDir 三目录（其余文件/目录不上树）；
 *   - 三目录内只收 RAW_FILE_RE 过的 .md（单层，嵌套不展开——与读面同判据）；
 *   - `raw/archives|research` 的下一层同样按三目录律处理（其子目录非 RAW_DIRS → 不展开）。
 */
function scanDir(rootAbs: string, rel: string, depth: number, budget: Budget, maxDepth: number, maxNodes: number): FsNode[] {
  const absDir = rel ? path.join(rootAbs, ...rel.split("/")) : rootAbs
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(absDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [] // 竞态消失：目录保留但无子项
    throw err
  }
  const out: FsNode[] = []
  const inRawSubtree = rel === "raw"
  const inRawDir = rel.startsWith("raw/")
  for (const ent of dirents) {
    if (isExcludedName(ent.name)) continue
    // 非符号链接判定：withFileTypes 的 isDirectory/isFile 已排除 symlink（lstat 语义）——
    // 链一律不上树，防越狱。raw 子树收紧判据（纪律 1）。
    if (inRawSubtree && !isRawDir(ent.name)) continue
    if (inRawDir && (!ent.isFile() || !RAW_FILE_RE.test(ent.name))) continue
    const childRel = rel ? `${rel}/${ent.name}` : ent.name
    if (budget.nodes >= maxNodes) {
      budget.truncated = true
      break
    }
    if (ent.isDirectory()) {
      if (depth + 1 > maxDepth) {
        budget.truncated = true
        continue // 目录本身保留展示，不下探
      }
      budget.nodes++
      const children = scanDir(rootAbs, childRel, depth + 1, budget, maxDepth, maxNodes)
      out.push({ name: ent.name, path: childRel, kind: "dir", children })
    } else if (ent.isFile()) {
      budget.nodes++
      out.push({ name: ent.name, path: childRel, kind: "file" })
    }
  }
  sortNodes(out)
  return out
}

/** 列知识根目录树（根子项数组，无虚拟根节点）。根缺席 = 404 诚实显形。 */
export function listKnowledgeFsTree(root: string, caps?: { maxDepth?: number; maxNodes?: number }): FsTree {
  const maxDepth = caps?.maxDepth ?? FS_DEFAULT_MAX_DEPTH
  const maxNodes = caps?.maxNodes ?? FS_DEFAULT_MAX_NODES
  const rootAbs = path.resolve(root)
  try {
    if (!fs.statSync(rootAbs).isDirectory()) {
      throw new IngestError("NOT_FOUND", `knowledge root is not a directory: ${rootAbs}`, 404)
    }
  } catch (err) {
    if (err instanceof IngestError) throw err
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new IngestError("NOT_FOUND", `knowledge root not found: ${rootAbs}`, 404)
    }
    throw err
  }
  const budget: Budget = { nodes: 0, truncated: false }
  const tree = scanDir(rootAbs, "", 0, budget, maxDepth, maxNodes)
  return { tree, truncated: budget.truncated, total: budget.nodes }
}

/**
 * 读知识根内任意 .md（SCHEMA.md/drafts/_archive/wiki 散页共用；raw 与页文件仍走各自现通道）。
 * Windows 安全判序（设计 A10 钉死）：①含 `\` 或 `:` 直接 400；②`/` 分段每段非空非 `.`
 * 非 `..` 不 `.` 开头；③排除名（user_preference*）404 与树对称；④末段必须 .md；
 * ⑤resolve+startsWith jail（readRawSource 判例）；⑥stat：目录/缺席 404，>5MB 413。
 */
export function readKnowledgeFile(root: string, relPosix: string): { path: string; content: string; bytes: number } {
  const bad = (msg: string): never => {
    throw new IngestError("INVALID_PARAM", msg, 400)
  }
  if (relPosix.includes("\\") || relPosix.includes(":")) {
    bad(`path must use POSIX separators without drive letters: ${relPosix}`)
  }
  const segs = relPosix.split("/")
  if (segs.length === 0 || segs.some(s => s === "" || s === "." || s === ".." || s.startsWith(".") || s.includes("%"))) {
    bad(`path contains unsafe segments: ${relPosix}`)
  }
  if (segs.some(s => s.startsWith("user_preference"))) {
    throw new IngestError("NOT_FOUND", `not found (excluded from knowledge fs): ${relPosix}`, 404)
  }
  if (!segs[segs.length - 1].endsWith(".md")) {
    bad(`only .md files are readable: ${relPosix}`)
  }
  const rootAbs = path.resolve(root)
  const abs = path.resolve(rootAbs, ...segs)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    bad(`path escapes the knowledge root: ${relPosix}`)
  }
  let content: string
  try {
    const st = fs.statSync(abs)
    if (!st.isFile()) throw new IngestError("NOT_FOUND", `not a regular file: ${relPosix}`, 404)
    if (st.size > FS_MAX_FILE_BYTES) {
      throw new IngestError("FILE_TOO_LARGE", `file exceeds ${FS_MAX_FILE_BYTES} bytes: ${relPosix}`, 413)
    }
    content = fs.readFileSync(abs, "utf-8")
  } catch (err) {
    if (err instanceof IngestError) throw err
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new IngestError("NOT_FOUND", `file not found: ${relPosix}`, 404)
    }
    throw err
  }
  return { path: segs.join("/"), content, bytes: Buffer.byteLength(content, "utf-8") }
}
