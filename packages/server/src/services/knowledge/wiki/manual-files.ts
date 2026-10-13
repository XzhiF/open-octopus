import path from "path"

/**
 * 人工文件写保护 — 质控⑥的服务层主闸（知识中心 spec §审批废除与写入闸门 / 故事 24，ADR-0030）。
 *
 * 目录契约（spec 三层架构）里 `user_preference.md` 与 `SCHEMA.md` 都住**知识根**、
 * 不入 wiki 仓——所以「自动通道根本不生成指向它们的页路径」在现输入语法下已是事实。
 * 但那只是**巧合级安全**：一旦新增直写通道 / 有人改 fileName 语义，防线就没了。
 * 本模块把安全从巧合升为**闸**：唯一写闸（compileEntry / compilePage / compileCase /
 * compilePages——curator 编译、回填触编译、finding 裁决修订全部经它们落盘）对这两个
 * 文件做**路径级拒绝**——目标经 `path.resolve` 归一后对拍，连 `../user_preference.md`、
 * `topics/../SCHEMA.md` 这类经 wiki 仓相对路径的旁路形态一并命中；闸先于文件名正则与
 * 逃逸检查触发（错码必须是 MANUAL_FILE_WRITE，不许退化成 INVALID_PARAM 的沉默）。
 *
 * wiki 仓 pre-commit 的同名文件 grep 分支（wiki-git.ts）是**纵深防御**（防旁路 fs 写
 * + 手滑提交），主闸在此。两层各钉各的：wiki-write-gate.test.ts。
 */

/** 人工文件基名单源（pre-commit 与文件-ops 豁免名单消费此值时用，勿各处硬拼）。 */
export const USER_PREFERENCE_FILE = "user_preference.md"
export const SCHEMA_DOC_BASENAME = "SCHEMA.md"

export const MANUAL_FILE_BASENAMES = [USER_PREFERENCE_FILE, SCHEMA_DOC_BASENAME] as const

/** 结构化错：code 进队列/任务面（extractError 读 err.code），status 供路由层。 */
export class ManualFileWriteError extends Error {
  readonly code = "MANUAL_FILE_WRITE"
  readonly status = 403
  constructor(message: string) {
    super(`MANUAL_FILE_WRITE: ${message}`)
    this.name = "ManualFileWriteError"
  }
}

/**
 * 现行布局下人工文件的合法位置（4 式）：知识根两式（目录契约本尊）+
 * wiki 根两式（旁路形态——人工文件若出现在这里本身即违规，闸拒任何通道写它）。
 */
export function manualFilePositions(wikiRoot: string): string[] {
  const positions: string[] = []
  for (const base of MANUAL_FILE_BASENAMES) {
    positions.push(path.resolve(wikiRoot, base))
    positions.push(path.resolve(wikiRoot, "..", base))
  }
  return positions
}

/**
 * 目标路径判定：`targetAbs`（调用方已 resolve 的绝对落盘目标）是否命中人工文件位。
 * Windows 盘上大小写不敏感——对拍用 lowercase（`SCHEMA.md`/`schema.md` 同拒；
 * 误伤仅限「恰以人工文件命名的页」，而五类页 id 语法本就不允许这类名）。
 */
export function isManualFileTarget(wikiRoot: string, targetAbs: string): boolean {
  const t = path.resolve(targetAbs).toLowerCase()
  return manualFilePositions(wikiRoot).some(p => p.toLowerCase() === t)
}
