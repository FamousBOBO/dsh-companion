/**
 * 分层检查（自写，零新依赖）。
 *
 * 目标架构（内部文档）里 `core/` `app/` `adapters/` `features/` 之间是有
 * 方向的：`adapters/dsh-host/` 是唯一允许 import `@deepseek-ai/*` 的地方，
 * `core/` 不许碰 `node:*` 之外的任何东西，`features/` 之间不许互相 import。
 *
 * 但现在（P1）代码还是扁平的 `src/*.ts`，那些规则一条都套不上。把一条套不上的
 * 规则写进 CI 只有一个结果：它被关掉。所以这里采用**棘轮**——只禁止"变更坏"：
 *
 *   R1  `src/**` 不得 import `lib/`、`test/`、`deploy/`、`scripts/` 或绝对文件系统路径
 *   R2  `@deepseek-ai/*` 只能从 scripts/layers-baseline.json 里记过名的文件 import；
 *       **新增一个就失败**，删掉一个则要在 `--update` 时落账（P2.9 的目标是把这张表
 *       收缩到只有 adapters/dsh-host/）
 *   R3  相对 import 必须带 `.js` 后缀（NodeNext ESM 的硬要求，写漏了要到运行时才炸）
 *   R4  `writeFile`（整份覆盖写）只能出现在 `src/adapters/fs-store/` 里；`appendFile` 不在此列
 *   R5  OneBot 动作名（`'send_group_msg'` 这类字符串）只能出现在 `src/adapters/onebot/` 里
 *   R6  `fetch(` 只能出现在 `src/adapters/http/` 里（浏览器端模板里的除外，见白名单）
 *   R7  `as never` / `as unknown as` 只能出现在 `src/adapters/` 里
 *   R8  `src/core/` 与 `src/app/` 是可重放层：不读全局时钟/随机、不起定时器、
 *       不 import 任何运行时依赖（`node:*` / `@deepseek-ai/*` / `ws` / 外层目录）
 *
 * R7 为什么值得单独一条：`as never` / `as unknown as` 是"我知道它的真实形状，类型
 * 系统不知道"的宣告。这种知识本身没错，错的是**散落**——它原来分布在 bridge / index /
 * tool-kit / emoji-library 的 24 处，于是"宿主升级之后哪里会坏"没有答案。
 * P2.9 把它们收进 `adapters/dsh-host/` 之后，这条规则让下一个需要转型的人只能二选一：
 * 写进那个目录，或者把接口改对。
 *
 * R6 为什么值得单独一条：超时、响应体积上限、SSRF 闸门这三件事在"取一个群友发的
 * 链接"这条路径上全是安全边界，而**每一处都要记得写**——32 处里迟早会漏一处。
 * 收进 `ports/http.ts` + `adapters/http/client.ts` 之后，默认值即安全值。
 *
 * R5 为什么值得单独一条：动作名散在业务代码里的时候，`R8`（评估换 NapCat 版本 /
 * 换 SnowLuma）没法回答"我们到底用了哪些动作、各自的参数与返回是什么形状"，
 * 拼错动作名也只能等群里发消息时才炸，而且业务没法造假件测。P2.6 把它们收进
 * `ports/platform.ts` 的 `QQApi` 之后，这条规则防止后来者顺手又写一个
 * `client.call('send_group_msg', ...)`。
 *
 * R8 为什么值得单独一条：`core/` 与 `app/` 是要能"给同样的输入就出同样的输出"的两层，
 * 而**读全局时钟**与**读全局随机**正好是这条性质的两个反例。P3 搬 `bridge.ts` 时的
 * 判据就是"`core/` 与 `app/` 里零直接调用 `Date.now()` / `new Date()` / `setInterval`"
 * （06 §P2.3）。没有这条规则，判据就只能靠人肉 grep，
 * 而下一个搬代码的人不会记得。`app/` 需要时间与定时器时注入 `ports/clock.ts` 的
 * `Clock`（见 `app/conversation/turn-tracker.ts`）。注意放行 `new Date(<参数>)`
 * ——那是**确定性的构造**，不是读时钟；被禁的是**无参**的 `new Date()`。
 *
 * R4 为什么值得单独一条：全仓原来 21 个文件 31 处 `writeFile`，没有一处是原子写，
 * 而里面装着记忆、语录、提醒、好感度——**丢了回不来**（B7）。P2.4 把它们全换成
 * `atomicWriteFile` 之后，这条规则防止后来者（包括我自己）顺手又写一个裸 `writeFile`。
 * 允许的例外写在下面的 ALLOWED_WRITE 里，并且**要写明理由**——没有理由的例外
 * 会在几次提交之后变成惯例。
 *
 * 用法：
 *   node scripts/check-layers.mjs             # 检查，有违规就非零退出
 *   node scripts/check-layers.mjs --update    # 把当前的允许集合写进基线（只在有意收缩时用）
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import * as path from 'node:path'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')
const BASELINE_PATH = path.join(ROOT, 'scripts', 'layers-baseline.json')
const update = process.argv.includes('--update')

/** 递归列出 src 下的 .ts 文件（相对仓库根的正斜杠路径）。 */
function listSources(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) { out.push(...listSources(full)); continue }
    if (entry.endsWith('.ts')) out.push(path.relative(ROOT, full).split(path.sep).join('/'))
  }
  return out.sort()
}

/** 抽出一个文件里所有的模块说明符（静态 import / 动态 import / require）。 */
function specifiersOf(text) {
  const found = []
  const push = (spec, index) => { if (typeof spec === 'string' && spec !== '') found.push({ spec, index }) }
  for (const m of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) push(m[1], m.index ?? 0)
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1], m.index ?? 0)
  for (const m of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1], m.index ?? 0)
  return found
}

const files = listSources(SRC)
const violations = []
/** file → 它 import 的 @deepseek-ai/* 包名集合。 */
const hostImporters = new Map()

/**
 * 允许直接写文件的路径（前缀匹配）。
 *
 * 只允许 `adapters/fs-store/`——那里就是"怎么写文件"这个问题的唯一答案所在。
 * 加例外必须在这里写明理由。
 */
const ALLOWED_WRITE = ['src/adapters/fs-store/']
/**
 * 裸写的识别规则：`writeFile(`，且不是我们自己的 `atomicWriteFile(`。
 *
 * **不拦 `appendFile`**：追加是日志的正确语义，而"原子替换"一个日志文件等于每写
 * 一行就把整份日志重写一遍。所以 R4 的判据是"**整份覆盖写必须原子**"，
 * 不是"不许写文件"。追加式日志会在 P2.2 由 `LogStream` 端口收口，
 * 届时那个例外也搬进 `adapters/fs-store`。
 */
const RAW_WRITE = /(?<!atomic)(?<!atomicWrite)\bwriteFile\s*\(/

/**
 * 允许出现 OneBot 动作名的目录（前缀匹配）。
 *
 * 只有 `adapters/onebot/`——那里就是"我们用了哪些动作、各自的参数与返回是什么
 * 形状"这个问题的唯一答案所在（`qq-api.ts` 的 34 个方法）。
 */
const ALLOWED_ACTIONS = ['src/adapters/onebot/']
/** 动作名清单：与 `ports/platform.ts` 的 `QQApi` 一一对应，只作识别用。 */
const ACTION_NAMES = [
  'send_group_msg', 'send_private_msg', 'get_msg', 'delete_msg', 'get_image', 'get_record',
  'get_file', 'send_like', 'get_group_list', 'get_group_info', 'get_group_member_info',
  'get_friend_list', 'set_group_ban', 'set_group_kick', 'set_group_whole_ban', 'set_group_admin',
  'set_group_card', 'group_poke', 'set_essence_msg', 'delete_essence_msg', 'get_essence_msg_list',
  'get_group_root_files', 'get_group_files_by_folder', 'get_group_file_url', 'upload_group_file',
  'create_group_file_folder', 'move_group_file', 'rename_group_file', 'delete_group_file',
  'get_private_file_url', 'upload_private_file', 'can_send_record', 'get_ai_record',
  'send_group_ai_record',
]
const ACTION_NAME_RE = new RegExp(`'(${ACTION_NAMES.join('|')})'`, 'g')

/**
 * 允许出现 `as never` / `as unknown as` 的路径（前缀匹配）。
 *
 * 只有 `adapters/`：宿主形状、协议形状、存储形状的"运行时知识"都在那里。
 */
const ALLOWED_CASTS = ['src/adapters/']
/** 转型的识别规则：两种写法都要拦，因为两种都能绕开类型检查。 */
const RAW_CAST = /\bas\s+(?:never|unknown\s+as)\b/

/**
 * 可重放层的路径前缀。
 *
 *   - `core/`  纯领域：判定、解析、打分、渲染，零 IO；
 *   - `app/`   编排：只依赖 core 与 ports，时间/随机/定时器一律注入。
 *
 * 这两层必须能在没有进程、没有网络、没有时钟的环境里跑出同样的结果——
 * 这是"行为不变"能被证明的前提。
 */
const PURE_PREFIXES = ['src/core/', 'src/app/']
/**
 * 不许读全局时钟 / 全局随机 / 起定时器。
 *
 * 逐条的理由：
 *   - `Date.now(`、无参 `new Date()`  —— 读时钟；
 *   - `Math.random(`                  —— 读随机；
 *   - `setTimeout/setInterval`        —— 起真实定时器（时间因此不可控）；
 *   - `clearTimeout/clearInterval`    —— 有定时器才会用到它们，出现即说明上面漏了。
 *
 * **放行 `new Date(<参数>)`**：那是确定性的构造，不是读时钟。
 * **放行 `clock.setTimeout(...)`**：那是注入进来的端口，正是我们要的写法——
 * 所以前缀带 `.` 或标识符字符的定时器函数名不算命中。
 */
const IMPURE_RE = /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bMath\.random\s*\(|(?<![\w.])set(?:Timeout|Interval)\s*\(|(?<![\w.])clear(?:Timeout|Interval)\s*\(/
/**
 * 不许 import 的运行时依赖。
 *
 * 这两层只允许 import `core/`、`app/`、`ports/`（只有类型）与 `src/types.ts`
 * （OneBot 线协议形状——它还没有自己的模型层，见 11 §5 的遗留）。
 */
/** 裸说明符里的运行时依赖：一律不许出现在 core/。 */
const IMPURE_SPEC_RE = /^(?:node:|@deepseek-ai\/|ws$)/
/** 可重放层允许 import 的自身之外的文件（只有线协议形状；见文件头 R8）。 */
const PURE_EXTRA_ALLOW = ['src/types.ts']

/**
 * 允许出现 `fetch(` 的路径（前缀匹配）。
 *
 *   - `adapters/http/`  —— `fetch` 唯一的落点；
 *   - `admin-html.ts`   —— 由 `admin-ui.html` **生成**的前端代码，里面的
 *     `fetch` 跑在学弟的浏览器里，打的是本页同源的 `/api/*`，不是服务端请求。
 */
const ALLOWED_FETCH = ['src/adapters/http/', 'src/admin-html.ts']
/**
 * 单独放行的文件及**理由**（没有理由的例外会在几次提交之后变成惯例）。
 *
 * `affection.ts` 里带一个自绘的仪表盘页面，页面内联的 `<script>` 里有三处
 * `fetch('/api/...')`——和 `admin-html.ts` 一样，那是浏览器端的代码，只是
 * 恰好写在这个 .ts 的模板字符串里。
 */
const ALLOWED_FETCH_FILES = new Map([['src/affection.ts', '内联仪表盘页面里的浏览器端 fetch']])

for (const file of files) {
  const text = readFileSync(path.join(ROOT, file), 'utf8')
  const lineOf = (index) => text.slice(0, index).split('\n').length
  const isPure = PURE_PREFIXES.some((prefix) => file.startsWith(prefix))

  // R4：裸写文件（见文件头）。先看整行，避免把注释里的举例也算进去。
  if (!ALLOWED_WRITE.some((prefix) => file.startsWith(prefix))) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (!RAW_WRITE.test(code)) continue
      violations.push({
        file, line: i + 1, rule: 'R4',
        detail: `裸写文件：${line.trim().slice(0, 80)}。改用 atomicWriteFile/atomicWriteJson`
          + `（src/adapters/fs-store/atomic.js）——原子写防的是"进程死在写一半"导致的半截文件，`
          + `而这些文件里装着不可再生的数据`,
      })
    }
  }

  // R5：动作名字符串（见文件头）。先去掉注释，避免把文档里的例子算成违规。
  if (!ALLOWED_ACTIONS.some((prefix) => file.startsWith(prefix))) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      for (const m of code.matchAll(ACTION_NAME_RE)) {
        violations.push({
          file, line: i + 1, rule: 'R5',
          detail: `OneBot 动作名 '${m[1]}' 出现在 adapters/onebot 之外。`
            + `改用 ports/platform.ts 的 QQApi 方法（实现见 adapters/onebot/qq-api.ts）`,
        })
      }
      if (/\.call\(\s*'/.test(code)) {
        violations.push({
          file, line: i + 1, rule: 'R5',
          detail: `字符串动作名调用：${line.trim().slice(0, 80)}。改用 QQApi 门面方法`,
        })
      }
    }
  }

  // R7：绕过类型检查的转型（见文件头）。
  if (!ALLOWED_CASTS.some((prefix) => file.startsWith(prefix))) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i].replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (!RAW_CAST.test(code)) continue
      violations.push({
        file, line: i + 1, rule: 'R7',
        detail: `绕过类型的转型：${lines[i].trim().slice(0, 80)}。`
          + `宿主/协议形状的知识写进 adapters/（见 adapters/dsh-host/），或者把接口改对`,
      })
    }
  }

  // R8：纯领域层不许碰时钟、随机、定时器与运行时依赖（见文件头）。
  if (PURE_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i].replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (!IMPURE_RE.test(code)) continue
      violations.push({
        file, line: i + 1, rule: 'R8',
        detail: `可重放层里读了全局时钟/随机或起了定时器：${lines[i].trim().slice(0, 80)}。`
          + `把"现在几点""随机数是多少"作为参数传进来（见 core/schedule/stamp.ts 的签名），`
          + `或由 app/ 层注入 ports/clock.ts 的 Clock`,
      })
    }
  }

  // R6：裸 `fetch(`（见文件头）。同样先去掉注释。
  if (!ALLOWED_FETCH.some((prefix) => file.startsWith(prefix)) && !ALLOWED_FETCH_FILES.has(file)) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i].replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (!/(?<![\w.])fetch\s*\(/.test(code)) continue
      violations.push({
        file, line: i + 1, rule: 'R6',
        detail: `裸 fetch()：${lines[i].trim().slice(0, 80)}。改用 ports/http.ts 的 HttpClient`
          + `（默认带超时、体积上限与 SSRF 闸门）`,
      })
    }
  }

  for (const { spec, index } of specifiersOf(text)) {
    const line = lineOf(index)

    // R8（import 部分）：纯领域层只依赖 core/ 与 ports/。
    //
    // 这一段必须放在 R1/R3 之前：相对 import 会在那里 `continue`，漏掉后面的检查。
    // 判据是**解析后的落点**而不是字面写法——`../adapters/x.js` 与
    // `../../adapters/x.js` 都要拦，而 `../../types.js` 是放行的（线协议形状）。
    if (isPure) {
      const relative = /^\.\.?\//.test(spec)
      const resolved = relative
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
        : spec
      // `.js` 是 ESM 的写法，磁盘上是 `.ts`：两条都要认，否则白名单永远对不上。
      const onDisk = resolved.replace(/\.js$/, '.ts')
      const strayed = relative
        ? !onDisk.startsWith('src/core/') && !onDisk.startsWith('src/app/')
          && !onDisk.startsWith('src/ports/') && !PURE_EXTRA_ALLOW.includes(onDisk)
        : IMPURE_SPEC_RE.test(spec)
      if (strayed) {
        violations.push({
          file, line, rule: 'R8', detail: `可重放层 import 了 ${spec}（core/ 与 app/ 只依赖 core/ ports/ app/，解析落点 ${onDisk}）`,
        })
      }
    }

    // R1：不许回头引用构建产物 / 测试 / 工具目录，也不许写绝对路径。
    if (/^\/(?!\/)/.test(spec) || /^[A-Za-z]:[\\/]/.test(spec)) {
      violations.push({ file, line, rule: 'R1', detail: `绝对文件系统路径：${spec}` })
      continue
    }
    if (/^\.\.?\//.test(spec)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
      const outside = ['build/', 'lib/', 'test/', 'deploy/', 'scripts/', 'lib-test/']
      const hit = outside.find((prefix) => resolved.startsWith(prefix) || resolved.startsWith(`../${prefix}`))
      if (hit !== undefined) {
        violations.push({ file, line, rule: 'R1', detail: `跨出 src 引用 ${resolved}` })
      }
      // R3：相对 import 必须写 .js（NodeNext 的 ESM 不做扩展名猜测）。
      if (!/\.(js|json|mjs|cjs)$/.test(spec)) {
        violations.push({ file, line, rule: 'R3', detail: `相对 import 缺少 .js 后缀：${spec}` })
      }
      continue
    }

    // R2：宿主包只能从基线里记过名的文件 import。
    if (spec.startsWith('@deepseek-ai/')) {
      const set = hostImporters.get(file) ?? new Set()
      set.add(spec)
      hostImporters.set(file, set)
      continue
    }

    // 其余裸说明符（node:、ws……）不在此处限制。
  }
}

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  : { hostImporters: [] }
const allowed = new Set(baseline.hostImporters ?? [])

const hostFiles = [...hostImporters.keys()].sort()
if (!update) {
  for (const file of hostFiles) {
    if (!allowed.has(file)) {
      const pkgs = [...(hostImporters.get(file) ?? [])].join(', ')
      violations.push({
        file, line: 1, rule: 'R2',
        detail: `新增了宿主包 import（${pkgs}）。宿主类型只允许出现在 scripts/layers-baseline.json 已记录的文件里；`
          + `若这是有意的，跑 node scripts/check-layers.mjs --update 落账（P2.9 的目标是把这张表收缩到 adapters/dsh-host/）`,
      })
    }
  }
}

if (update) {
  writeFileSync(BASELINE_PATH, JSON.stringify({
    note: '宿主包 import 的允许集合（棘轮：只能删，不能悄悄加）。见 scripts/check-layers.mjs。',
    updatedAt: new Date().toISOString().slice(0, 10),
    hostImporters: hostFiles,
  }, null, 2) + '\n')
  console.log(`已更新 ${path.relative(ROOT, BASELINE_PATH)}：${hostFiles.length} 个文件 import 宿主包`)
  for (const f of hostFiles) console.log('  ' + f)
  process.exit(0)
}

// 基线里有、实际已经不 import 的（说明收缩了，值得落账）。
const stale = [...allowed].filter((f) => !hostImporters.has(f))
if (stale.length > 0) {
  console.log(`提示：基线里这些文件已经不再 import 宿主包，可以跑 --update 把它从表里去掉：`)
  for (const f of stale) console.log('  ' + f)
}

if (violations.length === 0) {
  console.log(`check-layers: 通过（${files.length} 个源文件；宿主包 import 出现在 ${hostFiles.length} 个文件里，均在基线内）`)
  process.exit(0)
}
console.error(`check-layers: ${violations.length} 处违规`)
for (const v of violations) console.error(`  ${v.file}:${v.line}  [${v.rule}] ${v.detail}`)
process.exit(1)
