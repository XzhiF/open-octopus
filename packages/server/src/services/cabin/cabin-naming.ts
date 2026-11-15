// packages/server/src/services/cabin/cabin-naming.ts
//
// 舱名（v5）：新建作战舱的「舱名」是**可选**的。名字不填时不是空着 ——
// 需求（这个舱长期干什么活）本来就是必填的，初始化开头就按它取一个：
//   关键词表 → 去掉动词前缀后前 2–4 字 + 「舱」→ 兜底「新舱」。
// 规则与新建页原型 cabin-new-v5.html 一致；纯函数、毫秒级、可测、离线，
// 以后要接模型只换 nameForRequirements 的函数体，接口与门禁都不动。
//
// 名字只是称呼，目录才是舱的身份（design/17 §4）—— 所以重名允许。

/** 建舱时没给名字 → 先用这个；init 的 runGate 会在门禁前改名。 */
export const UNNAMED_CABIN_NAME = "未命名舱"

/** 与新建页输入框的 maxlength 一致。 */
export const CABIN_NAME_MAX = 16

const KEYWORDS: Array<[string, string]> = [
  ["电商", "电商舱"], ["商城", "商城舱"], ["订单", "订单舱"], ["库存", "库存舱"],
  ["健康", "健康舱"], ["体检", "健康舱"], ["医疗", "医疗舱"],
  ["对账", "账本舱"], ["账本", "账本舱"], ["财务", "财务舱"], ["结算", "结算舱"],
  ["知识", "知识舱"], ["文档", "文档舱"], ["爬虫", "采集舱"], ["采集", "采集舱"],
  ["监控", "监控舱"], ["数据", "数据舱"],
]

/** 起头的动词/量词：剥掉之后剩下的才是「这个舱是什么」。 */
const PREFIX_RE = /^(我要|我想|帮我|想要|做一个|做个|搭一个|搭个|开发|搭建|建一?个?|一个|新的?|这个|该|舱)/

/** 需求原文 → 舱名（2–6 字，以「舱」结尾）。 */
export function nameForRequirements(requirements: string): string {
  const text = (requirements ?? "").trim()
  for (const [keyword, name] of KEYWORDS) {
    if (text.includes(keyword)) return name
  }
  let stem = text.replace(/[，。；、,.!?！？\s]/g, "")
  let prev = ""
  while (stem !== prev) {
    prev = stem
    stem = stem.replace(PREFIX_RE, "")
  }
  return `${(stem.slice(0, 4) || "新")}舱`.slice(0, CABIN_NAME_MAX)
}