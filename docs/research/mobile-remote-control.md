# 手机远控 Octopus 调研

> 调研目标：让 PC 上常驻的 Octopus 可以被手机 App / 手机网页远程查看与指挥（下指令、批动作、看进度），
> 对标 Qoder 的移动端远控形态。
> 调研日期：2026-11-26
> 一手资料：Qoder 官方文档（docs.qoder.com，当日抓取）；Octopus 代码以当前工作区 `feat-new-ui-20261022` 为准。

---

## 0. TL;DR

**Octopus 已经完成约 60%，缺的不是"命令协议"，而是三样中间件：可达性、鉴权、窄屏界面。**

- 现有 REST 就是手机要发的「指令」：`POST /api/cabins/:id/wake`、`/items/deliver`、
  `POST /api/workspaces/:id/chat/sessions/:sid/messages`、`POST /api/tasks/:id/trigger`。
- 现有 SSE（`GET /api/workspaces/:id/events`）就是回报通道，心率 30s，手机浏览器原生支持。
- 不需要为手机另造一套后端、另造一套协议。

三个真实缺口，按严重度排序：

1. **零鉴权**。除 `/api/agent` 内部用的 `Bearer agent`（`packages/server/src/routes/agent/middleware.ts:94`）
   外，所有 `/api` 都不校验身份。而 Octopus 的 API 能跑 bash / python / agent —— 暴露到公网 = 把 PC 交出去。
   **鉴权必须先于任何远程通道落地。**
2. **桌面版不可达**。Electron sidecar 硬绑 `127.0.0.1:47820`（`packages/desktop/src/main.ts:127`），
   手机连 LAN 都进不来；dev 模式虽然绑 `0.0.0.0`（`packages/server/src/index.ts:1107`），但没有鉴权同样不能开门。
3. **界面是桌面形态**。9 个浮动窗口 + 双栏指挥舱，手机上不可用。需要一块只做三件事的移动壳：
   待你决定 / 会话 / 任务。
4. **多设备 + 远程启动**。要切换多台 PC，还要在 Octopus 未启动时把它拉起来 ——
   这需要一个常驻的哨兵角色：可以自建 **Sentinel** 进程，也可以用系统自带的 **SSH + 计划任务**
   实现（见 §5，两条路做的是同一件事）。单靠 Octopus 自己做不到。

推荐路线：**先做设备令牌 + 配对，再加 Sentinel，然后做移动壳（Tailscale 可达），最后才是推送**。
不要一上来就做账号体系和中转集群。

开源侧最完整的可抄样本是 [`slopus/happy`](https://github.com/slopus/happy)（MIT，24.8k★），
DSH 社区则有一整族插件式实现（见 §1.4）。两者都在做同一件事：**PC 是唯一真源，手机只是第二视图 + 少量写动作**。

---

## 1. 参考产品实际做到了哪一步

### 1.1 Qoder（有官方文档，可核实）

来源：<https://docs.qoder.com/mobile/app/remote-control>

| 维度 | Qoder 的做法 |
|---|---|
| 配对方式 | **账号制**，不是二维码：PC 端先开启远程控制 → 手机用同一账号登录 → 选择目标电脑 |
| 手机能做 | 看运行中/空闲/已归档任务；看进度；补充需求、回应待处理交互；在支持的 workspace 里新建任务；**审批关键操作**；Plan 模式下先审方案再执行 |
| 文件 | 一次最多 5 个普通文件、每个 ≤10 MiB；产物同步 ≤100 MiB |
| 历史 | 同步最近 30 天、最多 500 条 |
| 前置条件 | PC 必须保持开机、联网、执行环境可达；建议开 keep-awake |
| 未文档化 | 传输走 LAN / 中转 / 云、是否加密、如何吊销设备 —— 官方页面都没写 |

**可借鉴的形态结论**：手机端不是"远程桌面"，而是**同一份任务状态的第二视图 + 少量写动作**。
它刻意不搬到 PC 上的一切。这一点和 Octopus 的作战舱思路天然吻合（任务/会话/待你决定三样）。

### 1.2 WorkBuddy（未能证实）

公开检索显示 WorkBuddy 是腾讯的 AI 办公工作台，有桌面端；**未见"手机远控桌面"的官方说明**。
本调研不把它当作参考实现。若你实际用过某个具体功能，请以你的体验为准补充。

### 1.3 这类产品的通用四层拆解

```
[手机 App / PWA]
      │  ① 可达性：LAN / 虚拟网 / 反向隧道 / 自建中转
      ▼
[鉴权与配对层]  ② 设备令牌、配对码、吊销列表
      │  ③ 指令协议：其实就是 HTTP 请求 + 事件流
      ▼
[PC 上的 Agent 服务] —— Octopus server（已有）
      │
      ▼
[推送层] ④ APNs / FCM / Web Push —— 把"待你决定"叫醒手机
```

绝大多数产品真正的工作量在 ① 和 ④；③ 是复用现成的。

### 1.4 开源实现扫描（GitHub，2026-11-26）

先澄清一个容易搞混的点：DSH 社区的 `everettjf/dsh-ios`（43★）**不是远控**，而是把 `dsh`
整个跑在 iPhone 上（iSH-ARM64 模拟器 + Alpine + Node 22，镜像约 81 MB，性能受限、只做实验、不上架）。
「把 harness 搬到手机」和「手机远控 PC」是两条完全不同的路。

真正的远控实现按通道可分成五类：

| 类型 | 代表项目 | ★ | 做法 |
|---|---|---|---|
| 自建中继 + 原生 App | [`slopus/happy`](https://github.com/slopus/happy) | 24.8k | CLI/桌面端主动外连 relay；iOS(Swift)/Android(Kotlin)/Web 三端；E2E 加密；Cloudflare Worker 推 APNs/FCM |
| 反向隧道 + 浏览器 | [`amantus-ai/vibetunnel`](https://github.com/amantus-ai/vibetunnel) | 4.7k | 把终端/agent 反代进任意浏览器；远程访问首选 Tailscale；自带 PAM/口令/SSH key 鉴权 |
| 托管 Agent 平台 | [`omnara-ai/omnara`](https://github.com/omnara-ai/omnara) | 3.5k | 自托管平台：API + 机器池 + dashboard，agent 跑在沙箱里 |
| IM 通道 Bot | [`overwirehq/claude-code-telegram`](https://github.com/overwirehq/claude-code-telegram) | 2.8k | 不写手机 UI，把 agent 直接接进 Telegram / 微信 / 飞书 |
| DSH 插件 + 手机壳 | [`201222-L/dsh-mobile-remote`](https://github.com/201222-L/dsh-mobile-remote) | 127 | 插件跑在 dsh 进程内，电脑端出二维码，Android Flutter App 扫码直连；推送走 Server酱/ntfy/Bark |
| DSH 插件 + 纯浏览器 | [`JUEMING-006/dsh-mobile-remote-control`](https://github.com/JUEMING-006/dsh-mobile-remote-control) | 2 | 同上但不写 App：手机浏览器直连；无云端中继；配对 token 即时轮换 |
| DSH + Tailscale Serve | [`Auxin-zn/dsh-mobile-remote`](https://github.com/Auxin-zn/dsh-mobile-remote) | 5 | 不写一行代码：`tailscale serve --bg 3080` 把回环端口发布成 `https://<machine>.<tailnet>.ts.net` |
| Gateway + 全端 App | [`openclaw/openclaw`](https://github.com/openclaw/openclaw) | 395k | 本地 Gateway 作控制面 + IM channels + 原生 macOS/iOS/Android 应用 |

**值得直接抄的六个设计：**

1. **配对不把 token 放进二维码**（Happy）。CLI 生成一次性 NaCl box 密钥对 → 二维码只放公钥
   `happy://terminal?<base64url(pubkey)>` → 手机扫码后，服务端把 token + 共享密钥**用该公钥加密** →
   CLI 轮询 `/v1/auth/request` 取回并解密保存。二维码泄露 ≠ 凭据泄露。
   参考 `packages/happy-cli/src/ui/auth.ts`、`ui/qrcode.ts`。
2. **中继盲存**（Happy）。客户端用 AES-256-GCM / NaCl secretbox 加密，relay 只存密文；
   每个会话一个 data encryption key，随 `new-session` 事件下发。见其 `docs/encryption.md`。
3. **协议单一来源**（Happy）。`packages/happy-wire`（TS + Zod）被 CLI / iOS / Android / server 共享。
   **Octopus 的 `packages/shared` 就是同一个位置**，加一个 `remote/` 子模块即可，不需要新包。
4. **持久事件与瞬时事件分离 + 每用户单调 `seq`**（Happy `docs/protocol.md`）。断线重连按 seq 对齐，
   客户端"按序应用即一致"。Octopus 的 `SSEService` 有 500 条 ringBuffer 但**没有 seq**，这是要补的第一处。
5. **推送独立成小服务 + 可换通道**。Happy 用 Cloudflare Worker 推 APNs/FCM；DSH 社区更轻：
   Server酱 / ntfy / Bark / 企业微信机器人任选，**不依赖 App 常驻后台**。后者对 Octopus 是更低成本的第一步。
6. **审批双端同源**（DSH）。`approvalMode: both | mobile | desktop`，同一个待办任一端回答、两端同步消失。
   与 Octopus 的 `interaction` / attention 模型同构，可以直接照搬这个语义。

**不要抄的：**

- **从零写 iOS + Android 两套原生**。Happy 是 Swift + Kotlin 双端，属于多年工程量。Octopus 先 PWA，再 Capacitor。
- **早期自建 relay 集群**。Happy 的 relay 是 Fastify + Socket.IO + Postgres + Redis + S3；DSH 社区那个
  云中继 `april-jk/dsh-relay` 只有 2★。先 Tailscale，把中继当成后期的事。
- **给桌面端开 `0.0.0.0`**。DSH 桌面版同样强制回环，社区方案都是另开「LAN 桥」或走 Tailscale ——
  这反过来说明 Octopus sidecar 保持绑 `127.0.0.1` 是正确的，**不要为了手机去改它**。

许可证都友好（Happy/VibeTunnel/DSH 插件为 MIT，Omnara 为 Apache-2.0），代码可以参考甚至直接搬。

---

## 2. Octopus 现状盘点（代码事实）

| 能力 | 现状 | 位置 |
|---|---|---|
| HTTP API | Hono，全部 REST | `packages/server/src/routes/*` |
| 实时事件 | 进程内 SSEService + 每 workspace 一条 SSE | `packages/server/src/services/sse.ts`、`routes/events.ts:8` |
| WebSocket | 仅 Yjs 文档协同用 | `packages/server/src/index.ts:1151` |
| 鉴权 | **几乎为零**；仅 `/api/agent` 校验内部 `Bearer agent` | `routes/agent/middleware.ts:94` |
| 服务绑定 | dev 默认 `0.0.0.0`；桌面 sidecar 强制 `127.0.0.1` | `index.ts:1107`、`desktop/src/main.ts:127` |
| 静态托管 | prod 同源托管 web dist | `index.ts:1109` `createWebStaticHandler` |
| 手机访问 | dev 已把**本机非回环 IP** 注入 `SERVER_URL`，注释明确写着"供手机等其它设备访问（LAN / Tailscale）" | `web-app/lib/server-config.ts:45-51` |
| 通知 | 出站 one-way：hermes → Telegram / Slack | `server/src/services/notification.ts` |
| 移动布局 | 无。web-app 全是桌面尺寸的窗口/双栏 | — |

**结论**：手机"发指令"的 API 已经齐了；"看结果"的通道已经齐了；缺的是门锁、门牌和一块手机尺寸的仪表盘。

---

## 3. 四种可达性方案

| # | 方案 | 成本 | 延迟 | 依赖 | 适用 |
|---|---|---|---|---|---|
| A | **局域网 / 虚拟局域网**（手机与 PC 同 Wi-Fi，或都装 Tailscale；`tailscale serve` 可直接发布成 HTTPS 域名） | 极低（1 天） | 最低 | 同网 / 装 Tailscale | 自己用、出差时的家用机 |
| B | **反向隧道**：cloudflared / rathole / frp / ngrok | 低（1–2 天） | 中（多一跳） | 第三方或一台小 VPS | 快速验证、内测分发 |
| C | **自建中转 relay**：PC 主动外连 WSS，手机连 relay，relay 转发 | 中高（1–2 周） | 中 | 自己的服务器 + 运维 | 正式产品、多用户 |
| D | **原生 App 壳**（Capacitor/RN） | 中（3–7 天） | 同 A/B/C | App 商店账号 | 需要推送/离线的正式版 |

关键判断：

- **B 不要自己造多路复用协议**。SSE、WebSocket、大文件上传、背压都不是玩具。
  `cloudflared` / `rathole` 已经把"PC 主动外连、公网反代回本机"做完了，直接嵌二进制 + 自动拉起即可。
- **A 是验证成本最低的路径**，而且代码注释显示你们已经用手机构 LAN/Tailscale 访问过 dev。
- **C 只有在要做成对外产品时才值得**。自建 relay 的本质是一台「TCP/HTTP 反代 + 设备注册表」，
  PC 侧仍然是一个出站连接器，手机侧仍然走标准 HTTP/SSE —— 所以 C 和 B 在 Octopus 内部是**同一个接口**，
  可以先按 B 落地，日后把连接器从 cloudflared 换成自家 relay 而前端零改动。
- **D 建议晚做**。先用 PWA（添加到主屏）拿到 80% 体验；真正需要的是推送和生物识别解锁，
  那时再套 Capacitor，Web 代码原样复用。

---

## 4. 目标架构（推荐）

```
        ┌──────────── 手机 ────────────┐
        │ 移动壳 /m（PWA）              │
        │  ① 待你决定   ② 会话   ③ 任务 │
        └──────────┬───────────────────┘
                   │ HTTPS + Device Token
        ┌──────────▼───────────┐
        │ 通道：Tailscale 或隧道 │  ← 可替换，前端无感
        └──────────┬───────────┘
                   │
   ┌───────────────▼──────────────────────────────┐
   │ Octopus server（PC）                          │
   │  ┌────────────┐  ┌─────────────┐  ┌────────┐ │
   │  │ device-auth│→ │ 现有 /api/* │→ │ 引擎/舱 │ │
   │  │ middleware │  │ SSE events  │  │ 任务域  │ │
   │  └────────────┘  └─────────────┘  └────────┘ │
   │        ▲                                      │
   │   pairing 路由（仅本机回环可调）                │
   └───────────────────────────────────────────────┘
                   │ attention 事件
                   ▼
             推送服务（Web Push / FCM）
```

### 4.1 鉴权与配对（P0，必须先做）

新增 `packages/server/src/middleware/device-auth.ts`，规则：

- **回环豁免**：请求来自 `127.0.0.1` / `::1` 且带 Electron 注入的标记 → 放行（否则桌面版会自锁）。
- **内部通道豁免**：现有 `Authorization: Bearer agent` 继续有效，但要改成只在回环来源上接受。
- **其余一律要求设备令牌**：`Authorization: Bearer <device-token>` 或 `X-Octopus-Device: <token>`。
- 令牌 **32 字节随机**，DB 里只存 `sha256(token)`；每台设备一行。

新表 `devices`（建议随 `packages/server/src/db` 的迁移一起加）：

| 字段 | 说明 |
|---|---|
| `id` | `dev_xxx` |
| `name` | 手机型号 / 用户起的名字 |
| `token_hash` | sha256(token)，不存明文 |
| `scopes` | `read` / `chat` / `decide` / `trigger` / `admin` |
| `created_at` / `last_seen_at` / `revoked_at` | 审计与吊销 |

配对流程：

1. PC 端设置页点「添加手机」→ 服务端生成 **6 位一次性配对码**（TTL 2 分钟）+ 二维码。
   二维码 payload：`octopus://pair?v=1&url=<https 隧道地址或 LAN 地址>&code=123456`。
2. 手机扫码（或手动输入）→ `POST /api/pair/redeem {code, deviceName}` → 换回长期 device token，
   手机存进安全存储（Keychain / Android Keystore / Web: IndexedDB + PWA 前提）。
3. PC 端「已配对设备」列表可随时吊销。

注意：`/api/pair/*` 只允许**回环来源**发起生成，防止内网他人自签配对码。

### 4.2 移动壳 `/m`（P1）

不做第二套前端，做**同一 SPA 里的第三种壳**（参考现有 classic / cockpit 双壳）：

```
/m                      → 三块导航：待你决定 · 会话 · 任务
/m/inbox                → GET /api/cabins/:id/attention 聚合
/m/chat/:sessionId      → 复用 TuiTranscript 渲染，输入框发消息
/m/tasks                → 任务/执行状态（只读 + 少量动作）
/m/device               → 配对、设备管理
```

原则（与 CLAUDE.md 的舱系设计一致）：

- **换皮肤不换内容**：消息还是那份 TUI 语法（`❯ 你` / `✦ 汐音` / `▸ tool`），只是窄屏重排。
- **动作白名单**：手机只允许 读 / 发消息 / 回应急需决定 / 投递事项 / 触发或暂停任务 / 批准审批。
  **不允许**：改 workflow YAML、删舱、归档、改 spec 字段 —— 这些仍需在 PC 上做。
- SSE 在 App 切后台会被系统掐断，回到前台要重新 `last-event-id` 或重新拉一次快照；
  真正的"叫醒"交给推送层。

### 4.3 推送（P2）

- attention 的 `stage`（`answer` / `start` / `review` / `adjudicate` / `approval` / `blocked`）
  本来就在 `deriveCabinView` 里纯派生 —— **推送触发点直接挂在它的状态跃迁上**，不新增业务状态。
- **第一步用现成推送通道，不要先做 Web Push**：照 DSH 社区做法接 ntfy / Bark / Server酱 /
  企业微信机器人，实现量是"一个带 URL 的 POST"，且不依赖手机常驻后台。
  等确实需要点进 App 再上 Web Push（PWA，Android 全支持、iOS 需"添加到主屏"）→ 最后才是 FCM/APNs。
- 推送内容只放「哪个舱、哪件事、什么类型」，不放正文，点开再拉详情。

### 4.4 远程通道的连接器

`packages/desktop` 加一个 `remote-connector` 模块：

- 设置项 `remote.enabled` / `remote.provider = tailscale | cloudflared | relay`。
- 开启时：启动对应客户端（捆绑二进制或检测系统安装），把 `127.0.0.1:47820` 反代出去，
  拿到公网 URL 回填到配对二维码。
- **sidecar 保持绑 127.0.0.1**（`desktop/src/main.ts:127` 不要改），由连接器从回环出去。
  这是安全默认值：不开启远程时，机器在 LAN 上也不暴露。

### 4.5 本机实测（2026-11-26）

| 项 | 值 |
|---|---|
| Tailscale | 1.104.6，已登录 `xie.zhifeng1989@` |
| 本机 PC | `WIN-K724LD3R2L2` · `100.104.28.35` · DNS `win-k724ld3r2l2.tail363fcb.ts.net` |
| 手机 | `gt8` · `100.93.247.5` · Android · 在线（`tailscale ping` 已 pong） |
| MagicDNS | 已开启（suffix `tail363fcb.ts.net`） |
| HTTPS 证书 | **未开启**（`CertDomains` 为空） |
| serve 配置 | 无 |

手机接 PC 的两条路：

- **A（推荐）`tailscale serve --bg 47820`** → `https://win-k724ld3r2l2.tail363fcb.ts.net`。
  serve 会把 127.0.0.1:47820 代理到 tailnet，**Octopus 零代码改动**；真证书，Android 默认放行 HTTPS。
  前置：在 Tailscale 管理台（DNS 页）开启 **HTTPS Certificates** —— 现在 `CertDomains` 为空就是没开。
- **B（兜底）直连 tailnet IP**：桌面壳加一个只绑 `100.104.28.35` 的监听（如 47821）反代到回环。
  App 连 `http://100.104.28.35:47821`。WireGuard 已加密，但 Android 9+ 默认禁明文，
  需要在 App 的 network security config 里放行 `100.64.0.0/10`。

两条路都不要把 sidecar 改成绑 `0.0.0.0`。另外可以用 Tailscale ACL 把 47820 端口限定为只允许 `gt8` 访问，
和设备令牌形成两层防护。

**域名稳定性**：`<机器名>.<tailnet>.ts.net` 由「设备名 + tailnet 唯一后缀」拼成，正常使用不会变。
会变的情况只有三种：在管理台**改设备名**、**删除设备后重新加入**、**切换 tailnet（换账号）**。
注意默认设备名来自 Windows 主机名（`WIN-K724LD3R2L2` → `win-k724ld3r2l2`），不便于记忆；
建议在管理台改成固定名字（如 `octopus-pc`），之后 URL 就是 `https://octopus-pc.tail363fcb.ts.net`。
另外 Tailscale IP（`100.104.28.35`）也是每节点稳定的，删除重加才可能变。
**工程结论：App 不要把 URL 硬编码**，把它当作配对二维码里的 `url` 字段存到本地 + 设置页可改，
域名真变了只需重新配对，设备令牌不受影响。

**推送结论（针对自研 Android App）**：App 解决的是 UI 和深链，**不自动解决推送**。
按成本从低到高：ntfy / 企业微信机器人等现成通道 → FCM（需 gt8 有 Google 服务且网络可达）
→ 国内厂商推送（每家一个 SDK）→ App 前台服务常驻 WS（耗电、常驻通知，Doze 仍可能冻结）。
建议先测 gt8 的 FCM 可用性，不行就用 ntfy/企微机器人；App 只负责点开深链。

---

## 5. 多设备与远程启动（Sentinel）

前面几节默认「一台 PC」。多设备 + 未启动时远程拉起，需要多一个常驻角色。

> **已定方案（2026-11-26）：不自建 Sentinel 常驻进程。**
> 哨兵角色由「托盘常驻的 Octopus.exe」+「sshd + `octopus-ctl` 强制命令 + 计划任务」共同承担。
> 下面 §5.3–5.4 的 Sentinel HTTP API 仅作为备选存档，**不落地**；落地路径见 §5.9。

### 5.1 角色拆分

```
手机 App
  │  (Tailscale / WireGuard)
  ├──────────────► Octopus server  127.0.0.1:47820   ← 干活，可被杀
  └──────────────► Octopus Sentinel  <tailnet>:47830 ← 常驻哨兵，只做四件事
```

**Sentinel 只允许四类动作，绝不能是通用命令执行器：**

1. 证明"这台设备在线"
2. 报告 Octopus 状态：`running | starting | stopped | unhealthy` + 版本 + 端口 + PID
3. 启动 / 停止 Octopus
4. 完成配对（出二维码、兑换配对码）

### 5.2 配对必须放在 Sentinel，而不是 Octopus

如果二维码由 Octopus 页面出，那"Octopus 没启动"时就配不了对 —— 先有鸡还是先有蛋。
所以**加设备 = 扫 Sentinel 的二维码**，二维码里同时带上 Octopus 的地址，配对成功后 App 两个地址都记住。

### 5.3 Sentinel API（v1）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sentinel/ping` | `{deviceId, name, os, version}`，探活 |
| GET | `/sentinel/status` | 设备 + Octopus + Tailscale 三段状态 |
| GET | `/sentinel/events` | SSE：状态跃迁（starting → running/failed） |
| POST | `/sentinel/octopus/start` | 返回 `jobId`；需要 `launch` scope |
| POST | `/sentinel/octopus/stop` | 同上；可选，默认不开 |
| GET | `/sentinel/pair/new` | **仅回环来源**可调，返回一次性配对码 + 二维码 |
| POST | `/sentinel/pair/redeem` | 手机用配对码换设备令牌 |

`status` 形状：

```json
{
  "device":  { "id": "dev_x", "name": "书房主机", "os": "windows" },
  "octopus": { "state": "running", "port": 47820, "version": "1.0.0", "pid": 1234, "uptimeSec": 3600 },
  "tailscale": { "ip": "100.104.28.35", "dnsName": "octopus-pc.tail363fcb.ts.net" }
}
```

**健康判定不要另造**：Octopus 已有 `GET /api/actuator/health`
（`packages/server/src/routes/actuator.ts:25`，down 时返回 503）。Sentinel 每 2s 探一次：
200 → `running`，503 → `unhealthy`，连接被拒 → `stopped`。

### 5.4 启动机制（Windows）

| 方案 | 开机自启 | 未登录可用 | 能拉 GUI | 复杂度 |
|---|---|---|---|---|
| 登录任务（`schtasks /sc onlogon` 或启动文件夹） | ✅ | ❌ | ✅ | 低 |
| Windows 服务（session 0） | ✅ | ✅ | ❌（只能拉 sidecar） | 中 |
| 服务 + 登录任务混合 | ✅ | ✅ | ✅ | 高 |

**建议 P0.5 先用登录任务**：`POST /start` 直接 `spawn Octopus.exe`。锁屏不影响，未登录才不行。

若以后要"开机就能从手机用"，改成服务版：服务只启动 **sidecar**（`node resources/server/dist/index.js`，
带 `OCTOPUS_WEB_DIR` / `OCTOPUS_DB_PATH`）—— 手机远控本来就不需要 GUI。
但这要求桌面壳改成「47820 上已有服务就直接连，没有才自己 spawn」，否则会抢端口。

必做细节：

- **幂等启动**：先探 47820，活着就不再拉第二份。
- **冷启动慢**：桌面壳实测 40–75s（`desktop/src/main.ts:20` 注释），`starting` 状态要给足 90s，
  期间靠 SSE 推心跳，别让手机以为失败了。
- **失败可诊断**：回传 sidecar 日志尾部（脱敏后），否则手机端只有一个"失败"。

### 5.5 睡眠 / 关机边界（必须写进产品前提）

PC 睡眠或关机时 Sentinel 也不在，手机什么都做不了。Tailscale 不能唤醒睡眠机器。
可选缓解：BIOS「通电自启」+ 智能插座；或同一局域网里另一台常开设备发 WoL；
或干脆让主机插电时不睡眠。不要向用户承诺"随时能唤醒"。

### 5.6 App 侧的多设备模型

App 本地维护 `devices[]`：

```
{ deviceId, name, sentinelUrl, octopusUrl, token, lastSeen, status }
```

- **加设备**：扫 Sentinel 二维码，不经过云端，不需要账号。
- **切换设备**：切 baseUrl + token。每个设备的舱/会话本来就独立存在各自的 PC 上，**不跨设备同步**。
- **状态三档**：`离线`（Sentinel 不通）/ `在线·未启动`（可点启动）/ `在线·运行中`（可进入）。
- **发现**：v1 手动扫码即可；设备多了再考虑用 Tailscale 只读 API 列出 tailnet 设备，
  并发探测 `:47830/sentinel/ping` 做一键发现（需要一个只读 OAuth client，仅个人自用可接受）。

### 5.7 App 导航：设备 → 两件事

```
设备列表（带状态灯）
 └─ 选中设备
      ├─ 作业舱：列表 → 进入某个舱
      └─ 新建单独会话：POST /api/chat/global/sessions
```

单独会话 API 已经存在（`packages/server/src/index.ts:574` 挂载 `/api/chat/global`）。
舱内仍是三块：待你决定 / 会话 / 任务。

### 5.8 安全

- Sentinel 与 Octopus **端口分开、令牌分开、scope 分开**（`launch` 才允许 start/stop）。
- Tailscale ACL 限定只有 `tag:phone` 能访问各设备的 47820 / 47830。
- Sentinel 的写接口参数只有设备自身 ID，**不接受任意路径或命令**。
- 配对沿用 Happy 那套：二维码只放公钥，token 加密下发；配对码一次性、2 分钟过期。
- 审计：每次 start/stop 落日志，手机端可见。

### 5.9 SSH 方案：用系统自带的"哨兵"

两台机器都已开 SSH（本机实测：Windows OpenSSH 9.5p1，`sshd` 服务 Running / 自动启动，
监听 `0.0.0.0:22`）。SSH 确实能承担 Sentinel 的三个核心动作：

| 动作 | SSH 命令 |
|---|---|
| 判定设备在线 | TCP 连 22 |
| 判定 Octopus 状态 | `ssh host octopus-ctl status` |
| 启动 Octopus | `ssh host octopus-ctl start` |

但有三件事必须做对，否则会踩坑：

1. **绝不能给手机一个 shell**。用 `authorized_keys` 的 `command=` 强制命令 + 参数白名单：
   ```
   command="C:\\ProgramData\\octopus\\octopus-ctl.ps1" ssh-ed25519 AAAA...
   ```
   脚本只认 `status | start | stop`，其余一律拒绝。这样一把密钥的权限 ≈ 一个 Sentinel token。
2. **Windows 上 SSH 拉不起 GUI**。`sshd` 跑在 session 0，`Start-Process Octopus.exe` 的窗口
   不会出现在你的桌面。解法：预建一个「仅在用户登录时运行」的计划任务 `Octopus`，
   SSH 只负责 `schtasks /run /tn Octopus`，由计划任务在交互会话里拉起 GUI。
   如果接受"手机远控不需要 GUI"，也可以只拉 sidecar。
3. **管理员账号的密钥位置**。本机 `EDY` 属于 Administrators，`sshd_config` 的
   `Match Group administrators` 会把密钥指向 `C:\ProgramData\ssh\administrators_authorized_keys`，
   而不是 `~/.ssh/authorized_keys`；且该文件 ACL 必须只保留 Administrators + SYSTEM，
   否则 sshd 会静默忽略。这是 Windows OpenSSH 最常见的坑。

安全前置：当前 `PasswordAuthentication` 没有显式关闭（默认 yes），sshd 又监听 `0.0.0.0:22`。
在放入手机密钥之前，应关掉密码登录，并用 Tailscale ACL 只允许手机访问 22 / 47820。

**三种生命周期通道的取舍：**

| | A. 自研 HTTP Sentinel | B. SSH 强制命令（推荐 v1） | C. 纯 SSH + 端口转发 |
|---|---|---|---|
| 新增常驻进程 | 有 | **无**（复用 sshd） | 无 |
| 手机实现复杂度 | 低（HTTP + token） | 中（SSH 库 + 密钥） | 高（SSH + 本地转发 + 重连） |
| 权限最小化 | 天然 | 靠 `command=` 配置 | 靠 `command=` 配置 |
| 跨平台 | Win/macOS 分别实现 | 两平台自带 | 两平台自带 |
| 拉 GUI | 计划任务 | 计划任务 | 计划任务 |
| API 传输 | 直连 tailnet HTTP | 直连 tailnet HTTP | 全程走 SSH 隧道 |

**结论：SSH 可以替代"自建常驻服务"，但不能替代 Sentinel 这个角色。**
你仍然需要每平台一个 `octopus-ctl` 脚本 + 一个计划任务 + 一套给手机下发公钥的配对流程，
只是这些落在 OS 自带能力上，而不是一个新进程。

推荐组合（B）：**Octopus API 走 tailnet 直连 HTTP，SSH 只负责 status / start / stop**。
理由：手机端绝大多数交互是普通 HTTP（SSE 原生、实现简单、快），SSH 只在"没启动/探活"时出现；
配对时二维码一次下发两样东西（设备 token + SSH 公钥授权），用户体验上仍是一次扫码。

状态轮询不要每次走 SSH：先试 `GET http://<device>:47820/api/actuator/health`（300ms 超时），
失败再走 SSH `status`，这样绝大多数请求不产生 SSH 握手。

### 5.10 server / GUI / 客户端的拓扑（现状与目标）

Octopus **现在就已经是"server 进程 + GUI 窗口 + 浏览器界面"三件套**，不需要新增拆分：

- `packages/server` 是唯一真源：持有 `~/.octopus/db`，跑任务/会话/执行/SSE。
- `packages/desktop` 是 Electron 壳：打包模式下 `spawn` 一个 sidecar
  （`node resources/server/dist/index.js`），窗口加载 sidecar 托管的 SPA
  （`desktop/src/main.ts:122`）。
- 所以「桌面端」不是 server，它只是 **server 的第一个客户端**。

问题出在**生命归属**：窗口一关，Electron `app.quit()` → `before-quit` → `stopSidecar()`
（`main.ts:323`、`main.ts:331`、`main.ts:179`），server 跟着死。手机端要"随时可用"，
必须先解决这一点。

三档方案：

| | A. 现状 | B-. 托盘常驻 | B. 服务化 |
|---|---|---|---|
| server 的父进程 | Electron 窗口 | Electron（隐藏到托盘） | 系统 |
| 关窗口后 server | **退出** | 继续跑 | 继续跑 |
| 未登录可用 | ❌ | ❌ | ✅ |
| 改动量 | 0 | 小 | 大 |

**产品决策（2026-11-26）：Octopus.exe 是唯一入口，server 绝不单独运行。**
启动 server 必然意味着启动桌面程序。因此排除 B（服务化），采用 B-。

**这条决策的直接推论：**

- server 的生命周期严格嵌套在 Octopus.exe 进程内；没有"headless server"模式。
- 关窗口 ≠ 退出：窗口关闭后隐藏到托盘，server 继续跑；只有托盘菜单「退出 Octopus」才停 server。
- 开机自启 = 启动 `Octopus.exe --tray`（进程在、窗口不弹、托盘有图标）。
- **"手机远程启动"必须有进程外的东西触发**——因为进程不在时，没有任何监听者能接收命令。
  这个触发者就是 §5.9 的 SSH + 计划任务：`schtasks /run /tn Octopus` 以交互用户身份拉 `Octopus.exe --tray`。
  不是妥协，是逻辑必然。

### 5.11 macOS 可行性（与 Windows 对照）

结论：**「Octopus.exe 是唯一入口 + 托盘常驻 + SSH 触发」在 macOS 上同样成立**，
差异只在"怎么拉 GUI"和"怎么开机自启"。这也正是不做系统服务的原因 ——
macOS 上让 LaunchDaemon 去拉一个 GUI 应用比 Windows 更别扭（GUI 属于 Aqua 会话，不是服务会话）。

| 环节 | Windows | macOS |
|---|---|---|
| 托盘 | `Tray` + `icon.ico` | `Tray` + 模板图（`setTemplateImage(true)`），显示在菜单栏 |
| 关窗不退出 | 改 `window-all-closed` | 同；托盘模式下可 `app.dock.hide()` 隐藏 Dock 图标 |
| 开机自启 | `app.setLoginItemSettings` 或计划任务 | LaunchAgent plist，或 `setLoginItemSettings` + `wasOpenedAtLogin` |
| 远程拉起 GUI | `schtasks /run /tn Octopus` | **`open -a Octopus --args --tray`**（有 GUI 会话即可） |
| 状态检测 | `curl /api/actuator/health` + `tasklist` | `curl` + `pgrep -f Octopus.app/Contents/MacOS/Octopus` |
| 优雅停止 | `taskkill` / 计划任务 | `osascript -e 'tell application "Octopus" to quit'` |
| SSH 密钥位置 | 管理员 → `C:\ProgramData\ssh\administrators_authorized_keys` | `~/.ssh/authorized_keys`（无管理员特例） |
| `command=` 强制命令 | 支持 | 支持（同一套写法） |
| 未登录可用 | ❌ | ❌（`open` 需要有 Aqua 会话） |

**macOS 特有的风险：**

1. **签名与公证**。当前 `electron-builder.yml` 里 `mac.identity: null`（不签名）、target 只有 `dir` + `arm64`。
   自用构建、本机运行没问题；要分发给别人则需要 Developer ID 签名 + 公证，
   而且 `Contents/Resources/runtime/node` 这个被 spawn 的二进制也要一并签名，否则 hardened runtime 下可能被拦。
2. **图标**。`build/` 下只有 `icon.ico` 和 `icon.png`。macOS 需要 `.icns`（electron-builder 可由 ≥512×512 的 png 生成），
   托盘还需要一张单色模板图（16/32px）。
3. **Tailscale CLI 路径不统一**。独立安装包通常在 `/usr/local/bin/tailscale`，
   App Store 版在 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`，脚本要两个都探。
4. **`open -a` 的前提**。和 Windows 一样，Mac 停在登录界面时拉不起来；锁屏但已登录则可以。

**跨平台统一的东西**：`octopus-ctl status|start|stop` 是同一套命令接口，内部按平台分支，
输出同一份 JSON。手机端不需要知道对面是 Windows 还是 macOS —— 只认这三个动词和 JSON。
以后加 Linux 只是再写一段分支。

---

## 6. 分阶段实施计划

### P0 · 鉴权 + 配对（2–3 天）

改动点：

- `packages/server/src/middleware/device-auth.ts`（新）
- `packages/server/src/routes/pair.ts`（新，仅回环可生成）
- `packages/server/src/db/*`：`devices` 表迁移
- `packages/server/src/index.ts`：全局挂载 middleware（注意 `/api/pair`、`/api/actuator/health` 例外）
- `packages/web-app/lib/api-client.ts`（或等价的 fetch 封装）：自动带 device token；回环下不带
- 桌面设置页：添加手机 / 设备列表 / 吊销

验收：

1. 不带 token 从非回环地址请求 `/api/cabins` → 401。
2. 桌面版（回环）一切功能不受影响。
3. 配对码 2 分钟过期、只能用一次、错 5 次锁 5 分钟。
4. 吊销后该设备立刻 401。

### P0.5 · 托盘常驻 + 远程拉起（3–5 天）

目标：Octopus 没启动时，手机仍能看到设备、并把它拉起来。

改动点（**采用路 B**，见 §5.9）：

- **路 B · SSH 方案**：每平台一个 `octopus-ctl` 脚本（status/start/stop）+
  「仅在用户登录时运行」的计划任务 + `authorized_keys` 的 `command=` 强制命令；
  不新增常驻进程。`start` 实际执行 `schtasks /run /tn Octopus`，拉起的进程带 `--tray`。
- ~~路 A · 自建 Sentinel~~：存档，不落地（产品决策：server 不单独运行）。
- 共同项：桌面壳 `--tray` 模式、托盘常驻、登录自启、单实例。

> **2026-11-26 已落地（只有共同项里的桌面壳部分）**：`--tray` 启动即隐藏、关窗收进托盘、
> 托盘菜单（显示主窗口 / 开机自启 / 退出 Octopus）、macOS 模板图 + `dock.hide()`、
> 退出前查 `/api/agent/sessions/running` 拦在跑的 agent。图标在
> `packages/desktop/build/tray/`（16/32 两档 + mac 模板图），打包时经
> `prepare-resources.mjs` 进 `resources/tray`。**已构建、未重新打包分发**——
> 现有安装版还是旧壳。`octopus-ctl` + 计划任务（路 B 的 SSH 部分）仍未开始。

验收：

1. 关掉 Octopus，手机 `GET /sentinel/status` 返回 `stopped`。
2. `POST /sentinel/octopus/start` 后 90s 内手机看到 `running` 并能进入舱。
3. 连点启动不会拉起第二份进程。
4. 没有 `launch` scope 的设备调 start → 403。

### P1 · 移动壳 + PWA（3–5 天）

先用一个最小 Web 壳把协议打通（手机浏览器可用），再套自研 App —— 协议不变，App 只是换容器。
- `/m` 路由与三块页面；复用 `TuiTranscript`、`cabin-api.ts`。
- `manifest.webmanifest` + service worker（仅做壳缓存，不缓存 API）。
- 手机通过 Tailscale（或 cloudflared）访问 `/m`，完成一次真实的「手机下指令 → PC 执行 → 手机看结果」闭环。

验收：在地铁上用手机 4G 给家里 PC 下一条「继续执行当前任务」，30 秒内看到 SSE 流式输出。

### P2 · 推送 + 连接器（1–2 周）

- attention 跃迁 → 先接现成推送通道（ntfy / Bark / Server酱 / 企业微信机器人），
  再按需换 Web Push；`devices` 表加 `push_subscription`。
- desktop 远程连接器（cloudflared / 自建 relay 二选一，接口抽出）。

### P3 · 原生壳（按需）

- Capacitor 套壳 `/m`：推送换成 FCM/APNs、加生物识别解锁、加文件选择器。

---

## 7. 风险与未验证项

| 风险 | 说明 / 缓解 |
|---|---|
| **安全** | 当前 API 能执行任意命令。鉴权未落地前，**不要**给 server 开公网绑定或隧道。 |
| SSE 后台断流 | 手机浏览器/系统会掐后台连接；靠推送唤醒 + 前台重连，不做"后台常驻连接"假设。 |
| Windows 防火墙 | 绑 `0.0.0.0` 会弹防火墙授权；远程模式下应引导用户只放行私有网络或干脆只走回环 + 隧道。 |
| 多设备并发写 | 同一会话手机与 PC 同时发言需要冲突策略：现有 chat 是追加式消息，风险低；审批类动作需要"先到先得 + 状态校验"。 |
| 隧道第三方可见 | cloudflared 在 Cloudflare 终结 TLS；对隐私敏感时选 Tailscale（WireGuard）或自建 relay + 自家证书。 |
| Qoder 传输细节未知 | 官方文档未写走 LAN 还是中转；本方案的通道层不依赖这一点。 |
| WorkBuddy 未证实 | 公开资料未见手机远控，不作为参考实现。 |

---

## 8. 参考链接

**产品文档**

- Qoder 移动端远控：<https://docs.qoder.com/mobile/app/remote-control>
- Qoder 移动端下载/能力：<https://docs.qoder.com/mobile/app/download>
- Qoder Cloud Agents：<https://docs.qoder.com/cloud-agents/overview>

**开源实现**

- Happy（自建中继 + 三端 App + E2E）：<https://github.com/slopus/happy>
  - 后端架构：`docs/backend-architecture.md` · 加密：`docs/encryption.md` · 协议：`docs/protocol.md`
  - 配对实现：`packages/happy-cli/src/ui/auth.ts`、`ui/qrcode.ts`
- VibeTunnel（反向隧道 + 浏览器）：<https://github.com/amantus-ai/vibetunnel>
- Omnara（自托管 Agent 平台）：<https://github.com/omnara-ai/omnara>
- OpenClaw（Gateway + IM + 全端 App）：<https://github.com/openclaw/openclaw>
- Claude Code Telegram（IM 通道）：<https://github.com/overwirehq/claude-code-telegram>
- DSH 手机远控（插件 + Flutter App）：<https://github.com/201222-L/dsh-mobile-remote>
- DSH 手机远控（纯浏览器 + 无中继）：<https://github.com/JUEMING-006/dsh-mobile-remote-control>
- DSH + Tailscale Serve：<https://github.com/Auxin-zn/dsh-mobile-remote>

**仓库内既有文档**

- `docs/research/qoder-sdk-integration.md`（Provider 集成，与本篇互补）
