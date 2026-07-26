# Requirement Brief: Plugin-Based Skill Discovery

## Overview

用 Claude Agent SDK 和 Pi Agent SDK 的原生 plugin/skill 机制替代 prompt 文本注入，实现技能的自动发现、隔离和加载。

## Projects Involved

- [x] `packages/server` (路由层传入 plugin 配置)
- [x] `packages/providers` (provider 接受 plugins 参数)
- [ ] `packages/web-app` (不动)
- [ ] `packages/shared` (不动)

## Feature Scope

**Do:**
- `~/.octopus/agent/` 目录天然作为 main plugin（共享技能在 `skills/`）
- `~/.octopus/agent/built-in/{clone}/` 天然作为 clone plugin（分身技能在各自 `skills/`）
- `~/.octopus/agent/clones/{clone}/` 同上
- Claude Agent SDK 路径：通过 `plugins` 选项加载 plugin 目录
- Pi Agent SDK 路径：通过 `resourceLoader.skills` 注入 skill 对象
- 移除 `CloneRuntime.loadSkills()` 中的 prompt 文本注入（不再需要）

**Don't:**
- 不安装技能到 `~/.claude/`
- 不在 system prompt 中用文本描述技能
- 不修改前端
- 不改变 `~/.octopus/agent/` 的现有目录结构（已验证天然兼容 plugin 格式）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | Plugin 目录结构 | 现有目录天然兼容，无需重组 | SDK 只扫描 plugin 根目录的直接 `skills/` 子目录，不递归 |
| 2 | 嵌套隔离 | `built-in/{clone}/skills/` 不会被 main plugin 扫描 | 已通过实测验证（skills + agents + commands 均隔离） |
| 3 | Claude SDK 集成 | `plugins: [{ type: 'local', path }]` | SDK 原生发现，自动注入 system prompt |
| 4 | Pi SDK 集成 | 直接操作 `resourceLoader.skills` 数组 | Pi SDK 已有此机制 |
| 5 | 技能过滤 | Claude SDK 用 `skills` 选项过滤 | `undefined` = 全部, `string[]` = 指定 |
| 6 | Prompt 注入 | 移除 `loadSkills()` 的文本输出 | 原生发现替代文本注入 |
| 7 | `~/.octopus/agent/` 清理 | 开发阶段可删除重建 | 用户确认可删除 |

## Architecture

### 目录结构（无需改动，已兼容）

```
~/.octopus/agent/                    ← Main plugin 根目录
├── skills/                          ← Main 共享技能 (SDK auto-discover)
│   ├── octo-agent-memory/SKILL.md
│   └── ... (10 个)
├── persona.md
├── memory/
├── config.yaml
│
├── built-in/                        ← Built-in clones
│   ├── workspace/                   ← Workspace clone plugin
│   │   ├── skills/                  ← 分身专属技能 (SDK 独立发现)
│   │   ├── persona.md
│   │   └── memory/
│   └── scheduler/
│       ├── skills/
│       └── ...
│
└── clones/                          ← User clones
    └── my-clone/
        ├── skills/
        └── ...
```

### Claude Agent SDK 路径 (chat.ts / global-chat.ts)

```typescript
import { getAgentDir, getBuiltInCloneDir, getCloneDir } from './paths'

function getPlugins(cloneName?: string, cloneType?: 'built-in' | 'user') {
  const plugins: Array<{ type: 'local'; path: string }> = [
    { type: 'local', path: getAgentDir() }  // Main plugin (共享技能)
  ]
  if (cloneName) {
    const clonePath = cloneType === 'built-in'
      ? getBuiltInCloneDir(cloneName)
      : getCloneDir(cloneName)
    plugins.push({ type: 'local', path: clonePath })
  }
  return plugins
}

// In sendQuery:
agent.sendQuery(msg, cwd, session, {
  systemPrompt: { preset: 'claude_code', append: personaPrompt },  // 仅 persona + memory
  plugins: getPlugins('workspace', 'built-in'),
  skills: 'all',  // 启用所有发现的技能
})
```

### Pi Agent SDK 路径 (clone-runtime.ts → clone tab)

```typescript
// In pi-sdk-adapter.ts, add extraSkillDirs support:
if (opts.extraSkillDirs?.length) {
  for (const dir of opts.extraSkillDirs) {
    const skills = scanSkills(dir)
    resourceLoader.skills.push(...skills)
  }
}
```

## Implementation Plan

### Phase 1: Provider 层

**1.1 `providers/src/types.ts` — SendQueryOptions 增加 plugins**
```typescript
interface SendQueryOptions {
  plugins?: Array<{ type: 'local'; path: string }>
  // ... existing
}
```

**1.2 `providers/src/claude/provider.ts` — 传递 plugins 到 SDK**
```typescript
const sdkOptions = {
  ...existing,
  plugins: options?.plugins,
}
```

### Phase 2: Server 路由层

**2.1 `server/src/routes/chat.ts` — Workspace 传入 main plugin**
```typescript
plugins: [{ type: 'local', path: getAgentDir() }]
```

**2.2 `server/src/routes/global-chat.ts` — Scheduler 传入 main + clone plugin**
```typescript
plugins: [
  { type: 'local', path: getAgentDir() },
  { type: 'local', path: getBuiltInCloneDir('scheduler') }
]
```

### Phase 3: 清理

**3.1 `clone-runtime.ts` — loadSkills() 移除 prompt 输出**
- `assembleContext()` 中的 `loadSkills()` 不再输出技能列表文本
- Pi SDK 路径改为通过 `resourceLoader.skills` 注入

**3.2 `system-prompt-assembler.ts` — 废弃 assembleForClone**
- 已标记 @deprecated，确认无调用后删除

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | Workspace 页面技能发现 | agent 自动发现共享 octo-agent-* 技能 | 浏览器：发送"你有什么技能" |
| 2 | Scheduler 页面技能发现 | agent 发现共享 + scheduler 分身技能 | 浏览器：发送"你有什么技能" |
| 3 | Clone tab 技能发现 | agent 发现共享 + clone 专属技能 | 浏览器：进入分身对话 |
| 4 | 技能隔离 | main plugin 不加载 clone 技能 | 单元测试 |
| 5 | 无 prompt 膨胀 | system prompt 不再包含技能列表文本 | 检查 assembleContext() 输出 |
| 6 | 技能命名空间 | 技能以 plugin 前缀出现 (如 `main-plugin:octo-agent-memory`) | 浏览器验证 |

## Verification Strategy

### Manual Checklist

**Workspace 页面:**
- [ ] 发送"你有什么技能" → 列出 octo-agent-* 技能（带 plugin 前缀）
- [ ] 发送"使用 octo-agent-memory 技能" → agent 能调用

**Scheduler 页面:**
- [ ] 发送"你有什么技能" → 列出共享 + scheduler 技能
- [ ] 技能调用正常

**Clone tab:**
- [ ] 分身对话中技能发现和调用正常

### Unit Tests
- [ ] Plugin 隔离测试：main plugin 不扫描 nested skills/
- [ ] getPlugins() 函数正确返回 plugin 路径

## Risks & Notes

- R1: 技能命名空间前缀（如 `main-plugin:octo-agent-memory`）可能影响技能调用方式。需确认 agent 能正确识别带前缀的技能。
- R2: `skills: 'all'` 会加载所有发现的技能，包括 ECC 内置技能。如果 prompt 过大，可能需要用 `skills: string[]` 过滤。
- R3: Pi SDK 路径的 `resourceLoader.skills` 注入需要构建正确的 Skill 对象格式（name, description, content, filePath）。

## Glossary

| Term | Meaning |
|------|---------|
| Plugin | Claude Agent SDK 的本地扩展包，包含 skills/agents/commands/hooks |
| Plugin surface | plugin 提供的扩展类型：skills, agents, commands, hooks |
| 技能发现 | SDK 自动扫描 plugin 目录的 `skills/` 子目录并注册技能 |
| 嵌套隔离 | SDK 不递归扫描 plugin 根目录的子目录，嵌套的 clone plugin 互不干扰 |
