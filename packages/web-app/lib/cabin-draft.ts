// packages/web-app/lib/cabin-draft.ts
//
// 新建作战舱 v4 的草稿模型 + 取名逻辑（design/17 · plan §5/§8）。
//
// 草稿是壳级状态（cabin-mode），不是这一页的状态：走开（点别的舱/任务）只关
// 右页、草稿留着；`×` 才丢。落 localStorage，24h 过期 —— 跟 pendingTask 一样
// 「有默认名字、随时可以取消」的负担感。
//
// 取名 v1 不用 LLM：关键词表 → 确定性、零延迟、可测，接口位留给 async 版本。

/** 项目关联：ORG（org+repo）/ 舱内本地（localPath）/ 舱外（absolutePath+external）。
 *  老草稿只有 {org, repo} —— source 缺省按 org 读，保持兼容。 */
export interface CabinProjectRef {
  source?: 'org' | 'local'
  org?: string
  repo: string
  /** 舱内相对路径（source=local）。 */
  localPath?: string
  /** 舱外绝对路径（显式登记）。 */
  absolutePath?: string
  external?: boolean
}

export interface CabinDraft {
  /** 她算出来的舱名；空 = 还没提过案（左栏显示「未命名舱」）。 */
  name: string
  /** null = 新建工作空间（服务端在第一次创建时生成）。 */
  path: string | null
  projects: CabinProjectRef[]
  /** 大输入框原文 —— 唯一必填。 */
  requirements: string
  updatedAt: number
}

export const CABIN_DRAFT_KEY = 'octopus.cabinDraft.v1'
export const CABIN_DRAFT_TTL = 24 * 60 * 60 * 1000
export const CABIN_DIR_RECENT_KEY = 'octopus.cabinDirRecent.v1'
export const CABIN_DIR_PROJECTS_KEY = 'octopus.cabinDirProjects.v1'
export const CABIN_NAME_MAX = 16

export function emptyCabinDraft(): CabinDraft {
  return { name: '', path: null, projects: [], requirements: '', updatedAt: 0 }
}

export function draftDisplayName(draft: CabinDraft | null): string {
  return draft?.name?.trim() || '未命名舱'
}

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** 读草稿；超过 24h 视为过期（plan §5.1）。 */
export function readCabinDraft(now = Date.now()): CabinDraft | null {
  const storage = safeStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(CABIN_DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CabinDraft>
    const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
    if (!updatedAt || now - updatedAt > CABIN_DRAFT_TTL) {
      storage.removeItem(CABIN_DRAFT_KEY)
      return null
    }
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      path: typeof parsed.path === 'string' && parsed.path ? parsed.path : null,
      projects: Array.isArray(parsed.projects)
        ? parsed.projects.filter((p): p is CabinProjectRef =>
            !!p && typeof p === 'object'
            && typeof (p as CabinProjectRef).repo === 'string'
            && (typeof (p as CabinProjectRef).org === 'string'
              || typeof (p as CabinProjectRef).localPath === 'string'
              || typeof (p as CabinProjectRef).absolutePath === 'string'))
        : [],
      requirements: typeof parsed.requirements === 'string' ? parsed.requirements : '',
      updatedAt,
    }
  } catch {
    return null
  }
}

export function writeCabinDraft(draft: CabinDraft | null): void {
  const storage = safeStorage()
  if (!storage) return
  try {
    if (!draft) storage.removeItem(CABIN_DRAFT_KEY)
    else storage.setItem(CABIN_DRAFT_KEY, JSON.stringify(draft))
  } catch {
    /* storage unavailable → 只活在本会话 */
  }
}

// ── 最近用过的目录 / 目录 → 项目回显（本地记忆，plan §6.2） ──────────────

export interface RecentCabinDir {
  path: string
  at: number
}

export function readRecentCabinDirs(): RecentCabinDir[] {
  const storage = safeStorage()
  if (!storage) return []
  try {
    const parsed = JSON.parse(storage.getItem(CABIN_DIR_RECENT_KEY) ?? '[]') as RecentCabinDir[]
    return Array.isArray(parsed)
      ? parsed.filter((d) => d && typeof d.path === 'string').sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 4)
      : []
  } catch {
    return []
  }
}

export function rememberCabinDir(path: string): void {
  if (!path) return
  const storage = safeStorage()
  if (!storage) return
  try {
    const next = [{ path, at: Date.now() }, ...readRecentCabinDirs().filter((d) => d.path !== path)].slice(0, 4)
    storage.setItem(CABIN_DIR_RECENT_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

type DirProjectMap = Record<string, CabinProjectRef[]>

function readDirProjects(): DirProjectMap {
  const storage = safeStorage()
  if (!storage) return {}
  try {
    const parsed = JSON.parse(storage.getItem(CABIN_DIR_PROJECTS_KEY) ?? '{}') as DirProjectMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 目录原来绑过项目 → 打开时回显（「如果这个目录是之前已经有的话，绑定项目也会回显」）。 */
export function echoProjectsForDir(path: string | null): CabinProjectRef[] {
  if (!path) return []
  return readDirProjects()[path] ?? []
}

export function rememberDirProjects(path: string | null, projects: CabinProjectRef[]): void {
  if (!path) return
  const storage = safeStorage()
  if (!storage) return
  try {
    const map = readDirProjects()
    map[path] = projects
    storage.setItem(CABIN_DIR_PROJECTS_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

// 取名：v5 起由服务端做（init 开头按需求取，见 server cabin-naming.ts）。
// 前端只保留长度上限给输入框用。

/** 与 server `projectKey()` 同构：org:<org>/<name> · local:<path>。 */
export function projectKey(p: CabinProjectRef): string {
  if (p.source === 'local') return `local:${p.localPath ?? p.absolutePath ?? p.repo}`
  return `org:${p.org ?? ''}/${p.repo}`
}