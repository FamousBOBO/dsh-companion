#Requires -Version 5.1
<#
.SYNOPSIS
    Start the frozen CN Huawei Health sidecar on http://127.0.0.1:8765 (loopback only).

.DESCRIPTION
    Runs ``sidecars/huawei-health-cn/python/huawei_dashboard.py serve`` with the venv that has
    already been proven against the real account (``tmp/hwvenv``).

    What this script promises (frozen, see README §3):

      * the listener is **127.0.0.1** and nothing else — there is no parameter that can widen it;
      * the port is checked *before* launching; a foreign listener is refused, never replaced;
      * the process is launched **detached** through WMI, because ``tmp/hwvenv``'s ``python.exe``
        re-execs itself (one launcher process + one real interpreter).  Starting it with plain
        ``Start-Process`` lets those children inherit the caller's stdout pipe, which hangs any
        piped/automated invocation for ever.  Detaching avoids that and gives a clean log file;
      * a PID file (``logs/sidecar.pid``) records the wrapper PID, the port and the PID that
        actually listens — it is the only handle ``stop-sidecar.ps1`` will ever kill;
      * stdout/stderr go to ``logs/`` and are scanned for token material right after the start;
        a hit stops the process instead of leaving a credential in a log;
      * the credential file (``tmp/huawei_account.json``) is only ever opened by the sidecar
        process itself; this script does not read, echo, copy or back it up.

.EXAMPLE
    pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1
    pwsh -File sidecars\huawei-health-cn\start-sidecar.ps1 -Port 8765 -OpenDashboard
#>
[CmdletBinding()]
param(
    [int]$Port = 8765,
    [string]$PythonPath = "",
    [switch]$OpenDashboard,
    [int]$WaitSeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SidecarRoot = $PSScriptRoot
$Workspace = Split-Path -Parent (Split-Path -Parent $SidecarRoot)
$PythonDir = Join-Path $SidecarRoot 'python'
$Dashboard = Join-Path $PythonDir 'huawei_dashboard.py'
$LogDir = Join-Path $SidecarRoot 'logs'
$PidFile = Join-Path $LogDir 'sidecar.pid'
$OutLog = Join-Path $LogDir 'sidecar.out.log'
$ErrLog = Join-Path $LogDir 'sidecar.err.log'

# The one and only bind address.  Hard-coded on purpose: a sidecar answering on 0.0.0.0 would
# expose health data to the LAN, and loopback-only is what design/health/INTERFACES.md §2 says.
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

# ── 1. preconditions ───────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $Dashboard)) {
    throw "frozen dashboard copy missing: $Dashboard"
}
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$python = $PythonPath
if (-not $python) {
    $candidate = Join-Path $Workspace 'tmp\hwvenv\Scripts\python.exe'
    if (Test-Path -LiteralPath $candidate) { $python = $candidate }
}
if (-not $python -or -not (Test-Path -LiteralPath $python)) {
    throw "python not found: tried tmp\hwvenv\Scripts\python.exe — pass -PythonPath explicitly"
}
$pythonVersion = (& $python --version 2>&1 | Out-String).Trim()
Write-Step "python      : $python ($pythonVersion)"

# ── 2. is something already listening? ─────────────────────────────────────
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

# ── 3. launch detached ────────────────────────────────────────────────────
Write-Step "bind        : ${BindHost}:$Port (loopback only)"
Write-Step "credential  : tmp\huawei_account.json — read by the sidecar process, never by this script"
Write-Step "logs        : $LogDir"

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

# ── 4. wait for the listener (TCP only — no HTTP, so no cloud call is spent) ──
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
    note        = 'tmp/hwvenv/Scripts/python.exe re-execs itself: wrapperPid -> listenerPid'
}
$record | ConvertTo-Json | Set-Content -LiteralPath $PidFile -Encoding utf8
Write-Step "pid file    : $PidFile (wrapper $wrapperPid → listener $listenerPid)"

# ── 5. log hygiene gate: a log must never contain token material ───────────
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
Write-Host "  snapshot (redacted)         : tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\capture_snapshot.py"
Write-Host "  contract test (offline)     : tmp\hwvenv\Scripts\python.exe sidecars\huawei-health-cn\test_protocol_contract.py"
Write-Host "  stop                        : pwsh -File $(Join-Path $SidecarRoot 'stop-sidecar.ps1')"

if ($OpenDashboard) { Start-Process "http://${BindHost}:$Port/" | Out-Null }
