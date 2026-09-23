<#
  手填色卡 · 一键启动（实际干活的脚本，由 .cmd 内嵌调用，也可单独运行）

  做三件事：
    1. 找到主工具 HTML —— 依次尝试「手填色卡.html」和「lumina_singlestage_gui.html」
       两个名字（zip 里用的是前者，仓库里是后者）
    2. 解除 Windows 的「受限站点」标记（Unblock-File），避免 README 里写的
       「Windows 发现此文件可能有害」以及 file:// 下的导出限制
    3. 用浏览器打开它

  环境变量（.cmd 会设置）
    LUMINA_TOOL_DIR=...   本文件所在目录，作为首选查找位置
    LUMINA_TOOL_DRYRUN=1  只查找和报告，不解除锁定、不打开浏览器
#>

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$DryRun = ($env:LUMINA_TOOL_DRYRUN -eq '1')

# zip 里的友好名在前，仓库里的原名在后
$HTML_NAMES = @('手填色卡.html', 'lumina_singlestage_gui.html')

function Say([string]$m) { Write-Host $m }
function Ok([string]$m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  [警告] $m" -ForegroundColor Yellow }
function Bad([string]$m)  { Write-Host "  [失败] $m" -ForegroundColor Red }

Say ''
Say '=============================================================='
Say '  lumina studio 手填色卡  ·  一键启动'
Say '=============================================================='
Say ''

# ---------------------------------------------------------------- 1. 找 HTML
$dirs = New-Object System.Collections.Generic.List[string]
if ($env:LUMINA_TOOL_DIR) { $dirs.Add($env:LUMINA_TOOL_DIR) }
if ($PSScriptRoot)        { $dirs.Add($PSScriptRoot) }
$dirs.Add((Get-Location).Path)
$dirs.Add((Join-Path $env:USERPROFILE 'Desktop'))
$dirs.Add((Join-Path $env:USERPROFILE 'Downloads'))
$dirs.Add((Join-Path $env:USERPROFILE 'Desktop\dc works\projects\lumina\lumina-handfill-cards'))

$found = $null
foreach ($d in $dirs) {
  if (-not $d) { continue }
  foreach ($n in $HTML_NAMES) {
    $c = Join-Path $d $n
    if (Test-Path -LiteralPath $c -PathType Leaf) { $found = (Resolve-Path -LiteralPath $c).Path; break }
  }
  if ($found) { break }
}

# 首选位置没找到，就在本文件所在目录浅层搜一下
if (-not $found -and $env:LUMINA_TOOL_DIR) {
  foreach ($n in $HTML_NAMES) {
    $near = Get-ChildItem -LiteralPath $env:LUMINA_TOOL_DIR -Recurse -File -Filter $n -ErrorAction SilentlyContinue -Depth 3 | Select-Object -First 1
    if ($near) { $found = $near.FullName; break }
  }
}

if (-not $found) {
  Bad "找不到主工具 HTML（试过：$($HTML_NAMES -join '、')）"
  Say ''
  Say '  请把主工具 HTML 和本文件放在同一个文件夹里再运行。'
  Say '  如果只下载了启动器，请同时下载：'
  Say '      手填色卡.html'
  Say '      （或仓库里的 lumina_singlestage_gui.html，两个名字都认）'
  Say ''
  Say '  最省事的方式是下载「一键启动包_解压即用.zip」，解压出来就能直接用。'
  Say ''
  exit 1
}

Ok "已找到：$found"
$item = Get-Item -LiteralPath $found
Say ("      大小 {0:N0} 字节（{1} MB）" -f $item.Length, [Math]::Round($item.Length / 1MB, 2))

# ---------------------------------------------------------------- 2. 解除锁定
Say ''
Say '[1/2] 检查 Windows 文件锁定…'
try { $zone = Get-Item -LiteralPath $found -Stream Zone.Identifier -ErrorAction SilentlyContinue } catch { $zone = $null }

if ($DryRun) {
  if ($zone) { Warn '有「来自 Internet」标记（DryRun：不处理）' } else { Ok '没有锁定标记（DryRun）' }
} else {
  if ($zone) {
    try { Unblock-File -LiteralPath $found; Ok '已解除「受限站点」标记' }
    catch { Warn "解除失败（不影响使用）：$($_.Exception.Message)" }
  } else {
    Ok '没有锁定标记，无需处理'
  }
}

# ---------------------------------------------------------------- 3. 打开
Say ''
Say '[2/2] 打开浏览器…'

if ($DryRun) {
  Warn 'DryRun：不打开浏览器'
  Say ''
  Say '预演完成。'
  exit 0
}

try {
  Start-Process -FilePath $found
  Ok '已交给系统默认浏览器打开'
} catch {
  $browsers = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  )
  $opened = $false
  foreach ($b in $browsers) {
    if (Test-Path -LiteralPath $b) {
      Start-Process -FilePath $b -ArgumentList "`"$found`""
      Ok "已用 $(Split-Path $b -Leaf) 打开"
      $opened = $true
      break
    }
  }
  if (-not $opened) {
    Bad "无法打开：$($_.Exception.Message)"
    Say "  请手动双击：$found"
    exit 1
  }
}

Say ''
Say '  浏览器已打开。这个窗口可以关掉了。'
Say '  建议用 Edge / Chrome，并保持窗口宽度足够（工具按屏幕宽度自适应）。'
Say ''
