# 前端 UI 系统契约 (ui-system-auditor)

> 本文档为 `00-host-contract.md` 的子文档，专注前端技术栈与约束。

## 1. 框架与运行时

| 项 | 值 |
|----|-----|
| 框架 | **Next.js 16.2** (App Router) |
| React | **19.2** (RSC 启用) |
| 构建 | next build (Turbopack) |
| 测试 | Vitest + @testing-library/react + Playwright (E2E) |
| 语言 | TypeScript 5.7 |

## 2. 样式系统

### Tailwind CSS v4

- PostCSS 插件: `@tailwindcss/postcss`
- 颜色系统: **oklch** CSS 变量 (定义在 `globals.css`)
- 暗色模式: `next-themes` → `.dark` class + CSS 变量
- 动画: `tw-animate-css`

### 组件变体: CVA + cn()

```typescript
// packages/web-app/lib/utils.ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 所有组件使用 cva 定义变体，cn() 合并 className
import { cva } from 'class-variance-authority'
const buttonVariants = cva("base-classes", {
  variants: { variant: {...}, size: {...} },
  defaultVariants: { variant: 'default', size: 'default' },
})
```

**强制规则:** 所有新组件 **必须** 使用 `cn()` 合并 className，**必须** 使用 CVA 定义变体。

## 3. 组件库: shadcn/ui (new-york)

57 个 UI 基础组件在 `packages/web-app/components/ui/`:

| 类别 | 组件 |
|------|------|
| 布局 | accordion, collapsible, resizable, sheet, sidebar |
| 按钮 | button, button-group, toggle, toggle-group |
| 表单 | form, input, textarea, select, checkbox, radio-group, switch, slider, label, field, input-group, input-otp, calendar, auto-resize-textarea |
| 反馈 | alert, alert-dialog, dialog, toast, sonner, spinner, progress, skeleton, empty |
| 导航 | breadcrumb, menubar, navigation-menu, tabs, pagination, command |
| 数据展示 | avatar, badge, card, table, chart, chart-error-boundary, kbd, item |
| 弹出 | popover, hover-card, dropdown-menu, context-menu, tooltip, drawer, vaul |
| 其他 | aspect-ratio, scroll-area, separator, carousel, separator |

**图标库:** `lucide-react` (唯一图标库)

## 4. 状态管理

**无外部状态库** — 仅使用:
- React Context (通过 Provider 组件)
- Custom Hooks (34 个 hooks)
- 组件内 useState/useReducer

**强制规则:** 不要引入 Redux/Zustand/Jotai 等外部状态库。需要跨组件状态时，使用 Context + Hook 模式。

## 5. HTTP 通信

### apiFetch 包装器

```typescript
// packages/web-app/lib/api-client.ts
function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, credentials: "include" })
}
```

### Server URL 解析

```typescript
// packages/web-app/lib/server-config.ts
export function getServerUrl(): string {
  if (typeof window !== "undefined") {
    const fromHtml = document.documentElement.dataset.serverUrl
    if (fromHtml) return fromHtml
  }
  return "http://localhost:3001"
}
```

Root layout 通过 `<html data-server-url={serverUrl}>` 注入服务端运行时 URL。

### 错误处理模式

```typescript
async function handleResponse(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}
```

### 实时通信

| 协议 | 用途 | 实现 |
|------|------|------|
| WebSocket | 聊天 + Yjs 协同编辑 | 原生 WebSocket API |
| SSE | 执行事件流 | EventSource / fetch stream |

## 6. 表单

- **react-hook-form** + **@hookform/resolvers** + **zod** schema 验证
- shadcn/ui `<Form>` 组件封装了 react-hook-form

## 7. 路由与页面

App Router 页面结构:

```
app/
├── layout.tsx          ← RootLayout (Server Component)
├── page.tsx            ← 首页/Dashboard
├── agent/              ← Agent 对话界面
│   └── layout.tsx
├── scheduler/          ← 调度器管理
│   └── layout.tsx
├── settings/           ← 设置页面
│   └── layout.tsx
└── ...
```

## 8. 路径别名

```json
{
  "@/components/*": "packages/web-app/components/*",
  "@/lib/*": "packages/web-app/lib/*",
  "@/hooks/*": "packages/web-app/hooks/*"
}
```

## 9. 关键第三方库

| 库 | 用途 |
|----|------|
| `@xyflow/react` | DAG/流程图渲染 |
| `@monaco-editor/react` | 代码编辑器 |
| `y-monaco` + `y-websocket` + `yjs` | 协同编辑 |
| `recharts` | 图表 |
| `date-fns` | 日期处理 |
| `react-markdown` + `remark-gfm` | Markdown 渲染 |
| `cmdk` | 命令面板 |
| `sonner` | Toast 通知 |
| `react-resizable-panels` | 可调整面板 |
| `react-window` | 虚拟列表 |

## 10. 已知风险

1. **RSC 边界** — 使用 hooks/浏览器 API 的组件必须标记 `'use client'`，容易遗漏
2. **无全局状态库** — 复杂跨组件状态需精心设计 Context 层级
3. **Cookie 认证** — 前端用 `credentials: "include"` (cookie)，后端 Agent API 用 Bearer token — 两种认证机制并存
