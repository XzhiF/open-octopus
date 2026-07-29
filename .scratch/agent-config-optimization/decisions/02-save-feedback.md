# 02 — 保存反馈通知系统

Type: research+grilling
Status: resolved
Blocked by: None

## Question

所有保存按钮目前没有用户可见的反馈（成功/失败通知）。是前端完全没实现 toast，还是有实现但存在 bug？需要确认：
1. web-app 是否已安装 toast/notification 库（如 sonner, react-hot-toast）？
2. 其他页面（如对话、记忆）是否有使用 toast 的先例？
3. saveConfig/savePersona 的 Promise 链是否正确处理了 loading/success/error 状态？

## Answer

### 1. Toast/Notification 库安装情况

**已安装两套 toast 系统：**

| 库 | 版本 | 位置 |
|---|---|---|
| `sonner` | `^1.7.1` | `package.json` line 71 |
| `@radix-ui/react-toast` | `1.2.15` | `package.json` line 44 |

对应的 UI 组件和 hooks：
- **Sonner**: `components/ui/sonner.tsx` — 封装了 `<Toaster>` 组件，适配 next-themes 主题
- **Radix Toast**: `components/ui/toast.tsx` + `components/ui/toaster.tsx` + `components/ui/use-toast.ts`（与 `hooks/use-toast.ts` 是完全相同的副本）

### 2. Toast 使用情况

**Sonner `toast()` 在 agent 模块中被广泛使用：**

| 组件 | 文件 | toast 调用 |
|---|---|---|
| GeneralConfig | `components/agent/config/GeneralConfig.tsx` | `toast.success('通用配置已保存')`, `toast.error('保存失败')`, 验证错误 toast |
| PersonaEditor | `components/agent/config/PersonaEditor.tsx` | `toast.success('人格设定已更新')` — **缺少 error 分支** |
| NotificationConfig | `components/agent/config/NotificationConfig.tsx` | `toast.success/error` for save + test notification |
| MemoryStrategyConfig | `components/agent/config/MemoryStrategyConfig.tsx` | `toast.success('记忆策略已保存')`, `toast.error(...)` |
| SafeModePanel | `components/agent/config/SafeModePanel.tsx` | `toast.success('安全降级已启用/解除')` |
| Memory 模块 | `LongTermEditor.tsx`, `DailyBrowser.tsx`, `RefineModal.tsx` | 大量 `toast.success/error` |
| Clone 模块 | `CloneCreateWizard.tsx`, `CloneFilePanel.tsx`, `CloneMergeDialog.tsx`, `CloneDeleteDialog.tsx` | 大量 `toast.success/error` |
| Knowledge 模块 | `ExperienceDetail.tsx`, `ReviewQueueList.tsx`, `ArchiveDialog.tsx`, `PreferenceCard.tsx` 等 | 大量 `toast.success/error` |
| Skill 模块 | `SkillDetailView.tsx` | `toast.success('SKILL 已保存')` |

**Radix `toast()` 仅在 scheduler 模块使用：**
- `app/scheduler/page.tsx` — `import { toast } from "@/hooks/use-toast"`
- `app/scheduler/jobs/[id]/page.tsx` — `import { useToast } from "@/hooks/use-toast"`

**Sonner 在 system/workspaces 模块也有使用：**
- `app/system/repos/page.tsx` — `import { toast } from "sonner"`
- `app/workspaces/[id]/page.tsx` — `import { toast } from "sonner"`
- `app/workspaces/[id]/archive-detail/page.tsx` — `import { toast } from "sonner"`

### 3. 核心 Bug：`<Toaster>` 未挂载在 Agent 页面的布局层级中

**这是导致保存反馈完全不可见的根本原因。**

Sonner `<Toaster>` 仅在以下两个布局中挂载：
- `app/system/layout.tsx` — `<Toaster position="top-right" />`（仅覆盖 `/system/*` 路由）
- `components/resource/resource-layout.tsx` — `<Toaster position="top-right" />`（仅覆盖 `/resources/*` 路由）

以下布局**没有**挂载任何 `<Toaster>`：
- `app/layout.tsx`（根布局）— 无 Toaster
- `app/agent/layout.tsx` — 仅 `<>{children}</>`，无 Toaster
- `app/scheduler/layout.tsx` — 仅 `<>{children}</>`，无 Toaster
- `app/settings/layout.tsx` — 无 Toaster
- `app/experience/layout.tsx` — 无 Toaster
- `app/workspaces/` — 无 layout.tsx，无 Toaster
- `components/providers/app-shell.tsx` — 无 Toaster

**影响范围**：所有 agent 页面（config、memory、clone、knowledge、skill）、scheduler 页面、workspaces 页面的 toast 调用全部静默失败——`toast.success()` 和 `toast.error()` 被调用但用户永远看不到。

此外，Radix Toast 的 `components/ui/toaster.tsx` 也从未被任何页面导入——它是死代码。scheduler 页面虽然调用了 `toast()` from `hooks/use-toast`，但因为没有组件订阅该 state 并渲染 UI，同样不可见。

### 4. `useAgentConfig` Hook 分析

Hook 本身的 state 管理是正确的：

```typescript
// saveConfig (line 29-42): 
// - setSaving(true) → try api.updateConfig() → setSaving(false)
// - 成功返回 true，失败 setError() + 返回 false
// - 有完整的 try/catch/finally

// savePersona (line 44-56):
// - 同样的模式，正确返回 boolean
```

调用方（GeneralConfig、NotificationConfig、MemoryStrategyConfig）都正确检查了返回值并调用了 `toast.success()` 或 `toast.error()`。**toast 调用逻辑本身没有 bug——问题纯粹是 `<Toaster>` 没有挂载。**

一个小缺陷：`PersonaEditor.tsx` line 26-28 只有成功分支 `if (ok) toast.success(...)` 而**缺少 `else` 的 error toast**，与其他三个 config 组件不一致。

### 5. 其他页面的反馈模式

| 页面 | 反馈方式 | 是否可见 |
|---|---|---|
| `/system/repos` | sonner `toast.success/error` | ✅ 可见（system layout 有 Toaster） |
| `/system/models` | 未使用 toast | N/A |
| `/workspaces/[id]` | sonner `toast.success/error` | ❌ 不可见（无 Toaster） |
| `/scheduler` | Radix `toast()` from hooks | ❌ 不可见（无 Toaster 渲染组件） |
| `/agent/config/*` | sonner `toast.success/error` | ❌ 不可见（无 Toaster） |
| `/agent/memory/*` | sonner `toast.success/error` | ❌ 不可见（无 Toaster） |
| `/agent/clone/*` | sonner `toast.success/error` | ❌ 不可见（无 Toaster） |
| `/agent/knowledge/*` | sonner `toast.success/error` | ❌ 不可见（无 Toaster） |
| `/agent/skill/*` | sonner `toast.success/error` | ❌ 不可见（无 Toaster） |

### 6. 建议修复方案

**最小修复**：在 `app/layout.tsx`（根布局）的 `<AppShell>` 内或 `components/providers/app-shell.tsx` 中添加 Sonner `<Toaster>`。这样所有页面都能显示 toast。

```tsx
// app/layout.tsx 或 components/providers/app-shell.tsx
import { Toaster } from "@/components/ui/sonner"

// 在 AppShell 内添加:
<Toaster position="top-right" richColors closeButton />
```

**附带清理**：
1. 修复 `PersonaEditor.tsx` 缺少 error toast 的问题
2. 删除死代码 `components/ui/toaster.tsx`、`components/ui/toast.tsx`、`components/ui/use-toast.ts`、`hooks/use-toast.ts`（Radix toast 系统从未被正确挂载）
3. 或者将 scheduler 页面从 Radix toast 迁移到 sonner，统一 toast 系统
4. 从 `package.json` 移除 `@radix-ui/react-toast` 依赖（如果完全弃用 Radix toast）

**决定**: 完整修复 + 清理
1. 在根布局 `app/layout.tsx` 的 AppShell 内添加 Sonner `<Toaster position="top-right" richColors closeButton />`
2. 修复 `PersonaEditor.tsx` 缺少 error 分支 toast
3. 删除 Radix toast 死代码: `components/ui/toaster.tsx`、`components/ui/toast.tsx`、`components/ui/use-toast.ts`、`hooks/use-toast.ts`
4. 将 scheduler 页面从 Radix toast 迁移到 sonner
5. 从 `package.json` 移除 `@radix-ui/react-toast` 依赖
6. 删除 `system/layout.tsx` 和 `resource-layout.tsx` 中重复的 `<Toaster>` 挂载
