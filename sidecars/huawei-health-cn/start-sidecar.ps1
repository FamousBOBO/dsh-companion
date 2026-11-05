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
    [switch]$AllowUnconfigured,
    [switch]$OpenDashboard,
    [int]$WaitSeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SidecarRoot = $PSScriptRoot
$SuiteRoot = Split-Path -Parent (Split-Path -Parent $SidecarRoot)
$PythonDir = Join-Path $SidecarRoot 'python'
# 服务端入口：默认用随包的派生实现（MIT，见 PROTOCOL-FREEZE §1.1）；
# $env:HUAWEI_SERVE_SCRIPT 可指向你自己的实现。
$Dashboard = if ([string]::IsNullOrEmpty($env:HUAWEI_SERVE_SCRIPT)) { Join-Path $PythonDir 'huawei_dashboard.py' } else { $env:HUAWEI_SERVE_SCRIPT }

# ── paths: everything runtime lives under the suite data directory ─────────────────────────────
function Resolve-DataDir {
    if (-not [string]::IsNullOrEmpty($env:DSH_COMPANION_DATA_DIR)) { return $env:DSH_COMPANION_DATA_DIR }
    return (Join-Path $SuiteRoot 'data')
}
if (-not $LogDir) {
    if (-not [string]::IsNullOrEmpty($env:HUAWEI_LOG_DIR)) { $LogDir = $env:HUAWEI_LOG_DIR }
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
    Write-Host "找不到服务端入口: $Dashboard" -ForegroundColor Red
    Write-Host "  随包入口应在 sidecars\huawei-health-cn\python\huawei_dashboard.py；"
    Write-Host "  若你想用自己的实现，设 `$env:HUAWEI_SERVE_SCRIPT = 你的路径（需实现 GET /api/data?days=N 并只绑回环）。"
    exit 1
}
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$python = $PythonPath
if (-not $python -and -not [string]::IsNullOrEmpty($env:HUAWEI_PYTHON)) { $python = $env:HUAWEI_PYTHON }
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
$CredentialPath = if ([string]::IsNullOrEmpty($env:HUAWEI_ACCOUNT_JSON)) { Join-Path (Resolve-DataDir) 'credentials\huawei_account.json' } else { $env:HUAWEI_ACCOUNT_JSON }

Write-Step "bind        : ${BindHost}:$Port (loopback only)"
Write-Step "credential  : $CredentialPath — read by the sidecar process, never by this script"
Write-Step "serve       : $Dashboard"
Write-Step "logs        : $LogDir"
if (-not [string]::IsNullOrEmpty($env:HUAWEI_UPSTREAM_PKG)) {
    Write-Host "  upstream override: $env:HUAWEI_UPSTREAM_PKG" -ForegroundColor DarkGray
}
if (-not (Test-Path -LiteralPath $CredentialPath)) {
    # 「未配置」不是崩溃、也不是"连上了"：直接停下并把下一步说清楚，别让人等 30 秒超时。
    Write-Host ""
    Write-Host "  未配置（AWAIT_LOGIN）：还没有华为账号的令牌对（$CredentialPath）。" -ForegroundColor Yellow
    Write-Host "    1) 登录一次：& '$python' '$PythonDir\huawei_login.py' url   然后 exchange 粘贴回调里的 code"
    Write-Host "    2) 再跑本脚本。想用别的令牌文件：设 `$env:HUAWEI_ACCOUNT_JSON = 你的路径"
    Write-Host "    3) 只想先起进程（自定义入口能容忍无凭证）：加 -AllowUnconfigured"
    if (-not $AllowUnconfigured) { exit 2 }
    Write-Host "  -AllowUnconfigured 已指定：继续启动（采集会如实回落成空结果）。" -ForegroundColor DarkYellow
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
