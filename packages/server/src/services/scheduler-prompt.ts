import fs from "fs"
import path from "path"

const SKILL_SEARCH_PATHS = [
  path.resolve(process.cwd(), 'packages/core-pack/skills/octo-scheduler/SKILL.md'),
  path.resolve(__dirname, '../../core-pack/skills/octo-scheduler/SKILL.md'),
  path.resolve(__dirname, '../../../core-pack/skills/octo-scheduler/SKILL.md'),
]

export function loadSchedulerSystemPrompt(): string {
  for (const skillPath of SKILL_SEARCH_PATHS) {
    try {
      const content = fs.readFileSync(skillPath, 'utf-8')
      return content.replace(/^---[\s\S]*?---\n/, '').trim()
    } catch {}
  }
  return [
    '你是 Octopus Scheduler 助手。',
    '通过 curl 调用 http://localhost:3001/api/scheduler/ 的 REST API 管理调度任务。',
    '支持 workflow 和 agent 两种 Job 类型。',
    '所有 PUT 请求必须带 If-Match header（乐观锁）。',
    '创建前先用 POST /cron/parse 验证 Cron 表达式。',
  ].join('\n')
}
