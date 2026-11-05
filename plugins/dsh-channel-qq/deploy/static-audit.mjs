/**
 * Static audit of the plugin source.
 *
 * Finds the defect classes no runtime test catches, and which leave features the
 * operator believes are live:
 *
 *   A. 死配置 — a config field that is declared (so it is rendered in the admin
 *      panel and looks live) but never *read*. `requireMention` was exactly this.
 *   A3 does the same for sub-config sections.
 *   B. 幽灵字段 — code reading `config.foo.bar` where the declaration has no
 *      `bar` (typo or removed field) => always `undefined` at runtime.
 *   C. 断链导入 — an imported symbol the target module does not export.
 *   D. 孤儿导出 — exported but called from nowhere (possible half-finished work).
 *
 * v2 fixes the false positives that made v1 useless:
 *   - `import { type X }` no longer reported as a broken import (strip `type`).
 *   - alias tracking: `const s = this.config.morningReport; s.enabled` counts as a
 *     read, as does destructuring `const { enabled } = config.morningReport`.
 *   - section B requires the access to be on the config object or a known alias,
 *     so a *service* named `emoji` (`emoji.init()`) is no longer a ghost field.
 *
 * v3 (P4.7) makes it see the post-refactor tree:
 *   - **recursive**: v2 read `readdir(srcDir)` only, i.e. *top-level* files. Once
 *     P3/P4 moved code into `core/ app/ features/ adapters/`, most readers of a
 *     config field lived in a subdirectory the audit never opened — so A3 reported
 *     `stt.apiKey`, `batching.windowMs`, `poke.enabled` … as dead config when they
 *     are read on every message. A false "dead config" is worse than no audit:
 *     it is the report an operator deletes the feature over.
 *   - imports are resolved relative to the *importing* file (`'../config.js'` from
 *     `core/batching.ts` → `config.ts`), and directory targets fall back to
 *     `index.ts`.
 *   - D counts references across the whole repo (`test/ scripts/ deploy/` too).
 *     Counting only `src` reported every test-only export (`__setBackendForTest`)
 *     as half-finished work.
 *
 * Usage: node static-audit.mjs <srcDir>
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

const srcDir = process.argv[2] ?? 'src'
// 后台 UI 是原生 ES 模块（`.js`，无构建工具），所以源码扫描要连 `.js` 一起收。
const SRC_EXT = ['.ts', '.js']
const ANY_EXT = ['.ts', '.mjs', '.js', '.md']

/** Every file with one of `exts` under `dir`, keyed by its path relative to `dir`. */
async function walk(dir, prefix = '', exts = SRC_EXT) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = `${prefix}${entry.name}`
    if (entry.isDirectory()) out.push(...await walk(path.join(dir, entry.name), `${rel}/`, exts))
    else if (exts.some(e => entry.name.endsWith(e))) out.push(rel)
  }
  return out
}

const files = (await walk(srcDir)).sort((a, b) => a.localeCompare(b))
const text = new Map()
for (const f of files) text.set(f, await fs.readFile(path.join(srcDir, f), 'utf8'))
const joined = [...text.entries()]

/**
 * Everything outside `src` that may name an export: tests, probe scripts, deploy
 * scripts, docs. Only used to answer "is this name referenced anywhere?" — never
 * to derive config reads, which are `src`-only by definition.
 */
const beyond = []
for (const root of ['test', 'scripts', 'deploy', 'docs']) {
  for (const f of await walk(root, '', ANY_EXT)) {
    beyond.push([`${root}/${f}`, await fs.readFile(`${root}/${f}`, 'utf8')])
  }
}
// Root-level files only (`*.mjs` probes, README/HANDOVER markdown).
for (const entry of await fs.readdir('.', { withFileTypes: true })) {
  if (entry.isFile() && ANY_EXT.some(e => entry.name.endsWith(e))) {
    beyond.push([entry.name, await fs.readFile(entry.name, 'utf8')])
  }
}

const cfgSrc = text.get('config.ts')
if (cfgSrc === undefined) { console.error('config.ts not found in ' + srcDir); process.exit(2) }

/**
 * Resolve a relative import specifier to a key in `text`; null when it points
 * outside the tree (or at a non-`.ts` asset the audit has nothing to say about).
 *
 * Our sources import with explicit `.js` (ESM/tsc), which maps 1:1 onto the `.ts`
 * beside it. A directory target is also accepted in case one is ever written.
 */
function resolveKey(fromFile, spec) {
  const base = path.posix.join(path.posix.dirname(fromFile), spec).replace(/\.js$/, '.ts')
  if (text.has(base)) return base
  return text.has(`${base}/index.ts`) ? `${base}/index.ts` : null
}

/** `export interface X { ... }` -> Map<name, Map<field, type>> */
function parseInterfaces(src) {
  const out = new Map()
  const re = /export interface (\w+)\s*(?:extends[^{]*)?\{([\s\S]*?)\n\}/g
  let m
  while ((m = re.exec(src)) !== null) {
    const fields = new Map()
    for (const line of m[2].split('\n')) {
      if (/^\s*(\*|\/\/)/.test(line)) continue
      const f = line.match(/^\s*(?:readonly\s+)?(\w+)\??\s*:\s*(.+?)\s*$/)
      if (f === null) continue
      fields.set(f[1], f[2].replace(/\/\/.*$/, '').trim())
    }
    out.set(m[1], fields)
  }
  return out
}

const interfaces = parseInterfaces(cfgSrc)
const qq = interfaces.get('QQChannelConfig')
if (qq === undefined) { console.error('QQChannelConfig not found'); process.exit(2) }

const NESTED = ['connection', 'segmentation', 'batching', 'injectMode', 'imageRecognition', 'poke',
  'stt', 'groupModel', 'morningReport', 'emoji', 'admin', 'linkResolve', 'meme', 'quotes', 'tts',
  'reminders', 'rss', 'flood', 'imageGen', 'learn', 'eventMonitor', 'contextBudget']

/** Interfaces belonging to a sub-config section (matched by name prefix). */
function ifacesFor(parent) {
  return [...interfaces.keys()].filter(n => n.toLowerCase().startsWith(parent.toLowerCase()))
}

/**
 * Names bound to `config.<parent>` **within one file**, in the two shapes that
 * actually occur:
 *
 *   obj   — `const s = this.config.batching`   => reads look like `s.windowMs`
 *   destr — `const { windowMs } = config.batching` => the *binding itself* is the read
 *
 * Conflating the two made A3 useless in both directions, so they are returned
 * separately. The assignment must also *end* at the parent: without the
 * `(?![.\w])` guard, `const style = config.segmentation.style` recorded `style`
 * as an alias of the `segmentation` section, and then every `style.width` in the
 * admin panel's CSS was reported as a ghost config field.
 */
function bindingsFor(parent, src) {
  const obj = new Set()
  const destr = new Set()
  const end = '(?![.\\w])'
  const root = `(?:this\\.)?(?:\\w+\\s*\\??\\.\\s*)?config\\s*\\??\\.\\s*${parent}${end}`
  for (const m of src.matchAll(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*${root}`, 'g'))) {
    obj.add(m[1])
  }
  for (const m of src.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${root}`, 'g'))) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':').pop()?.trim().replace(/=.*$/, '').trim()
      if (n && /^\w+$/.test(n)) destr.add(n)
    }
  }
  return { obj, destr }
}

const METHODISH = new Set(['length', 'map', 'filter', 'find', 'findIndex', 'join', 'slice', 'includes',
  'push', 'then', 'catch', 'finally', 'replace', 'trim', 'startsWith', 'endsWith', 'split',
  'toLowerCase', 'toUpperCase', 'has', 'get', 'set', 'add', 'values', 'keys', 'entries', 'forEach',
  'some', 'every', 'toString', 'concat', 'at', 'flat', 'flatMap', 'sort', 'test', 'match', 'exec',
  'pop', 'shift', 'unshift', 'splice', 'fill', 'indexOf', 'lastIndexOf', 'repeat', 'padStart',
  'padEnd', 'reverse', 'reduce', 'init', 'start', 'stop', 'dispose', 'relisten', 'refresh', 'name'])

// ── A. top-level dead config ───────────────────────────────────────────────
const reads = new Map()
for (const [file, src] of joined) {
  if (file === 'config.ts') continue
  for (const line of src.split('\n')) {
    if (/^\s*(\*|\/\/)/.test(line)) continue
    for (const f of qq.keys()) {
      if (new RegExp(`[.\\['"]${f}\\b`).test(line)) {
        if (!reads.has(f)) reads.set(f, new Set())
        reads.get(f).add(file)
      }
    }
  }
}
const dead = [...qq.keys()].filter(f => !reads.has(f))
console.log('===== A. 顶层配置字段：无任何读取方（死配置） =====')
console.log(dead.length === 0 ? '  (none)' : dead.map(f => `  ${f}  (${qq.get(f).slice(0, 40)})`).join('\n'))

// ── A3. sub-config dead fields ─────────────────────────────────────────────
console.log('\n===== A3. 子配置字段：声明了但没有被读取 =====')

/**
 * Source with comments and the schema/generated files removed.
 *
 * Shapes 5 and 6 are name-based, so a *comment* mentioning `segmentation` next to
 * an unrelated `enabled:` port would mask a genuinely dead field; and the two
 * files that merely *declare* everything (`config/**` = the schema DSL, plus the
 * generated `admin-html.ts`) would make every field look read.
 */
const stripped = joined
  .filter(([file]) => !file.startsWith('config/') && file !== 'config.ts' && file !== 'admin-html.ts')
  .map(([file, src]) => [file, src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')])

/**
 * bindings[file][parent] = { obj, destr } — built once, per file, so a name
 * bound in one module never leaks into another's report.
 */
const bindingsOf = new Map()
for (const [file, src] of joined) {
  const per = new Map()
  for (const parent of NESTED) per.set(parent, bindingsFor(parent, src))
  bindingsOf.set(file, per)
}

/**
 * Is `<field>` of section `<parent>` read anywhere?
 *
 * Six shapes count, and missing any of them produced a false "dead field":
 *   1. `.parent.field` / `.parent?.field`
 *   2. `objAlias.field` where `const objAlias = config.parent`
 *   3. `field` destructured out of `config.parent`
 *   4. a *typed parameter*: `function f(config: SttConfig)` then `config.apiKey`.
 *      This is the shape stt.ts / imagegen.ts use, and it is why shape 4 exists.
 *   5. **narrow structural port** — the P3/P4 layers take exactly the fields they
 *      need (`deps.batching.maxMessages`, `deps.poke.enabled`) and declare them in
 *      their own interface. The read site then says nothing about `config`, so
 *      shapes 1–4 all miss it and every such field looked dead. A field declared
 *      in *any* `{ ... }` type block counts here.
 *   6. `const poke = this.deps.config().poke` — shape 2's alias, but bound from a
 *      call (`config()` / `configOf()`) rather than the raw config object.
 */
function sectionFieldRead(parent, field) {
  const re = new RegExp(`\\.\\s*${parent}\\s*\\??\\.\\s*${field}\\b`)
  const aliasFromCall = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*[\\w.()\\[\\]]*config\\w*\\(\\)\\s*\\??\\.\\s*${parent}\\b`)
  const portDecl = new RegExp(`(?:readonly\\s+)?${field}\\s*[?:]\\s*[^\\n]*`)
  const ifaceNames = ifacesFor(parent)
  for (const [file, src] of joined) {
    if (re.test(src)) return `${file}: .${parent}.${field}`
    const b = bindingsOf.get(file).get(parent)
    for (const a of b.obj) {
      if (new RegExp(`\\b${a}\\s*\\??\\.\\s*${field}\\b`).test(src)) return `${file}: ${a}.${field}`
    }
    if (b.destr.has(field)) return `${file}: { ${field} } = config.${parent}`
    // shape 4 — only in files that actually name this section's interface
    if (ifaceNames.some(n => new RegExp(`\\b${n}\\b`).test(src))) {
      if (new RegExp(`\\bconfig\\s*\\??\\.\\s*${field}\\b`).test(src)) return `${file}: config.${field} (: ${ifaceNames.join('/')})`
      if (new RegExp(`\\{\\s*[^}]*\\b${field}\\b[^}]*\\}\\s*=`).test(src)) return `${file}: { ${field} } (destructured, interface-typed file)`
    }
    // shape 6 — alias bound from a config accessor call
    const alias = aliasFromCall.exec(src)
    if (alias !== null && new RegExp(`\\b${alias[1]}\\s*\\??\\.\\s*${field}\\b`).test(src)) {
      return `${file}: ${alias[1]}.${field} (= config().${parent})`
    }
    // shape 7 — 整段被当**参数**传出去：`segmentText(text, config.segmentation)`、
    // 或 `{ ...config.segmentation }`。纯函数收下整段（自己声明 `SegmentOptions`）
    // 是常见做法，此时字段名一个都不出现，shapes 1–6 全都看不到——P6h 的
    // `core/text/segment.ts` 就是这样，A3 于是把四个字段报成"死配置"。
    // 只在"参数位置"（后面跟 `,` `)` `}`）才算；`if (config.segmentation)` 这种
    // 光取对象不读字段的写法不算——那才是真该报出来的。
    if (new RegExp(`\\.\\s*${parent}\\s*[,)}]`).test(src)) {
      return `${file}: .${parent} 整段作为参数传给别的函数（字段由对方声明）`
    }
  }
  // shape 5 — a narrow port *for this section* is declared somewhere: the file
  // must mention the section name (outside comments) and declare the field.
  for (const [file, src] of stripped) {
    if (!new RegExp(`\\b${parent}\\b`).test(src)) continue
    if (portDecl.test(src)) return `${file}: 声明在窄接口里（结构性端口）`
  }
  return null
}

let a3 = 0
// An interface used as an *array element type* (`feeds: RssFeedConfig[]`) has its
// fields read per element — `feeds.findIndex(f => f.id === id)` — which no
// `config.<section>.<field>` regex can see. Reporting those as dead config is a
// false positive, so they are listed separately instead.
const elementTypes = new Set()
for (const m of cfgSrc.matchAll(/:\s*(\w+)\[\]/g)) elementTypes.add(m[1])
const elementSkipped = []
const knownDead = []

/**
 * Dead config with an owner — reported once under A3b instead of every run.
 *
 * 目前是**空的**：`segmentation.*` 那五个字段在 P4.6 之后确实没人读（D9 只留了硬切分），
 * 审计如实报了它们一个阶段；**P6h 把它们接回 `qq_send_text` 之后就不该再留在这张表里**
 * ——留着会让"已经接线"的东西继续被当成借口。表本身保留，供下一次"确实有主、但暂时
 * 没人读"的字段登记。
 */
const KNOWN_DEAD = new Map([])

for (const parent of NESTED) {
  for (const n of ifacesFor(parent)) {
    if (elementTypes.has(n)) {
      elementSkipped.push(`${n} (element type of ${parent}.*[])`)
      continue
    }
    for (const [f, t] of interfaces.get(n)) {
      if (METHODISH.has(f)) continue
      if (sectionFieldRead(parent, f) !== null) continue
      const known = KNOWN_DEAD.get(`${parent}.${f}`)
      if (known !== undefined) { knownDead.push(`${parent}.${f}  — ${known}`); continue }
      console.log(`  ${parent}.${f}  (${t.slice(0, 34)})`)
      a3++
    }
  }
}
if (a3 === 0) console.log('  (none)')
if (elementSkipped.length > 0) {
  console.log(`  -- 跳过（数组元素类型，字段按元素读取，点式正则看不到）：${elementSkipped.join(', ')}`)
}
if (knownDead.length > 0) {
  console.log(`\n----- A3b. 已登记的死配置（有主，别再报警，共 ${knownDead.length} 个） -----`)
  for (const line of knownDead) console.log(`  ${line}`)
}

// ── B. ghost sub-fields: config.<parent>.<undeclared> ──────────────────────

/** Dotted file extensions that appear as `name.ext` in strings, not field reads. */
const FILEEXT = new Set(['xml', 'json', 'html', 'htm', 'ts', 'js', 'mjs', 'cjs', 'md', 'txt',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'wav', 'silk', 'mp4', 'yml', 'yaml', 'log', 'zstd'])
console.log('\n===== B. 幽灵字段：config.<子配置>.<未声明字段> =====')
let ghost = 0
for (const parent of NESTED) {
  const declared = new Set()
  for (const n of ifacesFor(parent)) for (const [f] of interfaces.get(n)) declared.add(f)
  if (declared.size === 0) continue
  for (const [file, src] of joined) {
    // Only accesses rooted at the config object, or at a name bound in THIS file.
    const roots = [
      `(?:this\\.)?config\\s*\\??\\.\\s*${parent}`,
      ...[...bindingsOf.get(file).get(parent).obj].map(a => a.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&')),
    ]
    for (const root of roots) {
      const re = new RegExp(`\\b${root}\\s*\\??\\.\\s*(\\w+)`, 'g')
      let m
      while ((m = re.exec(src)) !== null) {
        const f = m[1]
        // A dotted *filename* (`rss.xml`, `index.json`) is not a field access.
        if (declared.has(f) || METHODISH.has(f) || FILEEXT.has(f)) continue
        const label = root.replace(/\(\?:this\\\.\)\?/, '').replace(/\\s\*\\\?\?\\\.\\s\*/, '.').replace(/\\s\*/g, '')
        console.log(`  ${file}: ${label}.${f} — 未在 ${ifacesFor(parent).join('/')} 声明`)
        ghost++
      }
    }
  }
}
if (ghost === 0) console.log('  (none)')

// ── C. broken imports ─────────────────────────────────────────────────────
console.log('\n===== C. 断链导入：import 的名字在目标模块里没有导出 =====')
const exportsOf = new Map()
for (const [file, src] of joined) {
  const set = new Set()
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g)) set.add(m[1])
  for (const m of src.matchAll(/export\s+(?:type|interface)\s+(\w+)/g)) set.add(m[1])
  // `export type { X } from` 也是导出（P5 的配置模块大量用它）——少了 (?:type\s+)?
  // 会把每一处 `import type { X } from './y.js'` 误报成"目标未导出"。
  for (const m of src.matchAll(/export\s*(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) set.add(name)
    }
  }
  exportsOf.set(file, set)
}
let broken = 0
for (const [file, src] of joined) {
  // Comment lines are not imports: `config.ts` explains the re-export with a
  // literal `import { ... } from './config.js'` in prose, which v2 flagged as a
  // broken import of a symbol called `...`.
  const code = src.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n')
  for (const m of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    if (!m[2].startsWith('.')) continue
    const target = resolveKey(file, m[2])
    const avail = target === null ? undefined : exportsOf.get(target)
    if (avail === undefined) continue
    for (const w of m[1].split(',')) {
      // `type X` and `X as Y` both name the *source* symbol X
      const name = w.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (name === '') continue
      if (!avail.has(name)) { console.log(`  ${file}: import { ${name} } from '${m[2]}' — 目标未导出`); broken++ }
    }
  }
}
if (broken === 0) console.log('  (none)')

// ── D. orphan exports ─────────────────────────────────────────────────────
// Split by *where* the name is used. "Used only in its own module" is normal for
// a helper that happens to be exported (the audit must not cry wolf); "used
// nowhere at all" is the real smell.
console.log('\n===== D. 导出但全仓库零引用（疑似半成品） =====')
const TYPEISH = /(Config|Options|State|Entry|Record|Event|Hit|Result|Handle|Spec|Service|Listener|Snapshot|Info|Item|Deps|Block|Id|Like|Source|Repeat|Provider|VoiceOption)$/
/**
 * Exports the plan declares **ahead of** their consumer, with why.
 *
 * `ports/providers.ts` is the seam [04 §2] puts between `features/` and the
 * provider implementations. P4.4 landed the implementations in
 * `adapters/providers/`; the features still call those directly (P4 is
 * "no behavior change"), so the wiring is P6's. Listing them here keeps the
 * report honest — this is the one place that says "no consumer yet".
 */
const SEAMS = new Map([
  ['ports/providers.ts', 'P4.4 落实现、P6 接 features（04 §2 / 05 §能力提供者）'],
])
const seamHits = []
const ownOnly = []
let uncalled = 0
for (const [file, set] of exportsOf) {
  // 生成物不算：`admin-html.ts` 是把 29 个 UI 模块拼成一个字符串，在里面按文件
  // 统计引用数没有意义（原始模块自己会被扫到）。
  if (file === 'admin-html.ts') continue
  for (const name of set) {
    if (name === 'default' || TYPEISH.test(name)) continue
    // Count occurrences, not files: a helper used four times in its own module
    // is module-local, not orphaned. (Counting files made every such helper look
    // unused and turned this section into noise.)
    let ownOcc = 0
    let otherOcc = 0
    for (const [f2, s2] of joined) {
      const n = (s2.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
      if (f2 === file) ownOcc += n
      else otherOcc += n
    }
    // Tests, scripts and docs count as callers: an export used only by
    // `test/agent-gateway.test.ts` is exercised, not half-finished.
    for (const [, s2] of beyond) otherOcc += (s2.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
    if (otherOcc > 0) continue
    if (SEAMS.has(file)) { seamHits.push(`${file}: ${name}  — ${SEAMS.get(file)}`); continue }
    if (ownOcc <= 1) { console.log(`  ${file}: ${name}  — 除声明处外零引用`); uncalled++ }
    else ownOnly.push(`${file}: ${name}`)
  }
}
if (uncalled === 0) console.log('  (none)')
console.log(`\n----- D1. 计划内接缝（先声明、消费者在后续阶段，共 ${seamHits.length} 个） -----`)
for (const line of seamHits) console.log(`  ${line}`)
console.log(`\n----- D2. 仅在本模块内使用（导出但未形成跨模块接口，共 ${ownOnly.length} 个） -----`)
for (const line of ownOnly) console.log(`  ${line}`)