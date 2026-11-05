#Requires -Version 5.1
<#
.SYNOPSIS
    Start the frozen CN Huawei Health sidecar on http://127.0.0.1:8765 (loopback only).

.DESCRIPTION
    Runs ``sidecars/huawei-health-cn/python/huawei_dashboard.py serve`` with a Python 3.11+
    interpreter of your choice (standard library only — there is nothing to pip install).

    On Linux / macOS use ``start-sidecar.sh`` instead; this file is the Windows path and is the
    only place that talks to WMI.

    What this script promises (frozen, see README §3):

      * the listener is **127.0.0.1** and nothing else — there is no parameter that can widen it;
      * the port is checked *before* launching; a foreign listener is refused, never replaced;
      * the process is launched **detached** through WMI, so a piped/automated invocation cannot
        be held open by the child's inherited stdout, and stdout/stderr go to a log file;
      * a PID file records the wrapper PID, the port and the PID that actually listens — it is the
        only handle ``stop-sidecar.ps1`` will ever kill. Both live in the suite data directory
        (``<data>/logs/huawei-health-cn``, override with ``-LogDir`` or ``$env:HUAWEI_LOG_DIR``),
        never inside the repository;
      * stdout/stderr are scanned for token material right after the start; a hit stops the
        process instead of leaving a credential in a log;
      * the credential file (``<data>/credentials/huawei_account.json``, ``$env:HUAWEI_ACCOUNT_JSON``)
        is only ever opened by the sidecar process itself; this script prints its **path** and does
        not read, echo, copy or back it up.

.EXAMPLE
    pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1
    pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1 -Port 8765 -PythonPath C:\Python312\python.exe
#>
[CmdletBinding()]
param(
    [int]$Port = 8765,
    # Interpreter to use. Default: $env:HUAWEI_PYTHON → <sidecar>\.venv\Scripts\python.exe → python on PATH.
    [string]$PythonPath = "",
    # Where the PID file and the two log files go. Default: $env:HUAWEI_LOG_DIR → <data>\logs\huawei-health-cn
    [string]$LogDir = "",
    [switch]$OpenDashboard,
    [int]$WaitSeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SidecarRoot = $PSScriptRoot
$SuiteRoot = Split-Path -Parent (Split-Path -Parent $SidecarRoot)
$PythonDir = Join-Path $SidecarRoot 'python'
# 服务端实现不由本仓库提供（许可证原因）：用户自备，或用 $env:HUAWEI_SERVE_SCRIPT 指定。
$Dashboard = if ($env:HUAWEI_SERVE_SCRIPT) { $env:HUAWEI_SERVE_SCRIPT } else { Join-Path $PythonDir 'serve.py' }

# ── paths: everything runtime lives under the suite data directory ─────────────────────────────
function Resolve-DataDir {
    if ($env:DSH_COMPANION_DATA_DIR) { return $env:DSH_COMPANION_DATA_DIR }
    return (Join-Path $SuiteRoot 'data')
}
if (-not $LogDir) {
    if ($env:HUAWEI_LOG_DIR) { $LogDir = $env:HUAWEI_LOG_DIR }
    else { $LogDir = Join-Path (Resolve-DataDir) 'logs\huawei-health-cn' }
}
$LogDir = [IO.Path]::GetFullPath($LogDir)
$PidFile = if ($Port -eq 8765) { Join-Path $LogDir 'sidecar.pid' } else { Join-Path $LogDir "sidecar-$Port.pid" }
$OutLog = if ($Port -eq 8765) { Join-Path $LogDir 'sidecar.out.log' } else { Join-Path $LogDir "sidecar-$Port.out.log" }
$ErrLog = if ($Port -eq 8765) { Join-Path $LogDir 'sidecar.err.log' } else { Join-Path $LogDir "sidecar-$Port.err.log" }

# The one and only bind address.  Hard-coded on purpose: a sidecar answering on 0.0.0.0 would
# expose health data to the LAN.
$BindHost = '127.0.0.1'

function Write-Step([string]$Message) { Write-Host "  $Message" }
function Get-ListenerPid([int]$LocalPort) {
    $conn = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
    return 0
}
function Stop-Tree([int]$ProcessId) {
    if ($ProcessId -gt 0) { & taskkill /PID $ProcessId /T /F 2>&1 | Out-Null }
}

Write-Host "huawei-health-cn sidecar" -ForegroundColor Cyan

# ── 1. preconditions ───────────────────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $Dashboard)) {
    Write-Host "REFUSED: 找不到健康数据服务端实现。" -ForegroundColor Red
    Write-Host "  本仓库**不包含**上游实现（华为健康读取服务端）：上游许可证不归本项目分发，"
    Write-Host "  详见 sidecars/huawei-health-cn/PROTOCOL-FREEZE.md §1.1。"
    Write-Host "  两种用法："
    Write-Host "    1) 自备上游检出并指定入口："
    Write-Host '         $env:HUAWEI_UPSTREAM_PKG = "<你的>\custom_components\huawei_health"'
    Write-Host '         $env:HUAWEI_SERVE_SCRIPT = "<你的 serve 入口.py>"   # 需实现 GET /api/data?days=N'
    Write-Host '    2) 或者把你的入口放到 sidecars\huawei-health-cn\python\serve.py（默认查找位置）'
    Write-Host "  注意：BLE 心率通道（sidecars/ble-heart-rate）不受影响，可独立离线验收。"
    exit 3
}
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$python = $PythonPath
if (-not $python -and $env:HUAWEI_PYTHON) { $python = $env:HUAWEI_PYTHON }
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
    throw ("python not found. Pass -PythonPath, or set `$env:HUAWEI_PYTHON, or create .venv next to this " +
           "script. This sidecar needs Python 3.11+ and **no** third-party packages (standard library only).")
}
$pythonVersion = (& $python --version 2>&1 | Out-String).Trim()
Write-Step "python      : $python ($pythonVersion)"

# ── 2. is something already listening? ─────────────────────────────────────────────────────────
$existingPid = Get-ListenerPid $Port
if ($existingPid -gt 0) {
    $ownerPid = $existingPid
    $owner = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    $ours = $false
    if (Test-Path -LiteralPath $PidFile) {
        $recorded = (Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json)
        if ("$($recorded.listenerPid)" -eq "$ownerPid" -or "$($recorded.wrapperPid)" -eq "$ownerPid") {
            $ours = $true
        }
    }
    if ($ours) {
        Write-Step "already running on ${BindHost}:$Port (listener pid $ownerPid) — nothing to do"
        Write-Host "stop with: pwsh -File $(Join-Path $SidecarRoot 'stop-sidecar.ps1')"
        exit 0
    }
    throw ("port $Port is held by PID $ownerPid ($($owner.Name)) and it is NOT recorded in " +
           "$PidFile. Refusing to touch it — stop it yourself or choose another -Port.")
}

# ── 3. launch detached ─────────────────────────────────────────────────────────────────────────
$CredentialPath = if ($env:HUAWEI_ACCOUNT_JSON) { $env:HUAWEI_ACCOUNT_JSON }
    else { Join-Path (Resolve-DataDir) 'credentials\huawei_account.json' }
Write-Step "bind        : ${BindHost}:$Port (loopback only)"
Write-Step "credential  : $CredentialPath — read by the sidecar process, never by this script"
Write-Step "serve       : $Dashboard"
Write-Step "logs        : $LogDir"
if (-not $env:HUAWEI_UPSTREAM_PKG) {
    Write-Host "  ↑ HUAWEI_UPSTREAM_PKG 未设置：如果这个入口需要上游 client/const，它会自己报错。" -ForegroundColor DarkYellow
}
if (-not (Test-Path -LiteralPath $CredentialPath)) {
    # 「未配置」不是错误页：sidecar 能起来，但拿不到任何数据。先说清楚，别让用户去猜端口/蓝牙。
    Write-Host "  账号未配置：$CredentialPath 还不存在。sidecar 会启动但读不到数据。" -ForegroundColor DarkYellow
    Write-Host "  先登录一次：& '$python' '$PythonDir\huawei_login.py' url" -ForegroundColor DarkYellow
}

$inner = '"{0}" "{1}" serve --port {2} --host {3} > "{4}" 2> "{5}"' -f `
    $python, $Dashboard, $Port, $BindHost, $OutLog, $ErrLog
$commandLine = 'cmd.exe /c "' + $inner + '"'
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = $commandLine
    CurrentDirectory = $PythonDir
}
if ([int]$created.ReturnValue -ne 0) {
    throw "could not launch the sidecar (Win32_Process.Create returned $($created.ReturnValue))"
}
$wrapperPid = [int]$created.ProcessId
Write-Step "launched    : wrapper pid $wrapperPid (detached)"

# ── 4. wait for the listener (TCP only — no HTTP, so no cloud call is spent) ───────────────────
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
        (Get-Content -LiteralPath $ErrLog -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
    } else { '(no stderr log)' }
    Stop-Tree $wrapperPid
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    throw ("sidecar did not start listening on $Port within $WaitSeconds s.`nstderr tail:`n$tail")
}

$record = [ordered]@{
    wrapperPid  = $wrapperPid
    listenerPid = $listenerPid
    port        = $Port
    host        = $BindHost
    startedAt   = (Get-Date).ToString('o')
    python      = $python
    script      = $Dashboard
    outLog      = $OutLog
    errLog      = $ErrLog
    note        = 'some Python builds (embedded / uv-managed) re-exec themselves: wrapperPid -> listenerPid'
}
$record | ConvertTo-Json | Set-Content -LiteralPath $PidFile -Encoding utf8
Write-Step "pid file    : $PidFile (wrapper $wrapperPid → listener $listenerPid)"

# ── 5. log hygiene gate: a log must never contain token material ───────────────────────────────
$tokenPattern = 'DgE[A-Za-z0-9+/=_-]{8,}|accessToken|refreshToken|x-huid|"uid"\s*:\s*"\d{6,}'
$leaks = @()
foreach ($log in @($OutLog, $ErrLog)) {
    if (Test-Path -LiteralPath $log) {
        $hit = Select-String -LiteralPath $log -Pattern $tokenPattern -AllMatches -ErrorAction SilentlyContinue
        if ($hit) { $leaks += $hit }
    }
}
if ($leaks.Count -gt 0) {
    Stop-Tree $wrapperPid
    Stop-Tree $listenerPid
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    throw ("token material found in the sidecar logs — the process was stopped.`n" +
           "Offending lines: $($leaks.Count). Delete $LogDir\*.log and investigate before retrying.")
}
Write-Step "log hygiene : clean (no token material in stdout/stderr)"

Write-Host ""
Write-Host "sidecar is up: http://${BindHost}:$Port/  (listener pid $listenerPid)" -ForegroundColor Green
Write-Host "  probe (costs one cloud pull): curl.exe -s `"http://${BindHost}:$Port/api/data?days=7`""
Write-Host "  snapshot (redacted)         : $python $(Join-Path $SidecarRoot 'capture_snapshot.py')"
Write-Host "  contract test (offline)     : $python $(Join-Path $SidecarRoot 'test_protocol_contract.py')"
Write-Host "  redaction tests (offline)   : $python $(Join-Path $SidecarRoot 'test_redact.py')"
Write-Host "  stop                        : pwsh -File $(Join-Path $SidecarRoot 'stop-sidecar.ps1')"

if ($OpenDashboard) { Start-Process "http://${BindHost}:$Port/" | Out-Null }
