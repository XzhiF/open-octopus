#!/bin/bash
# Octopus 远程拉起 · macOS 一次性安装器（M4 对齐版 · 2026-11-27）。
#
# 与 install-remote.ps1 做同一件事，只是换成 macOS 的原生件：
#   1. 把 octopus-ctl.sh 装到 ~/.octopus/remote/（用户级，不需要 root）；
#   2. 生成 N 把 SSH 密钥「槽位」，公钥追加到 ~/.ssh/authorized_keys，
#      带 restrict + command= 强制命令 —— 手机拿到的密钥只能跑 status/start；
#   3. 注册 ~/Library/LaunchAgents/com.octopus.desktop.agent.plist
#      （RunAtLoad → 登录时以 --tray 启动；远程 start 走 launchctl kickstart）；
#   4. 写 ~/.octopus/remote/remote.json（server 读它得知 SSH 用户 / 端口 / 槽位）。
#
# 默认**不碰 /etc/ssh/sshd_config、不重启 sshd、不关密码登录**。只在当前用户的
# authorized_keys 里追加带限制的行，你原来的远程登录方式完全不受影响。
# 若「远程登录」没开，会用一次 macOS 管理员授权（osascript，等价于 Windows 的 UAC）
# bootstrap launchd 的 com.openssh.sshd（macOS 15 上 systemsetup 需要 Full Disk Access，
# 只在兜底时用）。
#
# 用法：
#   bash scripts/remote/install-remote.sh
#   bash scripts/remote/install-remote.sh --slots 12
#   bash scripts/remote/install-remote.sh --app /Applications/Octopus.app

set -u

SLOTS=8
APP_BUNDLE=""
TARGET_USER="$(id -un)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

LABEL='com.octopus.desktop.agent'
CTL_DIR="$HOME/.octopus/remote"
CTL="$CTL_DIR/octopus-ctl.sh"
SLOTS_DIR="$CTL_DIR/ssh/slots"
AUTH_KEYS="$HOME/.ssh/authorized_keys"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Octopus"
LOG_FILE="$LOG_DIR/remote-install.log"
SSH_PORT=22

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --slots) SLOTS="${2:-}"; shift 2 ;;
    --slots=*) SLOTS="${1#*=}"; shift ;;
    --app) APP_BUNDLE="${2:-}"; shift 2 ;;
    --app=*) APP_BUNDLE="${1#*=}"; shift ;;
    --user) TARGET_USER="${2:-}"; shift 2 ;;
    --user=*) TARGET_USER="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage; exit 2 ;;
  esac
done

case "$SLOTS" in
  ''|*[!0-9]*) echo "--slots 必须是正整数" >&2; exit 2 ;;
esac
if [ "$SLOTS" -lt 1 ]; then
  echo "--slots 必须 ≥ 1" >&2
  exit 2
fi
if [ "$TARGET_USER" != "$(id -un)" ]; then
  echo "只能给当前用户安装（收到 --user $TARGET_USER，当前是 $(id -un)）" >&2
  exit 2
fi

mkdir -p "$LOG_DIR"
: > "$LOG_FILE"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$1" >> "$LOG_FILE" 2>/dev/null || true; }
step() { printf '\n== %s\n' "$1"; log "== $1"; }
ok() { printf '   ok  %s\n' "$1"; log "ok  $1"; }
warn() { printf '   !   %s\n' "$1"; log "warn $1"; }
die() {
  printf '\n[失败] %s\n' "$1" >&2
  printf '日志：%s\n' "$LOG_FILE" >&2
  log "FAIL $1"
  exit 1
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g'
}
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# ── 0. 找到桌面程序 ───────────────────────────────────────────────────────
step '检查环境'

if [ -n "$APP_BUNDLE" ] && [ -x "$APP_BUNDLE" ] && [ ! -d "$APP_BUNDLE" ]; then
  # 允许直接传可执行文件。
  APP_BUNDLE="$(cd "$(dirname "$APP_BUNDLE")/../.." && pwd)"
fi
if [ -z "$APP_BUNDLE" ] && [ -n "${OCTOPUS_APP_BUNDLE:-}" ]; then
  APP_BUNDLE="$OCTOPUS_APP_BUNDLE"
fi
if [ -z "$APP_BUNDLE" ]; then
  for candidate in \
    "/Applications/Octopus.app" \
    "$HOME/Applications/Octopus.app" \
    "$SCRIPT_DIR/../../packages/desktop/release/mac-arm64/Octopus.app"; do
    if [ -d "$candidate" ]; then
      APP_BUNDLE="$candidate"
      break
    fi
  done
fi
APP_EXE="$APP_BUNDLE/Contents/MacOS/Octopus"
if [ ! -x "$APP_EXE" ]; then
  die "找不到 Octopus.app（找过 /Applications、~/Applications、release/mac-arm64）—— 先装桌面版，或用 --app 指定"
fi
ok "桌面程序 $APP_BUNDLE"

if [ "$(uname -s)" != "Darwin" ]; then
  die '这个安装器只用于 macOS；Windows 请用 install-remote.ps1'
fi

KEYGEN=/usr/bin/ssh-keygen
SSH_CLIENT=/usr/bin/ssh
NC=/usr/bin/nc
[ -x "$KEYGEN" ] || die '系统没有 /usr/bin/ssh-keygen'
[ -x "$SSH_CLIENT" ] || die '系统没有 /usr/bin/ssh'
[ -x "$NC" ] || die '系统没有 /usr/bin/nc'

# ── 1. 远程登录（sshd）────────────────────────────────────────────────────
step '检查远程登录（sshd）'

port_open() {
  "$NC" -z -w 2 127.0.0.1 "$SSH_PORT" >/dev/null 2>&1
}

if port_open; then
  ok "SSH 端口 $SSH_PORT 已在监听"
elif [ "${OCTOPUS_SKIP_SSHD:-0}" = "1" ]; then
  warn '跳过远程登录检查（OCTOPUS_SKIP_SSHD=1；脚本自测 / 由 MDM 管理 sshd 时用）'
else
  # macOS 15 起 `systemsetup -setremotelogin on` 即使 root 也要求 Full Disk Access。
  # 直接 bootstrap launchd 的 system/com.openssh.sshd（「远程登录」开关的底层服务），
  # 只需要一次普通管理员授权，不碰 sshd_config。
  warn "远程登录没开 —— 申请一次管理员授权（启用 launchd 的 com.openssh.sshd）"
  authorized=0
  if /usr/bin/osascript -e 'do shell script "/bin/launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist; /bin/launchctl enable system/com.openssh.sshd" with administrator privileges' \
    >> "$LOG_FILE" 2>&1; then
    authorized=1
  fi

  tries=0
  until port_open || [ "$tries" -ge 10 ]; do
    tries=$((tries + 1))
    sleep 1
  done

  # 授权拿到了但端口还没开：退回 systemsetup（老系统 / 特殊镜像）。
  if ! port_open && [ "$authorized" = "1" ]; then
    warn 'launchctl 方式没有打开端口，退回 systemsetup（部分系统要求 Full Disk Access）'
    /usr/bin/osascript -e 'do shell script "/usr/sbin/systemsetup -setremotelogin on" with administrator privileges' \
      >> "$LOG_FILE" 2>&1 || true
    tries=0
    until port_open || [ "$tries" -ge 10 ]; do
      tries=$((tries + 1))
      sleep 1
    done
  fi

  if ! port_open; then
    die "管理员授权被取消，或 $SSH_PORT 端口仍未监听 —— 也可以在「系统设置 → 通用 → 共享 → 远程登录」手动打开后重跑（日志：$LOG_FILE）"
  fi
  ok '远程登录已打开'
fi

# ── 2. 安装 octopus-ctl.sh ────────────────────────────────────────────────
step '安装 octopus-ctl.sh'

mkdir -p "$CTL_DIR"
cp "$SCRIPT_DIR/octopus-ctl.sh" "$CTL" || die "复制 $CTL 失败"
chmod 755 "$CTL"
ok "$CTL"

# ── 3. 生成手机密钥槽并授权 ───────────────────────────────────────────────
step "准备 $SLOTS 把手机 SSH 密钥槽"

mkdir -p "$SLOTS_DIR"
chmod 700 "$SLOTS_DIR"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
if [ ! -f "$AUTH_KEYS" ]; then
  : > "$AUTH_KEYS"
fi
chmod 600 "$AUTH_KEYS"

# authorized_keys 的最后一行若没换行，先补一个，避免和追加行黏在一起。
if [ -s "$AUTH_KEYS" ] && [ "$(tail -c 1 "$AUTH_KEYS" | wc -l | tr -d ' ')" = "0" ]; then
  printf '\n' >> "$AUTH_KEYS"
fi

added=0
kept=0
i=1
while [ "$i" -le "$SLOTS" ]; do
  name=$(printf 'slot-%02d' "$i")
  key="$SLOTS_DIR/$name"
  pub="$key.pub"

  if [ -f "$key" ] && [ -f "$pub" ]; then
    kept=$((kept + 1))
  else
    rm -f "$key" "$pub"
    "$KEYGEN" -q -t ed25519 -N '' -C "octopus-remote:$name" -f "$key" \
      || die "生成 $name 失败"
  fi

  blob=$(awk '{print $2}' "$pub")
  [ -n "$blob" ] || die "$pub 内容不完整"

  if grep -Fq "$blob" "$AUTH_KEYS"; then
    i=$((i + 1))
    continue
  fi

  line="restrict,command=\"$CTL\" $(cat "$pub")"
  printf '%s\n' "$line" >> "$AUTH_KEYS"
  added=$((added + 1))
  ok "授权 octopus-remote:$name"
  i=$((i + 1))
done

ok "密钥槽 ${SLOTS_DIR}（已有 $kept 把，本次新授权 $added 把，共 $SLOTS 把）"

unrestricted=$(awk '
  /^[[:space:]]*#/ { next }
  /^[[:space:]]*$/ { next }
  /restrict,/ { next }
  /command=/ { next }
  /(^|[[:space:]])ssh-(rsa|ed25519|dss)|ecdsa-sha2-/ { print $NF }
' "$AUTH_KEYS" 2>/dev/null || true)
if [ -n "$unrestricted" ]; then
  warn "发现没有限制的 SSH 密钥（等于一台 shell）：$unrestricted —— 本次不动它们"
fi

# ── 4. LaunchAgent：登录时以托盘方式启动 ──────────────────────────────────
step "注册登录项 $LABEL"

mkdir -p "$HOME/Library/LaunchAgents"
plist_tmp="$PLIST.tmp.$$"
cat > "$plist_tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$APP_EXE")</string>
    <string>--tray</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.log")</string>
</dict>
</plist>
PLIST

/usr/bin/plutil -lint "$plist_tmp" >/dev/null 2>&1 || { rm -f "$plist_tmp"; die '生成的 LaunchAgent plist 不合法'; }
mv "$plist_tmp" "$PLIST"
chmod 644 "$PLIST"

# 不 bootout 已加载的 job：当前 Octopus 可能正是它拉起来的，卸下会直接杀掉应用。
# plist 已更新，下次登录自然生效；远程 start 在 job 未加载时会按需 bootstrap。
ok "已注册：$APP_EXE --tray（登录时启动；start 动词走 launchctl）"

# ── 5. remote.json（server 读）────────────────────────────────────────────
step '写远程配置 ~/.octopus/remote/remote.json'

tailscale_dns=""
TS="$(command -v tailscale 2>/dev/null || true)"
if [ -z "$TS" ] && [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
  TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi
if [ -n "$TS" ]; then
  tailscale_dns="$("$TS" status --json 2>/dev/null \
    | sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -1 \
    | sed 's/\.$//')"
fi
if [ -n "$tailscale_dns" ]; then
  ok "Tailscale 域名 $tailscale_dns"
else
  warn '没能从 tailscale 读到本机域名（不影响安装；手机按填的地址连）'
fi

hosts_json=""
if [ -n "$tailscale_dns" ]; then
  hosts_json="\"$(json_escape "$tailscale_dns")\""
fi

remote_json="$CTL_DIR/remote.json"
cat > "$remote_json" <<JSON
{
  "version": 1,
  "os": "macos",
  "ssh_user": "$(json_escape "$(id -un)")",
  "ssh_port": $SSH_PORT,
  "tailscale_hosts": [$hosts_json],
  "task_name": "$LABEL",
  "ctl_path": "$(json_escape "$CTL")",
  "slots_dir": "$(json_escape "$SLOTS_DIR")",
  "authorized_keys_path": "$(json_escape "$AUTH_KEYS")",
  "app_path": "$(json_escape "$APP_BUNDLE")",
  "installed_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "installer": "scripts/remote/install-remote.sh"
}
JSON
chmod 600 "$remote_json"
ok "$remote_json"

# ── 6. 自测：用 slot-01 从本机走一遍 sshd + 强制命令 ──────────────────────
step 'SSH 强制命令自测'

slot_test="$SLOTS_DIR/slot-01"
if [ "${OCTOPUS_SKIP_SSHD:-0}" = "1" ]; then
  warn '跳过 SSH 自测（OCTOPUS_SKIP_SSHD=1）'
elif [ ! -f "$slot_test" ]; then
  warn 'slot-01 已发放（配对时用掉了私钥），跳过自测'
else
  probe="$("$SSH_CLIENT" -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5 \
    -o IdentitiesOnly=yes -i "$slot_test" -p "$SSH_PORT" \
    "$(id -un)@127.0.0.1" status 2>&1 || true)"
  if printf '%s' "$probe" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    ok 'sshd 接受密钥，强制命令返回正常 JSON'
  else
    warn "自测没有拿到预期输出（不影响安装，但手机可能连不上）：$(printf '%s' "$probe" | tr '\n' ' ')"
  fi
fi

# ── 完成 ──────────────────────────────────────────────────────────────────
printf '\n===== 安装完成 =====\n'
printf '  控制脚本    %s\n' "$CTL"
printf '  密钥槽      %s（%s 把，配对时每台手机消耗一把）\n' "$SLOTS_DIR" "$SLOTS"
printf '  SSH 用户    %s · 端口 %s · sshd 配置未改动\n' "$(id -un)" "$SSH_PORT"
printf '  登录项      %s（登录时自动启动；start 动词走 launchctl）\n' "$LABEL"
printf '  配置文件    %s\n\n' "$remote_json"
printf '下一步：\n'
printf '  1) 电脑上打开 Octopus「设置 → 手机配对」，生成 6 位码；\n'
printf '  2) 手机「添加设备」填 Tailscale 地址 → 提示需要配对码 → 填码；\n'
printf '  3) 之后退出 Octopus，手机上会显示「在线 · 未启动」，点启动即可。\n\n'
printf '注意：手机用 SSH 直连这台机器的 %s 端口；Tailscale ACL 若有收紧，\n' "$SSH_PORT"
printf '      记得放行手机的 22 端口（以及 443 / tailscale serve 的 47820）。\n'
printf '日志：%s\n' "$LOG_FILE"
log '安装完成'
