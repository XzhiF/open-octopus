// 工作目录（cwd）路径策略 —— 跨平台。
//
// 旧规则：目录必须在用户 home 下。但项目经常放在别的盘（如 C:\MiYuan\ai\kpi-10），
// 所以改为「只要不是系统敏感目录都可以选」：
//   - Windows: 盘根、Windows / Program Files / ProgramData / $Recycle.Bin 等；
//   - macOS:   /、/System、/Library、/usr、/bin、/etc、/private、/var …
//   - Linux:   /、/etc、/usr、/bin、/lib、/boot、/proc、/sys、/dev、/run、/var、/root …
//   - 任何平台都额外挡住 home 下的凭据/平台数据目录（.ssh / .gnupg / .aws / .octopus …）。
//
// 判定基于 realpath：符号链接指向敏感目录同样会被挡住。
// 根目录允许「浏览」（用来往下走），但不允许直接选作 cwd。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type PathPolicyCode =
  | 'PATH_BLOCKED'
  | 'PATH_NOT_FOUND'
  | 'PATH_NOT_DIRECTORY'
  | 'PATH_UNREADABLE'
  | 'PATH_EXISTS'
  | 'PATH_INVALID_NAME'

export class PathPolicyError extends Error {
  readonly code: PathPolicyCode

  constructor(code: PathPolicyCode, message: string) {
    super(message)
    this.name = 'PathPolicyError'
    this.code = code
  }
}

/** Windows/macOS 默认大小写不敏感；Linux 区分大小写。 */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

const DARWIN_BLOCKED = [
  '/System',
  '/Library',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/private',
  '/var',
  '/dev',
  '/cores',
  '/opt',
]

const LINUX_BLOCKED = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/boot',
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/var',
  '/root',
  '/lost+found',
  '/snap',
]

/** 盘根下一级里不能作为工作目录的名字（Windows，大小写不敏感）。 */
const WINDOWS_BLOCKED_TOP = new Set([
  'windows',
  'windows.old',
  'program files',
  'program files (x86)',
  'programdata',
  'system volume information',
  '$recycle.bin',
  'recovery',
  'boot',
  'efi',
  'perflogs',
  'config.msi',
  'msocache',
])

/** home 下永久排除的凭据 / 平台数据目录（任何操作系统）。 */
const HOME_BLOCKED = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.password-store',
  '.octopus',
]

function fold(value: string): string {
  return CASE_INSENSITIVE ? value.toLowerCase() : value
}

function expandHome(input: string): string {
  return input.replace(/^~(?=$|[\\/])/, os.homedir())
}

/** 绝对路径去掉末尾分隔符（根路径保留）。 */
function normalize(value: string): string {
  const resolved = path.resolve(value)
  const root = path.parse(resolved).root
  return resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved
}

/** `target` 是否等于 `base` 或位于其下。 */
function within(target: string, base: string): boolean {
  const t = fold(normalize(target))
  const b = fold(normalize(base))
  return t === b || t.startsWith(b + path.sep)
}

/** 盘根下的第一级名字（`C:\Windows\...` → `Windows`）。 */
function topSegment(resolved: string): string {
  const root = path.parse(resolved).root
  return resolved.slice(root.length).split(path.sep)[0] ?? ''
}

function isRoot(resolved: string): boolean {
  return fold(normalize(resolved)) === fold(normalize(path.parse(resolved).root))
}

/**
 * 系统敏感目录判定。根目录也算敏感（可浏览、不可选）。
 * 传入的应当是绝对路径（最好已 realpath）。
 */
export function isSensitivePath(input: string): boolean {
  const resolved = normalize(input)
  if (isRoot(resolved)) return true

  if (process.platform === 'win32') {
    if (WINDOWS_BLOCKED_TOP.has(topSegment(resolved).toLowerCase())) return true
    for (const envPath of [
      process.env.SystemRoot,
      process.env.windir,
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.ProgramData,
    ]) {
      if (envPath && within(resolved, envPath)) return true
    }
  } else if (process.platform === 'darwin') {
    for (const blocked of DARWIN_BLOCKED) {
      if (within(resolved, blocked)) return true
    }
  } else {
    for (const blocked of LINUX_BLOCKED) {
      if (within(resolved, blocked)) return true
    }
  }

  for (const name of HOME_BLOCKED) {
    if (within(resolved, path.join(os.homedir(), name))) return true
  }

  return false
}

/** 根目录允许浏览（用来往下走）；其余目录按敏感表判定。 */
function isBrowsable(resolved: string): boolean {
  if (isRoot(resolved)) return true
  return !isSensitivePath(resolved)
}

function statDirectory(resolved: string): fs.Stats {
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new PathPolicyError('PATH_NOT_FOUND', `目录不存在: ${resolved}`)
  }
  if (!stat.isDirectory()) {
    throw new PathPolicyError('PATH_NOT_DIRECTORY', `不是目录: ${resolved}`)
  }
  return stat
}

function realpath(resolved: string): string {
  try {
    return fs.realpathSync(resolved)
  } catch {
    throw new PathPolicyError('PATH_UNREADABLE', `无法读取目录: ${resolved}`)
  }
}

/**
 * 校验并返回可注册为 cwd 的真实目录路径。
 * 不存在 / 不是目录 / 系统敏感目录都会抛 PathPolicyError。
 */
export function resolveSelectableDirectory(input: string): string {
  const resolved = normalize(expandHome(input.trim()))
  statDirectory(resolved)
  const real = realpath(resolved)
  if (isSensitivePath(real)) {
    throw new PathPolicyError('PATH_BLOCKED', `系统敏感目录不能作为工作目录: ${real}`)
  }
  return real
}

/** Windows 保留设备名（不区分大小写，带扩展名也算：`CON.txt`）。 */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/** 新文件夹只允许单段名字：不带路径分隔符、不是 . / ..、不越过父目录。 */
function assertFolderName(raw: string): string {
  const name = raw.trim()
  const invalid = (why: string): never => {
    throw new PathPolicyError('PATH_INVALID_NAME', `文件夹名不可用（${why}）: ${raw}`)
  }
  if (!name) invalid('空名字')
  if (name === '.' || name === '..') invalid('不能是 . 或 ..')
  if (Buffer.byteLength(name) > 255) invalid('名字过长')
  if (/[\\/\0]/.test(name)) invalid('不能包含路径分隔符')
  if (process.platform === 'win32') {
    if (/[<>:"|?*]/.test(name)) invalid('不能包含 < > : " | ? *')
    if (/[. ]$/.test(name)) invalid('不能以点或空格结尾')
    if (WINDOWS_RESERVED.has(name.split('.')[0]!.toLowerCase())) invalid('系统保留名')
  }
  return name
}

export interface CreateDirectoryResult {
  path: string
  /** 新建后的目录列表 DTO —— 前端可以直接落到新目录，不用再请求一次。 */
  browse: BrowseResult
}

/**
 * 在可浏览的父目录下新建一个文件夹（目录浏览器 / 工作空间选择用）。
 * 父目录必须存在且可浏览；系统敏感目录、重名、非法名字都会被拒绝。
 */
export function createDirectory(parentInput: string, rawName: string): CreateDirectoryResult {
  const requested = expandHome(parentInput.trim())
  const resolvedParent = normalize(requested)
  statDirectory(resolvedParent)
  const realParent = realpath(resolvedParent)
  if (!isBrowsable(realParent)) {
    throw new PathPolicyError('PATH_BLOCKED', `系统敏感目录不能新建文件夹: ${realParent}`)
  }

  const name = assertFolderName(rawName)
  const target = path.join(realParent, name)
  if (isSensitivePath(target)) {
    throw new PathPolicyError('PATH_BLOCKED', `系统敏感目录不能新建文件夹: ${target}`)
  }
  try {
    fs.mkdirSync(target)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new PathPolicyError('PATH_EXISTS', `同名文件或文件夹已存在: ${name}`)
    }
    throw new PathPolicyError('PATH_UNREADABLE', `创建文件夹失败: ${name}`)
  }

  return { path: fs.realpathSync(target), browse: browseDirectory(target) }
}

export interface BrowseRoot {
  name: string
  path: string
}

export interface BrowseEntry {
  name: string
  path: string
}

export interface BrowseResult {
  path: string
  parent: string | null
  home: string
  roots: BrowseRoot[]
  dirs: BrowseEntry[]
  /** 当前目录能否直接选作 cwd（盘根/根目录为 false）。 */
  canSelect: boolean
}

/** 列出可用的文件系统根（Windows 盘符 / POSIX 根）。 */
export function listRoots(): BrowseRoot[] {
  if (process.platform !== 'win32') return [{ name: '/', path: '/' }]
  const roots: BrowseRoot[] = []
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`
    try {
      if (fs.existsSync(drive)) roots.push({ name: drive, path: drive })
    } catch {
      // 无权限/断开的网络盘：跳过。
    }
  }
  return roots
}

/**
 * 目录浏览器数据源。缺省从用户 home 开始。
 * 只返回可选择的子目录（敏感目录与指向敏感目录的软链被过滤）。
 */
export function browseDirectory(input?: string): BrowseResult {
  const requested = input?.trim() ? expandHome(input.trim()) : os.homedir()
  const resolved = normalize(requested)
  statDirectory(resolved)
  const real = realpath(resolved)

  if (!isBrowsable(real)) {
    throw new PathPolicyError('PATH_BLOCKED', `系统敏感目录不能浏览: ${real}`)
  }

  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(real, { withFileTypes: true })
  } catch {
    throw new PathPolicyError('PATH_UNREADABLE', `无法读取目录: ${real}`)
  }

  const dirs: BrowseEntry[] = []
  for (const entry of entries) {
    const child = path.join(real, entry.name)
    let childReal: string
    try {
      // 软链按目标判定：指向敏感目录的链接直接隐藏。
      childReal = fs.realpathSync(child)
      if (!fs.statSync(childReal).isDirectory()) continue
    } catch {
      continue
    }
    if (isSensitivePath(childReal)) continue
    dirs.push({ name: entry.name, path: childReal })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))

  const parentPath = path.dirname(real)
  const parent = fold(normalize(parentPath)) === fold(normalize(real)) ? null : parentPath

  return {
    path: real,
    parent,
    home: os.homedir(),
    roots: listRoots(),
    dirs,
    canSelect: !isSensitivePath(real),
  }
}
