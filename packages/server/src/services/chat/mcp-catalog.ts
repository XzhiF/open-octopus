// 内置 in-process MCP server 的只读元数据 —— 聊天 ＋ 面板「MCP」类别的数据源。
//
// 与 workflow-tools.ts / task-tools.ts / memory-tools.ts 的 tool() 定义保持同步：
// 名字集合由 mcp-catalog.test.ts 对源码做集合断言（加/删/改名不更新这里 → 测试红）。
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
  "get_workflow",
  "run_workflow",
  "validate_workflow",
  "simulate_workflow",
  "list_executions",
  "get_execution",
  "cancel_execution",
  "pause_execution",
  "resume_execution",
  "respond_approval",
  "retry_node",
  "rerun_execution",
  "diagnose_execution",
  "reset_execution_node",
  "reload_execution_workflow",
] as const

const TASK_TOOL_NAMES = [
  "get_task_status",
  "update_task_spec_field",
  "propose_launch",
  "launch_task",
  "enqueue_task",
  "trigger_task",
  "request_task_action",
  "propose_wiki_entries",
  "get_acceptance_plan",
  "ask_acceptance_check",
  "record_acceptance_check",
  "submit_acceptance_decision",
  "run_acceptance_probe",
  "start_acceptance_preview",
  "stop_acceptance_preview",
  "get_archive_state",
  "start_archive",
  "record_reflection_decision",
  "resolve_wiki_finding",
  "retry_archive",
  "resolve_archive_delta",
  "record_archive_amendment",
  "clean_archive_leftovers",
  "open_followup_task",
  "get_workflow_dev_state",
  "set_active_workflow",
  "complete_workflow",
  "finish_workflow_dev",
  "add_workspace_projects",
  "clone_dev_get_state",
  "clone_dev_set_meta",
  "clone_dev_verify",
  "clone_dev_finish",
] as const

const MEMORY_TOOL_NAMES = ["record_daily", "remember"] as const

const CABIN_TOOL_NAMES = [
  "cabin_list_tasks",
  "cabin_dispatch_task",
  "cabin_delegate_task",
  "cabin_delegation_archive",
  "cabin_relay_decision",
  "cabin_list_jobs",
  "cabin_job_trace",
  "cabin_note_job",
  "cabin_resume_job",
  "cabin_ack_attention",
] as const

const CABIN_DOER_TOOL_NAMES = ["cabin_delegation_done"] as const

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
    {
      server: "octopus-memory",
      label: "记忆",
      description: "写主 Agent 记忆：当日工作记忆自主记录；长期记忆仅在用户本轮明确要求或同意后追加（分节、有 token 预算）。",
      when: "自由主对话挂载（任务线程除外）",
      tools: MEMORY_TOOL_NAMES.map((name) => ({ name, description: MEMORY_TOOL_DESC[name] })),
    },
    {
      server: "octopus-cabin",
      label: "舱调度",
      description: "作战舱主对话的调度工具集：列舱内任务/作业、派发真实任务、派发轻量委派、转达用户决策、读审计 trace、恢复作业。自己动手改代码走通用 Read/Edit/Bash，不在这套工具里。",
      when: "会话绑定作战舱（cabin_id）且非任务线程、非委派 doer 时挂载",
      tools: CABIN_TOOL_NAMES.map((name) => ({ name, description: CABIN_TOOL_DESC[name] })),
    },
    {
      server: "octopus-cabin-doer",
      label: "委派执行",
      description: "独立委派 doer 的收口工具：交一句话结论 + 产物引用。不能派任务、不能开工作树。",
      when: "会话是某条独立委派（cabin_delegations）的 doer 时挂载",
      tools: CABIN_DOER_TOOL_NAMES.map((name) => ({ name, description: CABIN_DOER_TOOL_DESC[name] })),
    },
  ]
}

const CABIN_TOOL_DESC: Record<string, string> = {
  cabin_list_tasks: "列出本舱全部任务（派生状态/会话），监督读。",
  cabin_dispatch_task: "派发真实 Octopus 任务进舱（建任务+作者线程+授权 wake），brief 是编译后的意图、原文逐字附后；执行在独立 worktree。",
  cabin_delegate_task: "派发一次轻量委派（无 phase / worktree / 验收；有归档闸）：一份 brief + 一个 doer 会话，编队显示 D1。",
  cabin_delegation_archive: "归档一条委派会话：可选先做会话反思 + wiki 沉淀，再归档；运行中的会话不能归档。",
  cabin_relay_decision: "把用户在舱主对话里做的决定代述给 doer；verbatim 逐字、幂等，framing 只补边界不改选择。",
  cabin_list_jobs: "统一作业账本（task/workflow/subagent）+ 独立委派 + 派生 status + 句柄。",
  cabin_job_trace: "读某作业的 append-only 审计时间线。",
  cabin_note_job: "给作业留一条备注 / 范围变更（不授权），进审计时间线与作战详情「对接」；默认只留痕，notify=true 才唤醒会话。",
  cabin_resume_job: "恢复作业（草稿入列并触发 / ready 触发 / 暂停恢复）；gate 缺项原样报错。",
  cabin_ack_attention: "把已完成回流从「要我处理」收掉（不回复执行者）；先审阅判断无需人回复再收。",
}

const CABIN_DOER_TOOL_DESC: Record<string, string> = {
  cabin_delegation_done: "交委派结论（一句话 + 产物路径/链接）；ok=false 表示没做成并说明卡在哪。",
}

const MEMORY_TOOL_DESC: Record<string, string> = {
  record_daily: "把值得留到以后的工作发现写进当天工作记忆，同时生成一条可搜索摘要。",
  remember: "把持久事实追加进长期记忆的指定分节；用户本轮没有要求时只返回「先问用户」，不会落盘。",
}

const WORKFLOW_TOOL_DESC: Record<string, string> = {
  list_workflows: "列出当前工作空间可用的工作流；普通对话只显示已发布工作流，工作流开发任务还会显示快照与自写 YAML（含描述/阶段/版本）。",
  get_workflow: "读取单个工作流的完整 YAML 与解析摘要（描述/阶段/版本/输入/节点），用于讲解细节与使用场景。",
  run_workflow: "在当前工作空间执行一个工作流，返回执行 id（自动开跑）；工作流开发任务可跑快照，但自写 YAML 必须先通过校验+仿真（可显式豁免）。",
  validate_workflow: "用共享 parser 做结构与语义校验；工作流开发任务会按文件 hash 记录结果。",
  simulate_workflow: "工作流开发任务专用：运行同名 .test.yaml fixture（默认 strict），记录仿真结果。",
  list_executions: "列出当前工作空间最近的执行记录。",
  get_execution: "查看某次执行的状态与全部节点明细。",
  cancel_execution: "取消一次运行中的执行。",
  pause_execution: "在正在运行的节点处暂停一次执行。",
  resume_execution: "恢复已暂停的执行，可附带干预说明。",
  respond_approval: "回答执行中挂起的审批/交互节点。",
  retry_node: "重跑一次运行中执行里的单个失败节点。",
  rerun_execution: "终态执行（失败/取消/中止）一键重跑：取首个失败节点为恢复点连同下游洗回 pending，再以全新启动方式重新拉起引擎。",
  diagnose_execution: "诊断失败执行：根因、失败节点与建议动作。",
  reset_execution_node: "把单个节点重置为 pending（重跑）或 completed（人工接受输出）。",
  reload_execution_workflow: "用新的 YAML 替换执行快照（修完定义后热更新），返回节点差异。",
}

const TASK_TOOL_DESC: Record<string, string> = {
  get_task_status: "读取绑定任务的当前状态、phase/轮次、工作空间与可用动作。",
  update_task_spec_field: "（作者身份）写入 task_spec 的单个字段，走服务端校验与版本管线。",
  propose_launch: "（可选）向用户发起运行选择卡：立即执行 / 入列待触发 / 定时；规格已齐时优先直接 launch_task。",
  launch_task: "（作者身份）规格与 phase 绑定齐后，直接入列并开跑 —— 不需要人工确认。",
  enqueue_task: "（作者身份）只入列、不马上跑；仅在用户要求先入列 / 等待 / 定时时使用。",
  trigger_task: "（执行者身份）任务已 ready 且该开跑时直接触发 —— 不需要人工确认。",
  request_task_action: "（执行者身份）请人类确认一个任务动作（暂停/恢复/中止/触发…），只出确认卡、不执行。",
  propose_wiki_entries: "把本轮沉淀提炼成 wiki 条目提案，逐条交给人在对话里决定。",
  get_acceptance_plan: "读取本轮验收方案：cases 是人验场景（1–3 条），checks 是机器证据表。",
  ask_acceptance_check: "一次问一条人验场景，展示步骤与通过标准（卡片只是快捷方式）。",
  record_acceptance_check: "人明确表态后记录场景结论（通过/不通过/跳过）；机器证据不签。",
  submit_acceptance_decision: "人明确放行/退回后收口本轮验收结论。",
  run_acceptance_probe: "仅按用户点名重跑某条机器证据；不自动、不批量。",
  start_acceptance_preview: "按任务配置的 runbook 起验收预览。",
  stop_acceptance_preview: "停止验收预览并执行 teardown。",
  get_archive_state: "读取归档只读读模型：git 同步、失败、术语冲突、反思决策、知识包编译状态。",
  start_archive: "人明确说「归档」后，从待归档启动 git 同步 / ADR·术语合并 / commit+push+PR / 知识沉淀。",
  record_reflection_decision: "人明确说落/跳过之后，记录一条归档反思决策并执行入队。",
  resolve_wiki_finding: "人明确说采纳修订/忽略之后，裁决一条本次归档编译出的 wiki 矛盾（采纳=重新编译改写涉事页）。",
  retry_archive: "人明确说重试之后，触发 project 粒度幂等续跑。",
  resolve_archive_delta: "人明确选择纳入/排除后，处置放行后的未提交改动并继续归档。",
  record_archive_amendment: "归档完成后，人要求补充/修正归档内容时追加一条只增不改的增补记录。",
  clean_archive_leftovers: "归档完成后，人明确确认具体路径后删除项目工作区里残留的 git-ignored 构建产物（服务端逐条复验）。",
  open_followup_task: "归档完成后，开一个承接上下文的跟进任务继续开发。",
  get_workflow_dev_state: "（工作流开发任务）读取当前自写工作流、全部文件与校验/仿真状态。",
  set_active_workflow: "（工作流开发任务）登记/切换当前开发的工作流（一次一个）。",
  complete_workflow: "（工作流开发任务）校验+仿真通过后完成单个工作流，并记录 release/snapshot 选择。",
  finish_workflow_dev: "（工作流开发任务）全部工作流完成后结束开发，任务停在待归档。",
  add_workspace_projects: "（工作流开发任务）把项目仓库引入当前工作空间，供工作流调试运行。",
  clone_dev_get_state: "（分身开发任务）读取分身开发状态：代号、阶段、工具清单与三条验证。",
  clone_dev_set_meta: "（分身开发任务）登记分身代号 / 模式 / 工具清单；代号写入后锁定。",
  clone_dev_verify: "（分身开发任务）跑三条硬验证：工具可用、越权被拦、身份可用。",
  clone_dev_finish: "（分身开发任务）三条全绿后结束开发，任务停在待合入。",
}
