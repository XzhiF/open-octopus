# Electron 桌面宿主：固定 loopback 同源 + 独立 Node sidecar

## Context

M1 已把 web-app 变成 Vite 静态 SPA，并由 server 通过 `OCTOPUS_WEB_DIR` 托管 `dist` + SPA fallback。下一步需要把同一份产物装进桌面应用：Electron 外壳、后端 sidecar 生命周期、稳定 origin、与 CLI 共享 `~/.octopus` 数据。

打包环境中 `better-sqlite3` 是原生模块。用 `ELECTRON_RUN_AS_NODE` + `@electron/rebuild` 会把 pnpm store 中被硬链接的 `.node` 就地改成 Electron ABI，导致同仓库的 `pnpm dev` 无法加载（NODE_MODULE_VERSION 139 vs 137）。动态端口又会改变 localStorage origin。

## Decision

- **Electron 加载 `http://127.0.0.1:47820`**，由 sidecar 同源托管 SPA/API/SSE/WS；固定端口 + 单实例锁保证 origin 稳定。
- **sidecar 使用随包携带的 Node runtime**（`resources/runtime/node`）启动，不经过 Electron 的 Node ABI；原生模块保持 Node 构建，无需 electron-rebuild。
- **server 依赖用 `pnpm deploy --prod --legacy` 生成自包含树**，重命名为 `vendor/` 并由 `NODE_PATH` 解析，绕过 electron-builder 对 extraResources 中 `node_modules` 的过滤；外部软链在打包前删除。
- **数据共享**：默认 `~/.octopus/db/octopus.db`，与 CLI 同一数据面；可用 `OCTOPUS_DESKTOP_DB_PATH` 覆盖。
- **安全/体验**：`contextIsolation` + `sandbox` + `nodeIntegration:false`；同源导航留在主窗口，http(s)/mailto 交系统浏览器；下载落 Downloads；退出时 SIGTERM→3s→SIGKILL sidecar；窗口状态持久化。
- server 增加 `OCTOPUS_HOST`、`/api/actuator/ready`（routes 挂载完成后 200）、DB 父目录创建、shutdown 时 `closeAllConnections()`。

## Considered Options

- Electron ABI 重建：包体略小，但会污染 pnpm store，破坏 Node dev；且每次打包需重置依赖。弃。
- 动态端口 + preload 注入 server URL：origin 随端口变化，localStorage/窗口状态不稳定；也失去同源 SSE/WS 的简单性。弃。
- Electron `file://` + CORS：`Origin: null` 被 server 拒绝，且相对路径/下载/外链行为更复杂。弃。
- 把 SPA 与 API 拆成两个本地服务：多一个进程和端口，CORS/代理复杂；同源单端口更简单。弃。

## Consequences

- 应用体积增加（约 0.9–1GB：Electron + Node runtime + Claude SDK 平台二进制 + server 依赖）；后续可做按平台裁剪/依赖打包优化。
- 打包必须在目标平台执行（Node runtime 与 Claude SDK 平台包与架构绑定）；当前 macOS arm64 输出 `dir`，未签名。
- 固定端口 47820 被占用时启动失败并提示；不自动换端口。
- 删除 `vendor` 外部软链后，server 不再能看到 workspace CLI/self 链接；sidecar 运行只需自身依赖与 core-pack 数据。
- 文档/验证：dev 模式依赖 `pnpm dev`；打包模式用 `playwright` 启动 `.app` 验证同源加载、导航、sidecar 退出与端口释放。
