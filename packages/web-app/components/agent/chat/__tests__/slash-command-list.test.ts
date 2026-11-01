// packages/web-app/components/agent/chat/__tests__/slash-command-list.test.ts
//
// Composer `/` 菜单的数据整形（2026-10-31）：
//   命令表不再硬编码 —— SDK 的 system:init.slash_commands 才是事实源。
//   这里钉住：① 未收到 init 时给 headless 可用兜底；② init 到达后已知命令
//   归内置、其余归技能；③ 内部命令（__ 前缀）不露脸；④ 去重。

import { describe, it, expect } from 'vitest'
import {
  buildSlashCommands,
  COMMAND_DESCRIPTIONS,
  FALLBACK_SLASH_COMMANDS,
} from '../SlashCommandAutocomplete'

describe('buildSlashCommands', () => {
  it('未收到 init（空列表）→ 兜底内置命令', () => {
    expect(buildSlashCommands([])).toEqual(FALLBACK_SLASH_COMMANDS)
    expect(buildSlashCommands(null)).toEqual(FALLBACK_SLASH_COMMANDS)
    expect(FALLBACK_SLASH_COMMANDS.every((c) => c.kind === 'builtin')).toBe(true)
  })

  it('init 列表 → 已知命令内置组、其余技能组、内部命令剔除、去重', () => {
    const rows = buildSlashCommands(['user-skill', 'context', 'compact', '__remote-workflow', 'context'])

    expect(rows.map((c) => c.name)).toEqual(['compact', 'context', 'user-skill'])
    expect(rows[0]).toMatchObject({ name: 'compact', kind: 'builtin', description: COMMAND_DESCRIPTIONS.compact })
    expect(rows[1]).toMatchObject({ name: 'context', kind: 'builtin' })
    expect(rows[2]).toEqual({ name: 'user-skill', kind: 'skill' })
  })

  it('技能按名字排序，内置按兜底表顺序（不随 init 顺序漂移）', () => {
    const rows = buildSlashCommands(['zeta-skill', 'usage', 'alpha-skill', 'compact'])

    expect(rows.filter((c) => c.kind === 'builtin').map((c) => c.name)).toEqual(['compact', 'usage'])
    expect(rows.filter((c) => c.kind === 'skill').map((c) => c.name)).toEqual(['alpha-skill', 'zeta-skill'])
  })
})
