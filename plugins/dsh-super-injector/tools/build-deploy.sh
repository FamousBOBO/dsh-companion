#!/bin/bash
# 构建并部署修复后的注入器（copy-based link_pkg）
#
# ══ 🔴 v0.3.6 修（**这个脚本自己差一点发出去一个坏产物**）════════════════════
# 病案（2026-10-17 实测）：旧脚本第 43 行只拷**一个文件**：
#     cp "$SRC/lib/index.js" "$LIVE/lib/index.js"
#   而我这次把决策逻辑抽到了 `src/watch-dangle.ts` ⇒ 产物变**两个文件**
#   ⇒ 旧脚本会把 `index.js` 拷过去，而 `watch-dangle.js` **落在源目录**
#   ⇒ `index.js` 里那句顶层 `import './watch-dangle.js'` **解析失败**
#   ⇒ **注入器整个加载不了**。
#
# ⚠️ 为什么这个 bug 特别危险：**注入器挂了就是「谁来修修理工」** ——
#   它自己的重载器也依赖它自己。上一轮我刚因为一个测试夹具打瘫过整个会话，
#   这次若是注入器本体挂掉，连"用注入器修回来"这条路都没了。
#
# ⇒ 修法（**构造上不可能漏**，而不是"记得拷两个"）：
#   ① 拷**整个 lib/ 目录**（不是逐个文件）
#   ② 部署后**校验**：源里每个 .js 都在目标里，且逐个 `node --check`
#   ③ 再跑一次**真 import**（能加载才算数）—— 这才是"没坏"的判据
#   ⚠️ 判据：**"记得同步"是纪律，「目录整体拷贝 + 逐个校验」是构造** ——
#     纪律会被忘，构造不会。
set -uo pipefail
export PATH="/d/app/Modex-MH-Agent/runtime/node:$PATH"

SRC="/f/dsh-plugin/dsh-super-injector"
CK="/c/Users/Administrator/.dsh/super-injector/checkout"
LIVE="/d/dsh/super-injector"

echo "=== 1) 编译 host（tsc，用隔离 checkout）==="
cd "$SRC" || exit 1
TSC="$CK/node_modules/.bin/tsc.cmd"
[ -x "$TSC" ] || TSC="$CK/node_modules/.bin/tsc"
echo "tsc = $TSC"

# 构建期依赖：copy 到项目内 node_modules（不碰源）
node -e "
const fs=require('fs'),path=require('path');
const CK=process.argv[1], SRC=process.argv[2];
const pairs=[['@deepseek-ai/cordis','vendor/cordis'],['cosmokit','vendor/cosmokit'],['@deepseek-ai/schemastery','vendor/schemastery'],['@deepseek-ai/dsh-tools','packages/core/tools'],['@deepseek-ai/dsh-llm','packages/llm/llm'],['@deepseek-ai/dsh-system-prompt','packages/core/system-prompt'],['@types/node','node_modules/@types/node']];
for(const [name,rel] of pairs){
  const src=path.join(CK,rel), dst=path.join(SRC,'node_modules',...name.split('/'));
  if(!fs.existsSync(src)){ console.log('  MISS src '+src); continue }
  try{ const st=fs.lstatSync(dst); if(st.isSymbolicLink()) fs.rmdirSync(dst); else fs.rmSync(dst,{recursive:true,force:true}) }catch{}
  fs.mkdirSync(path.dirname(dst),{recursive:true});
  fs.cpSync(src,dst,{recursive:true,dereference:false,filter:(s)=>path.basename(s)!=='node_modules'});
  console.log('  ✓ '+name);
}
" "$CK" "$SRC" 2>&1

echo
echo "=== 2) tsc 编译 ==="
"$TSC" -p tsconfig.json 2>&1 | tail -25
echo "tsc exit=${PIPESTATUS[0]}"

if [ ! -f "$SRC/lib/index.js" ]; then echo "✗ lib/index.js 未生成"; exit 1; fi
echo "lib/index.js 大小: $(stat -c%s "$SRC/lib/index.js") 字节"

echo
echo "=== 2b) 产物逐个语法检查（**所有 .js，不止入口**）==="
bad=0
for f in "$SRC"/lib/*.js; do
  if node --check "$f" 2>/dev/null; then
    printf '  ✓ %s (%s 字节)\n' "$(basename "$f")" "$(stat -c%s "$f")"
  else
    printf '  ✗ %s 语法错误\n' "$(basename "$f")"; bad=1
  fi
done
[ "$bad" = 0 ] || { echo "✗ 产物有语法错误，拒绝部署"; exit 1; }

echo
echo "=== 3) 部署：拷**整个 lib/ 目录**（不是逐个文件）==="
mkdir -p "$LIVE/lib"
# ⚠️ 先删旧的 .js（防源里删掉的文件在目标里**残留**成孤儿）
for f in "$LIVE"/lib/*.js; do [ -e "$f" ] && rm -f "$f"; done
cp "$SRC"/lib/*.js "$LIVE/lib/"
echo "已部署到 $LIVE/lib："
for f in "$LIVE"/lib/*.js; do printf '  %s (%s 字节)\n' "$(basename "$f")" "$(stat -c%s "$f")"; done

echo
echo "=== 4) 部署完整性校验（源⊆目标，且逐字节相同）==="
miss=0
for f in "$SRC"/lib/*.js; do
  b="$(basename "$f")"
  if [ ! -f "$LIVE/lib/$b" ]; then printf '  ✗ 缺 %s（源里有、目标没有）\n' "$b"; miss=1
  elif ! cmp -s "$f" "$LIVE/lib/$b"; then printf '  ✗ %s 内容不一致\n' "$b"; miss=1
  else printf '  ✓ %s\n' "$b"; fi
done
[ "$miss" = 0 ] || { echo "✗ 部署不完整（**这正是旧脚本会漏的那个 bug**）—— 请勿重启，先修"; exit 1; }
echo "  ⇒ 源 $SRC/lib 的每个 .js 都已到位且一致"

echo
echo "=== 5) 加载冒烟（**能 import 才算数**）==="
# ⚠️ 判据：光"文件在"不够 —— 顶层 import 解析失败时，文件也好好的。
#   所以必须**真 import 一次**，让模块图完整求值。
node -e "
import('file:///D:/dsh/super-injector/lib/index.js')
  .then(m => { console.log('  LOAD OK:', Object.keys(m).join(',')); process.exit(0) })
  .catch(e => { console.log('  LOAD FAIL:', String(e).slice(0,300)); process.exit(1) })
" 2>&1
loadrc=$?
[ "$loadrc" = 0 ] || { echo "✗ 加载失败 —— **不要重启**（重启后注入器起不来，没人能修它）"; exit 1; }

echo
echo "✅ 部署完成且校验通过（含依赖文件完整性 + 真加载冒烟）"
