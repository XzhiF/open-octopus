// packages/web-app/components/tasks/run-console/tab-assembly.ts
//
// 票 02 统一弹窗壳 —— 页签/右栏动作的「装配表」纯函数单源。
//
// 期望词表来自 spec.md Implementation Decisions（统一壳 · 页签装配表，源自原型
// taskboard-v2.html 状态表）：
//
//   | 状态            | 页签                        | 默认   | 右栏                     |
//   | running(flow)   | 变更·节点·控制台            | 变更   | Pipeline+LIVE+(⏸/■)     |
//   | paused          | 同上                        | 保持   | (▶恢复/■)               |
//   | takeover(08)    | 对话接管·变更·节点·日志      | 对话   | 进度+(确认交付/改派/■)   |
//   | fixing(05/08)   | 变更·节点·控制台            | 节点   | 进度+产物列             |
//   | awaiting_review | 对话·变更·走查·日志          | 对话   | 验收进度+(通过/打回)     |
//
// 本模块只回答「哪些页签/哪些动作、默认哪个、←/→ 怎么卷」——不碰 DOM、不碰数据，
// TaskRunConsole 是唯一消费者。takeover/fixing 形态是 08/05 的预留接缝：状态由
// 上层推导后以 mode 传入，装配规则先钉在这里。v3 legacy / derived 未加载 一律
// 只剩「控制台」一页 —— 占位页签不压到旧任务头上（不回退铁律）。

/** 页签 key —— 票间契约（03 挂 files、04 挂 nodes、06 走 console+注入、07 挂 chat、
 *  走查=既有 AcceptanceSurface）。 */
export type ConsoleTabKey = "chat" | "files" | "nodes" | "review" | "console"

/** 壳的派生态：effectiveStatusOf 的输出 + 06/08 预留的 takeover/fixing（由 mode 给出，
 *  TaskStatusSchema 不加新状态 —— 铁律）。paused 来自 derived.taskStatus。 */
export type ConsoleShellStatus =
  | "ready" | "running" | "paused" | "awaiting_review" | "archiving"
  | "done" | "failed" | "aborted"

export type ConsoleShellMode = "flow" | "takeover" | "fixing"

export interface TabAssemblyInput {
  status: ConsoleShellStatus
  /** 缺省 "flow"。takeover/fixing 由上层按执行推导态给出（05/08 接线）。 */
  mode?: ConsoleShellMode
  /** v4 壳（derived 就位且 isV4）才谈变更/节点/对话页签。 */
  v4: boolean
  /** 看板「验收」按钮直开：awaiting_review 落地页签从 对话 改 走查。 */
  startOnAcceptance?: boolean
}

export interface TabAssembly {
  keys: ConsoleTabKey[]
  defaultKey: ConsoleTabKey
}

export function assembleTabs(input: TabAssemblyInput): TabAssembly {
  const { status, mode = "flow", v4, startOnAcceptance } = input
  if (status === "awaiting_review") {
    return {
      keys: ["chat", "files", "review", "console"],
      defaultKey: startOnAcceptance ? "review" : "chat",
    }
  }
  if (!v4) return { keys: ["console"], defaultKey: "console" }
  if (mode === "takeover") return { keys: ["chat", "files", "nodes", "console"], defaultKey: "chat" }
  if (mode === "fixing") return { keys: ["files", "nodes", "console"], defaultKey: "nodes" }
  // 执行动线（running / paused / ready / archiving / 终态）：变更·节点·控制台。
  // running 默认落「变更」（spec 表）；paused「保持」由调用方保留用户选择实现，
  // 纯函数返回值仍取装配表的基准位；ready/终态默认控制台（发射门禁/战报动线不回退）。
  if (status === "running") return { keys: ["files", "nodes", "console"], defaultKey: "files" }
  return { keys: ["files", "nodes", "console"], defaultKey: "console" }
}

const TAB_LABELS: Record<ConsoleTabKey, string> = {
  chat: "💬 对话",
  files: "≡ 变更",
  nodes: "◆ 节点",
  review: "✓ 走查",
  console: "▶ 控制台",
}

/** 页签标签（原型词表）：接管形态的对话叫「💬 对话接管」；日志口径（待验收/接管）
 *  把「控制台」改字为「日志」。 */
export function tabLabel(key: ConsoleTabKey, input: { status: ConsoleShellStatus; mode?: ConsoleShellMode }): string {
  const { status, mode = "flow" } = input
  if (key === "chat" && mode === "takeover") return "💬 对话接管"
  if (key === "console" && (status === "awaiting_review" || mode === "takeover")) return "▶ 日志"
  return TAB_LABELS[key]
}

/** ←/→ 切页：当前页不在页签集（状态迁移后页签重组）→ 回落到装配表首个。 */
export function cycleTab(keys: ConsoleTabKey[], current: ConsoleTabKey, delta: 1 | -1): ConsoleTabKey {
  if (keys.length === 0) return current
  const i = keys.indexOf(current)
  if (i < 0) return keys[0]
  return keys[(i + delta + keys.length) % keys.length]
}

// ── 右栏底部动作区 ────────────────────────────────────────────────────
// 票 02 铁律：动作只是「接线柱」——每个动作 id 在 TaskRunConsole 里连回它现有的
// handler（pause/resume/abort/reopen/trigger/duplicate）或 AcceptanceSurface 的
// 决策入口（accept/reject），行为零回退。「✋ 有问题」三分支（branch）归票 08，
// 「▶ 恢复·注入」输入框归票 06 —— 此处不预留空按钮。

export type RailActionId =
  | "trigger" | "trigger-cancel" | "reopen"
  | "pause" | "resume" | "abort"
  | "accept" | "reject" | "duplicate"

export interface RailActionsInput {
  status: ConsoleShellStatus
  /** 判据与控制台现状一致（服务端只认 running 轮可暂停）。 */
  canPause: boolean
  canResume: boolean
  canAbort: boolean
  canReopen: boolean
  /** ready 且已挂定时触发 → 触发钮换成 取消触发。 */
  armedFuture?: boolean
  /** ready 且已入队等并发闸（waitingForSlot）→ 触发钮让位（与导航条旧判据一致）。 */
  canTrigger?: boolean
  mode?: ConsoleShellMode
}

export function assembleRailActions(input: RailActionsInput): RailActionId[] {
  const { status, canPause, canResume, canAbort, canReopen, armedFuture, canTrigger = true } = input
  switch (status) {
    case "ready": {
      const acts: RailActionId[] = []
      if (armedFuture) acts.push("trigger-cancel")
      else if (canTrigger) acts.push("trigger")
      if (canReopen) acts.push("reopen")
      if (canAbort) acts.push("abort")
      acts.push("duplicate")
      return acts
    }
    case "running": {
      const acts: RailActionId[] = []
      if (canPause) acts.push("pause")
      if (canAbort) acts.push("abort")
      acts.push("duplicate")
      return acts
    }
    case "paused": {
      const acts: RailActionId[] = []
      if (canResume) acts.push("resume")
      if (canAbort) acts.push("abort")
      acts.push("duplicate")
      return acts
    }
    case "awaiting_review":
      // 中止不进这里 —— 待验收的 abort 留在走查面（既有二次确认框），与改版前一致。
      return ["accept", "reject", "duplicate"]
    case "archiving":
      return ["duplicate"]
    default: // done / failed / aborted —— 只读壳
      return ["duplicate"]
  }
}
