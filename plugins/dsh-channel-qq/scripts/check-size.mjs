/**
 * 体量检查（自写）：文件行数与函数长度的**棘轮**。
 *
 * 为什么是棘轮而不是硬闸门：`bridge.ts` 1282 行、`tools.ts` 1293 行，硬套
 * "单文件 ≤ 400 行"只会让 `npm run verify` 永远红着，然后被无视。棘轮的做法是
 * ——**只禁止变大**：记下当前每个超标文件和超标函数的数值，之后任何一次改动都不
 * 允许超过记录值；重构拆小时用 `--update` 把新值落账。于是"每个阶段都不得让结构
 * 变差"变成一条可执行、且当下就绿的规则。
 *
 * 函数长度用 TypeScript 自己的解析器量（`typescript` 已在 devDependencies，
 * 不引入新依赖）：正则数花括号会被字符串、注释、模板字面量骗到，而语法树不会。
 *
 * 用法：
 *   node scripts/check-size.mjs            # 检查
 *   node scripts/check-size.mjs --update   # 把当前数值写进基线（只应在结构变好之后跑）
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')
const BASELINE_PATH = path.join(ROOT, 'scripts', 'size-baseline.json')
const update = process.argv.includes('--update')

/** 硬上限：新文件、新函数不得超过这里。 */
const MAX_FILE_LINES = 400
const MAX_FUNCTION_LINES = 60

/**
 * 基线之上允许的容差。
 *
 * 没有容差的棘轮是脆的：加一行判空、补一段注释就会红，然后人会去改基线，棘轮就松了。
 * 有容差才能真正只抓**结构性增长**——往 `tools.ts` 里塞一个新工具（几十行）必然超标，
 * 而修一个类型收窄不会。容差是"编辑许可"，不是"可以慢慢胖 15 行"：每次重构收尾时
 * 应跑 `--update` 把基线收紧回实际值。
 */
const FILE_TOLERANCE = 15
const FUNCTION_TOLERANCE = 5

/** 生成物不算：它是 `admin-ui.html` 的逐行 JSON 编码，没有人工结构可言。 */
const GENERATED = new Set(['src/admin-html.ts'])

function listSources(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) { out.push(...listSources(full)); continue }
    if (entry.endsWith('.ts')) out.push(path.relative(ROOT, full).split(path.sep).join('/'))
  }
  return out.sort()
}

/** 一个节点的行跨度（含首尾行）。 */
function spanOf(sf, node) {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1
  return end - start + 1
}

/** 函数体为空/单行的（接口实现、转发器）不算长度问题。 */
function hasRealBody(node, sf) {
  const body = node.body
  if (body === undefined) return false
  if (body.kind === ts.SyntaxKind.Block) return body.statements.length > 0
  return spanOf(sf, node) > 1
}

/** 收集一个文件里所有"有名字的"函数与方法，按其行跨度排序。 */
function functionsOf(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found = []
  const visit = (node, owner) => {
    let name = owner
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) name = node.name.text
    else if (ts.isMethodDeclaration(node) && node.name !== undefined) name = `${owner}.${node.name.getText(sf)}`
    else if (ts.isConstructorDeclaration(node)) name = `${owner}.constructor`
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node))
      && hasRealBody(node, sf)) {
      found.push({ key: `${file}::${name}`, lines: spanOf(sf, node) })
    }
    const nextOwner = ts.isClassDeclaration(node) && node.name !== undefined ? node.name.text : owner
    ts.forEachChild(node, (child) => visit(child, nextOwner))
  }
  visit(sf, '<module>')
  return found
}

const files = listSources(SRC).filter((f) => !GENERATED.has(f))
const fileLines = new Map()
const functionLines = new Map()
for (const file of files) {
  const text = readFileSync(path.join(ROOT, file), 'utf8')
  fileLines.set(file, text.split('\n').length)
  for (const fn of functionsOf(file, text)) {
    // 同名重载/嵌套只保留最长的那个，键唯一即可。
    const prev = functionLines.get(fn.key)
    if (prev === undefined || fn.lines > prev) functionLines.set(fn.key, fn.lines)
  }
}

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  : { files: {}, functions: {} }
const baseFiles = baseline.files ?? {}
const baseFunctions = baseline.functions ?? {}

if (update) {
  const overFiles = {}
  for (const [file, lines] of [...fileLines].sort()) if (lines > MAX_FILE_LINES) overFiles[file] = lines
  const overFunctions = {}
  for (const [key, lines] of [...functionLines].sort()) if (lines > MAX_FUNCTION_LINES) overFunctions[key] = lines
  writeFileSync(BASELINE_PATH, JSON.stringify({
    note: `体量棘轮基线：基线之上只给 / 行容差，硬上限  行/文件、 行/函数。见 scripts/check-size.mjs。`,
    updatedAt: new Date().toISOString().slice(0, 10),
    limits: { file: MAX_FILE_LINES, function: MAX_FUNCTION_LINES, fileTolerance: FILE_TOLERANCE, functionTolerance: FUNCTION_TOLERANCE },
    files: overFiles,
    functions: overFunctions,
  }, null, 2) + '\n')
  console.log(`已更新基线：超标文件 ${Object.keys(overFiles).length} 个、超标函数 ${Object.keys(overFunctions).length} 个`)
  process.exit(0)
}

const problems = []
for (const [file, lines] of fileLines) {
  const allowed = baseFiles[file]
  if (allowed === undefined) {
    if (lines > MAX_FILE_LINES) problems.push(`${file}: ${lines} 行，超过硬上限 ${MAX_FILE_LINES}`)
    continue
  }
  if (lines > allowed + FILE_TOLERANCE) {
    problems.push(`${file}: ${lines} 行，基线 ${allowed} + 容差 ${FILE_TOLERANCE}`)
  }
}
for (const [key, lines] of functionLines) {
  const allowed = baseFunctions[key]
  if (allowed === undefined) {
    if (lines > MAX_FUNCTION_LINES) problems.push(`${key}: ${lines} 行，超过硬上限 ${MAX_FUNCTION_LINES}`)
    continue
  }
  if (lines > allowed + FUNCTION_TOLERANCE) {
    problems.push(`${key}: ${lines} 行，基线 ${allowed} + 容差 ${FUNCTION_TOLERANCE}`)
  }
}

// 拆小了就该落账，否则基线会一直虚高，棘轮也就松了。
const improved = []
for (const [file, allowed] of Object.entries(baseFiles)) {
  const lines = fileLines.get(file)
  if (lines === undefined || lines < allowed) improved.push(`${file}: ${allowed} → ${lines ?? '(已删除)'}`)
  }
for (const [key, allowed] of Object.entries(baseFunctions)) {
  const lines = functionLines.get(key)
  if (lines === undefined || lines < allowed) improved.push(`${key}: ${allowed} → ${lines ?? '(已删除)'}`)
}

const overFileCount = [...fileLines.values()].filter((n) => n > MAX_FILE_LINES).length
const overFnCount = [...functionLines.values()].filter((n) => n > MAX_FUNCTION_LINES).length
console.log(
  `check-size: ${files.length} 个文件（${overFileCount} 个超过 ${MAX_FILE_LINES} 行）、`
  + `${functionLines.size} 个函数（${overFnCount} 个超过 ${MAX_FUNCTION_LINES} 行）`,
)
if (improved.length > 0) {
  console.log(`提示：这些已经变小，跑 --update 收紧基线会让棘轮更紧：`)
  for (const line of improved.slice(0, 15)) console.log('  ' + line)
  if (improved.length > 15) console.log(`  …还有 ${improved.length - 15} 项`)
}

if (problems.length === 0) {
  console.log('check-size: 通过（没有任何文件或函数比基线更大）')
  process.exit(0)
}
console.error(`check-size: ${problems.length} 处回退`)
for (const p of problems) console.error('  ' + p)
console.error('若这是重构中间态、且最终会更小，请不要 --update 蒙过去；先把它拆完。')
process.exit(1)
