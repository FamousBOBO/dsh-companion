param([ValidateSet('start','stop','status','sync')][string]$Action='status')
$ErrorActionPreference='Stop'
$parentRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$suite=if($env:DSH_COMPANION_PRODUCTION_ROOT){[IO.Path]::GetFullPath($env:DSH_COMPANION_PRODUCTION_ROOT)}elseif(Test-Path -LiteralPath (Join-Path $parentRoot 'package.json')){$parentRoot}else{Join-Path $parentRoot 'dsh-production'}
$recordFile=Join-Path $suite 'data\tmp\production.json'
$guardFile=Join-Path $suite 'data\tmp\production-process.json'
function Find-Production {
    if (!(Test-Path -LiteralPath $guardFile)) { return $null }
    $guard=Get-Content -LiteralPath $guardFile -Raw | ConvertFrom-Json
    $proc=Get-Process -Id $guard.pid -ErrorAction SilentlyContinue
    if ($proc -and $proc.Path -eq $guard.executable -and $proc.StartTime.ToUniversalTime() -eq ([datetime]$guard.startedAt).ToUniversalTime()) { return $proc }
    return $null
}
function Stop-Production {
    $proc=Find-Production
    if ($proc) { & taskkill /PID $proc.Id /T /F | Out-Null; if($LASTEXITCODE -ne 0){throw 'Failed to stop production'} }
}
function Start-Production {
    $proc=Find-Production
    if($proc){Write-Output "Production already running (PID $($proc.Id))";return}
    $node=(Get-Command node.exe).Source
    $script=Join-Path $PSScriptRoot 'serve.mjs'
    $proc=Start-Process -FilePath $node -ArgumentList @('"'+$script+'"') -WorkingDirectory $suite -WindowStyle Hidden -PassThru
    @{pid=$proc.Id;executable=$node;startedAt=$proc.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $guardFile
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while($timer.Elapsed.TotalSeconds -lt 55){
        $proc.Refresh();if($proc.HasExited){throw 'Node host exited; see data/logs/production-host.log'}
        $httpReady=$false
        try { $r=Invoke-WebRequest 'http://127.0.0.1:3100/' -UseBasicParsing -TimeoutSec 2; $httpReady=$r.StatusCode -eq 200 } catch { $httpReady=$_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401 }
        if($httpReady){
            Start-Sleep -Seconds 2
            $checkResult=& $node (Join-Path $PSScriptRoot 'check-production.mjs') 2>&1
            if($LASTEXITCODE -eq 0){
                Write-Output $checkResult
                Write-Output 'Production ready: use open-browser.ps1 to authenticate the browser'
                return
            }
        }
        Start-Sleep -Milliseconds 400
    }
    throw 'Node host readiness timeout; see data/logs/production-host.log'
}
switch($Action){
    'start' { Start-Production }
    'stop' { Stop-Production;Write-Output 'Production stopped' }
    'status' { $proc=Find-Production;if($proc){Write-Output "Production Node supervisor PID $($proc.Id), http://127.0.0.1:3100/"}else{Write-Output 'Production stopped';exit 1} }
    'sync' {
        Push-Location $suite
        try {
            if(git status --porcelain --untracked-files=no){throw 'Tracked source changes exist; refusing to overwrite'}
            git fetch origin;if($LASTEXITCODE){throw 'GitHub fetch failed'}
            $before=git rev-parse HEAD
            $upstream=git rev-parse '@{upstream}'
            if($before -eq $upstream){Write-Output 'Already synchronized with GitHub';return}
            git merge-base --is-ancestor HEAD '@{upstream}';if($LASTEXITCODE){throw 'Upstream diverged; manual review required'}
            Stop-Production
            git merge --ff-only '@{upstream}';if($LASTEXITCODE){throw 'Fast-forward failed'}
            npm ci;if($LASTEXITCODE){throw 'npm ci failed; production remains stopped'}
            npm run build;if($LASTEXITCODE){throw 'Build failed; production remains stopped'}
            $savedTemp=$env:TEMP; $savedTmp=$env:TMP
            $savedPersona=$env:DSH_COMPANION_PERSONA_ID
            $savedSuiteRoot=$env:DSH_COMPANION_SUITE_ROOT
            $savedDataDir=$env:DSH_COMPANION_DATA_DIR
            $env:DSH_COMPANION_PERSONA_ID='bot'
            $testSuiteRoot=Join-Path $suite 'data\tmp\verify-suite-root'
            New-Item -ItemType Directory -Path $testSuiteRoot -Force | Out-Null
            $env:DSH_COMPANION_SUITE_ROOT=$testSuiteRoot
            $env:DSH_COMPANION_DATA_DIR=Join-Path $testSuiteRoot 'data'
            $env:TEMP=Join-Path $suite 'data\tmp';$env:TMP=$env:TEMP
            try {
                npm run verify -- --only=unit
                if($LASTEXITCODE){throw 'Unit verification failed; production remains stopped'}
                $env:DSH_COMPANION_SUITE_ROOT=$savedSuiteRoot
                $env:DSH_COMPANION_DATA_DIR=$savedDataDir
                npm run verify -- --only=static,compose
                if($LASTEXITCODE){throw 'Production composition verification failed; production remains stopped'}
            } finally { $env:DSH_COMPANION_PERSONA_ID=$savedPersona; $env:DSH_COMPANION_SUITE_ROOT=$savedSuiteRoot; $env:DSH_COMPANION_DATA_DIR=$savedDataDir; $env:TEMP=$savedTemp; $env:TMP=$savedTmp }
            Start-Production
        } finally { Pop-Location }
    }
}
