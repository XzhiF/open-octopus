#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
Octopus 远程拉起 · 一次性安装器（M4 · 2026-11-27）。

做什么：
  1. 把 octopus-ctl.ps1 装到 C:\ProgramData\octopus\（只读给普通用户）；
  2. 生成 N 把 SSH 密钥「槽位」（私钥留给 server 在配对时一次性下发，公钥写进
     administrators_authorized_keys，并加 restrict + command= 强制命令 —— 手机
     拿到的密钥只能跑 octopus-ctl 的 status/start，绝不是一个 shell）；
  3. 注册「登录时运行」的计划任务 Octopus（Octopus.exe --tray，交互会话里拉 GUI）；
  4. 写 ~/.octopus/remote/remote.json（server 读它得知 SSH 用户 / 端口 / 槽位）。

默认**不碰 sshd 配置、不重启 sshd、不关密码登录** —— 只在 authorized_keys 里追加
带限制的行，你原来的远程登录方式（密码 / 自己的密钥）完全不受影响。想做「只许密钥、
不许密码」的收紧时再加 -DisablePasswordAuth（会备份 sshd_config、先 sshd -t 再重启）。

不做 / 不碰：
  · 不断开 / 不停用 sshd；默认不改它的任何配置；
  · 不删任何已有的 authorized_keys 行；
  · 已有的无限制密钥（比如 xzf-tunnel-key）只报告，不修改。

用法（以管理员身份打开 PowerShell）：

  powershell -ExecutionPolicy Bypass -File scripts\remote\install-remote.ps1
  powershell -ExecutionPolicy Bypass -File scripts\remote\install-remote.ps1 -Slots 12
  powershell -ExecutionPolicy Bypass -File scripts\remote\install-remote.ps1 -DisablePasswordAuth
#>
[CmdletBinding()]
param(
  # 生成几把手机用的 SSH 密钥槽（每配一台手机消耗一把）
  [int]$Slots = 8,
  # 可选：收紧成「只许密钥、不许密码」。默认不做（保留你原来的远程登录习惯）
  [switch]$DisablePasswordAuth,
  # 计划任务已存在时重建它
  [switch]$RecreateTask,
  # 桌面程序路径；默认从 LOCALAPPDATA 找，找不到再从已有计划任务里读
  [string]$OctopusExe = '',
  # 目标用户（默认当前登录用户）
  [string]$User = $env:USERNAME
)

$ErrorActionPreference = 'Stop'

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$CtlSource = Join-Path $ScriptDir 'octopus-ctl.ps1'
$CtlDestDir = Join-Path $env:ProgramData 'octopus'
$CtlDest = Join-Path $CtlDestDir 'octopus-ctl.ps1'
$SshDir = Join-Path $env:ProgramData 'ssh'
$AdminsKeys = Join-Path $SshDir 'administrators_authorized_keys'
$SshdConfig = Join-Path $SshDir 'sshd_config'
$TaskName = 'Octopus'
$SshPort = 22

# 一键启用时用户看不到控制台里的报错（窗口一闪而过），把过程写一份日志。
$InstallLog = Join-Path $env:TEMP 'octopus-remote-install.log'
$LogEncoding = New-Object System.Text.UTF8Encoding($false)
try { [System.IO.File]::WriteAllText($InstallLog, '', $LogEncoding) } catch { }

function Write-Log([string]$Line) {
  try {
    [System.IO.File]::AppendAllText($InstallLog, ("[{0}] {1}`n" -f (Get-Date -Format 'HH:mm:ss'), $Line), $LogEncoding)
  } catch { }
}
function Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan; Write-Log "== $Text" }
function Ok([string]$Text) { Write-Host "   ok  $Text" -ForegroundColor Green; Write-Log "ok  $Text" }
function Warn([string]$Text) { Write-Host "   !   $Text" -ForegroundColor Yellow; Write-Log "warn $Text" }
function Die([string]$Text) {
  Write-Host "`n[失败] $Text" -ForegroundColor Red
  Write-Log "FAIL $Text"
  Write-Host "日志：$InstallLog" -ForegroundColor Yellow
  exit 1
}

function Find-Tool([string]$Name) {
  $candidates = @(
    (Join-Path $env:ProgramFiles "OpenSSH\$Name.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "OpenSSH\$Name.exe"),
    (Join-Path $env:WINDIR "System32\OpenSSH\$Name.exe")
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

if (-not (Test-Path $CtlSource)) { Die "找不到 octopus-ctl.ps1（脚本目录：$ScriptDir）" }

# ── OpenSSH Server：没有就自动启用（Windows 可选功能）────────────────────
Step '检查 OpenSSH Server'
if (-not (Get-Service sshd -ErrorAction SilentlyContinue) -or -not (Test-Path $SshDir)) {
  Warn '这台机器还没有 OpenSSH Server —— 尝试启用 Windows 可选功能（可能要一两分钟）'
  try {
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction Stop | Select-Object -First 1
    if (-not $cap) { throw '系统里没有 OpenSSH.Server 这个可选功能' }
    if ($cap.State -ne 'Installed') {
      Add-WindowsCapability -Online -Name $cap.Name -ErrorAction Stop | Out-Null
    }
    Set-Service sshd -StartupType Automatic -ErrorAction Stop
    Start-Service sshd -ErrorAction Stop
    Start-Sleep -Milliseconds 2000
    Ok 'OpenSSH Server 已启用并设为自动启动'
  } catch {
    Die "启用 OpenSSH Server 失败：$($_.Exception.Message)`n可以在「设置 → 系统 → 可选功能」里手动装上 OpenSSH 服务器后再跑一次"
  }
}
if (-not (Test-Path $SshDir)) { Die "找不到 $SshDir —— OpenSSH Server 可能没装好" }

$sshKeygen = Find-Tool 'ssh-keygen'
$sshdExe = Find-Tool 'sshd'
if (-not $sshKeygen) { Die '找不到 ssh-keygen（OpenSSH 客户端）' }

# ── 0. 解析目标用户 / 桌面程序 ────────────────────────────────────────────
Step '检查环境'

$userProfile = if ($User -ieq $env:USERNAME) { $env:USERPROFILE } else { $null }
if (-not $userProfile) {
  $userProfile = (Get-ItemProperty -Path "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProfileImagePath -and ($_.ProfileImagePath -split '\\')[-1] -ieq $User } |
    Select-Object -First 1).ProfileImagePath
}
if (-not $userProfile -or -not (Test-Path $userProfile)) { Die "找不到用户 $User 的配置目录" }
Ok "用户 $User · $userProfile"

if (-not $OctopusExe) {
  $OctopusExe = Join-Path $env:LOCALAPPDATA 'Programs\Octopus\Octopus.exe'
}
if (-not (Test-Path $OctopusExe)) {
  try {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $exe = $existing.Actions | Where-Object { $_.Execute } | Select-Object -First 1 -ExpandProperty Execute
    if ($exe -and (Test-Path $exe)) { $OctopusExe = $exe }
  } catch { }
}
if (-not (Test-Path $OctopusExe)) {
  Die "找不到 Octopus.exe（默认找 $env:LOCALAPPDATA\Programs\Octopus\Octopus.exe）—— 先装桌面版，或用 -OctopusExe 指定"
}
Ok "桌面程序 $OctopusExe"

$sshdService = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $sshdService) { Die 'sshd 服务不存在' }
if ($sshdService.Status -ne 'Running') {
  Warn "sshd 当前 $($sshdService.Status)，尝试启动"
  Start-Service sshd -ErrorAction Stop
}
Ok "sshd 运行中（$sshdService.StartType）"

# sshd 的实际端口（默认 22）
if (Test-Path $SshdConfig) {
  $portLine = Get-Content $SshdConfig | Where-Object { $_ -match '^\s*Port\s+(\d+)' } | Select-Object -Last 1
  if ($portLine -and $portLine -match '(\d+)') { $SshPort = [int]$Matches[1] }
}
Ok "SSH 端口 $SshPort"

$tailscaleHosts = @()
try {
  $ts = Get-Command tailscale -ErrorAction SilentlyContinue
  if (-not $ts) {
    $candidate = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (Test-Path $candidate) { $ts = Get-Item $candidate }
  }
  if ($ts) {
    $status = & $ts.Source status --json 2>$null | ConvertFrom-Json
    $dns = $status.Self.DNSName
    if ($dns) { $tailscaleHosts = @($dns.TrimEnd('.')) }
  }
} catch { }
if ($tailscaleHosts.Count -gt 0) { Ok "Tailscale 域名 $($tailscaleHosts -join ', ')" }
else { Warn '没能从 tailscale 读到本机域名（不影响安装；手机按填的地址连）' }

# ── 1. 装 octopus-ctl.ps1 ────────────────────────────────────────────────
Step '安装 octopus-ctl.ps1'

New-Item -ItemType Directory -Force -Path $CtlDestDir | Out-Null
Copy-Item -Force $CtlSource $CtlDest
# 目录 / 脚本：SYSTEM + Administrators 完全控制，普通用户只能读和执行。
& icacls.exe $CtlDestDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' 'Users:(OI)(CI)RX' | Out-Null
& icacls.exe $CtlDest /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' 'Users:RX' | Out-Null
if ($LASTEXITCODE -ne 0) { Die "设置 $CtlDestDir 的 ACL 失败" }
Ok $CtlDest

# ── 2. 生成手机用的密钥槽并授权 ──────────────────────────────────────────
Step "准备 $Slots 把手机 SSH 密钥槽"

$slotsDir = Join-Path $userProfile '.octopus\remote\ssh\slots'
New-Item -ItemType Directory -Force -Path $slotsDir | Out-Null

if (-not (Test-Path $AdminsKeys)) {
  New-Item -ItemType File -Force -Path $AdminsKeys | Out-Null
}
# 管理员密钥文件必须是 SYSTEM + Administrators 独占，否则 sshd 静默忽略。
& icacls.exe $AdminsKeys /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' | Out-Null

$forceCommand = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\octopus\octopus-ctl.ps1'
$existingText = [System.IO.File]::ReadAllText($AdminsKeys)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$added = 0
$kept = 0

for ($i = 1; $i -le $Slots; $i++) {
  $name = 'slot-{0:D2}' -f $i
  $keyPath = Join-Path $slotsDir $name
  $pubPath = "$keyPath.pub"

  if ((Test-Path $keyPath) -and (Test-Path $pubPath)) {
    $kept++
  } else {
    if (Test-Path $keyPath) { Remove-Item -Force $keyPath }
    if (Test-Path $pubPath) { Remove-Item -Force $pubPath }
    # Win32-OpenSSH 的空口令写法：PowerShell 里 '""' 会作为空参数传给 ssh-keygen。
    & $sshKeygen -q -t ed25519 -N '""' -C "octopus-remote:$name" -f $keyPath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $pubPath)) { Die "生成 $name 失败" }
  }

  $pub = (Get-Content -Raw -Path $pubPath).Trim()
  $parts = $pub -split '\s+', 3
  if ($parts.Count -lt 2) { Die "$pubPath 内容不完整" }
  $blob = $parts[1]
  if ($existingText.Contains($blob)) { continue }

  $line = 'restrict,command="{0}" {1}' -f $forceCommand, $pub
  [System.IO.File]::AppendAllText($AdminsKeys, "$line`n", $utf8NoBom)
  $existingText += $line
  $added++
  Ok "授权 octopus-remote:$name"
}

Ok "密钥槽 $slotsDir（已有 $kept 把，本次新授权 $added 把，共 $Slots 把）"

# 已有密钥里有没有全权的（只报告）
$unrestricted = @()
foreach ($line in (Get-Content $AdminsKeys)) {
  if (-not $line.Trim() -or $line.TrimStart().StartsWith('#')) { continue }
  if ($line -notmatch 'restrict,|command=') { $unrestricted += ($line -split '\s+' | Select-Object -Last 1) }
}
if ($unrestricted.Count -gt 0) {
  Warn "发现没有限制的 SSH 密钥（等于一台 shell）：$($unrestricted -join ', ') —— 本次不动它们"
}

# ── 3. 计划任务：登录时运行 + 可按需 run ──────────────────────────────────
Step "注册计划任务 $TaskName"

$taskExists = $false
try { $taskExists = $null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop) } catch { }
if ($taskExists -and -not $RecreateTask) {
  Ok "已存在，跳过（要重建加 -RecreateTask）"
} else {
  $userId = "$env:USERDOMAIN\$User"
  $action = New-ScheduledTaskAction -Execute $OctopusExe -Argument '--tray' -WorkingDirectory (Split-Path -Parent $OctopusExe)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'Octopus 登录时以托盘方式启动（手机远程拉起也走它）' -Force | Out-Null
  Ok "已注册：$OctopusExe --tray（用户 $userId · 交互会话）"
}

# ── 4. remote.json（server 读）───────────────────────────────────────────
Step '写远程配置 ~/.octopus/remote/remote.json'

$remoteDir = Join-Path $userProfile '.octopus\remote'
New-Item -ItemType Directory -Force -Path $remoteDir | Out-Null
$remoteJson = [ordered]@{
  version = 1
  os = 'windows'
  ssh_user = $User
  ssh_port = $SshPort
  tailscale_hosts = $tailscaleHosts
  task_name = $TaskName
  ctl_path = $CtlDest
  slots_dir = $slotsDir
  authorized_keys_path = $AdminsKeys
  installed_at = [DateTime]::UtcNow.ToString('o')
  installer = 'scripts/remote/install-remote.ps1'
}
$remotePath = Join-Path $remoteDir 'remote.json'
[System.IO.File]::WriteAllText($remotePath, ($remoteJson | ConvertTo-Json -Depth 5), $utf8NoBom)
Ok $remotePath

# ── 5. sshd 配置（默认不动）────────────────────────────────────────────
Step 'sshd 配置'

if (-not $DisablePasswordAuth) {
  Ok '保持原样：不修改 sshd_config、不重启 sshd、不关密码登录'
  Ok '（手机密钥是单独追加的 authorized_keys 行，随连随读，不需要重启服务）'
} else {
  $backup = "$SshdConfig.bak-octopus-$([DateTime]::Now.ToString('yyyyMMdd-HHmmss'))"
  Copy-Item $SshdConfig $backup -Force
  $text = [System.IO.File]::ReadAllText($SshdConfig)
  $lines = [System.Collections.Generic.List[string]]::new([string[]]($text -split "`r?`n"))

  $firstMatch = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*Match\s+') { $firstMatch = $i; break }
  }
  $limit = if ($firstMatch -ge 0) { $firstMatch } else { $lines.Count }

  $setGlobal = {
    param($key, $value)
    for ($i = 0; $i -lt $limit; $i++) {
      if ($lines[$i] -match "^\s*#?\s*$key\s+") { $lines[$i] = "$key $value"; return $true }
    }
    return $false
  }

  $hasPw = & $setGlobal 'PasswordAuthentication' 'no'
  $hasKey = & $setGlobal 'PubkeyAuthentication' 'yes'
  $insertAt = $limit
  if (-not $hasKey) { $lines.Insert($insertAt, 'PubkeyAuthentication yes') }
  if (-not $hasPw) { $lines.Insert($insertAt, 'PasswordAuthentication no') }
  if (-not $hasPw -or -not $hasKey) {
    $lines.Insert($insertAt, '# octopus: 手机只走密钥登录（install-remote.ps1 写入）')
  }

  [System.IO.File]::WriteAllText($SshdConfig, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

  if ($sshdExe) {
    & $sshdExe -t -f $SshdConfig
    if ($LASTEXITCODE -ne 0) {
      Copy-Item $backup $SshdConfig -Force
      Die "sshd 配置校验失败，已回滚（备份 $backup）"
    }
  } else {
    Warn '找不到 sshd.exe，跳过配置校验'
  }

  Restart-Service sshd
  Start-Sleep -Milliseconds 400
  $svc = Get-Service sshd
  if ($svc.Status -ne 'Running') {
    Copy-Item $backup $SshdConfig -Force
    Start-Service sshd -ErrorAction SilentlyContinue
    Die 'sshd 重启失败，配置已回滚'
  }
  Ok "PasswordAuthentication no · 备份 $backup"
}

# ── 5.5 自测：用 slot-01 从本机走一遍 sshd + 强制命令 ─────────────────────
Step 'SSH 强制命令自测'

$sshClient = Find-Tool 'ssh'
if (-not $sshClient) {
  Warn '找不到 ssh 客户端，跳过自测'
} else {
  $slotTestKey = Join-Path $slotsDir 'slot-01'
  if (-not (Test-Path $slotTestKey)) {
    Warn "slot-01 已发放（配对时用掉了私钥），跳过自测"
  } else {
    try {
      $probe = & $sshClient -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL `
        -o LogLevel=ERROR -o ConnectTimeout=5 -i $slotTestKey -p $SshPort "$User@127.0.0.1" status 2>&1 | Out-String
      if ($probe -match '"ok"\s*:\s*true') {
        Ok 'sshd 接受密钥，强制命令返回正常 JSON'
      } else {
        Warn "自测没有拿到预期输出（不影响安装，但手机可能连不上）：$($probe.Trim())"
      }
    } catch {
      Warn "自测异常：$($_.Exception.Message)"
    }
  }
}

# ── 完成 ────────────────────────────────────────────────────────────────
Write-Host "`n===== 安装完成 =====" -ForegroundColor Cyan
Write-Host "  控制脚本    $CtlDest"
Write-Host "  密钥槽      $slotsDir（$Slots 把，配对时每台手机消耗一把）"
Write-Host "  SSH 用户    $User · 端口 $SshPort · sshd 配置未改动"
Write-Host "  计划任务    $TaskName（登录时自动启动；start 动词走 schtasks /run）"
Write-Host "  配置文件    $remotePath"
Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1) 电脑上打开 Octopus「设置 → 手机配对」，生成 6 位码；"
Write-Host "  2) 手机「添加设备」填 Tailscale 地址 → 提示需要配对码 → 填码；"
Write-Host "     （配对响应里会带一把 SSH 私钥，手机存进系统安全存储）"
Write-Host "  3) 之后退出 Octopus，手机上会显示「在线 · 未启动」，点启动即可。"
Write-Host ""
Write-Host "注意：手机用 SSH 直连这台机器的 $SshPort 端口；Tailscale ACL 若有收紧，" -ForegroundColor Yellow
Write-Host "      记得放行手机的 22 端口（以及 443 / tailscale serve 的 47820）。" -ForegroundColor Yellow
Write-Host "日志：$InstallLog" -ForegroundColor DarkGray
Write-Log '安装完成'
