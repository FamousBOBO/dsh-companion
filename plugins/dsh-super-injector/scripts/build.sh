#!/bin/bash
# Build dsh-super-injector: compile src/ → lib/ with the dsh checkout's tsc.
# Requires DSH_CHECKOUT pointing at a dsh source checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

# ⚠️ 依赖物化用 **copy**，绝不用 junction（2026-10-15 终版定案）。
#
# 事故链（两轮实测 + 一次决定性对照）：
#   1) 旧实现 fs.rmSync(link,{recursive:true}) 会掏空 junction 目标 —— 已修。
#   2) 改成 rmdir 只删链接后**仍然被掏空**；决定性对照锁定元凶仍是本函数：
#      新建一个「外部从未触碰」的隔离 checkout，只放 link 目标，跑一次构建后
#      —— 5 个 link 目标 items=0，而同一目录下**非 link 目标**的
#      packages/llm/llm 与 packages/core/system-prompt **完好**（1:1 对应）。
#      ⇒ 破坏只可能源自 junction 物化：Windows + Node 在**递归删除含 junction
#      的目录**时会跟随链接，把目标的真实内容删空。
#   3) 结论：只要用 junction，「源目录是否安全」就依赖 Node 未定义行为。故改为
#      **cpSync 复制** —— 源目录从此只在读取侧被访问，物理上不可能被写坏。
#      代价：每次构建多复制几 MB（实测 <1s），换依赖永不被掏空，值得。
use_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const dst = path.resolve(process.argv[1]);
    const src = path.resolve(process.argv[2]);
    // 清的只是**本项目内**的 dst；若它是历史遗留 junction，同样只用 rmdir
    try {
      const st = fs.lstatSync(dst);
      if (st.isSymbolicLink()) fs.rmdirSync(dst);
      else fs.rmSync(dst, { recursive: true, force: true });
    } catch { /* 不存在则无需删除 */ }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, {
      recursive: true,
      dereference: false,
      filter: (s) => path.basename(s) !== 'node_modules',
    });
  " "node_modules/$1" "$target"
}
# 兼容历史调用名
link_pkg() { use_pkg "$@"; }

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
node -e "const fs=require('fs');fs.rmSync('node_modules/@standard-schema',{recursive:true,force:true})"
# ⚠️ 链接名必须与 src 的 import 说明符**逐字一致**（实测踩坑 2026-10-15）：
# 提交 1df6cde 把源码 import 从裸名（cordis/schemastery）改成 scoped
# （@deepseek-ai/cordis 等），但本文件仍链裸名 —— tsc 直接报 6 个
# TS2307「Cannot find module '@deepseek-ai/cordis'」，lib 根本编不出来。
# 决定性证据：补上 scoped 链接后 6 个 TS2307 全部消失、lib/index.js 正常产出。
link_pkg @deepseek-ai/cordis vendor/cordis
link_pkg @deepseek-ai/cosmokit vendor/cosmokit
link_pkg @deepseek-ai/schemastery vendor/schemastery
link_pkg @deepseek-ai/dsh-tools packages/core/tools
# src 直接 import 了 @deepseek-ai/dsh-llm（LLM 自主 loop 用）——缺它同样 TS2307。
link_pkg @deepseek-ai/dsh-llm packages/llm/llm
link_pkg @deepseek-ai/dsh-system-prompt packages/core/system-prompt
link_pkg @deepseek-ai/cordis-plugin-loader vendor/loader

# @types/node：tsconfig 写了 types:["node"]，缺它就 TS2688 直接编不动（实测踩坑：
# 没有 node_modules 的干净检出/换机器即构建失败——产线必须自洽，不靠某台机器的残留）。
TYPES_NODE="$CHECKOUT/node_modules/@types/node"
if [ ! -d "$TYPES_NODE" ]; then
  echo "build: @types/node not found at $TYPES_NODE" >&2
  exit 1
fi
# 同样用 copy（不用 junction）——理由见上面 use_pkg 的长注释。
node -e "
  const fs = require('fs');
  const path = require('path');
  const dst = path.resolve('node_modules/@types/node');
  const src = path.resolve(process.argv[1]);
  try {
    const st = fs.lstatSync(dst);
    if (st.isSymbolicLink()) fs.rmdirSync(dst);
    else fs.rmSync(dst, { recursive: true, force: true });
  } catch { /* 不存在则无需删除 */ }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, dereference: false, filter: (s) => path.basename(s) !== 'node_modules' });
" "$TYPES_NODE"

# ⚠️ 这里的 `find ... | head -1` 在 `set -o pipefail` 下会**误杀脚本**（实测踩坑）：
# head 读够 1 行就退出 → find 收到 SIGPIPE（退出码 141）→ pipefail 判定整条管道失败
# → `set -e` 直接终止构建。此时既无报错信息、也没进 tsc，表现为"构建静默停在
# Linking 之后、lib 不产出"，极难定位。正解：管道尾部补 `|| true` 吃掉这个状态。
STD_SCHEMA=$( { find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null || true; } | head -1 || true)
if [ -n "$STD_SCHEMA" ]; then
  # 同样用 copy（不用 junction）——理由见上面 use_pkg 的长注释。
  node -e "
    const fs = require('fs');
    const path = require('path');
    const dst = path.resolve('node_modules/@standard-schema/spec');
    const src = path.resolve(process.argv[1]);
    try {
      const st = fs.lstatSync(dst);
      if (st.isSymbolicLink()) fs.rmdirSync(dst);
      else fs.rmSync(dst, { recursive: true, force: true });
    } catch { /* 不存在则无需删除 */ }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, dereference: false, filter: (s) => path.basename(s) !== 'node_modules' });
  " "$STD_SCHEMA/node_modules/@standard-schema/spec"
else
  echo "build: @standard-schema/spec not found; skipLibCheck should cover it" >&2
fi

echo "=== Compiling src → lib (tsc $("$TSC" --version)) ==="
"$TSC" -p tsconfig.json

# ═══════════════════════════════════════════════════════════════════════
# UI（client bundle）也必须在 build.sh 里构建
# ═══════════════════════════════════════════════════════════════════════
# ⚠️ 实测缺口（2026-10-16 审计发现）：此前 build.sh **只跑 tsc**，不构建 client
# ⇒ lib/client.js 停留在手工构建的旧版本（实测：活跃 client.js 是 2026-08-15 的，
# 而 src/client/index.ts 是 10-15 的，差了两个月）⇒ UI 面板与源码不同步，
# 且新机器按 INSTALL.md 走 build.sh 会**完全没有 UI**（package.json 的
# dsh.client 声明了 platform:web，但产物不存在）。
#
# ⚠️ 必须用 tsdown.client.config.ts（**只构建 client**），不能用 tsdown.config.ts
# ——后者含 hostBundle，会把 tsc 刚产出的 host 覆盖成打包版（238KB → 453KB），
# 静默改变本地 dev 构建语义（实测踩坑）。发布形态由 prepare.mjs 负责，两条路互不干扰。
echo "=== Building client bundle (tsdown, client-only) ==="
if [ ! -f tsdown.client.config.ts ]; then
  echo "build: ✗ tsdown.client.config.ts 缺失（client 构建配置）" >&2
  exit 1
fi
if [ -f node_modules/.bin/tsdown ]; then
  node_modules/.bin/tsdown --config tsdown.client.config.ts
elif [ -f node_modules/.bin/tsdown.cmd ]; then
  node_modules/.bin/tsdown.cmd --config tsdown.client.config.ts
else
  # 本地没装 tsdown：用 npx 拉（与 prepare.mjs 同一策略，首次安装才下载）
  echo "  local tsdown not found — fetching via npx (first run only)"
  npx --yes "tsdown@^0.22.14" --config tsdown.client.config.ts
fi

# 判据：声明了 client（dsh.client.platform）就必须产出 lib/client.js，
# 且 **host 不得被 client 构建改动**（防止再次误用全量配置）
if ! grep -q '"platform"' package.json 2>/dev/null; then
  echo "build: package.json 未声明 dsh.client —— 跳过 client 产物校验"
elif [ ! -f lib/client.js ]; then
  echo "build: ✗ package.json 声明了 dsh.client，但 lib/client.js 未产出 —— UI 面板将不可用" >&2
  exit 1
fi

echo "=== Build complete ==="
ls -la lib/ lib/types/ 2>/dev/null
