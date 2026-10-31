// 内置 in-process MCP server 的只读元数据 —— 聊天 ＋ 面板「MCP」类别的数据源。
//
// 与 workflow-tools.ts / task-tools.ts 的 tool() 定义保持同步：名字集合由
// mcp-catalog.test.ts 对源码做集合断言（加/删/改名不更新这里 → 测试红）。
// 描述是人话摘要（不是给模型的 prompt），允许与 tool description 措辞不同。

export interface McpToolMeta {
  name: string
  description: string
}

export interface McpServerMeta {
  server: string
  label: string
  description: string
  /** 何时挂到会话上（装配条件的 UI 说明，见 chat-routes 的 toolServers 块）。 */
  when: string
  tools: McpToolMeta[]
}

const WORKFLOW_TOOL_NAMES = [
  "list_workflows",
  "run_workflow",
  "list_executions",
  "get_execution",
  "cancel_execution",
  "respond_approval",
  "retry_node",
  "rerun_execution",
] as const

const TASK_TOOL_NAMES = [
  "get_task_status",
  "update_task_spec_field",
  "propose_launch",
  "request_task_action",
  "propose_wiki_entries",
  "get_acceptance_plan",
  "ask_acceptance_check",
  "record_acceptance_check",
  "submit_acceptance_decision",
  "run_acceptance_probe",
  "start_acceptance_preview",
  "stop_acceptance_preview",
  "propose_acceptance_escalation",
  "get_archive_state",
  "start_archive",
  "record_reflection_decision",
  "retry_archive",
  "resolve_archive_delta",
  "record_archive_amendment",
  "open_followup_task",
] as const

export function buildMcpCatalog(): McpServerMeta[] {
  return [
    {
      server: "octopus-workflow",
      label: "工作流驾驶",
      description: "在当前工作空间里跑/查/停工作流：列定义、执行、看节点进度、取消、答审批、重试节点、终态重跑。",
      when: "会话绑定工作空间时挂载",
      tools: WORKFLOW_TOOL_NAMES.map((name) => ({ name, description: WORKFLOW_TOOL_DESC[name] })),
    },
    {
      server: "octopus-task",
      label: "任务线程",
      description: "任务主对话的状态读写与决策卡：查状态、写 spec 字段、发起运行选项、请求人工确认动作、沉淀 wiki。",
      when: "会话是某任务的主线程时挂载",
      tools: TASK_TOOL_NAMES.map((name) => ({ name, description: TASK_TOOL_DESC[name] })),
    },
  ]
}

const WORKFLOW_TOOL_DESC: Record<string, string> = {
  list_workflows: "列出当前工作空间可用的工作流（工作区级 + 内置）。",
  run_workflow: "在当前工作空间执行一个工作流，返回执行 id（自动开跑，不等确认）。",
  list_executions: "列出当前工作空间最近的执行记录。",
  get_execution: "查看某次执行的状态与全部节点明细。",
  cancel_execution: "取消一次运行中的执行。",
  respond_approval: "回答执行中挂起的审批/交互节点。",
  retry_node: "重跑一次运行中执行里的单个失败节点。",
  rerun_execution: "终态执行（失败/取消/中止）一键重跑：取首个失败节点为恢复点连同下游洗回 pending，再以全新启动方式重新拉起引擎。",
}

const TASK_TOOL_DESC: Record<string, string> = {
  get_task_status: "读取绑定任务的当前状态、phase/轮次、工作空间与可用动作。",
  update_task_spec_field: "（作者身份）写入 task_spec 的单个字段，走服务端校验与版本管线。",
  propose_launch: "（作者身份）向用户发起运行选择卡：立即执行 / 入列待触发 / 定时。",
  request_task_action: "（执行者身份）请人类确认一个任务动作（暂停/恢复/中止/触发…），只出确认卡、不执行。",
  propose_wiki_entries: "把本轮沉淀提炼成 wiki 条目提案，逐条交给人在对话里决定。",
  get_acceptance_plan: "读取本轮验收方案：cases 是人验场景（1–3 条），checks 是机器证据表。",
  ask_acceptance_check: "一次问一条人验场景，展示步骤与通过标准（卡片只是快捷方式）。",
  record_acceptance_check: "人明确表态后记录场景结论（通过/不通过/跳过）；机器证据不签。",
  submit_acceptance_decision: "人明确放行/退回后收口本轮验收结论。",
  run_acceptance_probe: "仅按用户点名重跑某条机器证据；不自动、不批量。",
  start_acceptance_preview: "按任务配置的 runbook 起验收预览。",
  stop_acceptance_preview: "停止验收预览并执行 teardown。",
  propose_acceptance_escalation: "超出小修边界时请人确认升级 task-fix 大修复。",
  get_archive_state: "读取归档只读读模型：git 同步、失败、术语冲突、反思决策、知识包编译状态。",
  start_archive: "人明确说「归档」后，从待归档启动 git 同步 / ADR·术语合并 / commit+push+PR / 知识沉淀。",
  record_reflection_decision: "人明确说落/跳过之后，记录一条归档反思决策并执行入队。",
  retry_archive: "人明确说重试之后，触发 project 粒度幂等续跑。",
  resolve_archive_delta: "人明确选择纳入/排除后，处置放行后的未提交改动并继续归档。",
  record_archive_amendment: "归档完成后，人要求补充/修正归档内容时追加一条只增不改的增补记录。",
  open_followup_task: "归档完成后，开一个承接上下文的跟进任务继续开发。",
}
