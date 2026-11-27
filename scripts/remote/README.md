# scripts/remote · 手机远程拉起（M4）

> 设计：`docs/cabin-design/design/35-mobile-dev-plan.md` §5 M4 · `docs/research/mobile-remote-control.md` §5.9

## 为什么是 SSH

Octopus 的 server 嵌在桌面程序里（`Octopus.exe`）。程序没跑的时候，手机上没有任何监听者 ——
这是产品决策（「Octopus.exe 是唯一入口，server 绝不单独运行」），不是 bug。
但系统自带的 sshd 常驻，所以手机用配对时拿到的一把**受限密钥**进来，让 PC 执行一个只认
`status` / `start` 的脚本，再由脚本通过「登录时运行」的计划任务把 `Octopus.exe --tray` 拉起来。

```
手机 ──SSH 22──► sshd ──强制命令──► octopus-ctl.ps1 status|start
                                          │
                                          └─ schtasks /run /tn Octopus ──► Octopus.exe --tray
手机 ──HTTPS 443（tailscale serve）──► Octopus server 127.0.0.1:47820
```

## 两个文件

| 文件 | 干什么 |
|---|---|
| `octopus-ctl.ps1` | 装到 `C:\ProgramData\octopus\`。只认 `status` / `start`，输出一份 JSON；`start` 幂等（已在跑 / 正在起就不会拉第二份）。sshd 的强制命令就是它。 |
| `install-remote.ps1` | 管理员一次性安装。会改 sshd 的 authorized_keys 与配置，见下。 |

## 安全模型

- 手机那把手钥在 `administrators_authorized_keys` 里带：

  ```
  restrict,command="powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\octopus\octopus-ctl.ps1" ssh-ed25519 AAAA... octopus-remote:slot-01
  ```

  `restrict` 关掉端口转发 / agent 转发 / PTY / X11；`command=` 把这条连接钉死在这个脚本上。
  脚本只读 `SSH_ORIGINAL_COMMAND` 的第一个词并**精确匹配** `status` / `start`，绝不 eval。
  一把手机密钥的权限 ≈ 一个「只能查状态 / 只能拉起来」的按钮。
- 密钥用**槽位池**：安装器一次生成 N 把（默认 8），公钥写进 authorized_keys；配对时服务端
  取一把的私钥放进 redeem 响应，**随即从 PC 磁盘删除**。私钥之后只存在于手机的系统安全存储里。
- 设备管理（生成配对码 / 列表 / 改名 / 吊销 / 远程状态）仍然**只许回环** —— 手机能兑换，不能签发。
- **默认不碰 sshd 配置、不重启 sshd**：手机密钥只是 `authorized_keys` 里多出的一行，随连接读取；
  你原来的远程登录方式（密码 / 自己的密钥）完全不受影响。`-DisablePasswordAuth` 是可选的收紧
  （先备份 `sshd_config.bak-octopus-<时间>` → `sshd -t` 校验 → 再重启）。
- 安装器**不会**动已有的其他密钥。若发现没有 `restrict` / `command=` 的密钥（等于一个 shell），
  会在最后点名 —— 是不是要处理由人决定。

## 一键启用（推荐）

Octopus 桌面端 →「设置 → 手机配对 → 远程拉起」→**启用远程拉起**：

1. 桌面端（server）以管理员身份调起本目录的 `install-remote.ps1`（弹一次 UAC）；
2. 机器上还没有 OpenSSH Server 时，安装器会顺带启用 Windows 可选功能（可能要一两分钟）；
3. 装完设置页自己轮询到「已就绪」。

每台 PC 点一次即可。安装器随桌面端打包（`resources/remote/`），不需要仓库。
日志：`%TEMP%\octopus-remote-install.log`。

开发模式（`pnpm dev`，没有桌面端）也是同一个按钮：server 会从仓库 `scripts/remote/` 找安装器。

## 手动安装（开发机 / 一键失败时）

在**以管理员身份**打开的 PowerShell 里：

```powershell
cd C:\xzf\ai\open-octopus
powershell -ExecutionPolicy Bypass -File scripts\remote\install-remote.ps1
```

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `-Slots <n>` | 8 | 生成几把手机密钥槽（每配一台手机用一把） |
| `-DisablePasswordAuth` | 关 | 可选收紧：关闭 sshd 密码登录（会备份配置并重启 sshd；默认完全不碰） |
| `-RecreateTask` | 关 | 计划任务已存在时重建（默认跳过） |
| `-OctopusExe <path>` | `%LOCALAPPDATA%\Programs\Octopus\Octopus.exe` | 桌面程序路径 |
| `-User <name>` | 当前用户 | 目标账号（SSH 用户 / 计划任务运行身份） |

它会做：

1. 把 `octopus-ctl.ps1` 复制到 `C:\ProgramData\octopus\`，ACL：SYSTEM / Administrators 完全控制，
   Users 只读+执行；
2. 在 `~/.octopus/remote/ssh/slots/` 生成 `slot-01…`，公钥带 `restrict,command=` 追加到
   `C:\ProgramData\ssh\administrators_authorized_keys`（按公钥去重；该文件 ACL 修正为 SYSTEM +
   Administrators 独占，否则 sshd 会静默忽略）；
3. 注册登录计划任务 `Octopus` → `<Octopus.exe> --tray`（交互会话、忽略重复实例）；
4. 写 `~/.octopus/remote/remote.json`（server 读它得知 SSH 用户 / 端口 / 槽位目录）；
5. **默认不动 sshd 配置、不重启 sshd**；加 `-DisablePasswordAuth` 才会收紧成只许密钥
   （备份 → `sshd -t` → 重启）；
6. 用 `slot-01` 从本机 `ssh 127.0.0.1 status` 自测一次。

装完打开 Octopus「设置 → 手机配对」，应能看到「远程拉起 · 已就绪 · 密钥槽 N / N」。

## 排错

| 现象 | 先看 |
|---|---|
| 手机上一直「离线」 | 电脑开关机 / 同一 tailnet；`ssh` 22 端口在 Tailscale ACL 里放行了吗 |
| 「在线 · 未启动」但点启动失败 | 电脑上 `powershell -NoProfile -File C:\ProgramData\octopus\octopus-ctl.ps1 status` 看 JSON |
| 点了「启用远程拉起」没反应 | 这台机器可能关了 UAC（`EnableLUA=0`）：桌面端会自动改走「直接执行（需管理员）」；如果 Octopus 本身不是管理员，用管理员身份启动它，或手动跑安装器 |
| `task_missing` | `schtasks /query /tn Octopus`；重跑安装器（或加 `-RecreateTask`） |
| SSH 自测失败 | `administrators_authorized_keys` 的 ACL 是否只有 SYSTEM + Administrators；sshd 是否 Running |
| 电脑睡眠 / 关机 | Tailscale 叫不醒睡眠机器 —— M4 只解决「进程没跑」，这是产品前提 |
| 槽位用完 | 重跑安装器并加大 `-Slots`（老的已发密钥不受影响） |

## 边界

- 只支持 Windows（PowerShell + 计划任务）。macOS 的 `octopus-ctl` + LaunchAgent 未做；
  `status/start` + JSON 这份接口本身是跨平台的。
- 没有 `stop`：v1 不提供「远程关掉 Octopus」。
- 远程控制走直连 SSH，不经过 Octopus server —— 所以「程序没跑」时它也能用。
