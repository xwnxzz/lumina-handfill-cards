# dsh-shot.ps1 —— 在「提权 DSH」环境下可靠地做 Edge headless 截图
#
# 背景：DSH 以管理员权限运行时，直接 Start-Process 起的 Edge 会打印
#   "Edge is running elevated: 1" 并拒绝出图（0 字节）。
#   解法：用计划任务以 RunLevel=Limited 启动 Edge（降权到普通用户令牌，无需密码），
#   并确保输出路径是当前用户可写的目录（不要用 C:\ 根目录）。
#
# 用法：
#   pwsh -File recon\shot.ps1 -Url "file:///C:/path/page.html" -Out "C:\Users\xzz\AppData\Local\Temp\a.png" -Width 1300 -Height 700

param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Width = 1300,
  [int]$Height = 700,
  [int]$Budget = 9000,        # --virtual-time-budget 毫秒
  [int]$Scale = 0,            # >0 时加 --force-device-scale-factor
  [int]$TimeoutSec = 45
)

$ErrorActionPreference = "Stop"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { Write-Output "FAIL 找不到 Edge: $edge"; exit 1 }

$tag  = [guid]::NewGuid().ToString("N").Substring(0, 8)
$task = "dsh-shot-$tag"
$prof = Join-Path $env:TEMP "dshprof-$tag"

Remove-Item $Out -ErrorAction SilentlyContinue
$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$flags = "--headless=new --disable-gpu --hide-scrollbars" +
         " --user-data-dir=`"$prof`"" +
         " --virtual-time-budget=$Budget" +
         " --window-size=$Width,$Height"
if ($Scale -gt 0) { $flags += " --force-device-scale-factor=$Scale" }
$flags += " --screenshot=`"$Out`" `"$Url`""

$action = New-ScheduledTaskAction -Execute $edge -Argument $flags
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
             -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force | Out-Null
try {
  Start-ScheduledTask -TaskName $task
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    if (Test-Path $Out) { break }
  }
} finally {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue
}

if (Test-Path $Out) { Write-Output ("OK " + (Get-Item $Out).Length + " 字节 -> " + $Out) }
else { Write-Output "FAIL 未生成截图（$Out）"; exit 1 }
