// packages/web-app/lib/task-name.ts
//
// 新建开发任务的第一版标题（2026-10-29）：首行 ≤40 字的截串 —— 侧栏立刻有字，
// 服务端首轮再用 AI 总结替换（仅当名字仍是这个截串，用户改名即冻结）。
//
// 必须与服务端 `services/tasks/task-title.ts#derivedTaskNameFromMessage` 逐字节
// 一致（两侧测试钉同一批样例）；不一致时 AI 标题永远落不了地。

/** Chat-created tasks start unnamed; the task-author autosave adopts the
 *  smart session title after the first turn (same as a main-agent session).
 *  名称带「开发」：任务品类会扩展，task-author 这条是开发任务。 */
export const NEW_TASK_NAME = '新开发任务'

/** First message seeds the task title (deterministic, instant). */
export function taskNameFromMessage(message: string): string {
  const first = message.split(/\r?\n/)[0].trim()
  if (!first) return NEW_TASK_NAME
  return first.length > 40 ? `${first.slice(0, 39)}…` : first
}
