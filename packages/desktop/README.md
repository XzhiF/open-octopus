# Octopus Desktop (Electron)

单窗口桌面壳：Electron 加载由 Node sidecar 同源托管的 Vite SPA。

## 结构

```
packages/desktop/
  src/main.ts             Electron 主进程（窗口/生命周期/sidecar）
  src/preload.ts          最小 preload（平台/版本）
  scripts/build-main.mjs  从 pnpm store 解析 tsup 编译 main/preload
  scripts/prepare-resources.mjs  构建并打包 sidecar/web/core-pack/Node runtime
  electron-builder.yml
  resources/              生成物（gitignored）
    runtime/node          随包携带的 Node 24
    server/dist           @octopus/server 构建产物
    server/vendor         sidecar 的生产依赖（原 node_modules，NODE_PATH 解析）
    web/                  Vite SPA dist
    packages/core-pack/   skills/agents/presets/clones/... 数据
  release/                electron-builder 输出（gitignored）
```

## 运行时模型

- **固定 loopback 端口** `47820`：`loadURL('http://127.0.0.1:47820')`。origin 稳定，localStorage/窗口状态不会因动态端口漂移。
- **同源**：server 设置 `OCTOPUS_HOST=127.0.0.1`，同时托管 `web/dist` 与 `/api`；前端 `getServerUrl()` 生产态返回 `window.location.origin`。
- **共享数据**：默认 DB 为 `~/.octopus/db/octopus.db`，与 CLI 共用；可用 `OCTOPUS_DESKTOP_DB_PATH` 覆盖。
- **独立 Node runtime**：sidecar 用 `resources/runtime/node` 启动，不使用 `ELECTRON_RUN_AS_NODE`。因此 better-sqlite3 保持 Node ABI，无需按 Electron ABI 重建，也不会污染 `pnpm dev` 使用的 pnpm store。
- **server 依赖**：`pnpm deploy --prod --legacy` 生成自包含依赖树，再重命名为 `vendor/`，sidecar 通过 `NODE_PATH` 解析（electron-builder 会过滤 extraResources 里的 `node_modules`）。
- **单实例**：`requestSingleInstanceLock()`；第二实例聚焦已有窗口。
- **外链**：同源链接回到主窗口；http(s)/mailto 交给系统浏览器；下载落到系统 Downloads。
- **退出**：窗口关闭 → SIGTERM sidecar → 最多 3s 后 SIGKILL；主进程等待后退出。

## 开发

终端 1：

```bash
pnpm dev                 # server:3001 + Vite:3000
```

终端 2：

```bash
pnpm --filter @octopus/desktop dev
# 或根目录 pnpm desktop:dev
```

dev 模式（`app.isPackaged === false`）只加载 `http://localhost:3000`，不启动自带 sidecar；可用 `OCTOPUS_DESKTOP_DEV_URL` 指向其它 Vite 端口。`OCTOPUS_DESKTOP_DEVTOOLS=1` 自动开 DevTools。

## 打包

```bash
# 生成 resources/ + .app（macOS arm64，未签名）
pnpm --filter @octopus/desktop pack:dir
# 产物：packages/desktop/release/mac-arm64/Octopus.app
```

`prepare:resources` 会先构建 server/web，再 deploy 生产依赖、清理外部软链、重命名 vendor、复制 Node runtime 与 core-pack 数据，并用打包后的 Node 实际加载一次 better-sqlite3 做自检。

分发前需要：
- 配置 Developer ID 签名与 notarization（当前 `identity: null` 仅用于本地冒烟）。
- 在目标平台（mac/win/linux）上执行打包，或提供对应平台的 Node runtime 与 Claude SDK 二进制。
- 安装包 target（当前 macOS 为 `dir`，可加 `dmg`）。

## 已知限制

- 应用体积较大（Electron + Node runtime + Claude SDK 平台包 + server 依赖）。
- 固定端口被占用时启动失败并弹错；不自动换端口（保证 origin 稳定）。
- `pnpm deploy` 后若 pnpm 在非交互环境提示 modules purge / 需要 TTY，跑一次交互式 `pnpm install` 即可；打包脚本本身用 store 内 tsup/vite 的绝对路径，不依赖 `.bin`。
- 不支持多窗口/浮动窗口、标签跨重启恢复、自动更新、托盘。
- 未做代码签名/公证；macOS 首次打开可能需要在系统设置中放行。
