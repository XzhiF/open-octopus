// 工作流执行的人话名字。
//
// 执行行的 workflow_name 是 ref 的 slug（acceptance-plan），不是给人看的。
// 作业坞「运行」列表与 header「运行中」指示共用这一张表，避免两处真值。

export const SYSTEM_WORKFLOW_LABEL: Record<string, string> = {
  'built-in/acceptance-plan': '验收规划',
}

/** 系统运行 → 人话名；普通工作流 → undefined（调用方回退任务名/workflow 名）。 */
export function systemWorkflowLabel(workflowRef: string | null | undefined): string | undefined {
  return workflowRef ? SYSTEM_WORKFLOW_LABEL[workflowRef] : undefined
}
