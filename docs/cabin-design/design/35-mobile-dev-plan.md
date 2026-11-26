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
│   ├── scenes/            ← scene-cruise.png / scene-deepspace.png（同步脚本拷贝）
│   ├── clips/             ← 07-idle.webm / 05-concerned.webm / 09-smile.webm（先 3 支）
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
│                            Starfield / CrewVideo / TuiTranscript / Composer
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
| 舱会话 | `GET/POST /api/workspaces/:id/chat/sessions` | ✅ |
| 会话详情 | `GET /api/workspaces/:id/chat/sessions/:sid` | ✅ |
| 发消息 | `POST /api/workspaces/:id/chat/sessions/:sid/messages`（响应体即 SSE） | ✅ |
| 工作区事件 | `GET /api/workspaces/:id/events`（SSE） | ✅ |
| 单独会话 | `GET/POST /api/chat/global/sessions`、`/:sid`、`/:sid/messages`（SSE） | ✅ |
| 在跑 agent | `GET /api/agent/sessions/running`（带任意 `Bearer`） | ✅ |
| 设备令牌 | `device-auth` 中间件 + `devices` 表 | ❌ M3 |
| 配对兑换 | `POST /api/pair/redeem`（+ 回环生成码） | ❌ M3 |
| 远程拉起 | sshd + `octopus-ctl status/start` | ❌ M4 |

> 注意：会话消息 POST 的 SSE 是**响应体内联流**，不是独立订阅；页面再开
> `workspaces/:id/events` 接收任务 / 状态类事件。切后台断流后，回前台先重拉一次会话快照。

---

## 5. 里程碑

### M0 · 骨架与视觉底（2–3 天）

- `flutter create --platforms=android,ios`，落 §2 目录；Riverpod + go_router。
- 主题 token、`RoundedPanel` / `StatusPill` / `SceneBackground` / `Starfield` / `CrewVideo`。
- 设备列表用本地假数据 + 真实 `/api/actuator/health`（填一个 `tailscale serve` 地址即可探活）。
- 舱 / 会话页先用静态假数据铺满 8 屏结构。

**验收**：Android 真机装上 APK，8 个页面可走通；星流 30fps 不吃满 CPU；切后台动效暂停。

**M0 必做的技术验证（spike）**：`video_player` 在目标 Android 机上能否播 **VP9 alpha WebM** 且透明。
不行就降级：静态 `crew/*.png` + 径向遮罩（原型上一版已验证可看），视频留到后续换 Rive / 序列帧。

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

- PC：`octopus-ctl status/start`（幂等：先探 47820）+「登录时运行」计划任务 +
  `authorized_keys` 的 `command=` 强制命令（只允许 status/start）。
- App：设备状态三档（离线 / 在线未启动 / 运行中）；`starting` 给足 90 秒并轮询，不误判失败。
- 触发通道二选一：App 内 `dartssh2` 跑 `octopus-ctl start`，或 PC 端另起常驻哨兵（不推荐）。
- 前提写进产品：**PC 睡眠 / 关机时什么都做不了**，Tailscale 不能唤醒睡眠机器。

**验收**：退出 Octopus 后，手机看到「在线 · 未启动」，点启动 90 秒内进入舱；连点不会拉起第二份。

### M5 · 打磨与打包（2–3 天）

- 图标：`flutter_launcher_icons` 用 `packages/desktop/build/icon.png`；Android 自适应背景 `#0d0a1e`；
  iOS 发布需要 1024 母图（同一张画稿导出）。
- 启动页、空态 / 错误态、触感反馈、字体与间距核对；场景图转 WebP（2×3.3MB → 目标 <1MB）。
- Android 签名密钥、`flutter build apk --release --split-per-abi`、安装说明。
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
| 立绘 | 一屏最多 1 支；`AppLifecycleState.paused` 暂停；失败回落到静态 PNG + 遮罩 |
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
| Android 对 VP9 alpha 支持不一致 | 立绘透明失效 / 黑底 | M0 spike；失败回落静态 PNG + 遮罩；后续 Rive / 序列帧 |
| iOS 不认 WebM | 二期才遇到 | 预留静态帧兜底；真要视频转 HEVC-alpha |
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
- [ ] `CrewVideo` + 静态兜底 + VP9 alpha spike 结论
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
3. 立绘默认**静帧 + 径向遮罩**；VP9 alpha 视频由「设置 → 立绘用视频（实验）」打开 ——
   等真机 spike 结论再决定默认值。

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

### 11.1 构建与联调记录

**工具链（2026-11-26 装在这台机器上）**

- Flutter 3.50.1 stable（Dart 3.14）→ `C:\tools\flutter`，用户 PATH 已加 `C:\tools\flutter\bin`
- Android SDK → `%LOCALAPPDATA%\Android\Sdk`：platforms 35/36 · build-tools 35/36 · platform-tools · cmdline-tools
- JDK 21（`ms-21.0.7`）；Gradle 9.5.0（wrapper 缓存已预置）
- 镜像：`FLUTTER_STORAGE_BASE_URL` / `PUB_HOSTED_URL` → flutter-io.cn；
  Gradle 依赖走本机代理（`~/.gradle/gradle.properties` → 127.0.0.1:15732）

**静态检查**：`flutter analyze` —— **0 error / 0 warning**；27 条 info，全部是 Flutter 3.50 的
`package:flutter/material.dart` deprecated 提示（官方迁 `material_ui`，暂不换）与风格建议。

**单元测试**：`flutter test` —— **16 passed**（SSE 分帧 7 · 模型解析 9）。

**本机联调**（`dart run tool/smoke.dart http://127.0.0.1:3001`，真实 dev DB，只读为主）：

- 列舱 2 个、attention 角标（wait=2 / wait=1）、任务 3 条 —— 解析与 PC 一致
- 会话 CRUD 往返：create → get → list → delete 全通（临时会话已删）
- SSE：`/api/workspaces/:id/events` 连接成功、30s heartbeat 被正确解析成事件

**APK**：（构建中，完成后回填路径与体积）

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

---

## 12. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-26 | 首版：基于 V1 定版原型拆 M0–M5；Flutter / `packages/mobile`；鉴权与远程拉起后置 |
| 2026-11-26 | M1 / M2 落地记录：真实舱与会话、待你定引用条、舱事件刷新与离线态 |
