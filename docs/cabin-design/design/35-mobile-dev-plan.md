# 35 · 手机 App 开发计划（Flutter）

> 状态：**计划**（2026-11-26）· 设计基线：`34-mobile-v1.md` + `../mobile-v1.html`（V1 定版）
> 调研与可达性：`../../research/mobile-remote-control.md`
> 本文只回答「怎么落地、先后顺序、验收标准」；界面规则一律以 34 为准。

---

## 0. 定版基线与已定决策

| 项 | 决定 |
|---|---|
| 原型 | `docs/cabin-design/mobile-v1.html` 8 屏（A–H），2026-11-26 定版 |
| 技术栈 | **Flutter**（Android 先，iOS 后） |
| 仓库位置 | `packages/mobile/`（pubspec 独立，**不加入 pnpm workspace**） |
| 网络 | 只走 **Tailscale**（手机装 Tailscale App）；不绑 `0.0.0.0`、不开公网隧道、不做 App 内 VPN |
| 鉴权 | v1 先裸连 tailnet；M3 加「单设备令牌」的最简实现（详见 §3） |
| 推送 | v1 不做；真要做时接自建 **ntfy**（见记忆 `mobile-push-ntfy-fallback`） |
| 远程拉起 | M4 可选（sshd + `octopus-ctl` + 计划任务），不阻塞 v1 |
| 应用图标 | **与 PC 同一张** `packages/desktop/build/icon.png`（512×512），不重绘；只做系统遮罩 |
| 会话内容 | 与桌面同一份 TUI 语法：`❯` / `✦ 汐音 + meta` / `◌` / `▸ tool [✓]` / `✳` |

---

## 1. 范围

**v1 做：**

1. 设备列表（手动添加 Tailscale 域名，`/api/actuator/health` 探活）。
2. 舱列表 + 舱内三块：待你定 / 会话 / 任务（任务只读）。
3. 待你定 → 点开回到会话 → 问题引用进输入框 → 人说话，agent 改状态。
4. 舱会话列表、会话详情、发消息、SSE 流式输出。
5. 单独会话（`/api/chat/global/sessions`）。
6. 视觉：全舱素材（2 幕场景 + 星流 + 立绘 3 状态）+ 圆角矩形。
7. 设置：设备管理（增删 / 重命名 / 令牌）、动效开关。

**v1 不做：**

- 改 spec 字段 / 工作流 YAML / 归档 / 删舱 —— 明细仍回 PC。
- 推送、多用户、生物识别、云端中转。
- 任务写操作（触发 / 验收 / 归档）。
- iOS 构建（需要 macOS + Apple 账号，先 Android）。

---

## 2. 工程结构

```
packages/mobile/
├── pubspec.yaml
├── assets/
│   ├── scenes/            ← scene-cruise.webp / scene-deepspace.webp（同步脚本拷贝）
│   ├── clips/             ← 07-idle.webp / 05-concerned.webp / 09-smile.webp（先 3 支，WebP 动画）
│   ├── crew/              ← xiyin-idle.png（头像 / 视频兜底帧）
│   └── icon/              ← icon.png（来自 packages/desktop/build/icon.png）
├── lib/
│   ├── main.dart
│   ├── app/               ← router / theme / bootstrap
│   ├── core/
│   │   ├── config.dart    ← 设备列表、当前设备、baseUrl、token
│   │   ├── http.dart      ← dio 实例 + 错误归一
│   │   ├── sse.dart       ← POST/GET SSE 解析 + 断线重连
│   │   ├── storage.dart   ← secure storage（token）+ prefs（设备 / 偏好）
│   │   └── models/        ← 手写模型（Cabin / Attention / Task / ChatMessage / SSE）
│   ├── features/
│   │   ├── devices/       ← 列表 / 添加 / 远程拉起占位
│   │   ├── cabins/        ← 舱列表 / 舱内三块
│   │   ├── chat/          ← 会话列表 / TUI 转录 / 输入框 / 引用条
│   │   ├── tasks/         ← 任务只读
│   │   └── settings/
│   └── widgets/           ← RoundedPanel / StatusPill / SceneBackground /
│                            Starfield / CrewFigure / TuiTranscript / Composer
├── scripts/sync-assets.mjs  ← 从 docs/cabin-design 拷素材（避免双份入库）
├── test/ · integration_test/
```

**依赖（最小集）**：`flutter_riverpod` · `go_router` · `dio` · `flutter_secure_storage` ·
`shared_preferences` · `video_player` · `mobile_scanner`（M3）· `flutter_launcher_icons`（构建期）。

**主题 token**（照抄原型）：主色 `#2EE6D6`、靛底 `#0d0a1e`、卡片圆角 18 / 按钮 16 / 药丸 999；
字体用系统字体，等宽只给数字 / 路径 / meta。

**素材策略**：`docs/cabin-design/assets/` 是唯一真源，App 只放副本；`sync-assets.mjs` 在
`flutter run/build` 前跑一次（根 `package.json` 加 `mobile:assets` 转发）。M5 再把场景图转 WebP 压体积。

---

## 3. 网络与安全

**PC 侧（一次性配置）：**

```bash
tailscale serve --bg --https=443 http://127.0.0.1:47820
tailscale serve status     # 验证
tailscale serve reset      # 撤销
```

手机访问 `https://<机器名>.<tailnet>.ts.net`。桌面壳 sidecar 固定 `OCTOPUS_HOST=127.0.0.1:47820`；
开发模式 `pnpm dev` 的 server 在 3001（dev 默认监听 0.0.0.0，可直接被同网/Tailscale 访问，但**仅限调试**）。

**底线：**

- 不允许把 server 绑 `0.0.0.0` 暴露公网，也不允许 cloudflared / ngrok 之类公网隧道 ——
  现有 API 能执行任意命令。
- Android release 只允许 HTTPS；明文 HTTP 只开在 debug variant（`network_security_config`）。

**鉴权（M3 · 最简版）：**

- 服务端加 `device-auth` 中间件：回环来源放行（桌面自锁保护）；其余要求
  `Authorization: Bearer <device-token>`；`/api/actuator/health`、`/api/pair/redeem` 例外。
- 令牌 32 字节随机，DB 只存 `sha256`；先做「单设备一令牌」表，不做 scope / 多用户。
- 配对：PC 设置页出一次性 6 位码（TTL 2 分钟，仅回环可生成）→ 手机兑换长期令牌；
  二维码可选（`mobile_scanner`）。v1 允许「手动粘贴 URL + 令牌」兜底。
- 手机侧令牌进 `flutter_secure_storage`，不写日志。

**落地补充（2026-11-27）**

- **本机判定 = socket 回环 ∧ 无 XFF/Forwarded ∧ Host 不是 `*.ts.net`。**
  `tailscale serve` 也是从 `127.0.0.1` 连进来的 —— 光看回环会把整个 tailnet 当本机。
  两个代理信号任一命中即按远程处理；`x-octopus-peer` 由 http 桥注入并覆盖客户端同名头。
- 鉴权闸的例外固定为四条：`/api/actuator/health`、`/api/pair/redeem`、
  `/api/pair/code`（路由自己只许回环）、`/api/chat-media/*`（`<img>` 带不了 Authorization）。
- 配对码 6 位、TTL 2 分钟、单次有效、错 5 次直接作废；只留内存，进程重启即失效。
- 设备管理（列表 / 改名 / 吊销）**只许回环**：一部手机被偷，不能拿它自己的令牌再签发令牌。
- **WebSocket 升级同样要令牌**：工作区文档（Yjs）也是可写面，HTTP 中间件管不到 upgrade 请求；
  非回环必须带 `?token=<device-token>`（浏览器 WS 带不了 Authorization 头），否则握手拒绝。
- 令牌形态 64 hex（32 字节）；DB 存 sha256 + 前 8 位展示前缀；`last_seen` 写库 60s 节流。

---

## 4. 接口清单

| 用途 | 接口 | 现状 |
|---|---|---|
| 探活 | `GET /api/actuator/health`（503 = 未就绪） | ✅ |
| 舱列表 | `GET /api/cabins` → `{cabins[]}` | ✅ |
| 舱详情 | `GET /api/cabins/:id` → `{cabin, view}`（含 `workspace_id`） | ✅ |
| 待你定 | `GET /api/cabins/:id/attention` → `{attention, health}` | ✅ |
| 舱事件 | `GET /api/cabins/:id/events`（SSE） | ✅ |
| 事项 | `GET/POST /api/cabins/:id/items`、`POST /:id/items/deliver` | ✅ |
| 任务 | `GET /api/tasks?cabin_id=` → `{items[]}` | ✅ |
| 任务详情 | `GET /api/tasks/:id`、`/executions`、`/artifacts` | ✅ |
| 舱会话 | `GET /api/agent/sessions/:sid`（主会话在 `sessions` 表；列表排除舱主会话） | ✅ |
| 舱会话发消息 | `POST /api/agent/sessions/:sid/chat`（响应体即 SSE：`text_delta.delta` / `tool_call.type` / `done`） | ✅ |
| 新开舱会话 | `POST /api/agent/sessions`（带 `workspace_id`）+ `POST /api/cabins/:id/delegations/register` | ✅ |
| 舱会话列表 | 主会话（`cabins.main_session_id`）+ `GET /api/cabins/:id/delegations` | ✅ |
| 工作区事件 | `GET /api/workspaces/:id/events`（SSE） | ✅ |
| 单独会话 | 仍走 `GET/POST /api/chat/global/sessions`、`/:sid/messages`（自由聊天域） | ✅ |
| 在跑 agent | `GET /api/agent/sessions/running`（带任意 `Bearer`） | ✅ |
| 设备令牌 | `device-auth` 中间件 + `devices` 表 | ✅ M3 |
| 配对码 / 兑换 | `POST /api/pair/code`（仅回环）· `POST /api/pair/redeem`（闸外） | ✅ M3 |
| 设备管理 | `GET /api/devices` · `PATCH/DELETE /api/devices/:id`（仅回环） | ✅ M3 |
| 远程拉起 | `GET /api/remote/status`（仅回环）· redeem 带 `wants_remote` 返回 SSH 私钥 | ✅ M4 |
| 拉起执行 | `octopus-ctl status/start`（sshd 强制命令）+ 登录计划任务 | ✅ M4 |

> 注意：会话消息 POST 的 SSE 是**响应体内联流**，不是独立订阅；页面再开
> `workspaces/:id/events` 接收任务 / 状态类事件。切后台断流后，回前台先重拉一次会话快照。

---

## 5. 里程碑

### M0 · 骨架与视觉底（2–3 天）

- `flutter create --platforms=android,ios`，落 §2 目录；Riverpod + go_router。
- 主题 token、`RoundedPanel` / `StatusPill` / `SceneBackground` / `Starfield` / `CrewFigure`。
- 设备列表用本地假数据 + 真实 `/api/actuator/health`（填一个 `tailscale serve` 地址即可探活）。
- 舱 / 会话页先用静态假数据铺满 8 屏结构。

**验收**：Android 真机装上 APK，8 个页面可走通；星流 30fps 不吃满 CPU；切后台动效暂停。

**M0 必做的技术验证（spike）**：`video_player` 在目标 Android 机上能否播 **VP9 alpha WebM** 且透明。
不行就降级：静态 `crew/*.png` + 径向遮罩（原型上一版已验证可看），视频留到后续换 Rive / 序列帧。

> **2026-11-27 真机结论**：不行。Flutter 的 Android `video_player` 走 SurfaceTexture，整帧不透明 ——
> VP9 alpha 的 webm 播出来是一块黑底（真机实测）。改为把同一份画稿转成**带透明通道的 animated WebP**
> （480×720 / 12fps / 60 帧循环），由 `Image` 解码，alpha 正常；见 §11 的 M5 记录。

### M1 · 真实数据：舱与会话（4–6 天）

- 设备添加 / 切换 / 删除；baseUrl + （M3 后）token 注入。
- 舱列表、舱内三块、任务只读列表、任务详情（只读）。
- 舱会话列表、会话详情、TUI 转录渲染、发消息、SSE 流式追加、错误态。
- 断线重连：`last-event-id` / 重新拉快照；下拉刷新。

**验收**：手机经 Tailscale 打开家里 PC，看到真实舱；进舱发一句「继续」，30 秒内看到流式输出；
杀掉 App 重开能看到历史消息。

### M2 · 待你定与回复（2–3 天）

- attention 列表（去重、按 stage 排序）；点开 → 定位/打开对应会话 → 引用条。
- 引用条内容：问题原文 + 来源（任务 / 轮次）+ 依据条数；输入框 placeholder 切换。
- 回复后保持引用上下文；状态变化靠 `cabins/:id/events` + 快照刷新。
- 空态、离线态、失败重试。

**验收**：待你定条数与 PC 一致；点任一条进去，引用条就是那个问题；用人话回复后，回到列表状态已更新
（agent 改的状态，App 不直接改）。

### M3 · 最简鉴权与配对（2–3 天）

- 服务端：`device-auth` 中间件 + `devices` 表 + `POST /api/pair/redeem`（回环生成码）。
- App：安全存储、令牌失效 → 提示重新配对；二维码扫码（可选）。
- 桌面设置页：生成配对码 / 已配对设备列表 / 吊销。

**验收**：非回环无令牌请求 `/api/cabins` → 401；桌面版（回环）功能不变；吊销后该设备立刻 401。

### M4 · 远程拉起（3–5 天 · 可选）

> 2026-11-27 已落地，记录见 §11；PC 侧安装器需要在本机以管理员跑一次。

- PC：`octopus-ctl status/start`（幂等：先探 47820）+「登录时运行」计划任务 +
  `authorized_keys` 的 `command=` 强制命令（只允许 status/start）。
- App：设备状态三档（离线 / 在线未启动 / 运行中）；`starting` 给足 90 秒并轮询，不误判失败。
- 触发通道二选一：App 内 `dartssh2` 跑 `octopus-ctl start`，或 PC 端另起常驻哨兵（不推荐）。
- 前提写进产品：**PC 睡眠 / 关机时什么都做不了**，Tailscale 不能唤醒睡眠机器。

**验收**：退出 Octopus 后，手机看到「在线 · 未启动」，点启动 90 秒内进入舱；连点不会拉起第二份。

### M5 · 打磨与打包（2–3 天）

- 图标：**已做（2026-11-27）** —— `packages/mobile/scripts/make-launcher-icons.py` 从
  `packages/desktop/build/icon.png` 直接生成（没用 `flutter_launcher_icons`）：Android 五档
  `ic_launcher.png` + 自适应图标（108dp，底色取立绘四角 `#0C0B0F`，立绘缩到 86% 居中）+
  iOS `AppIcon.appiconset` 全尺寸。iOS 的 1024 目前由 512 放大，二期有母图再替换。
- 启动页：**已做（2026-11-27）** —— 原生层（API 31+ 用系统启动页：底色 `#08060F` + 自适应图标；
  31 以下是深底 + 96dp 圆角图标）+ Flutter 的 `SplashGate`（青色光环呼吸 + `OCTOPUS` 字标 +
  「汐音 · 作战舱」副标题，约 1.2 秒后淡出；只冷启动出现一次）。
- 场景图：**已转 WebP（2026-11-27）** —— 1440 宽 / q82，5.6 MB → 307 KB
  （`docs/cabin-design/assets/scene-*.webp`，由同名 PNG 转出，同步脚本只拷 WebP）。
- 空态 / 错误态、触感反馈：**已做（2026-11-27）** —— `lib/core/haptics.dart`（`tap` 轻击 /
  `ok` 成功一拍），落在连接、启动、发送、配对成功；空态与错误态沿用既有
  `LoadingState` / `ErrorState` 与三档离线提示，没有新增组件。字体与间距随 §8 真机回归一起过。
- 签名与分包：**已做（2026-11-27）** —— release 密钥在仓库外
  `~\.octopus\mobile-signing\octopus-release.jks`（`android/key.properties` 读取，二者都不入 git）；
  `flutter build apk --release --split-per-abi` → armeabi-v7a **34.5 MB** / arm64-v8a **36.4 MB** /
  x86_64 **37.7 MB**（debug 三 ABI 合包 229 MB）。换签名后首次安装需先卸载旧包并重新配对。
- 真机回归清单（§8）。

**总计**：约 12–20 个工作日（M4 可后置）。

---

## 6. 关键技术点

| 点 | 做法 |
|---|---|
| SSE 解析 | `dio` `ResponseType.stream` 逐段解码 `data:` 行；心跳超时重连；后台回来先拉快照 |
| TUI 转录 | 按行类型渲染（用户 / 助手头 / 思考 / 工具 / 正文），不引 Markdown 全量渲染器 |
| 场景层 | `Image.asset` + 24s 缩放动画；`prefers-reduced-motion` 等效开关关掉 |
| 星流 | `CustomPainter` 移植 v22 `#warp`：70 星、30fps（`Ticker` 限频）、切后台停 |
| 立绘 | 一屏最多 1 支，只有动画形态（无静态图）；默认开，设置里关掉就不画；点一下换支 |
| 引用条 | 纯前端状态：`{question, source, sessionId}`；不新增服务端字段 |
| 设备模型 | `{id, name, baseUrl, token, lastSeen, status}`；本地存储，不跨设备同步 |
| 错误归一 | 401 → 重新配对；503 → 在线未就绪；超时 → 离线；显示可操作的重试 |

---

## 7. 测试

- **单元**：模型解析、SSE 分帧、引用条状态机、状态色映射。
- **组件**：卡片 / 药丸 / 引用条 / 转录行 widget test。
- **集成**：本机 `pnpm dev`（3001）跑 `integration_test`：列舱 → 进舱 → 发消息 → 收到流；
  测试用独立 DB / 测试工作区，不碰真实任务。
- **真机**：Tailscale 4G 下一次完整闭环；弱网 / 断线重连；后台 10 分钟回来。
- 不加 golden 截图（视觉以原型为准，避免维护成本）。

### 7.1 模拟器 vs 真机（2026-11-26 补充）

**结论：模拟器当日常主力，真机做里程碑收口；有 4 项必须真机。**

| 内容 | 模拟器 | 真机 | 说明 |
|---|---|---|---|
| UI / 布局 / 圆角 / 字体 | ✅ 主力 | 抽查 | `flutter run` 秒级迭代 |
| 路由 / 状态 / 假数据 | ✅ | — | |
| 接口联调（舱 / 会话 / SSE） | ✅ 走 `10.0.2.2` | ✅ | 模拟器直连宿主机 dev server，**不需要 Tailscale** |
| Tailscale / ts.net HTTPS | ⚠️ 不可靠 | ✅ 必须 | 模拟器里装 Tailscale 可能通，但别依赖；4G 闭环才算验收 |
| **VP9 alpha 立绘** | ❌ 不代表真机 | ✅ **M0 spike 必做** | 模拟器解码栈与真机不同，透明与否不能作为结论 |
| 星流 / 视频帧率、发热、耗电 | ❌ | ✅ | 模拟器性能数字无意义 |
| 切后台 / 锁屏 / 断流恢复 | ⚠️ | ✅ | 系统后台策略只在真机上算数 |
| 扫码配对 | ⚠️ 虚拟摄像头 | ✅ | 真机更快 |
| 图标 / 启动页 | ✅ | ✅ 终验 | 最终以真机桌面效果为准 |
| iOS | ❌ Windows 无 iOS 模拟器 | 需 Mac | v1 不做 iOS；二期要 Mac + 真机 |

**联调地址（不用等 M3 鉴权）：**

- 模拟器 → `http://10.0.2.2:3001`（`pnpm dev` 的 server）；debug variant 需放开明文
  （`network_security_config` 只对 `10.0.2.2` / 局域网 IP 放行，release 仍只允许 HTTPS）。
- 真机（同 Wi-Fi）→ `http://<PC 局域网 IP>:3001`（dev server 默认监听 0.0.0.0，仅调试用）。
- 真机（Tailscale）→ `https://<机器>.<tailnet>.ts.net`（`tailscale serve` → 桌面 sidecar `47820`，
  需要 Octopus 桌面版在跑）。

**建议节奏**：M0–M2 用模拟器每天跑；**M0 第一天先在真机做 VP9 alpha spike**；每个里程碑收口
（M1 / M2 / M3）上真机走一遍；M5 只在真机上做发布验收。

---

## 8. v1 完成定义（DoD）

1. Android APK 在真机安装，图标 / 名称 / 启动页正确（图标与 PC 一致）。
2. 手机经 Tailscale（含 4G）添加设备并看到状态。
3. 看到舱列表与每舱待办数；进入舱内三块。
4. 打开待你定任一条 → 引用条出现 → 用人话回复 → 流式输出可见。
5. 单独会话可新建、可发消息、可看历史。
6. 会话内容与桌面同一套 TUI 语法。
7. 切后台 / 断流后回来能恢复，不丢消息。
8. 桌面端功能零回归（回环豁免生效）。

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Android 对 VP9 alpha 支持不一致 | 立绘透明失效 / 黑底 | **已结论（2026-11-27）**：video_player 丢 alpha → 换 animated WebP（见 M0 spike 注） |
| iOS 不认 WebP 动画 | 二期才遇到 | 转 HEVC-alpha 或不放立绘（静态兜底图已删，不恢复） |
| SSE 在后台被系统掐断 | 消息断流 | 回前台拉快照 + `last-event-id` 重连；推送不在 v1 |
| 国产 ROM 杀后台 / 断 Tailscale | 收不到状态 | v1 以「打开 App 时刷新」为准，不做常驻 |
| PC 睡眠 / 关机 | 全不可用 | 产品前提写清楚；M4 只解决「进程没跑」，不解决睡眠 |
| 令牌泄露 | 可执行任意命令 | 只走 tailnet + ACL；M3 令牌只读/聊天分权可后置；禁止公网暴露 |
| 场景 / 视频体积 | 安装包偏大 | M5 场景转 WebP；视频只带 3 支 |

---

## 10. 第一批任务（M0 checklist）

- [ ] `packages/mobile` 骨架 + pubspec + 依赖锁定
- [ ] `scripts/sync-assets.mjs` + 根 `package.json` 的 `mobile:assets`
- [ ] 主题 token / `RoundedPanel` / `StatusPill`
- [ ] `SceneBackground` + `Starfield`（30fps / 后台暂停）
- [x] `CrewFigure` + 静态兜底 + alpha 结论（WebP 动画，2026-11-27）
- [ ] 设备列表（本地存储 + health 探活）
- [ ] 8 屏静态结构（假数据）与路由
- [ ] Android 真机跑通，记录帧率 / 内存基线

---

## 11. 实现进度

### 2026-11-26 · M0 + M1 落地（`packages/mobile`）

| 项 | 状态 |
|---|---|
| 工程骨架 · 主题 token · 基础组件（场景底 / 星流 / 立绘 / 圆角面板 / TUI 转录 / 输入区） | ✅ |
| 设备：添加（手填 Tailscale 域名 + 探活）/ 切换 / 重命名 / 删除 | ✅ |
| 舱列表 + 每舱角标（待你定 / 待验收 / 进行中） | ✅ |
| 舱内三块：待你定 / 会话 / 任务（只读） | ✅ |
| 舱会话：列表 / 详情 / TUI 转录 / 发消息（POST 内联 SSE 逐帧追加）/ 快照刷新 / 下拉刷新 / 错误态 | ✅ |
| 单独会话（`/api/chat/global/sessions`） | ✅ |
| 任务只读详情 | ✅ |
| 素材同步 `scripts/sync-assets.mjs`（真源 docs/cabin-design，`assets/` 不入库） | ✅ |

**与计划的偏差（有意）**

1. 待你定点开 = 回舱主会话；**问题引用条留给 M2**（M1 不假装已经能引用）。
2. 扫码配对留给 M3；M1 手填 Tailscale 域名（模拟器填 `http://10.0.2.2:3001`）。
3. 立绘**只有动画一种形态**（2026-11-27 改）：默认开 WebP 动画；「设置 → 立绘动画」关掉就整块
   不画 —— 原来的静态图是深底半身像，贴在场景上就是一块黑方块，已整体删除。

**验证**：见 §11.1。

### 2026-11-26 · M2 落地（`packages/mobile`）

| 项 | 状态 |
|---|---|
| attention 模型：`ask` 信封（decision / phase / message_id）、`subject`、`start_kind`、`awaiting` | ✅ |
| 列表口径：只列 `awaiting=person`、按票据（`ask_id`）去重、按 stage 排序；`notice`（已完成知会）不进待办 —— 与 PC inbox 同规则 | ✅ |
| 点待你定 → 打开舱主会话（顶栏切「回复 QUOTE」），顶部挂引用条（问题原文 / 来源 / 轮次 / 依据条数） | ✅ |
| 引用条：✕ 关闭（左置）、placeholder 切「回复上面这个问题…」、回复后保留上下文、依据不另开面板 | ✅ |
| 状态刷新：`GET /api/cabins/:id/events`（断线重连）+ `cabin_view` 去抖刷新；回前台 / 从会话返回再拉快照 | ✅ |
| 离线 / 未就绪提示条 + 重试；空态 / 失败重试沿用 | ✅ |
| 测试：42 passed（单元 31 · 组件 8 · 整链 3） | ✅ |

**与计划的偏差（有意）**

1. **依据条数**从会话快照里数：镜像卡之前、同一条用户提问内的 `▸ tool` 行；快照里没加载到那条消息时
   不显示（不编数）。
2. 只打开**舱主会话**（镜像卡所在）。`ask.author_session_id` 是作者线程、可能跨工作区，手机端不跳。
3. 待验收 / 待放行也走「回到会话 + 引用条」，不做验收矩阵 —— 与 design 34 §3「状态由 agent 改」一致。
4. 离线态不另开页面：在顶栏下面压一条可重试的提示，列表仍可下拉。
5. `notice`（已完成 / 委派完成知会）不进「待你定」，与 PC inbox 的「要我处理 N」口径一致。
6. 会话定位：优先舱主会话；主会话已不在会话列表里（被归档 / 清库）就退回最新一条；
   一条都没有时不硬闯，提示「去会话页」新建。

**验证**：见 §11.1 的「M2 复查」。

### 2026-11-27 · M3 落地（server + web 设置 + `packages/mobile`）

| 项 | 状态 |
|---|---|
| `devices` 表（token_hash / token_prefix / revoked_at）+ DeviceDAO | ✅ |
| DeviceAuthService：6 位码 TTL 2 分钟 · 单次 · 错 5 次作废；32 字节令牌只存 sha256；last_seen 60s 节流 | ✅ |
| device-auth 中间件：回环直连放行；XFF / 转发头 / `*.ts.net` Host 一律要 Bearer；health / redeem / pair code / chat-media 例外 | ✅ |
| Yjs WebSocket 升级守卫：非回环必须带 `?token=`（浏览器 WS 带不了 Authorization 头） | ✅ |
| `POST /api/pair/code`（仅回环）· `POST /api/pair/redeem`（闸外）· `GET/PATCH/DELETE /api/devices*`（仅回环） | ✅ |
| PC 设置窗口新增「手机配对」：配对码 + 倒计时 + 已配对设备（前缀 / 平台 / 上次活跃）+ 改名 / 吊销 | ✅ |
| 手机端：令牌进 `flutter_secure_storage`；`apiProvider` 注入 Bearer；添加设备遇 401 展开配对卡（6 位码 / 粘贴令牌）；设置里重新配对 / 清除；401 错误卡给「去配对」 | ✅ |
| 测试：server 17 · web 4 · mobile 52（新增 10） | ✅ |

**与计划的偏差（有意）**

1. 二维码扫码不做（计划里本来就是可选）：6 位码 + 手动粘贴令牌已经覆盖 v1 的真实路径。
2. 配对码只留内存：2 分钟 TTL 下持久化没有意义，进程重启即作废反而更干净。
3. 手机端只能兑换，不能管理设备 —— 列 / 改名 / 吊销一律 403（哪怕持有有效令牌）。
4. `/api/chat-media/*` 继续在闸外：`<img>` 带不了 Authorization，沿用 2026-11-26 的只读口径。
5. 本机判定不只看回环：`tailscale serve` 从 127.0.0.1 进来，必须叠加转发头 / ts.net Host 两个信号。

**验证**：见 §11.1 的「M3 复查」。

### 2026-11-27 · M4 落地（远程拉起）

| 项 | 状态 |
|---|---|
| PC `scripts/remote/octopus-ctl.ps1`：status / start 两个动词、纯 JSON、幂等（运行中/正在起不再拉第二份）、探活绕开系统代理、UTF-8 输出 | ✅ |
| PC `scripts/remote/install-remote.ps1`：管理员一次性——落脚本到 `C:\ProgramData\octopus\`、生成 8 把受限 SSH 密钥槽、写 `administrators_authorized_keys`（`restrict,command=`）、注册登录计划任务（`Octopus.exe --tray`）、写 `remote.json`、自测；**默认不改 sshd 配置、不重启 sshd**（`-DisablePasswordAuth` 才收紧） | ✅ 脚本就绪（本机尚未执行） |
| Server：`remote-control` 服务（读 `remote.json` / 密钥槽发放即删）+ `devices.ssh_key_slot` 列 + `GET /api/remote/status`（仅回环）+ redeem 带 `wants_remote` 返回 SSH 载荷 | ✅ |
| Web 设置页：「远程拉起」状态卡（已就绪 / 未安装 / 槽位余量）+ 设备行「远程 slot-XX」；未安装时点**启用远程拉起**（UAC）→ 轮询到已就绪 | ✅ |
| 打包：安装器与 `octopus-ctl.ps1` 随桌面端走（`resources/remote`），sidecar 用 `OCTOPUS_REMOTE_DIR` 找；开发模式回落到仓库 `scripts/remote` | ✅ |
| App：`dartssh2` + 私钥进安全存储；三档状态（离线 / 在线·未启动 / 运行中）+ 启动按钮 + 启动中 + 90 秒轮询 + 失败原样提示 | ✅ |
| 测试：server 13 · web 7 · mobile 64（新增 12） | ✅ |

**与计划的偏差（有意）**

1. 密钥用「槽位池」：安装器在 PC 上生成，配对时随 redeem 一次性下发，发完立刻从 PC 删掉。
   手机不自生成密钥 —— 换来的是装完之后零 UAC。
2. 只认 `status` / `start`；计划里的 `stop` 不做（v1 不提供「远程关掉 Octopus」）。
3. 触发通道选 App 内 SSH（`dartssh2`），没有常驻哨兵。
4. 只有 HTTP 探活失败时才多走一次 SSH —— 在跑的机器每次刷新仍然只花一次 health。
5. 脚本目前只有 PowerShell 分支；`status/start` + JSON 这份接口本身是按跨平台写的。
6. 多 PC 不做「每台手动配」：桌面端设置页一个按钮发起 UAC 安装（安装器随桌面端打包）；
   机器没有 OpenSSH Server 时安装器自动启用 Windows 可选功能。

**验证**：见 §11.1 的「M4 复查」。

### 11.1 构建与联调记录

**工具链（2026-11-26 装在这台机器上）**

- Flutter 3.50.1 stable（Dart 3.14）→ `C:\tools\flutter`，用户 PATH 已加 `C:\tools\flutter\bin`
- Android SDK → `%LOCALAPPDATA%\Android\Sdk`：platforms 35/36 · build-tools 35/36 · platform-tools · cmdline-tools
- JDK 21（`ms-21.0.7`）；Gradle 9.5.0（wrapper 缓存已预置）
- 镜像：`FLUTTER_STORAGE_BASE_URL` / `PUB_HOSTED_URL` → flutter-io.cn；
  Gradle 依赖走阿里云镜像（`~/.gradle/init.gradle` 把 google / mavenCentral 映到
  `maven.aliyun.com`，只影响本机、不进仓库）

**静态检查**：`flutter analyze` —— **0 error / 0 warning**；27 条 info，全部是 Flutter 3.50 的
`package:flutter/material.dart` deprecated 提示（官方迁 `material_ui`，暂不换）与风格建议。

**单元测试**：`flutter test` —— **16 passed**（SSE 分帧 7 · 模型解析 9）。

**本机联调**（`dart run tool/smoke.dart http://127.0.0.1:3001`，真实 dev DB，只读为主）：

- 列舱 2 个、attention 角标（wait=2 / wait=1）、任务 3 条 —— 解析与 PC 一致
- 会话 CRUD 往返：create → get → list → delete 全通（临时会话已删）
- SSE：`/api/workspaces/:id/events` 连接成功、30s heartbeat 被正确解析成事件

**APK**：`C:\xzf\ai\open-octopus\packages\mobile\build\app\outputs\flutter-apk\app-debug.apk`
—— debug · 227,832,466 字节（≈217 MiB，含 arm / arm64 / x64 三个 ABI）· 2026-11-27 10:05
构建完成，内核按 M3 代码编译（含 `flutter_secure_storage` 原生插件；新增
androidx.security / tink 依赖，比 M2 的 183 MiB 涨了约 34 MiB）。首次构建 755s
（大半花在新依赖下载），增量重建 51s；M5 再出 `--release --split-per-abi` 的小包。

**M2 复查（2026-11-26 晚）**

- `flutter analyze`：**0 error / 0 warning**；31 条 info（material 迁移提示 + 少量风格建议：
  多下划线占位、null-aware 元素等）。
- `flutter test`：**42 passed** —— SSE 分帧 7 · 模型解析 9 · attention/去重排序/引用 11 ·
  API/SSE 胶水 4 · 引用条组件 5 · 会话引用态 3 · 整链 3（待你定→会话、cabin_view→快照刷新、
  无会话兜底）。
  其中整链用假 HTTP 适配器驱动真实 `CabinScreen` → 点一条 → `SessionScreen`：
  引用条问题原文、来源行、`依据 2 条`、placeholder 切换都在真实 widget 树上验证；
  再推一条 `cabin_view`，去抖后重拉快照、待你定清空。
- 本机联调（`dart run tool/smoke.dart http://127.0.0.1:3001 --attention --cabin-events=2`）：
  2 个舱、attention 去重后 2 / 1 条（均为待放行）；引用行解析出
  `任务 · #1 · xzf` 与问题原文；`/api/cabins/:id/events` 收到 `heartbeat {hello:true}`。
  当前 dev DB 没有未答提问，`ask` 信封路径由假适配器夹具覆盖（含跨 chunk SSE 分帧）。
- 本机没有 Android 模拟器、也没有连接真机，**未做真机走查**；M2 的界面验收止于 widget
  整链测试，Tailscale 闭环 + 真实「回复后状态更新」要装 APK 后在手机上做（§7.1）。

**M3 复查（2026-11-27）**

- 服务端：`vitest run src/__tests__/device-auth.test.ts` —— **17 passed**
  （peer 判定 4 · 中间件 4 · 配对码 / 兑换 5 · 设备管理 2 · WS 升级守卫 2）。
- Web：`vitest run components/settings/__tests__/device-pairing-panel.test.tsx app/settings`
  —— **5 passed**（配对码展示 / 403 提示 / 吊销 / 设置壳）。
- 手机端：`flutter analyze` **0 error / 0 warning**（34 条 info，仍以 material 迁移提示为主）；
  `flutter test` **52 passed** —— M2 的 42 条零回归，新增配对解析 7 条 + 添加设备整链 3 条
  （回环真 HTTP 服务：探活 → 401 → 配对卡 → 兑换 → 进设备页；错码原样提示；粘贴令牌直接通过）。
- 真机冒烟（临时 DB · `127.0.0.1:3211` · 服务只绑回环，跑完即删）：13 项全通 ——
  本机 200 / XFF 与 ts.net Host 各 401 / 远程生成码 403 / 兑换得 64 hex 令牌 /
  带令牌 200 / 错令牌 401 / 设备列表不含 token_hash / 远程持令牌管设备 403 /
  吊销 204 → 同令牌立刻 401 / 健康探活始终 200；另验中文名 UTF-8、码只能用一次、
  舱事件 SSE 在闸内（401）、chat-media 在闸外。
- WebSocket 升级守卫（临时 DB · `127.0.0.1:3212`）：本机 `open(101)`；XFF / ts.net Host
  无令牌各 401；错令牌 401；有效令牌 + ts.net Host → `open(101)`。
- 仍未做真机走查（本机没模拟器 / 真机）：配对页面与令牌持久化的手感要在手机上验；
  Android 侧已重新构建 APK 验证 `flutter_secure_storage` 接入
  （`…\app-debug.apk` · 217 MiB · 2026-11-27 10:05，见上方 APK 行）。

**M4 复查（2026-11-27）**

- `octopus-ctl.ps1` 直接跑（真实桌面版在 47820）：`status` → `state=running`，带 sidecar pid /
  uptime / mode，`task.registered=false`（安装器还没跑）；强制命令路径（读
  `SSH_ORIGINAL_COMMAND`）→ 白名单生效，`rm -rf /` 返回 `bad_command`，中文提示按 UTF-8 正常输出。
- Server：`vitest run src/__tests__/remote-control.test.ts` —— **13 passed**
  （配置缺失 / 槽位计数 / 发放即删 / 坏私钥拒发 / 目录读不到 / redeem 三条路径 / 仅回环 /
  一键启用 202 · 409 · 已装 200 · 安装器目录发现）；M3 的 17 条零回归（合计 30）。
- Web：`vitest run components/settings/__tests__/device-pairing-panel.test.tsx` —— **7 passed**
  （新增「已就绪 + 槽位余量 + 远程标记」「未安装给安装命令」「一键启用 → 轮询到已就绪」）；
  eslint 干净。
- 本机冒烟（临时 DB · 127.0.0.1:3311）：`GET /api/remote/status` → `installed:false`；
  `POST /api/pair/code` → 200；服务器构建通过。
- 手机端：`flutter analyze` **0 error / 0 warning**（32 条 info，仍以 material 迁移提示为主）；
  `flutter test` **64 passed** —— M3 的 52 条零回归，新增 12 条：远程控制 JSON / 三档状态合成 /
  启动轮询 / 电脑拒绝（task_missing）/ SSH 失败 / 配对返回 ssh 载荷 / 配对没装远程 /
  设备列表「在线·未启动 → 点启动 → 运行中」整链。
- **本机已在 2026-11-27 实际安装**（桌面端「启用远程拉起」的同一条路径）：
  8 把密钥槽、计划任务 `Octopus`（Ready · `Octopus.exe --tray`）、`administrators_authorized_keys`
  8 行 `restrict,command=`、`remote.json` 落盘；`sshd_config` 未改动（LastWriteTime 仍是 2023）；
  安装器自测通过（`ssh 127.0.0.1 status` → 正常 JSON）。真机 SSH 闭环
  （退出 Octopus → 手机看到「在线·未启动」→ 点启动 90 秒内进入舱）还要等手机端换 M4 APK 后再走一遍。
- 本机两个环境坑（都已在代码里兜住）：
  1. **UAC 被关掉（`EnableLUA=0`）**：`Start-Process -Verb RunAs` 不弹窗且直接失败 →
     一键启用先探测权限，已是管理员就**直接执行**安装器；
  2. **detached + `stdio: 'ignore'` 的隐藏 PowerShell 子进程在本机根本不执行**（三个变体实测）→
     改成非 detached 的忽略输出子进程。
- 安装器自带自测（用 slot-01 从本机走 `ssh 127.0.0.1 status`）；装完当场就能看到强制命令是否生效。

### 2026-11-27 · M5 打磨（`packages/mobile`）

- **图标**：与 PC exe 同源（`packages/desktop/build/icon.png`）→ Android 五档 + 自适应图标
  （深底 `#0C0B0F` + 立绘 86% 居中）+ iOS 全尺寸，脚本 `scripts/make-launcher-icons.py`；
  真机桌面（realme 启动器）实测为汐音。
- **启动页**：API 31+ 系统启动页（底色 `#08060F` + 自适应图标；31 以下深底 + 96dp 圆角图标）+
  Flutter `SplashGate`（光环呼吸 + `OCTOPUS` + 「汐音 · 作战舱」，约 1.2s 淡出，只冷启动一次）。
  真机踩坑：debug 下 `Text` 缺 `Material` 祖先会被画出黄色双下划线，已用 `Material` 包住。
- **场景图**：WebP 1440 宽 / q82，5.6 MB → 307 KB（`docs/cabin-design/assets/scene-*.webp`）。
- **立绘动画**：VP9 alpha WebM 在 Android `video_player` 上丢透明通道（真机黑底）→ 转 animated WebP
  （480×720 / 12fps / 60 帧，3 支 10.2 MB），`Image` 解码 alpha 正常；点立绘换支用 `gaplessPlayback`，
  不再闪静态图；动作标签跟随当前支。`video_player` 依赖已移除。
- **立绘默认开、静态图删除**（同日）：`octopus.crewVideo.v2` 默认 true；关掉时 `CrewFigure` /
  `CrewStage` 直接不画（没有静态兜底）；深底头像只留给顶栏 `CrewAvatar` 裁脸。
- **触感**：`lib/core/haptics.dart`（`tap` / `ok`）落在连接、启动、发送、配对成功。
- **签名与分包**：仓库外 keystore `~\.octopus\mobile-signing\octopus-release.jks`
  （`android/key.properties` 读取，均不入 git）；`--split-per-abi` → armeabi-v7a 34.5 MB /
  arm64-v8a 36.4 MB / x86_64 37.7 MB。
- **测试**：`flutter test` **68 passed**（新增启动页 2 条 + 立绘 WebP/隐藏 2 条）；
  `flutter analyze` 0 error / 0 warning。

### 2026-11-28 · chat 内场落地（`packages/mobile`）

原型 `mobile-v1.html` §3（E3–E9）从「设计」变成真机可用的东西：

- **通讯台头**：舱主会话上方一行 `✦ 星核 · model · ctx · tok · ≡ N轮`；ctx 带占用底条
  （60% 琥珀 / 85% 红），tok 读会话账本，轮次只数真人发言（事件卡不计）。
- **过程折叠**：assistant 的 think / 工具折成一行摘要（时长 · 步数 · 工具 · tok · 费用），
  点开才看步骤；正文始终露出，跑动中折叠也不挡流式正文。
- **五个底部抽屉**：轮次索引（点一条收起抽屉 + 滚动定位 + 粉闪）、星核（技能 / 分身 / MCP / 会话）、
  模型设置（模型别名 + 每模型 effort / 上下文预设，本机记忆）、ctx 明细（构成 / 缓存 / 可用 / 压缩）、
  tok 明细（调用 / 入出 / 缓存 / 费用 / 按模型 + 本舱账本）。
- **动作全走真实端点**：技能挂载 = 下一条消息加 `/skill-name` 前缀；分身 = 会话 role；
  委派 = 一次性 `subagents`；压缩 / 清空 / 自动压缩 = 真斜杠命令；改名 = `PUT /api/agent/sessions/:id`；
  导出 = 最近 20 轮复制到剪贴板。
- **数据口径**：`context_usage` 来自会话详情（冷启动为账本估算，带 `~`）；每轮时长 / token / 费用来自
  `GET /api/sessions/:id/llm-calls`，归属规则与桌面 `turn-stats.ts` 一致（message_id 优先、按真人用户
  消息切窗、事件卡不作边界、`session_compress` 排除）。费用未定价显示「—」。
- **真机回归**：vivo V2304A / Android 16 上验证通讯台头、折叠展开、轮次跳转、模型切换持久化、
  星核四栏、ctx/tok 明细；`flutter test` **81 passed**，`flutter analyze` 0 error / 0 warning。

### 2026-11-28 · 提问卡与产物预览（原型 §4）

原型 `mobile-v1.html` §4（E10–E14）落地，同时按定稿删掉输入区上方的预设快捷词：

- **提问卡**：从 agent 消息 metadata 的 `questions` 解析（老数据用工具入参兜底），
  不再折成工具行；所有问题平铺、一次滚完、一次提交。单选圆点 / 多选方框，「其他」
  选中后就地出输入框；「先讨论」把问题与当前填写交回 agent。提交正文与桌面
  `ask-user-question-card.tsx` 同格式；作答后整卡收成「✓ 已回答」，结构化正文在转录里
  压成一行摘要。历史里按「提问之后是否出现用户消息」判已答。
- **产物**：助手正文里的绝对路径自动识别（markdown 图片 / 反引号 / 裸路径；URL 与相对路径
  不误判）。图片出缩略图（最多 4 张）+ 灯箱；其它可读文件出 `▤` chip，`⧉` 只复制文件名，
  点开只读文档窗（文本 / json / md 原样、图片预览、二进制明说）。走
  `/api/chat-media/:sessionId/{image,doc,raw}`，白名单按会话解析；加载失败静默收起。
- **输入区**：E / F / H 三屏的预设快捷词全部删除，只留身份贴纸 + 输入行。
- **验证**：`flutter test` **105 passed**（新增提问卡解析 / 组件、媒体路径识别、附件 chip /
  转录集成用例）；`flutter analyze` 0 error / 0 warning。真机上验证了真实提问卡的渲染、
  先讨论提交、已答折叠、图片缩略图 + 灯箱、文件 chip + 只读文档窗，以及媒体路径不把
  URL 误判为文件。

---

## 12. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-26 | 首版：基于 V1 定版原型拆 M0–M5；Flutter / `packages/mobile`；鉴权与远程拉起后置 |
| 2026-11-26 | M1 / M2 落地记录：真实舱与会话、待你定引用条、舱事件刷新与离线态 |
| 2026-11-27 | M3 落地：设备令牌 + 6 位配对码 + 设置页「手机配对」；本机判定叠加反向代理信号 |
| 2026-11-27 | M4 落地：SSH 强制命令（status/start）+ 登录计划任务 + 密钥槽配对下发；设备三档状态与一键启动 |
| 2026-11-27 | M5 打磨：图标换汐音（与 PC exe 同源）+ 自适应图标；启动页（系统层 + Flutter 光环字标）；场景图转 WebP（5.6 MB → 307 KB）；触感反馈；release 签名与 `--split-per-abi`（36.4 MB / arm64） |
| 2026-11-27 | 舱首页改主 chat（原型方案 A）：点进舱直接到 `cabins.main_session_id`，汐音 WebP 立在聊天面板后、底缘淡出；右上角「☰ 编队」= 待你定 / 会话 / 任务；删掉「汐音 · 待命 IDLE」动作标签；舱会话切 `/api/agent`（旧 `chat/sessions` 域在舱里没有行），TUI 增系统行；测试 73 passed |
| 2026-11-28 | chat 内场落地（原型 E3–E9）：通讯台头 + 过程折叠 + 轮次索引；星核 / 模型 / ctx / tok 五抽屉；技能挂载、委派、身份切换、压缩 / 清空 / 改名 / 导出全接真实端点；测试 81 passed |
| 2026-11-28 | 提问卡与产物预览（原型 §4）：AskUserQuestion 平铺提问卡（单选 / 多选 / 其他 / 先讨论 / 已答折叠）；图片缩略图 + 灯箱、文件 chip + 只读文档窗；输入区删掉预设快捷词；测试 105 passed |
