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
    runtime/node(.exe)    随包携带的 Node 24（Windows 为 node.exe）
    server/dist           @octopus/server 构建产物
    server/node_modules   sidecar 的生产依赖（hoisted 扁平布局，保留原名）
    web/                  Vite SPA dist
    packages/core-pack/   skills/agents/presets/clones/... 数据
  release/                electron-builder 输出（gitignored）
```

## 运行时模型

- **固定 loopback 端口** `47820`：`loadURL('http://127.0.0.1:47820')`。origin 稳定，localStorage/窗口状态不会因动态端口漂移。
- **同源**：server 设置 `OCTOPUS_HOST=127.0.0.1`，同时托管 `web/dist` 与 `/api`；前端 `getServerUrl()` 生产态返回 `window.location.origin`。
- **共享数据**：默认 DB 为 `~/.octopus/db/octopus-prod.db`（与 `pnpm prod` 同一份，
  dev 的 `octopus.db` 留给 `pnpm dev`）；可用 `OCTOPUS_DESKTOP_DB_PATH` 覆盖。
- **独立 Node runtime**：sidecar 用 `resources/runtime/node`（Windows 为 `node.exe`）启动，不使用 `ELECTRON_RUN_AS_NODE`。因此 better-sqlite3 保持 Node ABI，无需按 Electron ABI 重建，也不会污染 `pnpm dev` 使用的 pnpm store。
- **server 依赖**：`pnpm deploy --prod --legacy --config.node-linker=hoisted --config.ignore-scripts=true` 生成自包含依赖树。必须用 hoisted 布局并保留 `node_modules` 目录名 —— isolated 布局在 Windows 上是绝对路径 junction，换目录/换机器即断链；而 ESM 的裸模块解析不认 `NODE_PATH`。deploy 跳过了 install 脚本，编译好的 `better-sqlite3` 二进制由脚本从工作区补入。
- **单实例**：`requestSingleInstanceLock()`；第二实例聚焦已有窗口。
- **外链**：同源链接回到主窗口；http(s)/mailto 交给系统浏览器；下载落到系统 Downloads。
- **托盘常驻**：关窗 = 收进托盘（窗口与 sidecar 都留着），真退出走托盘菜单，见下一节。
- **退出**：SIGTERM sidecar → 最多 3s 后 SIGKILL；主进程等待后退出。

## 托盘常驻

桌面壳就是 server 的宿主，所以关窗不等于退出：`close` 被拦下改成隐藏，sidecar 继续在
`127.0.0.1:47820` 上服务 —— 手机 / 局域网 / 远程控制靠的就是这一点。

- **托盘菜单**：显示主窗口 / 开机自启（勾选，仅打包版可用）/ 退出 Octopus。
- **Windows·Linux**：左键点图标回窗口，右键出菜单。图标用 `build/tray/tray-16.png` 与
  `tray-32.png` 两档（按 DPI 选），打包时由 `electron-builder.yml` 复制到 `resources/tray`。
- **macOS**：`trayTemplate.png` 是模板图，跟随菜单栏明暗（`@2x` 自动带上）；窗口隐藏时
  `app.dock.hide()`，重新打开再 `show()`。
- **`--tray`**：启动后窗口不显示，只在托盘里待着（登录自启走这条）。macOS 13+ 登录项
  不传参数，改用 `app.getLoginItemSettings().wasOpenedAtLogin` 判断。
- **图标缺失时**退回旧行为：关窗即退出，避免留下找不回的进程。
- **agent 守卫**：原先挂在窗口 close 上的「agent 还在跑」确认框移到托盘退出，查
  `GET /api/agent/sessions/running`（仅打包版；dev 的 server 与窗口不同源，不查）。

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

### 走代理打包（国内网络）

```bash
pnpm desktop:dist:proxy        # 全量打包，自动读系统代理
pnpm desktop:pack:proxy        # 同上，只出 release/win-unpacked
pnpm desktop:dist:proxy -- --proxy http://127.0.0.1:7890
node packages/desktop/scripts/pack.mjs --dry-run    # 只看代理 / Electron zip 缓存状态
```

代理按 `HTTP(S)_PROXY` 环境变量 → Windows 系统代理设置（Internet Settings）的顺序自动发现，并同时注入给 `pnpm deploy` 与 electron-builder。打包前会打印 Electron zip 的缓存命中情况：命中则 130MB 发行包不会重下；日志里的 `downloaded label=electron` 多半是每次都会重拉的 `SHASUMS256.txt` 校验文件。

分发前需要：
- 配置 Developer ID 签名与 notarization（当前 `identity: null` 仅用于本地冒烟）。
- 在目标平台（mac/win/linux）上执行打包，或提供对应平台的 Node runtime 与 Claude SDK 二进制。
- 安装包 target（当前 macOS 为 `dir`，可加 `dmg`）。

## 已知限制

- 应用体积较大（Electron + Node runtime + Claude SDK 平台包 + server 依赖）。
- 固定端口被占用时启动失败并弹错；不自动换端口（保证 origin 稳定）。
- `pnpm deploy` 后若 pnpm 在非交互环境提示 modules purge / 需要 TTY，跑一次交互式 `pnpm install` 即可；打包脚本本身用 store 内 tsup/vite 的绝对路径，不依赖 `.bin`。
- 不支持多窗口/浮动窗口、标签跨重启恢复、自动更新。
- 未做代码签名/公证；macOS 首次打开可能需要在系统设置中放行。
