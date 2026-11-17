# 注册生产宿主（DSH Node host）的开机自启计划任务（需提权）。
#
# 为什么必须有这个：VoceChat 通道现在跑在宿主进程里（SSE 长连接 + 适配层）。宿主不在，
# 消息照常进平台、插件照常落盘 —— 但**没有任何回合会被驱动**，手机上看起来就是"没反应"。
# 之前每次验证都要手工 `production.ps1 -Action start`，那不能叫上线。
#
# 设计要点，逐条对应一个真实的失败模式：
#   - 触发器「登录后启动」：宿主依赖 Docker Desktop 的登录态（VoceChat 容器在 WSL2 里），
#     开机但未登录时启动会连不上 3009。与 Caddy 的任务用同一时机。
#   - 延迟 90 秒：Docker Desktop 起容器需要时间。太早启动 → SSE 首连失败 → 靠退避重试也能
#     恢复，但日志上多一串噪音，且首连 seed 可能取不到历史游标。
#   - MultipleInstances = IgnoreNew：两个宿主会抢同一个 profile 与同一个 refresh_token 设备名，
#     后者会把前者的会话顶掉（refresh_token 唯一键是 (uid, device)）。
#   - RestartCount/RestartInterval：宿主异常退出时每分钟重试，最多 3 次。
#   - ExecutionTimeLimit = 0：长驻，不能被计划任务按默认 72 小时掐掉。
#   - 运行身份：当前用户 + Highest。与 Caddy 一致；profile 与 secrets 的 ACL 都限定当前用户。
#
# 用法（提权 PowerShell）：
#   .\register-host-task.ps1 -Mode register
#   .\register-host-task.ps1 -Mode status
#   .\register-host-task.ps1 -Mode start
#   .\register-host-task.ps1 -Mode stop
#   .\register-host-task.ps1 -Mode unregister
param(
    [ValidateSet('register', 'status', 'start', 'stop', 'unregister')]
    [string]$Mode      = 'status',
    [string]$TaskName  = 'dsh-production-host',
    [string]$Ps1       = 'D:\DSH\dsh-ops\startup-chain.ps1',
    [string]$WorkDir   = 'D:\DSH\dsh-ops',
    [int]$DelaySeconds = 10
)

$ErrorActionPreference = 'Stop'

function Show-TaskState {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host '(任务不存在)'; return }
    $i = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    $ex = $t.Actions | Select-Object -First 1
    [pscustomobject]@{
        TaskName       = $t.TaskName
        State          = "$($t.State)"
        LastRunTime    = $i.LastRunTime
        LastResult     = $i.LastTaskResult
        Execute        = $ex.Execute
        Arguments      = $ex.Arguments
        WorkDir        = $ex.WorkingDirectory
        RunAs          = $t.Principal.UserId
        MultiplePolicy = "$($t.Settings.MultipleInstances)"
        RestartCount   = $t.Settings.RestartCount
    } | Format-List
}

switch ($Mode) {
    'status' { Show-TaskState }
    'start'  {
        if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { throw "任务不存在：先 -Mode register" }
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "已请求启动 $TaskName"
    }
    'stop'   {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName }
        Write-Host "已请求停止 $TaskName（宿主进程本身用 production.ps1 -Action stop 停）"
    }
    'unregister' {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host "已注销 $TaskName"
        } else { Write-Host '（本来就不存在）' }
        Show-TaskState
    }
    'register' {
        if (-not (Test-Path -LiteralPath $Ps1)) { throw "找不到 $Ps1" }

        # 用哪个 PowerShell 跑这个 .ps1 必须**显式指定一个稳定路径**，而且必须能让本脚本在
        # **任何**版本下都不会解析失败 —— 这个脚本自己也要能被 PS 5.1 读（第一次注册时是被
        # 提权的 PS 5.1 跑的）。所以这里不用 `?.` 这类 PS 7 才有的语法。
        #
        # 优先级：**PS 7 优先，Windows PowerShell 5.1 兜底。**
        #
        #   为什么不是反过来：PS 5.1 读无 BOM 的 UTF-8 .ps1 会按系统 ANSI（这里 GBK）解码，
        #   含中文的脚本会被解坏、引号对不上、整个脚本 ParserError。2026-11-17 实测：
        #   计划任务用 PS 5.1 跑 startup-chain.ps1 时 LastTaskResult=1，报的是乱码
        #   `Write-Chain '鍚勭幆鐘舵€侊細'`。给脚本加 BOM 能救，但那要每一个新增脚本都记得加；
        #   让解释器本身不挑编码更省事。PS 7 默认按 UTF-8 读，没有这个问题。
        #
        #   为什么不用 `Get-Command pwsh` 的结果：本机上它解析到
        #   `...OpenAI.CodexPrimaryRuntime...\pwsh.exe` —— 另一个应用的**包内路径**，
        #   随该应用升级会变、可能被卸载。计划任务里写它等于绑一个随时会消失的目标。
        #
        # 所以按固定路径找，找到第一个真实的就停：
        $candidates = @(
            'C:\Program Files\PowerShell\7\pwsh.exe',
            "$env:LOCALAPPDATA\Programs\PowerShell\7\pwsh.exe",
            (Get-ChildItem 'C:\Program Files\WindowsApps' -Directory -Filter 'Microsoft.PowerShell_7.*_x64__8wekyb3d8bbwe' -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending |
                ForEach-Object { Join-Path $_.FullName 'pwsh.exe' } |
                Select-Object -First 1),
            (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
        )
        $pwsh = $null
        foreach ($candidate in $candidates) {
            if ($candidate -and (Test-Path -LiteralPath $candidate)) { $pwsh = $candidate; break }
        }
        if (-not $pwsh) { throw '找不到可用的 PowerShell（PS 7 与 System32 都没有）' }
        Write-Host "运行 PowerShell: $pwsh"
        # 调 startup-chain.ps1，**不是**直接调 production.ps1：后者假设容器已经就绪，而
        # 容器就绪与否只能等，不能猜（固定延迟猜错就是静默失败，见 startup-chain.ps1 顶部注释）。
        $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `"& '$Ps1'`""

        $taskActionDef = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $WorkDir

        # 登录后启动 + 延迟：让 Docker Desktop 先把 VoceChat 容器拉起来。
        $triggerDef = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        # 延迟从 90 秒缩到 10 秒：真正的等待交给 startup-chain.ps1 去"等条件成立"，
        # 不再靠猜时间。留 10 秒只是为了别和 Docker Desktop 自身的启动抢 CPU。
        $triggerDef.Delay = "PT${DelaySeconds}S"

        $principalDef = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

        $settingsDef = New-ScheduledTaskSettingsSet `
            -MultipleInstances IgnoreNew `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -StartWhenAvailable `
            -RestartInterval (New-TimeSpan -Minutes 1) `
            -RestartCount 3 `
            -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }
        Register-ScheduledTask -TaskName $TaskName -Action $taskActionDef -Trigger $triggerDef `
            -Principal $principalDef -Settings $settingsDef `
            -Description 'DSH Companion 生产宿主（VoceChat SSE 通道依赖它常驻）' | Out-Null

        Write-Host "已注册 $TaskName（登录后 ${DelaySeconds}s 触发 startup-chain.ps1，由它等容器就绪）"
        Show-TaskState
    }
}
