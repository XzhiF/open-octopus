# Octopus 手机端（Flutter · M4）

在外面把家里那台机器上的活推进一格：看一眼有什么等你、说一句话、走了。

> 设计基线：`docs/cabin-design/mobile-v1.html`（V1 定版）
> 落地计划：`docs/cabin-design/design/35-mobile-dev-plan.md`
> 当前阶段：**M5 · 打磨与打包**（M0–M4 已落地；真机回归进行中）

## 跑起来

```bash
# 1) 同步素材（docs/cabin-design 是真源，这里只放副本）
#    场景图是 WebP（1440 宽 / q82，5.6 MB → 307 KB）；改场景时用 Pillow 从同名 PNG 重转：
#    python -c "from PIL import Image as I; im=I.open('docs/cabin-design/assets/scene-cruise.png').convert('RGB'); im.resize((1440, round(im.height*1440/im.width)), I.LANCZOS).save('docs/cabin-design/assets/scene-cruise.webp','WEBP',quality=82,method=6)"
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

**配对（M3）**：电脑上「设置 → 手机配对」生成 6 位码（2 分钟、单次）→ 手机添加设备时
遇到「需要配对码」就填进去；也可以在配对卡里直接粘贴设备令牌。令牌只存在手机的系统
安全存储里，服务端只留 sha256。

**远程拉起（M4）**：电脑上打开 Octopus →「设置 → 手机配对 → 远程拉起」→
**启用远程拉起**（弹一次 UAC；机器没有 OpenSSH Server 会顺带启用）。也可以手动跑：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\remote\install-remote.ps1
```

安装器会装一个只认 `status` / `start` 的 SSH 强制命令、注册登录计划任务、准备一批手机密钥槽
（详见 `scripts/remote/README.md`）。默认**不改 sshd 配置、不重启 sshd**，只往
`authorized_keys` 追加一行受限密钥 —— 原来的远程登录方式不受影响。之后配对时，手机同时
换到一把受限 SSH 私钥；电脑上 Octopus 没开时，设备列表会显示「在线 · 未启动」，点「启动」
最多 90 秒就能进舱。私钥同样只进系统安全存储；PC 上发完即删。

> **不要**把 server 绑 `0.0.0.0` 暴露公网，也不要用 cloudflared / ngrok 之类的隧道 ——
> 现有 API 能执行任意命令。只走 tailnet；鉴权闸对经 `tailscale serve` 进来的请求要求
> `Authorization: Bearer <设备令牌>`，本机回环直连（桌面端）不受影响。

## 本机工具链（2026-11-26 装好）

| 件 | 位置 / 版本 |
|---|---|
| Flutter | `C:\tools\flutter`（3.50.1 stable，Dart 3.14）· 用户 PATH 已加 `C:\tools\flutter\bin` |
| Android SDK | `%LOCALAPPDATA%\Android\Sdk`（platforms 35/36 · build-tools 35/36 · platform-tools） |
| JDK | `C:\Users\EDY\.jdks\ms-21.0.7`（21） |
| 镜像 | 用户环境变量 `FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn` · `PUB_HOSTED_URL=https://pub.flutter-io.cn` |
| Gradle 依赖 | 阿里云镜像：`~/.gradle/init.gradle` 把 google / mavenCentral 映到 `maven.aliyun.com`（只影响本机，不进仓库） |

> Flutter 3.50 起 `package:flutter/material.dart` 被标记 deprecated（官方迁到 `package:material_ui`）。
> 本项目暂时仍用 `flutter/material.dart`：只是 info 级提示，编译与构建不受影响，等 material_ui 稳定后统一换。

## 结构

```
lib/
├── main.dart / app/        ← 入口 · 主题 token · go_router
├── core/
│   ├── api.dart            ← 13 个端点的薄封装（舱 / 舱事件 / 会话 / 任务 / SSE）
│   ├── http.dart           ← dio 工厂 + 错误归一 + 探活
│   ├── pairing.dart        ← 兑换配对码 / 鉴权探针
│   ├── remote.dart         ← 远程拉起：SSH 执行面 + octopus-ctl 的 JSON 解析 + 三档状态合成
│   ├── remote_key_store.dart ← 远程拉起私钥（系统安全存储 / 测试用内存实现）
│   ├── providers.dart      ← Riverpod：设备状态 / 舱 / 会话列表 / 任务 / 舱事件流 / 启动状态机
│   ├── storage.dart        ← 设备清单与偏好（SharedPreferences；不含令牌）
│   ├── token_store.dart    ← 设备令牌（系统安全存储 / 测试用内存实现）
│   └── models/             ← 手写模型（Device / Cabin / Attention+Ask 信封 / Chat / Task / SSE / Quote）
├── features/
│   ├── devices/            ← A 设备列表 · B 添加设备
│   ├── cabins/             ← D 舱列表 · E 舱内三块（待你定 / 会话 / 任务）
│   ├── chat/               ← F 会话流 · G 引用条 · H 单独会话 · ChatController（内联 SSE）
│   ├── tasks/              ← 任务只读详情
│   └── settings/           ← 设备管理 · 动效开关 · 立绘动画
└── widgets/                ← 场景底 / 星流 / 立绘 / 圆角面板 / TUI 转录 / 输入区 / 引用条
```

## M1 做了什么

- 设备：添加（手填 Tailscale 域名 + 探活）、切换、重命名、删除。
- 舱：真实舱列表 + 每舱「待你定 / 待验收 / 进行中」角标；舱内三块。
- 会话：列表、详情、TUI 转录（`❯` / `✦ 汐音 + meta` / `◌` / `▸ tool [✓]` / `✳`）、
  发消息走 **POST 内联 SSE** 逐帧追加、结束后拉快照、下拉刷新、错误态。
- 单独会话：`/api/chat/global/sessions`。
- 任务：只读列表与详情。

## M2 做了什么

- **待你定列表**：只列 `awaiting=person`，按票据（`ask_id`）去重、按 stage 排序 —— 口径与 PC inbox 一致；
  卡片显示主体名 / 来源行（`任务 · #1 · P2 · 第 2 轮`）/ 那一问。
- **引用条**：点任一待办回到舱主会话，顶部挂「正在回复 + 问题原文 + 来源 + 依据 N 条」；
  ✕ 可关；输入框 placeholder 切到「回复上面这个问题…」；回复后引用仍留着，接着聊同一件事。
- **依据条数**从会话快照里数（镜像卡之前、同一轮提问内的 `▸ tool` 行），加载不到就不显示。
- **状态刷新**：订阅 `GET /api/cabins/:id/events`（断线自动重连），`cabin_view` / `cabin_status`
  一到就去抖重拉快照；回前台、从会话页返回也会再拉一次。
- **离线 / 未就绪**：顶栏下压一条可重试的提示；空态与失败重试沿用 M1。
- 硬规则不变：界面上没有「通过 / 退回」按钮，状态由 agent 改，人只管说话。

## M3 做了什么

- **设备令牌**：服务端 `devices` 表只存 sha256；手机端令牌进 `flutter_secure_storage`，
  `apiProvider` 每次请求带 `Authorization: Bearer`，重新配对时旧 dio 会自动换掉。
- **配对**：电脑「设置 → 手机配对」生成 6 位码（2 分钟、单次、错 5 次作废）；
  手机添加设备时先探活、再试 `/api/cabins`，401 就把配对卡展开（填码或直接粘贴令牌）。
- **重新配对 / 清除令牌**：设置页设备行菜单里；删除设备会同时清掉令牌。
- **令牌失效**：401 错误卡标题变成「需要配对」，并给一个「去配对」入口。
- 服务端闸门：本机回环直连放行（桌面零回归）；经 `tailscale serve` 或任何转发头进来的
  请求必须带令牌。设备管理接口只许回环 —— 手机能兑换，不能签发 / 吊销。

## M4 做了什么

- **三档状态**：HTTP 探活通了就是「运行中 / 未就绪」；连不上时才多走一次 SSH ——
  `octopus-ctl status` 说 `stopped` 就显示「在线 · 未启动」，SSH 也不通才是「离线」。
- **一键启动**：点「启动」→ SSH 敲 `start`（幂等）→ 每 2 秒探一次 health，90 秒封顶；
  成功自动变「运行中」，失败把原因原样显示（计划任务不存在 / SSH 连不上 / 90 秒超时）。
- **受限密钥**：配对时随 redeem 拿到一把 SSH 私钥，只能执行 PC 上那个
  `status` / `start` 的强制命令；私钥进系统安全存储，PC 上发完即删。
- **没装也能用**：电脑没装「远程拉起」时，配对照常成功，只是少一样能力（会提示怎么装）。

## 应用图标

- 与 PC exe **同一张汐音立绘**（`packages/desktop/build/icon.png`），不重绘。
- 重新生成（需要 Pillow）：`python scripts/make-launcher-icons.py`
  → Android 五档 `ic_launcher.png` + 自适应图标（108dp：深底 `#0C0B0F` + 86% 立绘居中，
  圆形 / 圆角方遮罩下都是同一张脸）+ iOS `AppIcon.appiconset` 全尺寸（1024 由 512 放大）。
- Android 8+ 若没有自适应图标，系统会把方形图标塞进白圆圈里 —— 所以别只换 `mipmap-*/ic_launcher.png`。

## 签名与发版包

- release 签名用**仓库外**的密钥库：`C:\Users\EDY\.octopus\mobile-signing\octopus-release.jks`，
  密码 / 别名在同目录的 `credentials.txt`；Gradle 通过 `android/key.properties` 读它
  （`key.properties` 与 `*.jks` 都在 `.gitignore` 里）。
- **这个密钥就是以后所有 release 安装包的身份证**：丢了只能卸载重装（手机里的设备令牌、SSH 私钥
  都会没）。请把它复制到密码管理器或私有备份。
- 出包：

  ```bash
  flutter build apk --release --split-per-abi
  # 手机装 build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
  ```

- 换了签名后的第一次安装要先卸载旧包（签名不同装不上去）：
  `adb uninstall com.octopus.octopus_mobile`。

## 测试

```bash
flutter analyze     # 0 error / 0 warning
flutter test        # 68 passed
dart run tool/smoke.dart http://127.0.0.1:3001 --attention --cabin-events=2   # 连真实 dev server
```

- 单元：模型解析、`ask` 信封、attention 去重 / 排序、引用与依据条数、SSE 分帧、
  配对兑换解析 / 鉴权探针 / Bearer 注入、远程控制 JSON / 三档状态合成。
- 胶水：假 HTTP 适配器跑真实 `OctopusApi`（JSON 解析 + 跨 chunk SSE）。
- 组件 / 流程：`QuoteBar` 渲染与关闭；真实 `CabinScreen` → 点待办 → `SessionScreen`
  整链；`cabin_view` 事件去抖后重拉快照；舱里一条会话都没有时提示「去会话页」；
  **添加设备整链**跑在回环真 HTTP 服务上（探活 → 401 → 配对卡 → 兑换 → 进设备页、
  错码原样提示、粘贴令牌直接通过）；**设备列表整链**（在线·未启动 → 点启动 → 运行中，
  SSH 与探针都是假的）；启动状态机（SSH 失败 / 电脑拒绝）。

## 没做（按计划后置）

- **M5 已完成**：图标（汐音，与 PC 同源 + 自适应）、启动页（系统层 + Flutter 光环字标）、
  场景图 WebP（5.6 MB → 307 KB）、立绘改 WebP 动画（真透明、默认开）、触感反馈、release 签名 +
  `--split-per-abi`（34.5 / 36.4 / 37.7 MB）。
- **M5 剩下**：真机回归（§8 DoD 八条）；换 release 包要先卸载旧包并重新配对。
- 推送：v1 不做；兜底自建 ntfy（见 `docs/research/mobile-remote-control.md` §4.3）。
- 二维码扫码配对：计划里本就是可选，M3 用 6 位码 + 粘贴令牌覆盖真实路径。
- 远程 `stop` / macOS 分支：M4 只做了 Windows 的 status + start。
- 验收矩阵 / 放行开关：手机端只带话，明细回桌面。

## 已知技术风险

- **立绘动画**：Flutter 在 Android 上的 `video_player` 走 SurfaceTexture，**VP9 alpha WebM 会丢透明通道**
  （真机实测是一块黑底）。所以同一份画稿转成了带透明通道的 animated WebP
  （`assets/clips/*.webp`，480×720 / 12fps / 60 帧），由 `Image` 解码，alpha 正常；
  设置里「立绘动画」打开即可，点立绘换下一支（`gaplessPlayback`，不闪静态图）。
  原 webm 只留在 `docs/cabin-design/assets/v22/` 作原型素材。
- **立绘没有静态图**：默认开动画；「设置 → 立绘动画」关掉就整块不画（原来的深底半身像贴在
  场景上就是一块黑方块，已删）。`assets/crew/xiyin-idle.png` 只给顶栏头像裁脸用。
- iOS 不认 WebM：v1 只做 Android；iOS 要么转 HEVC-alpha，要么继续静帧。
