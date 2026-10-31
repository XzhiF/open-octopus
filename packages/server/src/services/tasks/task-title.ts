// packages/server/src/services/tasks/task-title.ts
//
// 新建开发任务的标题（2026-10-29 用户反馈）：任务名不能是用户输入的截串，
// 要像新对话一样由 AI 总结。
//
// 时序：
//   1. 客户端创建任务时先落一个「确定性名字」（首行 ≤40 字的截串）—— 侧栏立刻有字。
//   2. 首轮 chat 请求进来，服务端异步用 haiku 起一个真标题；只在任务名**仍等于
//      那条消息的确定性名字**时替换 —— 用户手动改过名就永久冻结。
//
// derivedTaskNameFromMessage 必须与 web-app `ChatTab.taskNameFromMessage` 同规则
// （两侧测试都钉住同一批样例），否则第 2 步的「仍是自动名」判据会失效。

import { getProvider } from '@octopus/providers'
import { getAgentDir } from '../agent/paths'

/** 与客户端同规则：首行、去首尾空白、超 40 字截成 39 + `…`。空输入回落占位名
 * （web-app `ChatTab.NEW_TASK_NAME`）。 */
export function derivedTaskNameFromMessage(message: string): string {
  const first = message.split(/\r?\n/)[0].trim()
  if (!first) return '新开发任务'
  return first.length > 40 ? `${first.slice(0, 39)}…` : first
}

/** 模型输出 → 标题。去掉标点/引号/「标题：」前缀，只留首行，封顶 30 字。 */
export function normalizeTaskTitle(raw: string): string | null {
  const first = raw.trim().split(/\r?\n/)[0]?.trim() ?? ''
  const title = first
    .replace(/^(?:标题|任务标题|task\s*title)\s*[:：]\s*/i, '')
    .replace(/[.。,，!！?？""''「」『』]/g, '')
    .trim()
  if (!title) return null
  return title.slice(0, 30)
}

/** haiku 起名（与 session auto-title 同一档模型）。失败返回 null，调用方保留截串名。 */
export async function generateTaskTitle(message: string): Promise<string | null> {
  const provider = getProvider('claude')
  const prompt = [
    '为一个开发任务生成简短标题（不超过 20 个汉字，中文优先），概括用户需求。',
    '只输出标题本身：不要标点、引号、序号或解释。',
    '',
    `用户需求：${message.replace(/\r?\n/g, ' ').slice(0, 400)}`,
  ].join('\n')

  let out = ''
  for await (const chunk of provider.sendQuery(prompt, getAgentDir(), undefined, { model: 'haiku' })) {
    if (chunk.type === 'text_delta') out += chunk.content
  }
  return normalizeTaskTitle(out)
}
