#Requires -Version 5.1
<#
.SYNOPSIS
    Stop the sidecar that start-sidecar.ps1 started — and nothing else.

.DESCRIPTION
    The PID file (``logs/sidecar.pid``) is the only source of truth.  Because ``tmp/hwvenv``'s
    ``python.exe`` re-execs itself, one sidecar is two processes (a launcher plus the real
    interpreter that listens); the recorded ``listenerPid`` is verified against the process that
    currently owns the recorded port, and its command line must still name
    ``huawei_dashboard.py``.  Only then is the tree killed.

    Refusals are deliberate: a recycled PID, a foreign listener on the port, or a command line
    that does not match all mean "leave it alone and tell the operator".

.EXAMPLE
    pwsh -File sidecars\huawei-health-cn\stop-sidecar.ps1
    pwsh -File sidecars\huawei-health-cn\stop-sidecar.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [int]$DefaultPort = 8765,
    [int]$WaitSeconds = 15
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SidecarRoot = $PSScriptRoot
$LogDir = Join-Path $SidecarRoot 'logs'
$PidFile = Join-Path $LogDir 'sidecar.pid'

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

Write-Host "huawei-health-cn sidecar — stop" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Step "no PID file at $PidFile"
    $strayPid = Get-ListenerPid $DefaultPort
    if ($strayPid -gt 0) {
        $name = (Get-Process -Id $strayPid -ErrorAction SilentlyContinue).Name
        $line = Get-CommandLine $strayPid
        Write-Step "port $DefaultPort is held by PID $strayPid ($name) — not started by this script, leaving it alone"
        Write-Step "its command line: $line"
        Write-Warning "if that is a stray sidecar, stop it yourself: taskkill /PID $strayPid /T /F"
        exit 2
    }
    Write-Step "nothing is listening on $DefaultPort either — already stopped"
    exit 0
}

$record = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
$port = [int]$record.port
$recordedListener = [int]$record.listenerPid
$recordedWrapper = [int]$record.wrapperPid
Write-Step "pid file    : $PidFile (port $port, wrapper $recordedWrapper → listener $recordedListener, started $($record.startedAt))"

$currentListener = Get-ListenerPid $port
$targets = @()

if ($currentListener -gt 0) {
    $line = Get-CommandLine $currentListener
    if ($line -and $line -match 'huawei_dashboard\.py' -and
        $line -match [regex]::Escape($(Split-Path -Parent $record.script))) {
        Write-Step "verified    : listener pid $currentListener on port $port is our dashboard"
        $targets += $currentListener
    } else {
        throw ("port $port is now held by PID $currentListener whose command line is not ours:`n  $line`n" +
               "Refusing to kill it. Delete $PidFile by hand once you know what it is.")
    }
} else {
    Write-Step "nothing listens on port $port any more"
}

if (Get-Process -Id $recordedWrapper -ErrorAction SilentlyContinue) {
    $wrapperLine = Get-CommandLine $recordedWrapper
    if ($wrapperLine -and $wrapperLine -match 'huawei_dashboard\.py') {
        Write-Step "verified    : wrapper pid $recordedWrapper still carries the dashboard command line"
        $targets += $recordedWrapper
    } else {
        Write-Warning "wrapper pid $recordedWrapper was recycled by another process — not touching it"
    }
}
$targets = $targets | Select-Object -Unique

if ($targets.Count -eq 0) {
    Write-Step "no live process belongs to the PID file — cleaning it up"
    if (-not $DryRun) { Remove-Item -LiteralPath $PidFile -Force }
    exit 0
}

if ($DryRun) {
    Write-Step "-DryRun: would kill the tree of pid(s) $($targets -join ', ') and delete the PID file"
    exit 0
}

foreach ($target in $targets) {
    & taskkill /PID $target /T /F 2>&1 | Out-Null
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
    if ((Get-ListenerPid $port) -eq 0) { break }
    Start-Sleep -Milliseconds 250
}

$stillUp = Get-ListenerPid $port
if ($stillUp -gt 0) {
    throw "port $port is still held by PID $stillUp after the kill — inspect it before retrying"
}

Remove-Item -LiteralPath $PidFile -Force
Write-Step "stopped     : pid(s) $($targets -join ', '), port $port is free, PID file removed"
Write-Host "sidecar is down." -ForegroundColor Green
