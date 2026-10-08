// packages/web-app/components/tasks/run-console/takeover.ts
//
// 票08「✋ 有问题？接管本 Round…」三分支决策框的纯逻辑单源 —— 选项词表 /
// 按钮文案随选 / 提交闸门。DOM 零依赖；TakeoverBranchDialog 与 FixDispatchDialog
// 是仅有的两个消费者。
//
// 文案真相源：原型 taskboard-v2.html openBranch()/pickBr()/confirmDispatch()
// （逐字），行为真相源：票面 AC「三分支框三选一各走通；选 ③ 时指令必填」+
// ADR-0025（② 不留反悔半程）与 ADR-0024（③ = task-fix 一条路）。

export type BranchChoice = "inject" | "takeover" | "fix"

export interface BranchOption {
  id: BranchChoice
  /** 主文案（原型 .rad 第一行，逐字）。 */
  label: string
  /** 小字（原型 .rad small，逐字）。 */
  hint: string
}

export const BRANCH_OPTIONS: BranchOption[] = [
  {
    id: "inject",
    label: "① ⚑ 注入干预 · 原工作流继续",
    hint: "暂停当前节点 → 写干预指令 → 恢复。方向偏了、骨架没问题时最轻。",
  },
  {
    id: "takeover",
    label: "② ✋ 停流 · 我接管（对话开发）",
    hint: "终止绑定工作流，之后通过对话让 agent 完成本 Round，你一步一确认，满意手动转待验收。",
  },
  {
    id: "fix",
    label: "③ ⚙ 改派通用修复流 task-fix",
    hint: "终止绑定流，把你的指令交给通用流：开发 → 回归 → 调整 → 补产物（报告/证据）→ 自动转待验收。",
  },
]

/** go 按钮文案随选变化（原型 pickBr 三分支逐字）。 */
export function branchGoLabel(sel: BranchChoice): string {
  if (sel === "inject") return "① 注入干预并继续"
  if (sel === "takeover") return "② 停止工作流 · 进入接管"
  return "③ 派发 task-fix"
}

/** ③ 缺指令的拦下文案（原型 confirmDispatch 的 toast 逐字 —— 通用流按指令开发，
 *  空指令 = 无轮可派，同 K7 打回必填反馈的一个鼻孔）。 */
export const FIX_DISPATCH_BLOCK_MESSAGE = "指令必填 — task-fix 通用流按你的输入开发"

/** 分支框提交闸门：返回 null = 可提交；返回字符串 = 就地提示（不关窗）。
 *  ① 的指令走 06 注入框（本框 textarea 与它无关），② 的指令是可选开场草稿
 *  （预填进对话输入，人按发送才算第一交）—— 只有 ③ 把 textarea 当必填指令。 */
export function branchSubmitBlocked(sel: BranchChoice, note: string): string | null {
  if (sel === "fix" && note.trim().length === 0) return FIX_DISPATCH_BLOCK_MESSAGE
  return null
}

/** 独立「改派 task-fix」框（接管中 ⚙ 钮走这条）的派发闸门 —— 指令同样必填。 */
export function fixDispatchBlocked(instruction: string): string | null {
  return instruction.trim().length === 0 ? FIX_DISPATCH_BLOCK_MESSAGE : null
}
