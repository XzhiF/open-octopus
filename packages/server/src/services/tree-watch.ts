// 只读目录树的增量刷新（2026-11-24 目录窗优化）：
//   GET /api/cabins/:id(/repos/:name)/tree?watch=1 → touchTreeWatch(root, notify)。
//   chokidar 监听该根，文件增删（结构变化）debounce 250ms 后：
//     · invalidateTreeCache(root) —— 下一次 GET 重扫；
//     · notify(dirs) —— 路由在 cabin:<id> SSE 频道推 tree_changed，前端静默重拉
//       （不重置展开 / 选中 / 标签页）。
//
// 生命周期：每次 GET 续租 IDLE_MS；窗口关掉后没人续租，watcher 自己退场，
// 长期跑着的 server 不会积一堆目录句柄。idle timer unref —— 不拖住进程退出。

import path from "path"
import { watch, type FSWatcher } from "chokidar"
import { TREE_MAX_DEPTH, TREE_SKIP_DIRS, invalidateTreeCache } from "./local-tree"

const IDLE_MS = 120_000
const DEBOUNCE_MS = 250
const MAX_WATCHERS = 16

interface WatchEntry {
  root: string
  watcher: FSWatcher
  idle: NodeJS.Timeout
  notify: (dirs: string[]) => void
}

const entries = new Map<string, WatchEntry>()

function normRoot(root: string): string {
  const resolved = path.resolve(root)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** 重目录不监听（与扫描的 skip 同口径），正则同时匹配 POSIX / Windows 分隔符。 */
const SKIP_RE = new RegExp(
  `(^|[\\\\/])(?:${[...TREE_SKIP_DIRS].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})([\\\\/]|$)`,
)

function armIdle(key: string, entry: WatchEntry): void {
  clearTimeout(entry.idle)
  entry.idle = setTimeout(() => closeTreeWatchByKey(key), IDLE_MS)
  entry.idle.unref?.()
}

/** 变更路径 → 所属目录（根的相对 posix；根自己 = ""）。 */
function changedDir(root: string, filePath: string): string {
  const relDir = path.dirname(path.relative(root, filePath))
  if (relDir === "." || relDir === "") return ""
  return relDir.split(path.sep).join("/")
}

/**
 * 开始（或续租）对 root 的监听。notify 每次调用都会替换为最新闭包。
 * 同一根同时只开一个 watcher，多个界面/请求共享。
 */
export function touchTreeWatch(rootAbs: string, notify: (dirs: string[]) => void): void {
  const root = path.resolve(rootAbs)
  const key = normRoot(root)
  const existing = entries.get(key)
  if (existing) {
    existing.notify = notify
    armIdle(key, existing)
    return
  }

  const pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  const entry: WatchEntry = {
    root,
    watcher: null as unknown as FSWatcher,
    idle: undefined as unknown as NodeJS.Timeout,
    notify,
  }

  const onEvent = (filePath: string) => {
    pending.add(changedDir(root, filePath))
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const dirs = [...pending]
      pending.clear()
      invalidateTreeCache(root)
      entry.notify(dirs)
    }, DEBOUNCE_MS)
    timer.unref?.()
  }

  const watcher = watch(root, {
    ignoreInitial: true,
    ignorePermissionErrors: true,
    persistent: true,
    // 只关心结构变化（新增 / 删除 / 重命名）；内容修改不改变树。
    depth: TREE_MAX_DEPTH + 2,
    ignored: SKIP_RE,
  })
  watcher.on("add", onEvent)
  watcher.on("unlink", onEvent)
  watcher.on("addDir", onEvent)
  watcher.on("unlinkDir", onEvent)
  entry.watcher = watcher

  entries.set(key, entry)
  armIdle(key, entry)
  evictOverflow(key)
}

function evictOverflow(keepKey: string): void {
  if (entries.size <= MAX_WATCHERS) return
  for (const key of [...entries.keys()]) {
    if (entries.size <= MAX_WATCHERS) return
    if (key !== keepKey) closeTreeWatchByKey(key)
  }
}

function closeTreeWatchByKey(key: string): void {
  const entry = entries.get(key)
  if (!entry) return
  entries.delete(key)
  clearTimeout(entry.idle)
  void entry.watcher.close()
}

export function closeTreeWatch(rootAbs: string): void {
  closeTreeWatchByKey(normRoot(rootAbs))
}

/** 测试 / 进程收尾：关掉全部 watcher。 */
export function closeAllTreeWatches(): void {
  for (const key of [...entries.keys()]) closeTreeWatchByKey(key)
}

/** 诊断用：当前活着的 watcher 根。 */
export function activeTreeWatches(): string[] {
  return [...entries.values()].map((entry) => entry.root)
}
