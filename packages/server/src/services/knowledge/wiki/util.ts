/**
 * wiki 模块共享小工具（评审去重，Standards-HARD #1 单一来源）：
 * 散落 compile/curate/split/distill/migrate 的同体 today() 与 curate/split 的
 * 同体 escapeRe() 收口于此。行为逐字保持（ISO 日期 + regex 元字符转义）。
 */

/** 今日日期（YYYY-MM-DD，UTC ISO 切片——LOG/last_compiled 口径）。 */
export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 转义正则元字符（H2 小节标题 / wikilink 路径入 RegExp 前必过）。 */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
