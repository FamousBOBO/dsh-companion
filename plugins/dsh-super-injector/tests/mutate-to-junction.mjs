#!/usr/bin/env node
/**
 * 变异注入器：把 scripts/build.sh 里 use_pkg 的 cpSync 换回 symlinkSync。
 * 用途：验证 P0-A 回归测试「真的能失败」（变异测试）。
 *
 * 用法：node tests/mutate-to-junction.mjs <apply|revert>
 *   apply  → 注入变异（原文件备份到 build.sh.mutation-orig）
 *   revert → 从备份还原
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET = path.join(ROOT, 'scripts', 'build.sh')
const BACKUP = path.join(ROOT, 'scripts', 'build.sh.mutation-orig')

const action = process.argv[2] ?? 'apply'

/**
 * 精确匹配 use_pkg 里那段 cpSync。
 *
 * ⚠️ 必须容忍行尾差异（实测踩坑）：build.sh 在 Windows 上是 CRLF（git autocrlf），
 * 而内嵌的 node -e 块又可能是 LF —— 用固定字符串会匹配失败，导致变异测试
 * 静默"没变异"，进而产出「测试抓不住」的**假结论**。故用 \r?\n 宽松匹配。
 */
const CP_SYNC_RE =
  /fs\.cpSync\(src, dst, \{\r?\n\s*recursive: true,\r?\n\s*dereference: false,\r?\n\s*filter: \(s\) => path\.basename\(s\) !== 'node_modules',\r?\n\s*\}\);/

const JUNCTION_BLOCK =
  'fs.symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");'

if (action === 'apply') {
  const src = fs.readFileSync(TARGET, 'utf8')
  if (!CP_SYNC_RE.test(src)) {
    console.error('✗ 未匹配到 use_pkg 的 cpSync 块 —— 实现已变，请同步本工具')
    process.exit(1)
  }
  fs.copyFileSync(TARGET, BACKUP)
  fs.writeFileSync(TARGET, src.replace(CP_SYNC_RE, JUNCTION_BLOCK), 'utf8')
  const after = fs.readFileSync(TARGET, 'utf8')
  console.log(`✓ 已注入变异（备份 → ${path.basename(BACKUP)}）`)
  console.log(`  cpSync=${(after.match(/cpSync/g) ?? []).length}  symlinkSync=${(after.match(/symlinkSync/g) ?? []).length}`)
} else if (action === 'revert') {
  if (!fs.existsSync(BACKUP)) {
    console.error('✗ 没有备份可还原')
    process.exit(1)
  }
  fs.copyFileSync(BACKUP, TARGET)
  fs.rmSync(BACKUP, { force: true })
  const after = fs.readFileSync(TARGET, 'utf8')
  console.log('✓ 已还原')
  console.log(`  cpSync=${(after.match(/cpSync/g) ?? []).length}  symlinkSync=${(after.match(/symlinkSync/g) ?? []).length}`)
} else {
  console.error('用法: node tests/mutate-to-junction.mjs <apply|revert>')
  process.exit(1)
}
