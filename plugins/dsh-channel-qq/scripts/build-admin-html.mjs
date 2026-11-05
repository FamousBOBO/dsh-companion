/**
 * Generate `src/admin-html.ts` from the `src/admin/ui/**` sources.
 *
 * 前端是**多个原生 ES 模块**（内部文档 §9：不引入框架与打包器），这个脚本
 * 把每个文件逐行内嵌进 `src/admin-html.ts`——因为插件由 `tsc` 编译，而 tsc 不复制
 * 非 TS 文件：内嵌之后**部署产物只有一个 `.js`**，页面与代码永远同版本（历史上
 * 出过"页面与脚本各自漂移 → 整页白屏"的事故）。浏览器通过 `/ui/*` 路径加载，
 * 服务端从这份内嵌包应答（见 `src/admin.ts` 的静态路由）。
 *
 * 同时把三类"只有浏览器才会暴露"的错误挡在构建阶段（05 §14：校验模块清单与
 * 模板引用）：
 *   1. 每个 `.js` 都能通过 TypeScript 的**语法**解析（`transpileModule` 只解析，
 *      不执行——与旧版 `new Function` 等价，且支持 import/export 语法）；
 *   2. 每个 `import` 说明符都能在包内解析得到（打错文件名 → 构建失败，而不是
 *      运行时 404 变成白屏）；禁止包外模块（页面必须自包含，无 npm/CDN 依赖）；
 *   3. `index.html` 引用的 `/ui/*` 资源全部存在；`#login` 默认可见、`<title>` 是
 *      "管理后台"、入口 `<script type="module">` 存在——白屏回归的三条硬底线；
 *      全包无任何外部资源引用（机房出网不稳）。
 *
 * Run:        `node scripts/build-admin-html.mjs`           （写文件）
 * Check only: `node scripts/build-admin-html.mjs --check`   （verify 用；过期即失败）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const UI_DIR = path.join(root, 'src', 'admin', 'ui')
const target = path.join(root, 'src', 'admin-html.ts')

/** 页面包只收文本扩展名；二进制资源会让"逐行内嵌"失效，必须显式失败。 */
export const UI_TEXT_EXT = new Set(['.html', '.js', '.css'])

/**
 * 读取 `src/admin/ui/**`。返回按路径排序的 `{ path, ext, content }` 数组；
 * 不支持的扩展名保留条目（`content: null`）交给校验层报错。
 * 行尾统一成 `\n`（构建产物必须与工作树的行尾无关）。
 */
export function loadAdminUi() {
  const files = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full, `${prefix}${entry}/`); continue }
      const ext = path.extname(entry).toLowerCase()
      const rel = prefix + entry
      const content = UI_TEXT_EXT.has(ext)
        ? readFileSync(full, 'utf8').replace(/\r\n/g, '\n')
        : null
      files.push({ path: rel, ext, content })
    }
  }
  walk(UI_DIR, '')
  return files
}

function validateJs(file, map, problems) {
  const result = ts.transpileModule(file.content, {
    reportDiagnostics: true,
    fileName: file.path,
    compilerOptions: { allowJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  for (const d of result.diagnostics ?? []) {
    if (d.category !== ts.DiagnosticCategory.Error) continue
    let where = ''
    if (d.file !== undefined && d.start !== undefined) {
      where = `:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}`
    }
    problems.push(`${file.path}${where} 语法错误：${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
  }
  const specs = []
  for (const m of file.content.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const m of file.content.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
  for (const spec of specs) {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), spec))
      if (!map.has(resolved)) problems.push(`${file.path} 的 import ${spec} 解析不到（→ ${resolved}）`)
      continue
    }
    if (spec.startsWith('/')) {
      if (!map.has(spec.slice(1))) problems.push(`${file.path} 的 import ${spec} 在包内不存在`)
      continue
    }
    problems.push(`${file.path} import 了包外模块「${spec}」：页面必须自包含，禁止 npm 依赖与 CDN`)
  }
  for (const m of file.content.matchAll(/fetch\s*\(\s*["'`]https?:\/\//g)) {
    problems.push(`${file.path} 直接请求外部地址：${m[0].slice(0, 60)}`)
  }
}

/** 全部构建期校验；返回问题清单（空数组 = 通过）。 */
export function validateAdminUi(files) {
  const problems = []
  const map = new Map(files.filter((f) => f.content !== null).map((f) => [f.path, f.content]))
  for (const f of files) {
    if (f.content === null) {
      problems.push(`${f.path}：不支持的扩展名（页面包只收 .html/.js/.css）`)
    }
  }
  const html = map.get('index.html')
  if (html === undefined) {
    problems.push('缺少 index.html')
  } else {
    if (!/<title>[^<]*管理后台[^<]*<\/title>/.test(html)) {
      problems.push('index.html 的 <title> 必须包含"管理后台"')
    }
    const loginTag = /<div[^>]*id="login"[^>]*>/.exec(html)
    if (loginTag === null) {
      problems.push('index.html 找不到 #login 容器（登录框必须默认可见——脚本挂掉也不黑屏）')
    } else if (/\bhidden\b/.test(loginTag[0])) {
      problems.push('#login 初始带 hidden：脚本一旦出错就只剩黑屏，登录框必须默认可见')
    }
    if (!/<script\s[^>]*type="module"[^>]*src="\/ui\/app\.js"/.test(html)) {
      problems.push('入口 <script type="module" src="/ui/app.js"> 缺失')
    }
    for (const m of html.matchAll(/(?:src|href)\s*=\s*["'](\/ui\/[^"']+)["']/g)) {
      if (!map.has(m[1].slice(4))) problems.push(`index.html 引用了不存在的页面文件 ${m[1]}`)
    }
  }
  for (const f of files) {
    if (f.content === null) continue
    if (f.ext === '.html') {
      for (const m of f.content.matchAll(/(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']*)["']/g)) {
        problems.push(`${f.path} 引用了外部资源 ${m[1]}（服务器出网不稳，页面必须自包含）`)
      }
    }
    if (f.ext === '.css') {
      if (/@import\s[^;]*(?:https?:)?\/\//.test(f.content)) problems.push(`${f.path} 有外部 @import`)
      if (/url\(\s*["']?(?:https?:)?\/\//.test(f.content)) problems.push(`${f.path} 的 url() 指向外部地址`)
    }
    if (f.ext === '.js') validateJs(f, map, problems)
  }
  if (files.length < 6) problems.push(`src/admin/ui 只有 ${files.length} 个文件，明显不完整`)
  return problems
}

function buildModule(files) {
  const entries = files.map(({ path: p, content }) => {
    const lines = content.split('\n')
    // 尾部换行不生成一个多余的空行元素。
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const body = lines.map((line) => `      ${JSON.stringify(line)},`).join('\n')
    return `  {\n    path: ${JSON.stringify(p)},\n    lines: [\n${body}\n    ],\n  },`
  }).join('\n')
  return `/** GENERATED FILE — do not edit by hand.
 *
 * Source: \`src/admin/ui/**\`（原生 ES 模块，多文件）
 * Regenerate: \`node scripts/build-admin-html.mjs\`
 *
 * 前端拆成多个原生 ES 模块（内部文档 §9），由生成器逐文件内嵌到这里：
 * tsc 不复制非 TS 文件，内嵌之后**部署产物只有一个 .js**，页面与代码永远同版本。
 * 浏览器经 \`/ui/*\` 路径加载，服务端（src/admin.ts）从这份包直接应答。
 * 每个文件的每一行都经过 \`JSON.stringify\`，任何内容都不可能生成非法的 TS 字面量。
 */

const UI_FILE_LIST: ReadonlyArray<{ path: string; lines: readonly string[] }> = [
${entries}
]

let uiFilesCache: Readonly<Record<string, string>> | null = null

/** 前端文件包：键是 \`src/admin/ui/\` 下的相对路径（正斜杠）。 */
export function adminUiFiles(): Readonly<Record<string, string>> {
  if (uiFilesCache === null) {
    const out: Record<string, string> = {}
    for (const file of UI_FILE_LIST) out[file.path] = file.lines.join('\\n')
    uiFilesCache = out
  }
  return uiFilesCache
}

/** 后台首页（\`index.html\`）。 */
export function renderAdminPage(): string {
  return adminUiFiles()['index.html'] ?? ''
}
`
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const files = loadAdminUi()
  const problems = validateAdminUi(files)
  if (problems.length > 0) {
    console.error('admin-ui 校验失败：')
    for (const problem of problems) console.error('  - ' + problem)
    process.exit(1)
  }
  const output = buildModule(files)
  const totalBytes = files.reduce((n, f) => n + (f.content?.length ?? 0), 0)
  if (checkOnly) {
    if (!existsSync(target)) {
      console.error(`${path.relative(root, target)} 不存在：先跑 npm run build:admin`)
      process.exit(1)
    }
    if (readFileSync(target, 'utf8') !== output) {
      console.error(`${path.relative(root, target)} 与 src/admin/ui/** 不一致——生成物过期了。`)
      console.error('跑 `npm run build:admin` 重新生成，并把结果一起提交。')
      process.exit(1)
    }
    console.log(`check:admin-ui: 通过（${files.length} 个模块，${totalBytes} 字节，与 src/admin/ui/** 一致）`)
    return
  }
  writeFileSync(target, output, 'utf8')
  console.log(`generated ${path.relative(root, target)} from src/admin/ui/** (${files.length} 个模块, ${totalBytes} 字节)`)
}

/** 仅当本文件被直接执行时才跑 CLI——probe 会 import 本模块复用包读取。 */
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (invokedDirectly) main()
