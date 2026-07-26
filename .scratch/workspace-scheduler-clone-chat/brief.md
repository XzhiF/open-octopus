# Requirement Brief: Workspace & Scheduler Chatbot → Clone 身份替换 (v3)

## Overview

将 `/workspaces/:id` 和 `/scheduler` 页面的 chatbot 后端替换为对应的 workspace / scheduler 分身身份。分身拥有正确的人格、记忆和技能，每个分身在独立 CWD 下工作。

## Projects Involved

- [x] `packages/server` (clone-runtime 技能模型 + CWD 策略 + 页面接入)
- [ ] `packages/web-app` (不动)

## Feature Scope

**Do:**
- `CloneRuntime.loadSkills()` 重写为两层技能模型（共享 + 分身专属）
- 技能输出格式：基准目录声明 + 分组列表（名称+描述）
- CWD 策略：分身自己的目录，workspace 页面由调用方覆盖
- Workspace 页面使用 workspace 分身身份 + Claude Agent SDK
- Scheduler 页面使用 scheduler 分身身份 + Claude Agent SDK
- 修正 scheduler 技能名 `octo-schedule-manager` → `octo-scheduler`
- Agent Tab 保持基础 clone chat（不变）

**Don't:**
- 不修改前端
- 不迁移旧对话历史
- 不改变 SSE 事件格式
- 不使用 resource 模块的 installed 路径

## Integration Paths — 两条集成路径

### Workspace 页面 (`/workspaces/:id`)

```
浏览器 → POST /api/workspaces/:id/chat/sessions/:sid/messages

chat.ts:
  cwd       = workspace.path              ← 操作项目文件
  cloneDef  = getBuiltinCloneDef('workspace')
  clonePrompt = new CloneRuntime(cloneDef, org).assembleContext()
               ├─ persona: "全栈开发助手"
               ├─ shared memory (memoryScope: shared → 读全局记忆)
               └─ skills: [] → 无技能段

  agent.sendQuery(msg, cwd, session, {
    systemPrompt: { preset: 'claude_code', append: clonePrompt }
  })
  // claude_code preset → 读取 workspace.path 下的 CLAUDE.md + 工具调用
```

### Scheduler 页面 (`/scheduler`)

```
浏览器 → POST /api/chat/global/sessions/:sid/messages

global-chat.ts:
  cwd       = ~/.octopus/agent/built-in/scheduler/    ← 分身自己的目录
  cloneDef  = getBuiltinCloneDef('scheduler')
  clonePrompt = new CloneRuntime(cloneDef, org).assembleContext()
               ├─ persona: "定时任务管理"
               ├─ isolated memory (memoryScope: isolated → 只读隔离记忆)
               └─ skills: ['octo-scheduler'] → 分身技能段

  agent.sendQuery(msg, cwd, session, {
    systemPrompt: { preset: 'claude_code', append: clonePrompt }
  })
```

### 对比

| | Workspace 页面 | Scheduler 页面 |
|---|---|---|
| 后端文件 | `chat.ts` | `global-chat.ts` |
| CWD | `workspace.path` (项目目录) | `built-in/scheduler/` (分身目录) |
| persona | 全栈开发助手 | 定时任务管理 |
| memoryScope | shared (读全局记忆) | isolated (隔离记忆) |
| skills | `[]` (空，后续设计安装功能) | `['octo-scheduler']` |
| CLAUDE.md | 项目目录下的 | 分身目录下的 (如有) |

## Architecture — 断裂与修复

### 断裂 1: SkillLoader 技能模型

```
当前 (broken):
  Tier 1: ~/.octopus/agent/skills/                     ✅ 本地进化
  Tier 2: {cwd}/packages/core-pack/skills/              ❌ 开发专用
  Tier 3: ~/.octopus/prod/.../skills/                   ❌ 不存在

修复后 — 两层模型:
  共享: ~/.octopus/agent/skills/                        (全局共享, 父级)
  分身: ~/.octopus/agent/built-in/{clone}/skills/       (built-in clone)
        ~/.octopus/agent/clones/{clone}/skills/         (user clone)

  同名优先级: 分身 > 共享
```

### 断裂 2: CWD 设计

```
当前 (broken):
  所有 clone → ~/.octopus/agent                  ❌ 无隔离，无归属

修复后:
  built-in clone → ~/.octopus/agent/built-in/{name}/    分身自己的目录
  user clone     → ~/.octopus/agent/clones/{name}/      分身自己的目录
  Workspace 页面 → workspace.path                       调用方覆盖
```

### 断裂 3: 技能输出格式

```
当前 (broken):
  - **name**: description     (只有名称+描述，无路径指令)

修复后 — 基准目录声明 + 分组列表:
  # 可用技能
  当需要使用某个技能时，用 Read 工具读取 {基准目录}/{技能名}/SKILL.md

  共享: ~/.octopus/agent/skills
  - **octo-agent-memory**: Search and manage agent memory layers.

  分身: ~/.octopus/agent/built-in/scheduler/skills
  - **octo-scheduler**: Octopus Scheduler API 操作助手。
```

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | 替换边界 | 仅后端，前端不动 | 最小改动，无缝迁移 |
| 2 | 历史数据 | 丢弃，全新开始 | 简化迁移 |
| 3 | Workspace SDK | 复用现有 Claude SDK，换 system prompt | 保留 CLAUDE.md + 工具 |
| 4 | 技能模型 | 两层：共享 + 分身目录，同名分身优先 | 独立分身设计，不依赖 resource 模块 |
| 5 | 技能输出 | 基准目录声明 + 分组列表（名称+描述） | 紧凑，agent 自拼路径 |
| 6 | CWD | 分身自己的目录，workspace 页面调用方覆盖为 workspace.path | 隔离 + 归属清晰 |
| 7 | workspace 技能 | 保持 `[]`，后续版本设计分身技能安装 | 可改，不急 |
| 8 | scheduler 技能名 | `octo-schedule-manager` → `octo-scheduler` | 与实际安装的技能名对齐 |
| 9 | Agent Tab | 不变，基础 clone chat | 只有 workspace/scheduler 页面特殊 |
| 10 | 验证方式 | 手动浏览器测试 | 快速验证 |

## Implementation Plan — 改动清单

### Phase 1: 基础设施

**1.1 `paths.ts` — 新增 `getCloneSkillsDir()`**
```typescript
export function getCloneSkillsDir(name: string, type: 'built-in' | 'user'): string {
  if (type === 'built-in') {
    return path.join(getBuiltInCloneDir(name), 'skills')
  }
  return path.join(getCloneDir(name), 'skills')
}
```

**1.2 `clone-runtime.ts` — `loadSkills()` 重写 + CWD 默认值**
```typescript
// loadSkills: 两层扫描 + 分组输出
private loadSkills(): string {
  // 1. 扫描共享技能: ~/.octopus/agent/skills/
  // 2. 扫描分身技能: built-in/{name}/skills/ 或 clones/{name}/skills/
  // 3. 按 cloneDef.skills 过滤 (空数组 = 不过滤)
  // 4. 同名分身优先
  // 5. 输出: 基准目录 + 分组列表
}

// CWD 默认改为 clone 自己的目录
private getDefaultCwd(): string {
  return this.cloneDef.type === 'built-in'
    ? getBuiltInCloneDir(this.cloneDef.name)
    : getCloneDir(this.cloneDef.name)
}
```

**1.3 `builtin-clones.ts` — 修正 scheduler 技能名**
```typescript
{
  name: 'scheduler',
  skills: ['octo-scheduler'],  // 原来是 'octo-schedule-manager'
}
```

### Phase 2: 页面接入

**2.1 `chat.ts` — Workspace 分身 (cwd = workspace.path)**
```typescript
import { CloneRuntime } from '../services/agent/clone-runtime'
import { getBuiltinCloneDef } from '../services/agent/builtin-clones'

const cloneDef = getBuiltinCloneDef('workspace')
const clonePrompt = cloneDef
  ? new CloneRuntime(cloneDef, 'default').assembleContext()
  : ''

agent.sendQuery(body.content, cwd, session.providerSessionId, {
  systemPrompt: { type: 'preset', preset: 'claude_code', append: clonePrompt || undefined },
  abortSignal: abortController.signal,
})
// cwd 保持 workspace.path — 操作项目文件
```

**2.2 `global-chat.ts` — Scheduler 分身 (cwd = built-in/scheduler/)**
```typescript
import { CloneRuntime } from '../services/agent/clone-runtime'
import { getBuiltinCloneDef } from '../services/agent/builtin-clones'

const cloneDef = getBuiltinCloneDef('scheduler')
const clonePrompt = cloneDef
  ? new CloneRuntime(cloneDef, 'default').assembleContext()
  : SYSTEM_PROMPT  // fallback

const cwd = getBuiltInCloneDir('scheduler')  // 分身自己的目录

agent.sendQuery(body.content, cwd, session.providerSessionId, {
  systemPrompt: { type: 'preset', preset: 'claude_code', append: clonePrompt },
  abortSignal: abortController.signal,
})
```

### Phase 3: 清理

- `global-chat.ts` 的 `loadSchedulerSystemPrompt()` + `SKILL_SEARCH_PATHS` → 保留作为 fallback
- `SystemPromptAssembler.assembleForClone()` → 标记废弃（不再使用）

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | Workspace 分身身份 | AI 以"全栈开发助手"身份回答 | 浏览器：发送"你是谁" |
| 2 | Workspace CLAUDE.md | AI 读取项目目录下的 CLAUDE.md | 浏览器：发送"读取 CLAUDE.md" |
| 3 | Workspace 工具调用 | Bash/Read/Write 相对于 workspace.path | 浏览器：发送"ls" |
| 4 | Workspace 共享记忆 | AI 能访问全局长期记忆 | 浏览器：发送"你记得什么" |
| 5 | Scheduler 分身身份 | AI 以"定时任务管理"身份回答 | 浏览器：发送"你是谁" |
| 6 | Scheduler 技能 | 列出 octo-scheduler 技能，能 Read 其 SKILL.md | 浏览器：发送"你有什么技能" |
| 7 | Scheduler CWD | Bash/Read/Write 相对于 built-in/scheduler/ | 浏览器：发送"pwd" |
| 8 | Scheduler 隔离记忆 | 不读全局记忆，只用隔离记忆 | 浏览器：发送"你记得什么" |
| 9 | Agent Tab 不受影响 | clone chat 行为不变 | 浏览器：对比重造前后 |

## Verification — 手动测试清单

**Workspace 页面 (`/workspaces/:id`):**
- [ ] 发送"你是谁" → "我是 Workspace 分身，全栈开发助手"
- [ ] 发送"ls" → 输出 workspace.path 下的文件（项目文件）
- [ ] 发送"读取 CLAUDE.md" → 成功读取项目 CLAUDE.md
- [ ] 发送"你记得什么" → 能引用全局长期记忆内容

**Scheduler 页面 (`/scheduler`):**
- [ ] 发送"你是谁" → "我是 Scheduler 分身，专注定时任务管理"
- [ ] 发送"pwd" → 输出 `~/.octopus/agent/built-in/scheduler`
- [ ] 发送"你有什么技能" → 只显示 octo-scheduler
- [ ] 发送"读取 octo-scheduler 技能" → 成功读取 SKILL.md
- [ ] 发送"你记得什么" → 不引用全局记忆（isolated）

**Agent Tab (`/agent?tab=clone`):**
- [ ] 分身列表正常
- [ ] clone 对话行为与改造前一致

## Risks & Notes

- R1: `cloneDef.skills: []` 在两层模型中意味着"不过滤"。当共享目录和分身目录都没有技能时，技能段为空——这是预期行为。
- R2: workspace 分身 memoryScope=shared，`assembleContext()` 会读全局记忆 + 隔离记忆。如果全局记忆很大，可能影响 prompt 大小。当前 `truncateToBudget` 机制可缓解。
- R3: scheduler 目录目前没有 CLAUDE.md。`claude_code` preset 会静默跳过不存在的 CLAUDE.md——无影响。

## Glossary

| Term | Meaning |
|------|---------|
| 共享技能 | `~/.octopus/agent/skills/` — 所有分身可继承的全局技能 |
| 分身技能 | `built-in/{name}/skills/` 或 `clones/{name}/skills/` — 分身专属技能 |
| memoryScope | `shared` = 读全局记忆 + 隔离记忆; `isolated` = 只读隔离记忆 |
| 基准目录声明 | 技能输出中声明一次目录路径，agent 自拼 `{base}/{name}/SKILL.md` |
