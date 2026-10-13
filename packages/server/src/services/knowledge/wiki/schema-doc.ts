import fs from "fs"
import path from "path"

/**
 * SCHEMA.md 首版（知识中心票05，spec §三层架构「层 3 约定文档」）—
 * 模板单源 + 幂等 seed 进全局知识根。
 *
 * 内容 = octo-wiki-curate skill（core-pack/clones/archive/skills）的编译纪律/页格式约定/
 * 命名法/工作流 四块提炼入册（票05 AC4：curate skill 瘦身为「指向 SCHEMA + 编译 API 用法」，
 * 纪律正文的家从 skill 文本搬到本文件——人机共演，策展人每次编译前必读）。
 *
 * seed 纪律：只在缺席时写入（`SCHEMA.md` 是人工确认制文件——owner/策展人提议改动都经人落笔，
 * 自动通道永不覆盖既有内容，对齐 user_preference.md 写保护）。
 */

export const SCHEMA_DOC_FILE = "SCHEMA.md"

export const SCHEMA_MD_TEMPLATE = `# SCHEMA.md — wiki 共演约定（层 3 · 人工确认制）

> 本文件是策展人（archive 分身）每次编译前的**必读约定**：结构 / 页格式 / 命名法 /
> 编译纪律 / 工作流。它由人与策展人共同演化——策展人只能**提议**修改（写保护卡），
> 落笔永远由人。**自动通道永不改写本文件与 user_preference.md。**

## 三层契约

- \`raw/\`（层 1）：不可变源。写=人或系统投递（投喂/归档），读=策展人（编译时全文读）。
  落盘即冻结（front-matter 记 hash），编译可重跑、矛盾可对质。
- \`wiki/\`（层 2）：编译产物页网络。**写=唯一写闸（编译服务，一次编译一个 git commit）**，
  读=所有人/分身。人改它 = 对话驱动策展人，不动手改文件。
- \`SCHEMA.md\`（层 3）：本约定文档。

## 页格式约定（v3 五类页）

front-matter 以 \`type\`（entity/concept/topic/source/case）取代 \`domain\`；
\`stability/confidence/sources/last_compiled\` 保留；\`links\` 为 [[wikilink]] 目标数组，
编译期断链校验（目标不存在 ⇒ 拒写）。各类页的收载与格式：

| 目录 | 收什么 | 格式要点 |
|---|---|---|
| entities/ | 项目/服务/工具/org/人（有身份的名词） | 概述 + 关键属性 + 关系（[[链接]]）+ 来源注记；带 aliases/entity_kind |
| concepts/ | 领域概念/术语/方法论 | 定义 + 展开 + 相邻概念辨析 + 来源注记 |
| topics/ | SOP/工作流知识/操作纪律/how-to | 步骤 + **「硬约束」小节**（祈使句规则行承锚点）+ 已知陷阱→判例指针 |
| sources/ | 每 raw 源一页（编译回执） | 要点清单 + 触及页清单 + 回指 raw 路径与 sha256（溯源链闭环） |
| cases/ | 判例（P0 形态保留） | symptom/tags/severity/occurrences/rule_ref + 五段正文；append-only，真实+可定位即准入 |

正文纪律：**常青正文零日期**（日期由 front-matter sources / LOG.md / git history 三处承接；
sources 页为编译回执，允许引用带日期的 raw 路径与文件名）；禁 >20 行长代码块（长内容指回源指针）；
单页容量闸 ≤120 行 / ~2000 token，超限拆分（对话内自纠，拆分建议随编译失败返回）。

## 命名法

- 页 id：kebab-case，前缀 \`ent-\` / \`con-\` / \`top-\` / \`src-\` / \`case-\`；文件名默认 \`{id}.md\`。
- raw 文件：\`raw/{inbox,archives,research}/{日期}-{slug}.md\`。
- 规则锚点 \`<!--#oct-NNN-->\`：**只存在于 topic 页「硬约束」小节**；全库唯一、永不复用；
  发号=全库 max+1（串行编译下天然无竞态）；拆分/退役/更新不改变存活规则的锚点
  （wiki_refs 引用不断链）。锚点由编译服务发号，LLM 不自主编号。
- INDEX.md 按 必读/Entities/Concepts/Topics/Sources/Cases/Optional 分组，程序化重建，
  **永不经 LLM/人手写**，预算 ≤800 token（低频页溢出移 ## Optional）。
- LOG.md 行格式 \`## [date] ingest|compile|query|lint|revert | title\` + 续行 \`→ 结果\`，
  append-only、grep 前缀友好。

## 编译纪律（唯一写闸 — 写入单一闸门）

1. **唯一写入口**：wiki 一切落盘只走编译服务（单页 compileEntry / 多页 compilePages），
   内建 lint L1/L3/L4/L5 闸。**不存在手写旁路，也不许造一个。**
2. **一次编译 = 一个 git commit**：新建/更新 N 页 + sources 摘要页 + INDEX 重建 + LOG
   一行 + FTS/DB 同步，全在同一原子事务内——任一步失败 ⇒ 快照补偿回滚，零半成品。
3. **矛盾不静默覆盖**：新源与旧断言冲突 ⇒ 两页内矛盾标记（「## 矛盾（待裁决）」节 +
   finding 指针），旧断言保留原位；产出 finding 报对话，裁决权在人（采纳/忽略/讨论）。
4. **溯源闭环**：每页 front-matter \`sources\` 回指 raw 路径；sources 页回指 raw 路径与
   sha256——回指必须是可解析断言（路径+hash 逐字在页，对质时可机械校验）。
5. **pre-commit 写权闸**：wiki 仓提交须带来源标记（curate=服务通道 / manual=人工）；
   自动通道触及 user_preference.md / SCHEMA.md 的提交被 hook 拒绝。
6. **幂等**：同 raw（同 hash）重编译产物逐字节相同 ⇒ 空 diff、不产生新 commit。

## 工作流（审批废除后的质控六道）

- **投喂即编译**：owner 对话投喂（URL/粘贴/文件）或任务归档自动落 raw → 异步编译任务
  （排队中→编译中→已提交/失败）→ diff 卡回报（触及页明细/冲突数/新页数/commit hash）。
  输入即审批——人管输入与方向，LLM 管全部 bookkeeping。
- **先看后纠**：质控全部事后/机械——溯源回指不可变 raw、git 一键回滚（revert 单 commit
  + INDEX/LOG/FTS 重同步）、结构 lint 编译期硬闸、语义巡检产 findings 报对话、人工文件写保护。
- **裁决即编译**：finding（矛盾/stale/孤儿/缺页/缺引用）在对话里当场裁决，
  采纳修订走同一编译通道；无审批队列。

## 指针

- 写侧操作手册与编译 API 用法见 octo-wiki-curate skill（本文件的纪律正文以其为源提炼）。
- 只读消费链（导航协议/引用纪律/stale 上报）见 octo-wiki skill。
`

/**
 * 幂等 seed：SCHEMA.md 缺席才写模板；已存在（含人工改写）一律不动。
 * 返回 true = 本次新建；false = 已存在未触碰。
 */
export function ensureSchemaDoc(knowledgeRoot: string): boolean {
  const target = path.join(knowledgeRoot, SCHEMA_DOC_FILE)
  if (fs.existsSync(target)) return false
  fs.mkdirSync(knowledgeRoot, { recursive: true })
  fs.writeFileSync(target, SCHEMA_MD_TEMPLATE, "utf-8")
  return true
}
