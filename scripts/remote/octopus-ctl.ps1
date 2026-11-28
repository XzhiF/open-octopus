#Requires -Version 5.1
<#
Octopus 远程控制小脚本（M4 · 2026-11-27）。

为什么需要它：Octopus 的 server 嵌在桌面程序里（Octopus.exe），程序没跑时
手机上没有任何监听者。手机靠 sshd（系统自带、常驻）进来执行本脚本，再由
脚本通过计划任务把 Octopus.exe 拉起来。

只认两个动词（强制命令的白名单）：

  status   探本机 47820 健康，输出一段 JSON
  start    幂等启动：已经在跑 / 正在起 → 不再拉第二份；否则 schtasks /run

强制命令的用法（写在 administrators_authorized_keys 里）：

  restrict,command="powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\octopus\octopus-ctl.ps1" ssh-ed25519 AAAA...

sshd 会把客户端原本要执行的命令放进 SSH_ORIGINAL_COMMAND，本脚本只读第一个
词并精确匹配 —— 绝不做 Invoke-Expression，任何别的字符串一律拒绝。

手工调试：

  powershell -NoProfile -File octopus-ctl.ps1 status
  powershell -NoProfile -File octopus-ctl.ps1 start
#>
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = 'Stop'

# SSH 会话的 stdout 默认是控制台代码页（中文机器通常是 936），统一改成无 BOM 的 UTF-8，
# 手机端按 utf8 解码 JSON。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$Port = if ($env:OCTOPUS_PORT) { [int]$env:OCTOPUS_PORT } else { 47820 }
$TaskName = if ($env:OCTOPUS_TASK) { $env:OCTOPUS_TASK } else { 'Octopus' }
$HealthUrl = "http://127.0.0.1:$Port/api/actuator/health"

function Write-JsonExit {
  param(
    [Parameter(Mandatory = $true)] $Payload,
    [int]$Code = 0
  )
  $text = $Payload | ConvertTo-Json -Compress -Depth 8
  [Console]::Out.Write($text)
  [Console]::Out.Write("`n")
  exit $Code
}

function Get-Verb {
  # 强制命令模式下以 sshd 传进来的原始命令为准；本机调试时用位置参数。
  $raw = $env:SSH_ORIGINAL_COMMAND
  if ([string]::IsNullOrWhiteSpace($raw)) { $raw = ($Arguments -join ' ') }
  if ([string]::IsNullOrWhiteSpace($raw)) { return '' }
  $token = ($raw.Trim() -split '\s+')[0]
  return $token.Trim('"', "'").ToLowerInvariant()
}

function Invoke-Health {
  # 只连回环：明确绕开系统代理（本机装了 127.0.0.1 的代理时，
  # Invoke-WebRequest 会把 127.0.0.1:47820 也送进代理，导致假离线）。
  $req = [System.Net.HttpWebRequest]::Create($HealthUrl)
  $req.Method = 'GET'
  $req.Timeout = 3000
  $req.ReadWriteTimeout = 3000
  $req.Proxy = $null
  $req.KeepAlive = $false
  try {
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $body = ''
    try { $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch { }
    $resp.Close()
    return [pscustomobject]@{ http = $code; body = $body }
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if ($resp) {
      $code = [int]$resp.StatusCode
      $body = ''
      try { $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch { }
      $resp.Close()
      return [pscustomobject]@{ http = $code; body = $body }
    }
    return [pscustomobject]@{ http = 0; body = $null }
  } catch {
    return [pscustomobject]@{ http = 0; body = $null }
  }
}

function Get-OctopusProcess {
  try {
    return @(Get-Process -Name 'Octopus' -ErrorAction SilentlyContinue) | Select-Object -First 1
  } catch {
    return $null
  }
}

function Get-TaskRegistered {
  try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    return ($null -ne $task)
  } catch {
    return $false
  }
}

function Get-State {
  $health = Invoke-Health
  $proc = Get-OctopusProcess
  $state = 'stopped'
  $details = [ordered]@{}
  if ($health.http -eq 200) {
    $state = 'running'
    try {
      $json = $health.body | ConvertFrom-Json
      $server = $json.components.server.details
      if ($server) {
        if ($null -ne $server.pid) { $details.pid = [int]$server.pid }
        if ($null -ne $server.uptime_seconds) { $details.uptime_sec = [int]$server.uptime_seconds }
        if ($server.mode) { $details.mode = [string]$server.mode }
        if ($server.branch) { $details.branch = [string]$server.branch }
        if ($null -ne $server.port) { $details.port = [int]$server.port }
        if ($server.started_at) { $details.started_at = [string]$server.started_at }
      }
      if ($json.status) { $details.health = [string]$json.status }
    } catch {
      # 健康体解析失败不影响「在跑」这个结论
    }
  } elseif ($health.http -eq 503) {
    $state = 'starting'
  } elseif ($proc) {
    # 进程在、端口还没起：冷启动的那几十秒
    $state = 'starting'
  }

  $app = [ordered]@{ process_running = [bool]$proc }
  if ($proc) {
    $app.pid = [int]$proc.Id
    $app.started_at = $proc.StartTime.ToUniversalTime().ToString('o')
  }

  return [ordered]@{
    state = $state
    http = [int]$health.http
    details = $details
    app = $app
  }
}

$verb = Get-Verb
if ($verb -ne 'status' -and $verb -ne 'start') {
  Write-JsonExit -Code 2 -Payload ([ordered]@{
    ok = $false
    verb = $verb
    error = 'bad_command'
    message = '只支持 status | start'
  })
}

$snapshot = Get-State
$base = [ordered]@{
  ok = $true
  verb = $verb
  host = $env:COMPUTERNAME
  os = 'windows'
  time = [DateTime]::UtcNow.ToString('o')
  port = $Port
  octopus = $snapshot
  task = [ordered]@{ name = $TaskName; registered = (Get-TaskRegistered) }
}

if ($verb -eq 'status') {
  Write-JsonExit -Payload $base -Code 0
}

# ── start：幂等 ──────────────────────────────────────────────────────────
if ($snapshot.state -eq 'running' -or $snapshot.state -eq 'starting') {
  $base.result = 'already_running'
  Write-JsonExit -Payload $base -Code 0
}

if (-not $base.task.registered) {
  Write-JsonExit -Code 3 -Payload ([ordered]@{
    ok = $false
    verb = 'start'
    error = 'task_missing'
    message = "计划任务 $TaskName 不存在 —— 在电脑上以管理员运行 scripts/remote/install-remote.ps1"
    port = $Port
    octopus = $snapshot
  })
}

try {
  $output = & schtasks.exe /run /tn $TaskName 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Write-JsonExit -Code 4 -Payload ([ordered]@{
      ok = $false
      verb = 'start'
      error = 'launch_failed'
      message = ($output.Trim())
      port = $Port
      octopus = $snapshot
    })
  }
} catch {
  Write-JsonExit -Code 4 -Payload ([ordered]@{
    ok = $false
    verb = 'start'
    error = 'launch_failed'
    message = $_.Exception.Message
    port = $Port
    octopus = $snapshot
  })
}

$base.result = 'started'
Write-JsonExit -Payload $base -Code 0
