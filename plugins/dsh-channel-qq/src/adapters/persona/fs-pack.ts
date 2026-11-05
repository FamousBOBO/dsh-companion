/** 人格包的文件实现：一段文案 = 一个 `.txt` 文件。
 *
 * 布局与键一一对应（`packet/group` ↔ `packet/group.txt`），这样"她到底被怎么交代的"
 * 可以直接用 `grep` 找，也可以用编辑器直接改。默认包在 `assets/persona/default/`，
 * 内容与搬出代码之前的字面量逐字节一致（黄金快照钉住这一点）。
 *
 * 两个刻意的约定：
 *   - **末尾的一个换行是文件格式，不进模板**。不然每段提示词都会凭空多一个空行，
 *     而提示词里多一个空行就是行为变化；
 *   - **按 mtime 缓存**。改完文件不用重启（`statSync` 一次是微秒级；每包读一次文件
 *     则会白白多出几十次磁盘 IO）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderTemplate } from '../../core/text/template.js'
import { MissingTemplateError, type PersonaPack } from '../../ports/persona.js'

/** 允许用环境变量指到别的人格包（后台"换包"与测试用）。 */
const DIR_ENV = 'CHANNEL_QQ_PERSONA_DIR'

/**
 * 从本模块所在目录往上找**包根**——也就是那个含 `assets/persona` 的目录。
 *
 * 为什么不用 `process.cwd()`：服务的 cwd 由 systemd 决定，测试的 cwd 是仓库根，
 * 两者不一样；而 `import.meta.url` 在两种情况下都指向真实文件。为什么不用固定的
 * `../../..`：源码树（`src/`）与构建产物（`lib/`、`lib-test/`）深度不同。
 */
export function findPackageRoot(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'assets', 'persona'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 默认人格包目录（`<包根>/assets/persona/default`）。 */
export function resolvePersonaDir(): string {
  const fromEnv = process.env[DIR_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)))
  if (root === null) {
    throw new Error(`persona pack: cannot find assets/persona from ${fileURLToPath(import.meta.url)}`)
  }
  return path.join(root, 'assets', 'persona', 'default')
}

/** 一份从磁盘读取的人格包。 */
class FsPersonaPack implements PersonaPack {
  private readonly cache = new Map<string, { text: string; mtimeMs: number }>()

  constructor(readonly dir: string) {}

  template(key: string): string | undefined {
    const file = path.join(this.dir, `${key}.txt`)
    let mtimeMs: number
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      return undefined
    }
    const hit = this.cache.get(key)
    if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.text
    const raw = readFileSync(file, 'utf8')
    // 末尾的一个换行是文件格式，不是模板内容。
    const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw
    this.cache.set(key, { text, mtimeMs })
    return text
  }

  render(key: string, vars: Readonly<Record<string, string>> = {}): string {
    const template = this.template(key)
    if (template === undefined) throw new MissingTemplateError(key, this.dir)
    return renderTemplate(template, vars)
  }

  keys(): string[] {
    const found: string[] = []
    const walk = (relative: string): void => {
      const abs = relative === '' ? this.dir : path.join(this.dir, relative)
      let entries: string[]
      try {
        entries = readdirSync(abs)
      } catch {
        return
      }
      for (const entry of entries) {
        const next = relative === '' ? entry : `${relative}/${entry}`
        if (statSync(path.join(this.dir, next)).isDirectory()) walk(next)
        else if (entry.endsWith('.txt')) found.push(next.slice(0, -'.txt'.length))
      }
    }
    walk('')
    return found.sort()
  }
}

/** 建一份人格包。目录不存在时**不抛错**——启动自检会拿 `keys()` 报出来。 */
export function createPersonaPack(options: { dir?: string } = {}): PersonaPack {
  const dir = options.dir ?? resolvePersonaDir()
  return new FsPersonaPack(dir)
}
