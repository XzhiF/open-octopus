/**
 * 页键 stem 归一两式单源（aa-fix 项②2：实效账目页键 stem 三份手写制式合一）。
 *
 * 消费面（行为零变声明）：
 * - `stripMdSuffix` —— patrol.ts buildResolver 的全路径键（entities/ent-a.md→entities/ent-a）。
 * - `pageLedgerStem` —— effectiveness-ledger.ts normalizeRefEntry 的页键形态、
 *   wiki/auto-retire.ts toNarrowGatePage 的 pageLedgerKey。
 * 旧三份的 `.md` 剥除一处大小写不敏感（ledger/auto-retire）、一处大小写敏感（patrol）：
 * 扫描面文件名恒小写 `.md`（scanWikiEntries 目录面 endsWith(".md") 闸），两态对实际输入面
 * 逐字等价；`pageLedgerStem` 的 trim/反斜杠切分继承 ledger 原式（账目 token 可含路径/空白，
 * 必须宽容），对 auto-retire 的 relPath（无空白无 `\`）为恒等。
 */

/** 剥 `.md` 尾缀（大小写不敏感）；非 .md 结尾逐字原样。 */
export function stripMdSuffix(text: string): string {
  return text.replace(/\.md$/i, "")
}

/** 实效账目页键：路径/token → 末段（POSIX/反斜杠通吃）去 .md 再 trim。 */
export function pageLedgerStem(pathOrToken: string): string {
  return stripMdSuffix((pathOrToken.split(/[\\/]/).pop() ?? "")).trim()
}
