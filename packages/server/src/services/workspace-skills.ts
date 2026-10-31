// 工作区自带技能：<workspace>/.claude/skills/*/SKILL.md
//
// 工作区创建时会把 core-pack 的一部分技能复制进去，供工作区内运行的
// Claude Code 发现；用户也可以手工放技能。这里只做只读枚举。

import fs from 'node:fs'
import path from 'node:path'

export interface WorkspaceSkillEntry {
  name: string
  source: 'workspace'
  token_count: number
  file_size: number
  last_modified: string | null
}

export function listWorkspaceSkills(workspacePath: string): WorkspaceSkillEntry[] {
  const skillsDir = path.join(workspacePath, '.claude', 'skills')
  if (!fs.existsSync(skillsDir)) return []

  const items: WorkspaceSkillEntry[] = []
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(skillsDir, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillFile)) continue
    try {
      const content = fs.readFileSync(skillFile, 'utf-8')
      const stat = fs.statSync(skillFile)
      items.push({
        name: entry.name,
        source: 'workspace',
        token_count: Math.ceil(content.length / 4),
        file_size: stat.size,
        last_modified: stat.mtime.toISOString(),
      })
    } catch {
      // 不可读的技能目录跳过，不影响其它条目。
    }
  }

  items.sort((a, b) => a.name.localeCompare(b.name))
  return items
}
