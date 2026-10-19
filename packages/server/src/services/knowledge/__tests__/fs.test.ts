import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { listKnowledgeFsTree, readKnowledgeFile, type FsNode } from "../fs"
import { IngestError, listRawSources } from "../raw"

/**
 * fs 只读投影面契约（知识中心左栏真实目录树改版，20261016）：
 * 排除纪律（隐藏/user_preference 防复活）、raw 子树与读面单源同口径（可见即可读）、
 * 帽与截断、Windows 路径闸判序。tmpdir 造形（raw-ingest 同制式）。
 */

let tmpDir: string

function w(rel: string, content = "x"): void {
  const abs = path.join(tmpDir, ...rel.split("/"))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

/** 树扁平化为 path→kind 映射 + 收集全部 name（断言辅助）。 */
function flatten(nodes: FsNode[], into = new Map<string, "dir" | "file">()): Map<string, "dir" | "file"> {
  for (const n of nodes) {
    into.set(n.path, n.kind)
    if (n.children) flatten(n.children, into)
  }
  return into
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-fs-"))
  // 顶层
  w("SCHEMA.md", "# schema")
  // wiki：.git 与隐藏必须被排；INDEX/LOG 与五类目录在树
  w("wiki/INDEX.md", "# INDEX")
  w("wiki/LOG.md", "- log")
  w("wiki/concepts/con-a.md", "a")
  w("wiki/_retired/concepts/old.md", "old")
  w("wiki/.git/config", "[core]")
  w("wiki/.hidden-note.md", "h")
  // raw：三白名单单层 RE 文件；越权件全不进树
  w("raw/inbox/2026-10-13-ok.md", "ok")
  w("raw/inbox/.draft.md", "hidden")
  w("raw/inbox/bad name.md", "bad")
  w("raw/inbox/nested/x.md", "nest")
  w("raw/stray.md", "stray")
  w("raw/archives/2026-01-01-a.md", "arc")
  // drafts 两层
  w("drafts/skills/s1/SKILL.md", "---\nname: s1\n---\nbody")
  // _archive：user_preference* 整棵剔；pending-review json 保留展示
  w("_archive/user_preference/keep.md", "up")
  w("_archive/user_preference.removed-20261016.md", "up2")
  w("_archive/pending-review-2026-10-14.json", "{}")
  w("_archive/org-knowledge-20261013/1.md", "org")
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("listKnowledgeFsTree — 形状与排除纪律", () => {
  it("根层：目录先行 + name 升序 + 文件随后；path 全 POSIX 无越权段", () => {
    const { tree } = listKnowledgeFsTree(tmpDir)
    expect(tree.map(n => n.name)).toEqual(["_archive", "drafts", "raw", "wiki", "SCHEMA.md"])
    for (const n of tree) expect(n.path).not.toContain("\\")
    const wiki = tree.find(n => n.name === "wiki")!
    expect(wiki.kind).toBe("dir")
    expect(wiki.children!.map(n => n.name)).toEqual(["_retired", "concepts", "INDEX.md", "LOG.md"])
  })

  it("隐藏项（. 开头，含 .git）与 user_preference* 任意层级不上树；pending-review json 保留（防过杀）", () => {
    const flat = flatten(listKnowledgeFsTree(tmpDir).tree)
    expect([...flat.keys()].some(k => k.includes(".git"))).toBe(false)
    expect([...flat.keys()].some(k => k.includes("user_preference"))).toBe(false)
    expect(flat.has("wiki/.hidden-note.md")).toBe(false)
    expect(flat.get("_archive/pending-review-2026-10-14.json")).toBe("file")
    expect(flat.get("_archive/org-knowledge-20261013/1.md")).toBe("file")
  })

  it("raw 子树与读面单源同口径：可见叶集 == listRawSources 集（三目录单层 RE 件）", () => {
    const { tree } = listKnowledgeFsTree(tmpDir)
    const fsRawLeaves = [...flatten(tree).entries()]
      .filter(([p, k]) => k === "file" && p.startsWith("raw/"))
      .map(([p]) => p)
      .sort()
    const apiRaw = listRawSources(tmpDir).map(s => s.path).sort()
    expect(fsRawLeaves).toEqual(apiRaw)
    expect(fsRawLeaves).toEqual(["raw/archives/2026-01-01-a.md", "raw/inbox/2026-10-13-ok.md"])
  })

  it("帽：maxDepth 触顶标 truncated 且目录保留不下探；maxNodes 截断显式", () => {
    w("d1/d2/d3/d4/d5/leaf.md")
    const shallow = listKnowledgeFsTree(tmpDir, { maxDepth: 2 })
    expect(shallow.truncated).toBe(true)
    const flat = flatten(shallow.tree)
    expect(flat.get("d1/d2")).toBe("dir")
    expect(flat.has("d1/d2/d3")).toBe(false)
    const capped = listKnowledgeFsTree(tmpDir, { maxNodes: 3 })
    expect(capped.truncated).toBe(true)
    expect(capped.total).toBeLessThanOrEqual(3)
  })

  it("根缺席 = 404 NOT_FOUND 诚实显形，不伪造空树", () => {
    try {
      listKnowledgeFsTree(path.join(tmpDir, "nope"))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(IngestError)
      expect((err as IngestError).status).toBe(404)
    }
  })
})

describe("readKnowledgeFile — Windows 路径闸判序（A10）", () => {
  it("SCHEMA.md/嵌套 md 正常回读，path 归一 POSIX，bytes=utf-8 长度", () => {
    const r = readKnowledgeFile(tmpDir, "SCHEMA.md")
    expect(r.content).toBe("# schema")
    expect(r.path).toBe("SCHEMA.md")
    expect(r.bytes).toBe(8)
    expect(readKnowledgeFile(tmpDir, "drafts/skills/s1/SKILL.md").content).toContain("name: s1")
  })

  const bad400: Array<[string, string]> = [
    ["反斜杠", "wiki\\INDEX.md"],
    ["盘符", "C:/x/SCHEMA.md"],
    ["段穿越", "../../etc/passwd.md"],
    ["编码残留段", "wiki/%2e%2e/x.md"],
    ["空段", "wiki//INDEX.md"],
    ["点开头段", "wiki/.git/config.md"],
    ["非 md", "_archive/pending-review-2026-10-14.json"],
  ]
  it.each(bad400)("400 INVALID_PARAM（%s）", (_label, p) => {
    try {
      readKnowledgeFile(tmpDir, p)
      expect.unreachable()
    } catch (err) {
      expect((err as IngestError).status).toBe(400)
      expect((err as IngestError).code).toBe("INVALID_PARAM")
    }
  })

  it("404 三态：缺席 / .md 名目录 / user_preference（与树可见性对称）", () => {
    w("wiki/afolder.md/inner.md") // 目录名以 .md 结尾——过扩展名闸后按「非普通文件」404
    const code404 = (p: string): IngestError => {
      try {
        readKnowledgeFile(tmpDir, p)
      } catch (err) {
        expect(err).toBeInstanceOf(IngestError)
        const e = err as IngestError
        expect(e.status).toBe(404)
        return e
      }
      throw new Error(`expected 404 for ${p}`)
    }
    expect(code404("wiki/nope.md").code).toBe("NOT_FOUND")
    expect(code404("wiki/afolder.md").code).toBe("NOT_FOUND")
    expect(code404("_archive/user_preference/keep.md").code).toBe("NOT_FOUND")
    expect(code404("_archive/user_preference.removed-20261016.md").code).toBe("NOT_FOUND")
  })

  it(">5MB 帽 = 413 FILE_TOO_LARGE（真库永不触发的防御钉）", () => {
    w("big.md", "a".repeat(5 * 1024 * 1024 + 1))
    try {
      readKnowledgeFile(tmpDir, "big.md")
      expect.unreachable()
    } catch (err) {
      expect((err as IngestError).status).toBe(413)
      expect((err as IngestError).code).toBe("FILE_TOO_LARGE")
    }
  })
})
