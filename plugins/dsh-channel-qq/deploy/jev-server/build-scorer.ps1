<# 构建 `jev-score`：把 llama.cpp 的评分器壳编译成本机可执行文件。

为什么这个脚本要存在而不是"让用户自己去编译"：
`jev-score` 不是 llama.cpp 官方发布的产物，它是一层**按 Jev 线协议**写的薄壳
（读 stdin 的 JSON、只在指定 token 位置读 logit、打印 JSON）。没有它，本地判断这一路
根本起不来，而"怎么编"这件事在一台新机器上是全新的（MSVC 版本、SDK、库路径、DLL 摆放）。

三条踩出来的环境事实（写在这里省掉一次排查）：
  1. `cl.exe` 必须在 `vcvars64.bat` 的环境里跑，直接调会找不到标准头；
  2. 库在 `llama-build\src\Release` 与 `llama-build\ggml\src\Release`，
     **不在** `bin\Release`（那个目录里只有 DLL）；
  3. 运行时 DLL（`llama.dll` / `ggml*.dll`）是从 **exe 所在目录**解析的，不是 cwd。
     漏拷会得到 `{"error":"model load failed"}`——看起来像权重坏了。

`jev_score.cpp` **不在本仓库**：它是 Jev-Style-0.8B-Decision-v3 发布物的一部分
（Apache-2.0，头注释里有它要求的上游 commit）。所以这个脚本按 `-Source` 去找它，
默认在模型目录里找。

用法：
  .\build-scorer.ps1 -ModelDir 'D:\jev\model' -LlamaBuild 'D:\jev\llama-build'
#>

[CmdletBinding()]
param(
  # 模型目录（`fetch-model.ps1` 下载到这里；`jev_score.cpp` 也在里面）。
  [Parameter(Mandatory = $true)][string] $ModelDir,
  # llama.cpp 的构建目录（里面有 src\Release 与 ggml\src\Release）。
  [Parameter(Mandatory = $true)][string] $LlamaBuild,
  # 输出目录（默认模型目录下的 `bin`；DLL 会一起拷进去）。
  [string] $Out = '',
  # `jev_score.cpp` 的路径；缺省在 `-ModelDir` 里找。
  [string] $Source = '',
  # MSVC 的 vcvars64.bat；缺省从 VS 安装目录里找最新的那个。
  [string] $VcVars = '',
  # llama.cpp 的头文件目录（缺省按构建目录推断）。
  [string] $Include = ''
)

$ErrorActionPreference = 'Stop'
if ($Out -eq '') { $Out = Join-Path $ModelDir 'bin' }

# ── 0. 输入自检：先确认三个东西都在，再谈编译 ────────────────────────────────
if ($Source -eq '') {
  $found = Get-ChildItem -Path $ModelDir -Filter 'jev_score.cpp' -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $found) { throw "在 $ModelDir 里没找到 jev_score.cpp：请传 -Source（它在模型发布包里）" }
  $Source = $found.FullName
}
if (-not (Test-Path $Source)) { throw "缺少 jev_score.cpp：$Source" }

# ── 1. vcvars64.bat ─────────────────────────────────────────────────────────
if ($VcVars -eq '') {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) { throw "找不到 vswhere.exe（$vswhere）：请手动传 -VcVars" }
  $vsRoot = & $vswhere -latest -products * -property installationPath
  $VcVars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
}
if (-not (Test-Path $VcVars)) { throw "找不到 vcvars64.bat：$VcVars" }

# ── 2. 头文件 ───────────────────────────────────────────────────────────────
if ($Include -eq '') {
  $Include = @(
    (Join-Path $LlamaBuild 'include'),
    (Join-Path $LlamaBuild '..\llama.cpp\include'),
    (Join-Path $LlamaBuild '..\include')
  ) | Where-Object { Test-Path (Join-Path $_ 'llama.h') } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($Include) -or -not (Test-Path (Join-Path $Include 'llama.h'))) {
  throw "找不到 llama.h：请传 -Include（推断值：$Include）"
}

# ── 3. 库目录（含 ggml 后端可能落在的几个子目录） ───────────────────────────
$required = @((Join-Path $LlamaBuild 'src\Release'), (Join-Path $LlamaBuild 'ggml\src\Release'))
foreach ($dir in $required) {
  if (-not (Test-Path $dir)) { throw "缺少库目录：$dir（先构建 llama.cpp 的 Release 配置）" }
}
$optional = @('ggml\Release', 'ggml\cpu\Release', 'common\Release') |
  ForEach-Object { Join-Path $LlamaBuild $_ } | Where-Object { Test-Path $_ }
$libDirs = @($required) + @($optional)

# ── 4. 编译 ─────────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$exePath = Join-Path $Out 'jev-score.exe'
$ldflags = $libDirs | ForEach-Object { "/LIBPATH:$_" }
$command = (@(
  'call', "`"$VcVars`"",
  '&&', 'cl', '/nologo', '/std:c++17', '/O2', '/EHsc', '/MD',
  "/I`"$Include`"",
  "`"$Source`"",
  '/Fe:' + "`"$exePath`"",
  '/link', '/SUBSYSTEM:CONSOLE'
) + $ldflags + @('llama.lib', 'ggml.lib', 'ggml-base.lib', 'ggml-cpu.lib', 'llama-common.lib')) -join ' '

Write-Host "→ 编译 ..." -ForegroundColor Cyan
& cmd.exe /c $command
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）。若报找不到符号，把 lib 文件名按 $LlamaBuild\src\Release 里的实际清单改一下。" }

# ── 5. DLL 必须和 exe 同目录（运行时按 exe 目录解析） ────────────────────────
$dlls = Get-ChildItem -Path $LlamaBuild -Recurse -Filter '*.dll' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^(llama|ggml|libomp)' }
foreach ($dll in $dlls) {
  Copy-Item -Path $dll.FullName -Destination (Join-Path $Out $dll.Name) -Force
}
if ($dlls.Count -eq 0) {
  Write-Warning '没找到 llama/ggml 的 DLL：若 llama.cpp 是静态构建可忽略这一条'
} else {
  Write-Host "→ 拷入 $($dlls.Count) 个 DLL" -ForegroundColor Cyan
}

# ── 6. 冒烟：不带参数启动必须打印用法并退出（只验"进程能起来、DLL 找得到"） ──
& $exePath 2>&1 | Select-Object -First 4

Write-Host "`n构建完成：$exePath" -ForegroundColor Green
Write-Host '下一步：后台「判断模型」页把 scorerPath 填成上面这个路径，' -ForegroundColor Cyan
Write-Host 'modelPath 填模型目录里的 .gguf，tokenizerPath 填 tokenizer\tokenizer.json。' -ForegroundColor Cyan
