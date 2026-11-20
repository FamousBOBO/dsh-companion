<#
取模型与校验。

为什么要一个脚本：判断这一路要三样东西，而它们的**来源不同**——
  - `Jev-Style-0.8B-Decision-v3` 的 GGUF（495 MB，Q4_K_M 量化）
  - `readout_config.json`（校准温度与槽位 token 定义）
  - `tokenizer\tokenizer.json` + `tokenizer_config.json`（渲染器要用它切 token）
任何一个缺失或版本不一致，渲染出的槽位就会偏，而**不会报错**——只会给出看起来合理的
错答案。所以这里除了下载，还要按已知的 sha256 校验一遍。

`-VerifyOnly` 只校验不下载：模型目录已经在的时候用它确认"还是那份文件"。

用法：
  .\fetch-model.ps1 -Out 'D:\jev\model'
  .\fetch-model.ps1 -Out 'D:\jev\model' -VerifyOnly
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Out,
  # 模型发布包的地址（HuggingFace 风格的 resolve 直链；换成你自己的镜像即可）。
  [string] $BaseUrl = 'https://huggingface.co/Jev-Style/Jev-Style-0.8B-Decision-v3/resolve/main',
  # 只校验，不下载。
  [switch] $VerifyOnly,
  # 已知的哈希（改发布版本时同步改这里；校验失败是**硬错**，不是警告）。
  [hashtable] $Hashes = @{
    'Jev-Style-0.8B-Decision-v3-Q4_K_M.gguf' = '0a19bc29bacc33e0d871146c8612b24dd14c2ed2e61cedeb7a928b0852628bac'
    'readout_config.json'                    = ''
    'tokenizer\tokenizer.json'               = '06b9509352d2af50381ab2247e083b80d32d5c0aba91c272ca9ff729b6a0e523'
    'tokenizer\tokenizer_config.json'        = ''
  }
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# 要取的文件清单（相对路径；`tokenizer\` 那两件必须在同一个子目录里——
# `@huggingface/tokenizers` 会去 tokenizer.json 的同目录找 tokenizer_config.json）。
$files = @(
  'Jev-Style-0.8B-Decision-v3-Q4_K_M.gguf',
  'readout_config.json',
  'tokenizer/tokenizer.json',
  'tokenizer/tokenizer_config.json'
)

function Get-Sha256([string] $path) {
  return (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$failed = @()
foreach ($rel in $files) {
  $dest = Join-Path $Out ($rel -replace '/', '\')
  $dir = Split-Path -Parent $dest
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $known = $Hashes[$rel]

  # ── 已在：只校验 ─────────────────────────────────────────────────────────
  if (Test-Path $dest) {
    $actual = Get-Sha256 $dest
    if ($known -ne '' -and $actual -ne $known) {
      Write-Warning "$rel 的哈希不符：`n  实际 $actual`n  期望 $known"
      $failed += $rel
    } else {
      Write-Host "✔ $rel 已在（$([math]::Round((Get-Item $dest).Length / 1MB, 1)) MB）" -ForegroundColor Green
    }
    continue
  }

  if ($VerifyOnly) {
    Write-Warning "$rel 不存在"
    $failed += $rel
    continue
  }

  # ── 下载 ─────────────────────────────────────────────────────────────────
  # 只取 HTTPS 直链、不跟到别的域：模型文件不该经过第三方跳转。
  $url = "$BaseUrl/$rel"
  Write-Host "↓ $rel" -ForegroundColor Cyan
  try {
    Invoke-WebRequest -Uri $url -OutFile $dest -MaximumRedirection 5 -TimeoutSec 300 -UseBasicParsing
  } catch {
    throw "下载失败：$url`n$($_.Exception.Message)"
  }

  $actual = Get-Sha256 $dest
  if ($known -ne '' -and $actual -ne $known) {
    # 哈希不符时删掉半成品：留着一个"看起来下完了"的坏文件，下次会静默复用。
    Remove-Item -Path $dest
    throw "$rel 下载后哈希不符（期望 $known，实际 $actual）。已删除该文件，请重下。"
  }
  if ($known -eq '') {
    Write-Host "  （这个文件没有钉哈希：记下来填进 -Hashes）$actual" -ForegroundColor Yellow
  }
}

if ($failed.Count -gt 0) {
  Write-Error "校验未通过：$($failed -join ', ')"
  exit 1
}

Write-Host "`n模型目录就绪：$Out" -ForegroundColor Green
Write-Host '下一步：\build-scorer.ps1 -ModelDir 这个目录 -LlamaBuild <llama.cpp 构建目录>' -ForegroundColor Cyan
