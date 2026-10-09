// packages/web-app/components/tasks/run-console/tab-assembly.ts
//
// 票 02 统一弹窗壳 —— 页签/右栏动作的「装配表」纯函数单源。
//
// 期望词表来自 spec.md Implementation Decisions（统一壳 · 页签装配表，源自原型
// taskboard-v2.html 状态表）：
//
//   | 状态            | 页签                                        | 默认   | 右栏                     |
//   | running(flow)   | 变更·节点·消耗·产物·控制台                     | 变更   | Pipeline+LIVE+(✋/⏸/■)  |
//   | paused          | 同上                                        | 保持   | (▶恢复/■)               |
//   | takeover(08)    | 对话接管·变更·节点·消耗·产物·日志            | 对话   | 进度+(确认交付/改派/■)   |
//   | fixing(05/08)   | 变更·节点·追加指令·消耗·产物·控制台（保留dock）| 节点  | 进度+产物列             |
//   | awaiting_review | 对话·变更·走查·消耗·产物·日志                 | 对话   | 验收进度+(通过/打回/中止) |
//
// 票11 ⑩回补：消耗/产物两列按原型定稿进装配表；待验收右栏补「■ 中止」
// （复用既有任务级 abort 动作与二次确认，不新增状态/端点）。
//
// 本模块只回答「哪些页签/哪些动作、默认哪个、←/→ 怎么卷」——不碰 DOM、不碰数据，
// TaskRunConsole 是唯一消费者。takeover/fixing 形态是 08/05 的预留接缝：状态由
// 上层推导后以 mode 传入，装配规则先钉在这里。v3 legacy / derived 未加载 一律
// 只剩「控制台」一页 —— 占位页签不压到旧任务头上（不回退铁律）。

/** 页签 key —— 票间契约（03 挂 files、04 挂 nodes、06 走 console+注入、07 挂 chat、
 *  走查=既有 AcceptanceSurface；11 加 usage=▤ 消耗 / artifacts=▣ 产物）。 */
export type ConsoleTabKey = "chat" | "files" | "nodes" | "review" | "usage" | "artifacts" | "console"

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
    // 票11 ⑩回补终表（原型 renderModal）：对话·变更·走查·消耗·产物·日志。
    return {
      keys: ["chat", "files", "review", "usage", "artifacts", "console"],
      defaultKey: startOnAcceptance ? "review" : "chat",
    }
  }
  if (!v4) return { keys: ["console"], defaultKey: "console" }
  if (mode === "takeover") return { keys: ["chat", "files", "nodes", "usage", "artifacts", "console"], defaultKey: "chat" }
  // 票 07（spec 故事27 / 票 AC4）：修复轮也装配对话页签 —— 语义是「追加指令」
  // （经 06 的暂停→注入通道生效），默认页仍是节点（自动推进直播，spec 表不动）。
  // 票11：fixing 保留 dock（chat 原位），消耗/产物插在控制台之前。
  if (mode === "fixing") return { keys: ["files", "nodes", "chat", "usage", "artifacts", "console"], defaultKey: "nodes" }
  // 执行动线（running / paused）：变更·节点·消耗·产物·控制台（票11 终表）。
  // running 默认落「变更」（spec 表）；paused「保持」由调用方保留用户选择实现，
  // 纯函数返回值仍取装配表的基准位；ready/终态默认控制台（发射门禁/战报动线不回退，
  // 且不在 ⑩ 回补表内 —— 页签集保持原样不加消耗/产物，改动面收敛）。
  if (status === "running") return { keys: ["files", "nodes", "usage", "artifacts", "console"], defaultKey: "files" }
  if (status === "paused") return { keys: ["files", "nodes", "usage", "artifacts", "console"], defaultKey: "console" }
  return { keys: ["files", "nodes", "console"], defaultKey: "console" }
}

const TAB_LABELS: Record<ConsoleTabKey, string> = {
  chat: "💬 对话",
  files: "≡ 变更",
  nodes: "◆ 节点",
  review: "✓ 走查",
  usage: "▤ 消耗",
  artifacts: "▣ 产物",
  console: "▶ 控制台",
}

/** 页签标签（原型词表）：接管形态的对话叫「💬 对话接管」；修复轮形态叫
 *  「💬 追加指令」（票 07 UI 明示 —— 这里发消息走 06 的暂停→注入通道，不是快改
 *  对话）；日志口径（待验收/接管）把「控制台」改字为「日志」。 */
export function tabLabel(key: ConsoleTabKey, input: { status: ConsoleShellStatus; mode?: ConsoleShellMode }): string {
  const { status, mode = "flow" } = input
  if (key === "chat" && mode === "takeover") return "💬 对话接管"
  if (key === "chat" && mode === "fixing") return "💬 追加指令"
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
// 「resume」已升级为「▶ 恢复 · 可注入干预」弹框（票 06 · resume-intervention-dialog）。

export type RailActionId =
  | "trigger" | "trigger-cancel" | "reopen"
  | "pause" | "resume" | "abort"
  | "accept" | "reject" | "duplicate"
  // 票08 三分支动作（「✋ 有问题」框 = ask-takeover；接管态右栏 = 确认交付/改派）
  | "ask-takeover" | "takeover-deliver" | "takeover-reassign"
  // ⑪真机复点：待验收右栏「🗂 工作空间 · P<ph> 执行视图 ↗」（纯导航，新标签打开，
  // URL = deepLinkTarget 单源；只进 awaiting 装配，run/takeover/fixing 右栏不动）。
  | "ws-deeplink"

/** 形态判定单源（票08 壳 :305 留位的纯函数化）：fixing（live task-fix 轮）优先，
 *  其次 takeover（派生 phase 'takeover' = 停流未交付），否则 flow。
 *  判据都在调用方算好（runs/derived 各一条 some），这里只钉优先级。 */
export function deriveShellMode(input: { fixingLive: boolean; takeoverActive: boolean }): ConsoleShellMode {
  if (input.fixingLive) return "fixing"
  if (input.takeoverActive) return "takeover"
  return "flow"
}

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
  const { status, canPause, canResume, canAbort, canReopen, armedFuture, canTrigger = true, mode = "flow" } = input
  if (mode === "takeover") {
    // spec 表 takeover 行「进度+（确认交付/改派/■）」—— 流已停，暂停/恢复/✋ 都不存在；
    // 复制保持全态在场（02 惯例，功能不回退）。
    const acts: RailActionId[] = ["takeover-deliver", "takeover-reassign"]
    if (canAbort) acts.push("abort")
    acts.push("duplicate")
    return acts
  }
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
      // 票08：✋ 三分支入口 = running flow 现场独有（fixing 已在通用流手里，
      // 04 只读纪律与 06 零输入铁律都不受影响 —— 按钮在 rail-acts，框是弹层）。
      if (mode === "flow") acts.push("ask-takeover")
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
    case "awaiting_review": {
      // 票11 ⑩回补：「■ 中止」从走查内列挪进本栏（原型 railWait 通过→打回→中止）。
      // 动作仍接既有实现 = AcceptanceActionApi.requestAbort（surface 的二次确认框
      // 与 abortTask 端点单源），不新增端点、不新增状态。待验收期持久态仍 running
      // （K3 派生不落库），canAbort 判据天然为真。
      // ⑪真机复点四钮定版（顺序逐字）：✓ 验收通过 → ↩ 反馈打回（task-fix 修复轮，
      // 大改）→ 🗂 工作空间·P<ph> 执行视图 ↗（deepLinkTarget 同源，新标签）→ ■ 中止任务。
      const acts: RailActionId[] = ["accept", "reject", "ws-deeplink"]
      if (canAbort) acts.push("abort")
      acts.push("duplicate")
      return acts
    }
    case "archiving":
      return ["duplicate"]
    default: // done / failed / aborted —— 只读壳
      return ["duplicate"]
  }
}
