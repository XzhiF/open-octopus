#!/bin/bash
# Octopus 远程控制小脚本（macOS · M4 对齐版）。
#
# 与 scripts/remote/octopus-ctl.ps1 同一份协议：只认 status / start，输出一份 JSON。
# 手机端（Flutter）不区分对面是 Windows 还是 macOS，只读 { ok, octopus: { state, http } }。
#
# 被 sshd 的强制命令钉死：
#
#   restrict,command="/Users/<你>/.octopus/remote/octopus-ctl.sh" ssh-ed25519 AAAA...
#
# sshd 把客户端原本要执行的命令放进 SSH_ORIGINAL_COMMAND，本脚本只取第一个词
# 并精确匹配 status / start —— 绝不 eval。
#
# 启动方式：macOS 用 ~/Library/LaunchAgents/com.octopus.desktop.agent.plist
# （RunAtLoad=true，登录时以 --tray 拉起；远程 start 走 launchctl kickstart）。
#
# 手工调试：
#   ~/.octopus/remote/octopus-ctl.sh status
#   ~/.octopus/remote/octopus-ctl.sh start

set -u

PORT="${OCTOPUS_PORT:-47820}"
LABEL="${OCTOPUS_TASK:-com.octopus.desktop.agent}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HEALTH_URL="http://127.0.0.1:$PORT/api/actuator/health"

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

verb_from_env_or_args() {
  local raw="${SSH_ORIGINAL_COMMAND:-}"
  if [ -z "$raw" ]; then
    raw="$*"
  fi
  # 去掉前导空白，取第一个词，再剥掉包裹的引号。
  raw="$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//')"
  local token="${raw%%[[:space:]]*}"
  token="${token%\"}"; token="${token#\"}"
  token="${token%\'}"; token="${token#\'}"
  printf '%s' "$token" | tr '[:upper:]' '[:lower:]'
}

# 只连回环，显式 --noproxy '*' —— 本机装了 127.0.0.1 代理时不能把探活也送进代理。
probe_health() {
  local body_file
  body_file="$(mktemp -t octopus-ctl.XXXXXX)" || body_file=""
  local code=""
  if [ -n "$body_file" ]; then
    code="$(/usr/bin/curl --noproxy '*' -sS -m 3 -o "$body_file" -w '%{http_code}' "$HEALTH_URL" 2>/dev/null)"
  fi
  case "$code" in
    ''|000) code=0 ;;
  esac
  echo "$code|$body_file"
}

find_app_pid() {
  # 打包后的进程名就是 Octopus；再兜一层 bundle 路径匹配（dev 的 Electron 不算）。
  local pid
  pid="$(pgrep -x Octopus 2>/dev/null | head -1)"
  if [ -z "$pid" ]; then
    pid="$(pgrep -f '/Octopus\.app/Contents/MacOS/Octopus' 2>/dev/null | head -1)"
  fi
  printf '%s' "$pid"
}

uid="$(id -u)"
health_raw="$(probe_health)"
http="${health_raw%%|*}"
body_file="${health_raw#*|}"

if [ -n "$body_file" ] && [ -f "$body_file" ]; then
  health_status="$(sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file" | head -1)"
  rm -f "$body_file"
else
  health_status=""
fi

app_pid="$(find_app_pid)"

case "$http" in
  200) state='running' ;;
  503) state='starting' ;;
  *)
    if [ -n "$app_pid" ]; then state='starting'; else state='stopped'; fi
    ;;
esac

details="\"port\":$PORT"
if [ -n "$health_status" ]; then
  details="$details,\"health\":\"$(json_escape "$health_status")\""
fi

app_json="\"process_running\":false"
if [ -n "$app_pid" ]; then
  app_json="\"process_running\":true,\"pid\":$app_pid"
fi

task_registered=false
if [ -f "$PLIST" ]; then
  task_registered=true
fi

host="$(scutil --get ComputerName 2>/dev/null || hostname 2>/dev/null || echo mac)"
now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

emit_status() {
  printf '{"ok":true,"verb":"%s","host":"%s","os":"macos","time":"%s","port":%s,"octopus":{"state":"%s","http":%s,"details":{%s},"app":{%s}},"task":{"name":"%s","registered":%s}}\n' \
    "$1" "$(json_escape "$host")" "$now" "$PORT" "$state" "$http" "$details" "$app_json" \
    "$(json_escape "$LABEL")" "$task_registered"
}

emit_error() {
  local code="$1" error="$2" message="$3"
  printf '{"ok":false,"verb":"%s","error":"%s","message":"%s","port":%s,"octopus":{"state":"%s","http":%s,"details":{%s},"app":{%s}}}' \
    "$verb" "$error" "$(json_escape "$message")" "$PORT" "$state" "$http" "$details" "$app_json"
  printf '\n'
  exit "$code"
}

verb="$(verb_from_env_or_args "$@")"
if [ "$verb" != 'status' ] && [ "$verb" != 'start' ]; then
  emit_error 2 bad_command '只支持 status | start'
fi

if [ "$verb" = 'status' ]; then
  emit_status status
  exit 0
fi

# ── start：幂等 ──────────────────────────────────────────────────────────
if [ "$state" = 'running' ] || [ "$state" = 'starting' ]; then
  # 在 JSON 里补 result=already_running：重打一遍，字段与 status 一致。
  printf '{"ok":true,"verb":"start","host":"%s","os":"macos","time":"%s","port":%s,"octopus":{"state":"%s","http":%s,"details":{%s},"app":{%s}},"task":{"name":"%s","registered":%s},"result":"already_running"}\n' \
    "$(json_escape "$host")" "$now" "$PORT" "$state" "$http" "$details" "$app_json" \
    "$(json_escape "$LABEL")" "$task_registered"
  exit 0
fi

if [ "$task_registered" != true ]; then
  emit_error 3 task_missing "登录项 $LABEL 不存在 —— 在电脑上运行 scripts/remote/install-remote.sh"
fi

if launchctl print "gui/$uid/$LABEL" >/dev/null 2>&1; then
  launch_out="$(launchctl kickstart -k "gui/$uid/$LABEL" 2>&1)"
  launch_code=$?
else
  launch_out="$(launchctl bootstrap "gui/$uid" "$PLIST" 2>&1)"
  launch_code=$?
fi

if [ "$launch_code" -ne 0 ]; then
  emit_error 4 launch_failed "launchctl 启动失败：$(printf '%s' "$launch_out" | tr '\n' ' ')"
fi

printf '{"ok":true,"verb":"start","host":"%s","os":"macos","time":"%s","port":%s,"octopus":{"state":"%s","http":%s,"details":{%s},"app":{%s}},"task":{"name":"%s","registered":%s},"result":"started"}\n' \
  "$(json_escape "$host")" "$now" "$PORT" "$state" "$http" "$details" "$app_json" \
  "$(json_escape "$LABEL")" "$task_registered"
exit 0
