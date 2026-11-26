# Octopus 手机端（Flutter · M1）

在外面把家里那台机器上的活推进一格：看一眼有什么等你、说一句话、走了。

> 设计基线：`docs/cabin-design/mobile-v1.html`（V1 定版）
> 落地计划：`docs/cabin-design/design/35-mobile-dev-plan.md`
> 当前阶段：**M1 · 真实数据（舱与会话）**

## 跑起来

```bash
# 1) 同步素材（docs/cabin-design 是真源，这里只放副本）
node scripts/sync-assets.mjs        # 或仓库根目录 pnpm mobile:assets

# 2) 依赖
flutter pub get

# 3) 跑（模拟器直连宿主机 dev server）
pnpm dev                            # 仓库根：web 3000 / server 3001
flutter run                         # 添加设备时填 http://10.0.2.2:3001
```

真机（同一 Wi-Fi）：填 `http://<PC 局域网 IP>:3001`（仅调试）。
真机（Tailscale，正式形态）：电脑上

```bash
tailscale serve --bg --https=443 http://127.0.0.1:47820
```

手机上填 `https://<机器名>.<tailnet>.ts.net`。桌面版 sidecar 固定 127.0.0.1:47820。

> **不要**把 server 绑 `0.0.0.0` 暴露公网，也不要用 cloudflared / ngrok 之类的隧道 ——
> 现有 API 能执行任意命令。只走 tailnet。

## 本机工具链（2026-11-26 装好）

| 件 | 位置 / 版本 |
|---|---|
| Flutter | `C:\tools\flutter`（3.50.1 stable，Dart 3.14）· 用户 PATH 已加 `C:\tools\flutter\bin` |
| Android SDK | `%LOCALAPPDATA%\Android\Sdk`（platforms 35/36 · build-tools 35/36 · platform-tools） |
| JDK | `C:\Users\EDY\.jdks\ms-21.0.7`（21） |
| 镜像 | 用户环境变量 `FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn` · `PUB_HOSTED_URL=https://pub.flutter-io.cn` |
| Gradle 依赖 | `~/.gradle/gradle.properties` 走本机代理 `127.0.0.1:15732`（ViewTurbo）；代理不开时 gradle 会连不上，临时注释掉即可 |

> Flutter 3.50 起 `package:flutter/material.dart` 被标记 deprecated（官方迁到 `package:material_ui`）。
> 本项目暂时仍用 `flutter/material.dart`：只是 info 级提示，编译与构建不受影响，等 material_ui 稳定后统一换。

## 结构

```
lib/
├── main.dart / app/        ← 入口 · 主题 token · go_router
├── core/
│   ├── api.dart            ← 12 个端点的薄封装（舱 / 会话 / 任务 / SSE）
│   ├── http.dart           ← dio 工厂 + 错误归一 + 探活
│   ├── providers.dart      ← Riverpod：设备状态 / 舱 / 会话列表 / 任务
│   ├── storage.dart        ← 设备清单与偏好（SharedPreferences）
│   └── models/             ← 手写模型（Device / Cabin / Attention / Chat / Task / SSE）
├── features/
│   ├── devices/            ← A 设备列表 · B 添加设备
│   ├── cabins/             ← D 舱列表 · E 舱内三块（待你定 / 会话 / 任务）
│   ├── chat/               ← F 会话流 · H 单独会话 · ChatController（内联 SSE）
│   ├── tasks/              ← 任务只读详情
│   └── settings/           ← 设备管理 · 动效开关 · 立绘视频（实验）
└── widgets/                ← 场景底 / 星流 / 立绘 / 圆角面板 / TUI 转录 / 输入区
```

## M1 做了什么

- 设备：添加（手填 Tailscale 域名 + 探活）、切换、重命名、删除。
- 舱：真实舱列表 + 每舱「待你定 / 待验收 / 进行中」角标；舱内三块。
- 会话：列表、详情、TUI 转录（`❯` / `✦ 汐音 + meta` / `◌` / `▸ tool [✓]` / `✳`）、
  发消息走 **POST 内联 SSE** 逐帧追加、结束后拉快照、下拉刷新、错误态。
- 单独会话：`/api/chat/global/sessions`。
- 任务：只读列表与详情。

## 没做（按计划后置）

- **M2**：待你定 → 引用条（点一条回到会话、问题挂到输入框上方）。
- **M3**：设备令牌 + 配对码 + 扫码（现在手填地址直连 tailnet）。
- **M4**：远程拉起（未启动的机器从手机上拉起来）。
- 推送：v1 不做；兜底自建 ntfy（见 `docs/research/mobile-remote-control.md` §4.3）。

## 已知技术风险

- **VP9 alpha 立绘**：Android 解码器对 WebM alpha 支持不一致。默认走静帧 + 径向遮罩
  （`CrewFigure(videoEnabled: false)`）；设置里打开「立绘用视频（实验）」即可切到
  `assets/clips/*.webm`。**真机 spike 结论要回填到计划 §7.1。**
- iOS 不认 WebM：v1 只做 Android；iOS 要么转 HEVC-alpha，要么继续静帧。
