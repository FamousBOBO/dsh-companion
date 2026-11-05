#Requires -Version 5.1
<#
.SYNOPSIS
    停掉 start-sidecar.ps1 起的那个心率 sidecar —— 只停它，别的概不碰。

.DESCRIPTION
    PID 文件（``<data>\logs\ble-heart-rate\sidecar.pid``；``-LogDir`` / ``$env:BLE_HEART_RATE_LOG_DIR``
    可覆盖）是唯一事实来源。校验分三步，任何一步对不上就**不动手**、只报告：

      1. PID 文件里记的 port/listenerPid/wrapperPid 还在；
      2. 当前占着那个端口的进程，命令行里仍然含 ``heart_rate.py``，且目录是本 sidecar；
      3. wrapper 进程若不是回收来的（命令行也含 ``heart_rate.py``）才一起杀。

    然后 ``taskkill /T /F`` 杀整棵树，等端口真的空出来，最后删 PID 文件。端口还被别人占着
    就报错退出，不做任何"反正先 kill 一下"的猜测。

    Linux / macOS 用 ``stop-sidecar.sh``；这个文件是 Windows 那条路（WMI/taskkill）。

.EXAMPLE
    pwsh -File sidecars\ble-heart-rate\stop-sidecar.ps1

.EXAMPLE
    pwsh -File sidecars\ble-heart-rate\stop-sidecar.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    # 要停哪个端口的实例：契约端口 8151 用 sidecar.pid，其它端口用 sidecar-<port>.pid
    [int]$Port = 8151,
    [string]$LogDir = "",
    [int]$WaitSeconds = 15
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SidecarRoot = $PSScriptRoot
$SuiteRoot = Split-Path -Parent (Split-Path -Parent $SidecarRoot)
if (-not $LogDir) {
    if (-not [string]::IsNullOrEmpty($env:BLE_HEART_RATE_LOG_DIR)) { $LogDir = $env:BLE_HEART_RATE_LOG_DIR }
    elseif (-not [string]::IsNullOrEmpty($env:DSH_COMPANION_DATA_DIR)) { $LogDir = Join-Path $env:DSH_COMPANION_DATA_DIR 'logs\ble-heart-rate' }
    else { $LogDir = Join-Path $SuiteRoot 'data\logs\ble-heart-rate' }
}
$PidFile = if ($Port -eq 8151) { Join-Path $LogDir 'sidecar.pid' } else { Join-Path $LogDir "sidecar-$Port.pid" }

function Write-Step([string]$Message) { Write-Host "  $Message" }
function Get-ListenerPid([int]$LocalPort) {
    $conn = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
    return 0
}
function Get-CommandLine([int]$ProcessId) {
    (Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue).CommandLine
}

Write-Host "ble-heart-rate sidecar — stop" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Step "没有 PID 文件: $PidFile"
    $strayPid = Get-ListenerPid $Port
    if ($strayPid -gt 0) {
        $name = (Get-Process -Id $strayPid -ErrorAction SilentlyContinue).Name
        $line = Get-CommandLine $strayPid
        Write-Step "端口 $Port 被 PID $strayPid（$name）占着 —— 不是本脚本起的，不动它"
        Write-Step "它的命令行: $line"
        Write-Warning "如果那确实是个跑飞的心率 sidecar，自己停：taskkill /PID $strayPid /T /F"
        exit 2
    }
    Write-Step "$Port 上也没人监听 —— 本来就是停的"
    exit 0
}

$record = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
# ⚠️ PowerShell 变量名大小写不敏感：这里绝不能写 `$port = ...`，否则会覆盖参数 $Port。
$recordedPort = [int]$record.port
$recordedListener = [int]$record.listenerPid
$recordedWrapper = [int]$record.wrapperPid
# 防御：PID 文件里记的端口必须就是要停的端口。绝不能因为"文件里是 8151"就去杀 8151
# 而调用方其实想停的是 8165（这个坑 2026-11-04 真踩过一次，误杀了一个正在用的实例）。
if ($recordedPort -ne $Port) {
    throw ("PID 文件 $PidFile 记的是端口 $recordedPort，但你要停的是 $Port —— 拒绝动手。" +
           "端口和 PID 文件必须对应（8151→logs/sidecar.pid，其它→logs/sidecar-<port>.pid）。")
}
Write-Step "pid file    : $PidFile (port $recordedPort, wrapper $recordedWrapper → listener $recordedListener, started $($record.startedAt))"

$currentListener = Get-ListenerPid $recordedPort
$targets = @()

if ($currentListener -gt 0) {
    $line = Get-CommandLine $currentListener
    # 命令行里既要有 heart_rate.py，也要指向本 sidecar 目录。目录可能是绝对路径（本脚本起的），
    # 也可能是相对路径（有人手工从工作区根目录起的 sidecars\ble-heart-rate\...）——两种都认，
    # 但仍然必须是这一个 sidecar，不能是别人的进程。
    $looksOurs = $line -and $line -match 'heart_rate\.py' -and
                 ($line -match [regex]::Escape($SidecarRoot) -or $line -match 'sidecars[\\/]ble-heart-rate')
    if ($looksOurs) {
        Write-Step "verified    : 端口 $recordedPort 上的 PID $currentListener 是本 sidecar"
        $targets += $currentListener
    } else {
        throw ("端口 $recordedPort 现在是 PID $currentListener 在听，命令行不是我们的：`n  $line`n" +
               "不杀。确认清楚后自己删掉 $PidFile。")
    }
} else {
    Write-Step "端口 $recordedPort 上已经没人在听了"
}

if (Get-Process -Id $recordedWrapper -ErrorAction SilentlyContinue) {
    $wrapperLine = Get-CommandLine $recordedWrapper
    if ($wrapperLine -and $wrapperLine -match 'heart_rate\.py') {
        Write-Step "verified    : wrapper pid $recordedWrapper 的命令行还带着 heart_rate.py"
        $targets += $recordedWrapper
    } else {
        Write-Warning "wrapper pid $recordedWrapper 的 PID 被别的进程回收了 —— 不碰它"
    }
}
$targets = @($targets | Select-Object -Unique)

if ($targets.Count -eq 0) {
    Write-Step "PID 文件里没有活着的进程 —— 清掉 PID 文件"
    if (-not $DryRun) { Remove-Item -LiteralPath $PidFile -Force }
    exit 0
}

if ($DryRun) {
    Write-Step "-DryRun: 会杀 pid(s) $($targets -join ', ') 的进程树，并删掉 PID 文件"
    exit 0
}

foreach ($target in $targets) {
    # 已经退出的进程直接跳过：venv 的 python.exe 会 re-exec，cmd/wrapper 往往早就退了，
    # 对死 PID 再 taskkill 只会吐一条 ERROR 噪声（PowerShell 5.1 下还会变成终止错误）。
    if (-not (Get-Process -Id $target -ErrorAction SilentlyContinue)) {
        Write-Step "skip        : pid $target 已经退出（多半是 wrapper）"
        continue
    }
    try {
        & taskkill /PID $target /T /F *> $null
    } catch {
        Write-Step "taskkill    : pid $target 报错（可能刚好自己退出）—— 继续收尾"
    }
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
    if ((Get-ListenerPid $port) -eq 0) { break }
    Start-Sleep -Milliseconds 250
}

$stillUp = Get-ListenerPid $port
if ($stillUp -gt 0) {
    throw "杀完之后端口 $port 还挂在 PID $stillUp 上 —— 先查清楚再重试"
}

Remove-Item -LiteralPath $PidFile -Force
Write-Step "stopped     : pid(s) $($targets -join ', ')，端口 $port 已释放，PID 文件已删"
Write-Host "sidecar is down." -ForegroundColor Green
