import * as Y from "yjs"
import fs from "fs"
import path from "path"
import os from "os"
import { watch, FSWatcher } from "chokidar"
import { BINARY_EXTENSIONS } from "./file-service"

const watchers = new Map<string, FSWatcher>()

function createBatchHandler(
  ms: number,
  handler: (paths: string[]) => void
): (filePath: string) => void {
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  return (filePath: string) => {
    pending.add(filePath)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const paths = Array.from(pending)
      pending.clear()
      timer = null
      if (paths.length > 0) handler(paths)
    }, ms)
  }
}

export function getNestedYMap(root: Y.Map<unknown>, segments: string[]): Y.Map<unknown> {
  let current = root
  for (const seg of segments) {
    if (!current.has(seg)) {
      current.set(seg, new Y.Map())
    }
    current = current.get(seg) as Y.Map<unknown>
  }
  return current
}

const MAX_FILE_SIZE = 512 * 1024 // 512KB — skip large files from YDoc

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".nuxt", ".output", ".cache",
  "dist", "build", "coverage", "__pycache__", "vendor",
  "bower_components", "target", ".worktrees",
])

export function populateFromDisk(dirPath: string, tree: Y.Map<unknown>): void {
  tree.clear()
  if (!fs.existsSync(dirPath)) return

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  const dirs: fs.Dirent[] = []
  const files: fs.Dirent[] = []

  for (const entry of entries) {
    // Skip dot dirs except .claude/.octopus/.scratch (but skip their large content later)
    if (entry.name.startsWith(".") && entry.name !== ".claude" && entry.name !== ".octopus" && entry.name !== ".scratch") continue
    // Skip known heavy directories entirely
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    if (entry.isDirectory()) dirs.push(entry)
    else files.push(entry)
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.name.localeCompare(b.name))

  for (const dir of dirs) {
    const childMap = new Y.Map()
    tree.set(dir.name, childMap)
    populateFromDisk(path.join(dirPath, dir.name), childMap)
  }

  for (const file of files) {
    const fullPath = path.join(dirPath, file.name)
    const stat = fs.statSync(fullPath)
    const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : undefined
    const meta = new Y.Map()
    const isBinary = ext ? BINARY_EXTENSIONS.has(ext) : false
    if (!isBinary && stat.size <= MAX_FILE_SIZE) {
      const ytext = new Y.Text()
      try {
        const content = fs.readFileSync(fullPath, "utf-8")
        ytext.insert(0, content)
      } catch {
        // truly unreadable file — skip content
      }
      meta.set("content", ytext)
    }
    meta.set("size", stat.size)
    if (ext) meta.set("extension", ext)
    tree.set(file.name, meta)
  }
}

export function startWatch(workspaceId: string, workspacePath: string, doc: Y.Doc): void {
  if (watchers.has(workspaceId)) return

  const tree = doc.getMap("fileTree")

  const handleAdd = createBatchHandler(50, (paths: string[]) => {
    doc.transact(() => {
      for (const filePath of paths) {
        const rel = path.relative(workspacePath, filePath)
        if (!rel) continue
        const segs = rel.split(path.sep)
        // Skip if any path segment is in SKIP_DIRS
        if (segs.some(s => SKIP_DIRS.has(s))) continue
        const baseName = segs[segs.length - 1]
        const stat = safeStat(filePath)
        if (!stat) continue

        const parentMap = createDirPath(tree, segs.slice(0, -1))
        if (parentMap.has(baseName)) continue

        if (stat.isDirectory()) {
          const childMap = new Y.Map()
          parentMap.set(baseName, childMap)
          populateFromDisk(filePath, childMap)
        } else {
          const ext = baseName.includes(".") ? baseName.split(".").pop()!.toLowerCase() : undefined
          const isBinary = ext ? BINARY_EXTENSIONS.has(ext) : false
          const meta = new Y.Map()
          if (!isBinary && stat.size <= MAX_FILE_SIZE) {
            const ytext = new Y.Text()
            try {
              const content = fs.readFileSync(filePath, "utf-8")
              ytext.insert(0, content)
            } catch {
              // truly unreadable file — skip content
            }
            meta.set("content", ytext)
          }
          meta.set("size", stat.size)
          if (ext) meta.set("extension", ext)
          parentMap.set(baseName, meta)
        }
      }
    })
  })

  const handleChange = (filePath: string) => {
    const rel = path.relative(workspacePath, filePath)
    const segs = rel.split(path.sep)
    if (segs.some(s => SKIP_DIRS.has(s))) return
    const dirSegs = segs.slice(0, -1)
    const baseName = segs[segs.length - 1]
    const ext = baseName.includes(".") ? baseName.split(".").pop()!.toLowerCase() : undefined
    const isBinary = ext ? BINARY_EXTENSIONS.has(ext) : false
    const parentMap = dirSegs.length > 0 ? findNestedMap(tree, dirSegs) : tree
    const stat = safeStat(filePath)
    if (!stat) return
    if (parentMap && parentMap.has(baseName)) {
      const node = parentMap.get(baseName) as Y.Map<unknown>
      node.set("size", stat.size)
      // Skip content updates for binary files
      if (isBinary) return
      const ytext = node.get("content") as Y.Text
      if (ytext instanceof Y.Text && stat.size <= MAX_FILE_SIZE) {
        try {
          const content = fs.readFileSync(filePath, "utf-8")
          if (ytext.toString() === content) return
          doc.transact(() => {
            ytext.delete(0, ytext.length)
            ytext.insert(0, content)
          })
        } catch {
          // truly unreadable file — remove content from YDoc
          doc.transact(() => {
            if (node.get("content")) node.delete("content")
          })
        }
      } else if (stat.size > MAX_FILE_SIZE && ytext instanceof Y.Text) {
        // File grew too large — remove content from YDoc
        doc.transact(() => {
          ytext.delete(0, ytext.length)
          node.delete("content")
        })
      }
    } else {
      handleAdd(filePath)
    }
  }

  const handleRemove = createBatchHandler(100, (paths: string[]) => {
    doc.transact(() => {
      for (const filePath of paths) {
        const rel = path.relative(workspacePath, filePath)
        if (!rel) continue
        const segs = rel.split(path.sep)
        const baseName = segs[segs.length - 1]
        const parentMap = segs.length > 1 ? findNestedMap(tree, segs.slice(0, -1)) : tree
        if (parentMap) {
          parentMap.delete(baseName)
        }
      }
    })
  })

  const watcher = watch(workspacePath, {
    ignored: /(^|[\/\\])(\.(?!claude|octopus)|node_modules|target|dist|build|\.next|\.nuxt|\.output|\.cache|coverage|__pycache__|vendor|bower_components|\.worktrees)|\.(class|jar|war|ear|o|so|dll|exe|pyc|rbc|beam|node|wasm)$/,
    persistent: true,
    ignoreInitial: true,
    depth: 22,
  })

  watcher.on("add", handleAdd)
  watcher.on("change", handleChange)
  watcher.on("unlink", handleRemove)
  watcher.on("addDir", handleAdd)
  watcher.on("unlinkDir", handleRemove)

  watchers.set(workspaceId, watcher)
}

function findNestedMap(root: Y.Map<unknown>, segs: string[]): Y.Map<unknown> | null {
  let current = root
  for (const seg of segs) {
    const next = current.get(seg)
    if (!next || !(next instanceof Y.Map)) return null
    current = next as Y.Map<unknown>
  }
  return current
}

function createDirPath(root: Y.Map<unknown>, segs: string[]): Y.Map<unknown> {
  let current = root
  for (const seg of segs) {
    let next = current.get(seg)
    if (!next || !(next instanceof Y.Map)) {
      next = new Y.Map()
      current.set(seg, next)
    }
    current = next as Y.Map<unknown>
  }
  return current
}

function safeStat(filePath: string): fs.Stats | null {
  try { return fs.statSync(filePath) } catch { return null }
}

export async function initWorkspace(workspaceId: string, workspaceDbPath: string): Promise<Y.Doc> {
  const { getOrCreateYDoc } = await import("../routes/yjs-ws")
  const doc = getOrCreateYDoc(`workspace:${workspaceId}`)
  const resolvedPath = workspaceDbPath.replace(/^~/, os.homedir())
  startWatch(workspaceId, resolvedPath, doc)
  return doc as Y.Doc
}

export function closeWorkspace(workspaceId: string): void {
  const watcher = watchers.get(workspaceId)
  if (watcher) {
    watcher.close()
    watchers.delete(workspaceId)
  }
}