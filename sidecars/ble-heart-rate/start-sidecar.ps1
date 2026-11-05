#Requires -Version 5.1
<#
.SYNOPSIS
    启动 BLE 心率广播接收端（Pulse Bond sidecar），只绑 http://127.0.0.1:8151。

.DESCRIPTION
    跑 ``sidecars/ble-heart-rate/heart_rate.py``，解释器按下面的顺序找（不写死任何 venv 路径）：

      1. ``-PythonPath``
      2. ``$env:BLE_HEART_RATE_PYTHON``
      3. ``<sidecar>\.venv\Scripts\python.exe``
      4. ``<data>\venv\Scripts\python.exe``（``<data>`` = ``$env:DSH_COMPANION_DATA_DIR`` 或 ``<套件根>\data``）
      5. PATH 上的 ``python``

    Linux / macOS 用 ``start-sidecar.sh``；这个文件是 Windows 那条路，也是唯一用 WMI 的地方。

    本脚本承诺（与 sidecars/huawei-health-cn 同一套做法）：

      * 监听地址只有 **127.0.0.1**，脚本没有、heart_rate.py 也没有能把它放大到局域网的参数；
      * 启动**之前**先预检端口，被别的进程占着就以 **退出码 2** 退出，绝不替换、绝不抢占；
      * 进程用 WMI（``Win32_Process.Create``）**detached** 起，输出重定向到 ``logs/``。
        不用 ``Start-Process`` 裸起：那会让子进程继承调用者的 stdout 管道，把任何管道/自动化
        调用挂死；
      * PID 文件记 ``{port, wrapperPid, listenerPid, startedAt}``，是 ``stop-sidecar.ps1``
        唯一会动的句柄；它和两份日志一起落在套件数据目录
        （``<data>\logs\ble-heart-rate``，可用 ``-LogDir`` 或 ``$env:BLE_HEART_RATE_LOG_DIR`` 覆盖），
        **不写进仓库**；
      * 起来之后自检 ``GET /api/health``（端口对得上、ok=true），再顺手看一眼 ``/api/state``；
      * 最后扫一遍日志：**出现蓝牙地址明文就立刻停进程并报错**。隐私要求是"日志里只允许
        addressHash 前 8 位"，宁可失败也不能留一条明文。

    没有硬件时用 ``-Fixture`` 回放合成序列，行为与真机完全一致（只是不碰蓝牙）。

.EXAMPLE
    pwsh -File sidecars\ble-heart-rate\start-sidecar.ps1 -Fixture

.EXAMPLE
    pwsh -File sidecars\ble-heart-rate\start-sidecar.ps1 -FixtureFile calm-steady

.EXAMPLE
    pwsh -File sidecars\ble-heart-rate\start-sidecar.ps1 -NameHint WATCH

.EXAMPLE
    pwsh -File sidecars\ble-heart-rate\start-sidecar.ps1 -Address 3f9a1c2d7b0e4411
#>
[CmdletBinding()]
param(
    [int]$Port = 8151,
    [string]$PythonPath = "",
    # 日志与 PID 文件目录。默认 $env:BLE_HEART_RATE_LOG_DIR → <data>\logs\ble-heart-rate
    [string]$LogDir = "",
    # -Fixture 用默认合成序列；-FixtureFile 换一条（可以只写文件名，自动到 fixtures\ 里找）
    [switch]$Fixture,
    [string]$FixtureFile = "",
    [string]$Address = "",
    [string]$NameHint = "",
    [switch]$AllowAddressDisplay,
    # 旧行为：启动就扫、自动连接、断线后台退避重连。默认是"懒模式"（不扫不连不重连）。
    [switch]$Auto,
    [switch]$NoAutoConnect,
    [switch]$Verbose2,
    [int]$WaitSeconds = 40,
    [switch]$OpenApi
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SidecarRoot = $PSScriptRoot
$SuiteRoot = Split-Path -Parent (Split-Path -Parent $SidecarRoot)
$Script = Join-Path $SidecarRoot 'heart_rate.py'

# ── 运行时路径：一律落在套件数据目录，不写进仓库 ──────────────────────────────────────────
function Resolve-DataDir {
    if ($env:DSH_COMPANION_DATA_DIR) { return $env:DSH_COMPANION_DATA_DIR }
    return (Join-Path $SuiteRoot 'data')
}
if (-not $LogDir) {
    if ($env:BLE_HEART_RATE_LOG_DIR) { $LogDir = $env:BLE_HEART_RATE_LOG_DIR }
    else { $LogDir = Join-Path (Resolve-DataDir) 'logs\ble-heart-rate' }
}
$LogDir = [IO.Path]::GetFullPath($LogDir)
# PID / 日志文件按端口隔离：契约端口 8151 用契约里的名字（logs/sidecar.pid），
# 其它端口带后缀。否则在 8151 上已经跑着一个实例时，再用别的端口起第二个会：
#   (a) 抢同一个 sidecar.out.log —— 旧实例握着句柄，cmd 的重定向打不开就直接退出；
#   (b) 覆盖同一个 sidecar.pid —— stop-sidecar.ps1 会按它把 8151 那个实例杀掉。
$PidFile = if ($Port -eq 8151) { Join-Path $LogDir 'sidecar.pid' } else { Join-Path $LogDir "sidecar-$Port.pid" }
$OutLog = if ($Port -eq 8151) { Join-Path $LogDir 'sidecar.out.log' } else { Join-Path $LogDir "sidecar-$Port.out.log" }
$ErrLog = if ($Port -eq 8151) { Join-Path $LogDir 'sidecar.err.log' } else { Join-Path $LogDir "sidecar-$Port.err.log" }

# 唯一允许的绑定地址。硬编码是刻意的：0.0.0.0 上的心率就是全局域网的心率。
$BindHost = '127.0.0.1'
if ($Port -ne 8151) {
    Write-Host "note: 契约端口是 8151（8765 是华为 sidecar、8139 是 GPU 网关）" -ForegroundColor DarkYellow
}

function Write-Step([string]$Message) { Write-Host "  $Message" }
# JSON 的 null / true / false 在 PowerShell 里会显示成空 / True / False，看着别扭；
# 这里跟契约的写法对齐，排障时一眼能对上 /api/state 的字段。
function Show-Value($Value) {
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    return "$Value"
}
# 读一个可能不存在的 JSON 字段（例如对面跑的是 2026-11-04 之前的老进程，还没有 scanCount）。
# Set-StrictMode 下直接取不存在的属性会抛 PropertyNotFoundException，这里绕开。
function Get-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}
function Get-ListenerPid([int]$LocalPort) {
    $conn = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
    return 0
}
function Stop-Tree([int]$ProcessId) {
    if ($ProcessId -le 0) { return }
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    try { & taskkill /PID $ProcessId /T /F *> $null } catch { }
}

Write-Host "ble-heart-rate sidecar" -ForegroundColor Cyan

# ── 1. 前置条件 ────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $Script)) {
    throw "sidecar 脚本不存在: $Script"
}
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$python = $PythonPath
if (-not $python -and $env:BLE_HEART_RATE_PYTHON) { $python = $env:BLE_HEART_RATE_PYTHON }
if (-not $python) {
    foreach ($candidate in @(
        (Join-Path $SidecarRoot '.venv\Scripts\python.exe'),
        (Join-Path (Resolve-DataDir) 'venv\Scripts\python.exe')
    )) {
        if (Test-Path -LiteralPath $candidate) { $python = $candidate; break }
    }
}
if (-not $python) {
    $onPath = Get-Command python -ErrorAction SilentlyContinue
    if ($onPath) { $python = $onPath.Source }
}
if (-not $python -or -not (Test-Path -LiteralPath $python)) {
    throw ("找不到 python。试过 -PythonPath、`$env:BLE_HEART_RATE_PYTHON、.venv、PATH。" +
           "先建一个 venv 并装依赖（只有真机模式需要 bleak）：" +
           "python -m venv .venv; .venv\Scripts\python -m pip install -r " +
           (Join-Path $SidecarRoot 'requirements.txt') +
           "（只想跑 fixture：加 -Fixture，连 bleak 都不需要）")
}
$pythonVersion = (& $python --version 2>&1 | Out-String).Trim()
Write-Step "python      : $python ($pythonVersion)"

$fixturePath = ""
if ($Fixture -or $FixtureFile) {
    $wanted = if ($FixtureFile) { $FixtureFile } else { 'synthetic-ramp.json' }
    $resolved = $wanted
    if (-not (Test-Path -LiteralPath $resolved)) {
        $guess = Join-Path $SidecarRoot (Join-Path 'fixtures' $wanted)
        if (-not [IO.Path]::HasExtension($wanted)) {
            $guess = Join-Path $SidecarRoot (Join-Path 'fixtures' ($wanted + '.json'))
        }
        if (Test-Path -LiteralPath $guess) { $resolved = $guess }
    }
    if (-not (Test-Path -LiteralPath $resolved)) {
        $available = (Get-ChildItem (Join-Path $SidecarRoot 'fixtures') -Filter *.json -ErrorAction SilentlyContinue |
                      Select-Object -ExpandProperty Name) -join ', '
        throw "fixture 不存在: $wanted（可用: $available）"
    }
    $fixturePath = (Resolve-Path -LiteralPath $resolved).Path
    Write-Step "fixture     : $fixturePath (回放模式，不需要蓝牙硬件)"
} else {
    # 真机模式才需要 bleak；没有就早说，别等半分钟后报个看不懂的错
    & $python -c "import bleak" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw ("$python 里没有 bleak。装一下：& '$python' -m pip install -r " +
               (Join-Path $SidecarRoot 'requirements.txt') + "`n（没有硬件只是想过 fixture：加 -Fixture）")
    }
    $bleakVersion = (& $python -c "import importlib.metadata as m; print(m.version('bleak'))" 2>&1 | Out-String).Trim()
    Write-Step "bleak       : $bleakVersion"
}

# ── 2. 端口预检：别人的监听绝不动 ──────────────────────────────────────────
$existingPid = Get-ListenerPid $Port
if ($existingPid -gt 0) {
    $owner = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    $ours = $false
    if (Test-Path -LiteralPath $PidFile) {
        $recorded = (Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json)
        if ("$($recorded.listenerPid)" -eq "$existingPid" -or "$($recorded.wrapperPid)" -eq "$existingPid") {
            $ours = $true
        }
    }
    if ($ours) {
        Write-Step "已经在跑：${BindHost}:$Port（listener pid $existingPid），什么都没做"
        Write-Host "stop with: pwsh -File $(Join-Path $SidecarRoot 'stop-sidecar.ps1')"
        exit 0
    }
    Write-Step "端口 $Port 已被 PID $existingPid（$($owner.Name)）占用，且不在 $(Split-Path -Leaf $PidFile) 里 —— 不抢。"
    Write-Host "  要么自己停掉它，要么换端口：pwsh -File $PSCommandPath -Port 8152" -ForegroundColor Yellow
    exit 2
}

# ── 3. detached 启动 ──────────────────────────────────────────────────────
$argList = @('--port', "$Port")
if ($fixturePath) { $argList += @('--fixture', "`"$fixturePath`"") }
if ($Address) { $argList += @('--address', "`"$Address`"") }
if ($NameHint) { $argList += @('--name-hint', "`"$NameHint`"") }
if ($AllowAddressDisplay) { $argList += '--allow-address-display' }
if ($Auto) { $argList += '--auto' }
if ($NoAutoConnect) { $argList += '--no-auto-connect' }
if ($Verbose2) { $argList += '--verbose' }
$argText = ($argList -join ' ')

$modeText = if ($Auto) { 'auto（启动就扫、自动连接、断线自动重连）' } else { 'lazy（默认：不扫、不自动连、不重连，等 POST /api/connect）' }
Write-Step "mode        : $modeText"
Write-Step "bind        : ${BindHost}:$Port (loopback only，不可改)"
Write-Step "logs        : $LogDir"

$inner = '"{0}" "{1}" {2} > "{3}" 2> "{4}"' -f $python, $Script, $argText, $OutLog, $ErrLog
$commandLine = 'cmd.exe /c "' + $inner + '"'
# 这两行只在 -Verbose2 时打出来：命令行里可能有 address（真地址），默认不外显
if ($Verbose2) { Write-Step "command     : $(($commandLine -replace '\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b', '<redacted>'))" }

$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = $commandLine
    CurrentDirectory = $SidecarRoot
}
if ([int]$created.ReturnValue -ne 0) {
    throw "启动失败（Win32_Process.Create 返回 $($created.ReturnValue)）"
}
$wrapperPid = [int]$created.ProcessId
Write-Step "launched    : wrapper pid $wrapperPid (detached)"

# ── 4. 等监听 ─────────────────────────────────────────────────────────────
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$listenerPid = 0
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    $listenerPid = Get-ListenerPid $Port
    if ($listenerPid -gt 0) { break }
    if (-not (Get-Process -Id $wrapperPid -ErrorAction SilentlyContinue)) { break }
}
if ($listenerPid -le 0) {
    $tail = if (Test-Path -LiteralPath $ErrLog) {
        (Get-Content -LiteralPath $ErrLog -Tail 20 -Encoding utf8 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
    } else { '(no stderr log)' }
    Stop-Tree $wrapperPid
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    throw "sidecar 在 $WaitSeconds 秒内没有监听 $Port。`nstderr tail:`n$tail"
}

$record = [ordered]@{
    port        = $Port
    wrapperPid  = $wrapperPid
    listenerPid = $listenerPid
    startedAt   = (Get-Date).ToString('o')
    host        = $BindHost
    python      = $python
    script      = $Script
    fixture     = if ($fixturePath) { $fixturePath } else { $null }
    outLog      = $OutLog
    errLog      = $ErrLog
}
$record | ConvertTo-Json | Set-Content -LiteralPath $PidFile -Encoding utf8
Write-Step "pid file    : $PidFile (port $Port, wrapper $wrapperPid → listener $listenerPid)"

# ── 5. 自检 /api/health ───────────────────────────────────────────────────
$baseUrl = "http://${BindHost}:$Port"
$health = $null
$healthDeadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $healthDeadline) {
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 3
        break
    } catch {
        Start-Sleep -Milliseconds 300
    }
}
if (-not $health) {
    Stop-Tree $wrapperPid; Stop-Tree $listenerPid
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    throw "端口通了但 /api/health 拉不到 —— sidecar 不健康，已停掉。"
}
if (-not $health -or -not (Get-Field $health 'ok') -or [int](Get-Field $health 'port') -ne $Port) {
    Stop-Tree $wrapperPid; Stop-Tree $listenerPid
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    throw "/api/health 自检失败：$($health | ConvertTo-Json -Compress)"
}
Write-Step "health      : ok=$(Show-Value (Get-Field $health 'ok')) port=$((Get-Field $health 'port')) version=$((Get-Field $health 'version')) fixture=$(Show-Value (Get-Field $health 'fixture')) connected=$(Show-Value (Get-Field $health 'connected')) scanCount=$(Show-Value (Get-Field $health 'scanCount'))"

$state = $null
try { $state = Invoke-RestMethod -Uri "$baseUrl/api/state" -TimeoutSec 5 } catch { }
$health2 = $null
try { $health2 = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 5 } catch { }
if ($state) {
    Write-Step "state       : bpm=$(Show-Value (Get-Field $state 'bpm')) connected=$(Show-Value (Get-Field $state 'connected')) quality=$(Show-Value (Get-Field $state 'quality')) sampleAgeMs=$(Show-Value (Get-Field $state 'sampleAgeMs')) lastErrorCode=$(Show-Value (Get-Field $state 'lastErrorCode')) scanCount=$(Show-Value (Get-Field $health2 'scanCount'))"
    if (-not $Auto) {
        # 懒模式：启动后 connected=false / bpm=null 是**正常**的，别当成故障
        Write-Host "  懒模式：进程只监听、不扫描不连接。上层调用工具时会 POST /api/connect 才真正去连；" -ForegroundColor DarkGray
        Write-Host "  想立刻验证连通：curl.exe -s -X POST `"$baseUrl/api/connect`"（扫描 + 连一次，需要真硬件/广播已开）" -ForegroundColor DarkGray
        Write-Host "  没有硬件也能验：用 -Fixture 回放合成序列（见 README §2）" -ForegroundColor DarkGray
    } elseif (-not (Get-Field $state 'connected')) {
        Write-Host "  提示：还没连上设备（lastErrorCode=$(Show-Value (Get-Field $state 'lastErrorCode'))）。确认手表『心率广播』已开，或用 -Address/-NameHint 指定设备。" -ForegroundColor DarkYellow
        Write-Host "  没连上时状态如实显示「不可用」，不会给出任何假读数。" -ForegroundColor DarkYellow
    }
}

# ── 6. 隐私闸：日志里不许有蓝牙地址明文 ───────────────────────────────────
# 只允许 addressHash 前 8 位（形如 ble:c1582e87）。这条闸宁可真阳性停进程，也不留明文。
$macPattern = '([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}'
$leaks = @()
foreach ($logFile in @($OutLog, $ErrLog)) {
    if (Test-Path -LiteralPath $logFile) {
        $hit = Select-String -LiteralPath $logFile -Pattern $macPattern -AllMatches -ErrorAction SilentlyContinue
        if ($hit) { $leaks += $hit }
    }
}
if ($leaks.Count -gt 0) {
    Stop-Tree $wrapperPid
    Stop-Tree $listenerPid
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    throw ("日志里出现蓝牙地址明文 —— 已停掉进程。`n$LogDir\*.log 里的命中行数: $($leaks.Count)。" +
           "删掉日志、修好打印再重试（日志只允许 addressHash 前 8 位）。")
}
Write-Step "privacy     : 日志干净（无蓝牙地址明文）"

Write-Host ""
Write-Host "sidecar 起来了：$baseUrl/  (listener pid $listenerPid)" -ForegroundColor Green
Write-Host "  自检（不联网、不开蓝牙）: & '$python' '$(Join-Path $SidecarRoot 'heart_rate.py')' --selftest"
Write-Host "  按需连接一次（要硬件）  : curl.exe -s -X POST `"$baseUrl/api/connect`""
Write-Host "  扫一次（要硬件）        : curl.exe -s `"$baseUrl/api/devices?scan=1`""
Write-Host "  读当前状态              : curl.exe -s `"$baseUrl/api/state`""
Write-Host "  stop                    : pwsh -File $(Join-Path $SidecarRoot 'stop-sidecar.ps1')"

if ($OpenApi) { Start-Process "$baseUrl/api/state" | Out-Null }
