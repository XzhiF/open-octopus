// packages/server/src/services/tasks/plan-changelog.ts
//
// 计划回写 · 变更记录节的文本规则（票02/03 · ADR-0026；终审自 tasks-service
// 迁出：这三件是「server 单源重建账本」的纯文本契约，与服务类无关，独立成模块
// 供两侧复用，tasks-service 只留装配）。三件契约：
//  · 节标题单源字符串 —— ADR-0026「spec 文末『变更记录』节 append 一行」逐字取词。
//  · extract —— 摘出既有文件变更记录节的**全部**内容行并按序原样保留：bullet 是
//    机器行，非 bullet 是手写字（人经 PUT /home-file 或手改补在节里的段落/备注），
//    重建后两者都必须在（票02 AC5「累积不覆盖」保护的也是人写内容，终审修复：
//    旧实现只认 `- ` 行，手写行会在下次回写被静默丢弃）。节恒在文末（server 只在
//    文末续写）；首标题行之后的**头尾空白行**是模板自产物，裁掉不带 —— 防每次
//    回写累积一个空行；节中间的空白行（段落分隔）原样保留。
//  · strip —— 剥掉请求正文自带的变更记录节（标题及其后全部行）。账本由 server
//    单源重建，防「自报历史」与盘上历史分叉；正文部分原样保留（仅收掉尾部空白）。

/** 变更记录节的固定标题 —— 机械落痕的落点，单源字符串（ADR-0026「spec 文末
 *  「变更记录」节 append 一行」逐字取词）。 */
export const PLAN_CHANGELOG_HEADING = "## 变更记录"

/** 摘出变更记录节的全部内容行（标题行之后），按序原样：bullet=机器行、其余=
 *  人写行，重建时都放回（见文件头 extract 契约；头尾空白行裁除，中间保留）。
 *  无节 → 空数组。 */
export function extractChangelogEntries(text: string): string[] {
  const lines = text.split("\n")
  const at = lines.findIndex((l) => l.trim() === PLAN_CHANGELOG_HEADING)
  if (at < 0) return []
  const section = lines.slice(at + 1)
  while (section.length > 0 && section[0].trim() === "") section.shift()
  while (section.length > 0 && section[section.length - 1].trim() === "") section.pop()
  return section
}

/** 剥掉请求正文自带的变更记录节（标题及其后全部行）—— 账本由 server 单源重建，
 *  防「自报历史」与盘上历史分叉；正文部分原样保留（仅收掉尾部空白）。 */
export function stripChangelogSection(text: string): string {
  const lines = text.split("\n")
  const at = lines.findIndex((l) => l.trim() === PLAN_CHANGELOG_HEADING)
  const body = at < 0 ? text : lines.slice(0, at).join("\n")
  return body.replace(/\s+$/, "")
}
