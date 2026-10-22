# Web 去 Next：Vite SPA + 壳内常驻详情标签

## Context

`feat-new-ui-20261022` 已完成「桌面壳 v0.8」：AppShell 三栏、左导轨、右作业坞、对话常驻，`lib/app-navigation.tsx` 统一了 Link/useRouter/useSearchParams。但前端仍依赖 Next.js：根 layout 用 `headers()` 动态渲染并注入 `SERVER_URL`，5 组详情路由（工作空间、归档、运行观测、资源、调度作业）走 Next RSC，无法产出可打包的静态单页；后续 Electron 也无法只带一个静态渲染器。

前端实际是纯客户端：25 个 page 中绝大多数已是 client component，没有 Next API routes / server actions / SSR 数据读取；全仓仅 16 个源文件 import `next/*`。数据面全部走独立 Hono server。

## Decision

- **Next → Vite + React Router**：React Router 只负责 location/history；不使用 `<Routes>` 按路由挂载页面，避免切路由时卸载壳与常驻标签。所有页面模块保留在 `app/**`，新增 `src/main.tsx` 入口与 `lib/routes.tsx` 路由描述表。
- **壳内全路由**：顶层 10 个视图继续由 ViewHost 常驻；详情路由由 DetailTabsHost 以顶部标签承载。URL 是活动标签唯一真相；隐藏视图/标签各自保留 pinned path/search，导航互不串味。
- **标签规则**：同资源按 key 去重聚焦；最多 8 个，LRU 淘汰；打开 push、标签切换 replace、关闭活动标签 replace 到 MRU/回退路径；隐藏容器 `display:none + inert`，全局快捷键按 `active` 门禁。跨应用重启不恢复标签（M1 非目标）。
- **生产同源**：Vite 产出 `dist/`；server 通过 `OCTOPUS_WEB_DIR` 托管静态文件并对非 `/api` 路径回退 `index.html`。生产 `getServerUrl()` 返回 `window.location.origin`；dev 由 Vite 注入 `SERVER_URL` meta。prod 入口统一为 server 端口 3099，3098 不再启动 UI。
- **Monaco 本地化**：`lib/monaco-setup.ts` 静态配置 `loader.config({ monaco })` 与 `?worker` workers，删除 async CDN 回退，保证离线/Electron 可编辑。

## Considered Options

保留 Next + Electron 内嵌 `next start`：改动最小，但仍是 Next 路由、包体大、启动慢，不是纯 SPA——弃。Next `output: 'export'`：动态详情路由无 `generateStaticParams`，根 layout 又是动态渲染，需把详情改成 query 形态，逆着框架走——弃。浮动窗口/可拖拽分屏：工作空间管理器另立一期，M1 先做顶部标签——延后。

## Consequences

- 删除 `next`、`next-env.d.ts`、`next.config.mjs`、`middleware.ts`、根 layout、redirect 页面与仅 metadata 的 layouts；退役重定向逻辑移入 `lib/retired-redirects.ts`。
- `lib/app-navigation.tsx` 成为唯一导航 API，新增 `useParams` / `useIsActiveRoute`；隐藏标签里的 Cmd-K/Cmd-S/键盘监听必须门禁。
- 生产不再启动独立 web 进程，`pnpm prod` 只起 server（UI + API 同源）；文档端口表同步。
- 测试面：26 个 mock `next/navigation|next/link` 的测试已迁移/暂由 test-only alias 桥接；后续应全部改 mock `@/lib/app-navigation`。Playwright 的 webServer 改为 Vite。
- 已知遗留：仓库原有 `tsc` 类型债（Next 时代 `ignoreBuildErrors` 掩盖）仍需单独清偿；本 ADR 不扩大为全仓类型修复。
