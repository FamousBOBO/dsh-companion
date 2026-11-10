/** 参与者注册表的**取用面**（P9-G4 §2.2）：读字节、补版本哈希、按 mtime 缓存。
 *
 * 为什么这一层只做"读"：判定"这个号是 bot 还是人类"的逻辑已经在 `core/participant.ts`
 * 里写死了（§2.1 的四条约束），而 `core/` 与 `app/` 不许碰 `node:fs`（分层检查 R8）。
 * 所以这里只负责三件平台事实——**这一版注册表长什么样、它的版本号是什么、它有没有变**——
 * 一行判定逻辑都不复制。复制一份就等于给"她怎么认人"埋第二个事实来源。
 *
 * 四条口径：
 *   1. **注册表坏了不等于插件坏了**：文件不存在、JSON 坏、形状不对、读不出来，一律返回
 *      带问题列表的结果，**绝不抛**。群的社交判断在没有注册表时照常工作（所有人 `unknown`）。
 *   2. **版本号必须能追溯**（§2.3「回放使用事件发生时有效的注册表版本」）：注册表自己写了
 *      `version` 就用它；没写就按**文件内容**算 sha256 前 16 位。内容哈希不会撒谎——
 *      语义哈希要先做规范化，而那等于又引入一套"什么算同一个注册表"的判断。
 *   3. **按 (路径, mtimeMs, size) 缓存**：这条路径在**每条群消息**上都会被调用，每次
 *      `readFile + JSON.parse + sha256` 是把 CPU 花在不变的东西上。stat 很便宜，缓存不便宜的那半。
 *   4. **不跨群**：这里只把文件读成形状，`registryOf(groupId)` 之外没有"拿到所有群"的读法。
 */

import { createHash } from 'node:crypto'
import { promises as fs, realpathSync } from 'node:fs'
import * as path from 'node:path'

import {
  normalizeRegistryFile,
  registryFor,
  type GroupRegistry,
  type RegistryFile,
} from '../../core/participant.js'
import { resolveDshHome } from '../../paths.js'
import { readTextFileOrNull } from './atomic.js'

/** 注册表在套件 data root 下的默认相对位置（`<dataRoot>/home/companion/participants.json`）。 */
export const PARTICIPANTS_RELATIVE = path.join('home', 'companion', 'participants.json')

/**
 * 套件 data root = `DSH_HOME` 的父目录（`data/home` → `data`）。
 *
 * **与 `adapters/dsh-host/group-persona.ts` 的 `dataRootOfDshHome` 必须逐字一致**，两处
 * 算的是同一个目录（人格快照的进程级注册表键也用它）。没有直接 import 那一个，是因为
 * 那个文件同时拖进宿主端口探测的一整包依赖，而这个模块要能被最笨的装配路径单独引用。
 * `realpathSync` 的作用也一样：把 junction / 8.3 短名折成同一个拼法，否则"写进了 A，
 * 读的是 B"会表现成**静默的空注册表**。
 */
export function dataRootOfDshHome(dshHome: string): string | null {
  try {
    return path.dirname(realpathSync(dshHome))
  } catch {
    return null
  }
}

/** 默认注册表文件；算不出 data root 时返回 `null`（不是空串：空串会被当成相对路径）。 */
export function defaultParticipantsFile(dshHome: string): string | null {
  const root = dataRootOfDshHome(dshHome)
  return root === null ? null : path.join(root, PARTICIPANTS_RELATIVE)
}

/**
 * 解析出真正要读的那个文件。
 *
 * `configured` 非空就用它（相对路径按进程 cwd 解析——**建议写绝对路径**，否则从哪个目录
 * 起的进程就读到不同的文件，这种坑只会以"有时有 bot、有时没有"的形式出现）。
 */
export function participantsFilePath(input: {
  readonly configured?: string | null
  readonly dshHome: string
}): string | null {
  const configured = (input.configured ?? '').trim()
  if (configured !== '') return path.resolve(configured)
  return defaultParticipantsFile(input.dshHome)
}

/** 一次加载的结果（可判别联合：调用方不必猜"null 到底是没文件还是坏了"）。 */
export type RegistryLoad =
  | {
    readonly kind: 'loaded'
    readonly file: RegistryFile
    /** 被丢弃的条目说明（文件仍然可用）。 */
    readonly problems: readonly string[]
    readonly readAtMs: number
  }
  | {
    /** 文件不存在 / 读不出来：**不是错误**，等于"这个群没有已登记成员"。 */
    readonly kind: 'missing'
    readonly problems: readonly string[]
    readonly readAtMs: number
  }
  | {
    /** 文件在、但内容不可用（坏 JSON、schemaVersion 不对、形状不对）。 */
    readonly kind: 'invalid'
    readonly problems: readonly string[]
    readonly readAtMs: number
  }

/** stat 里缓存真正用到的两个字段（大小也看：某些文件系统上 mtime 只到秒）。 */
export interface RegistryFileStat {
  readonly mtimeMs: number
  readonly size: number
}

/** 构造参数：IO 全部可注入（测试要能数"读了几次盘"，装配侧用默认实现）。 */
export interface ParticipantRegistryOptions {
  /** 配置里的 `participants.file`；空串/`null` = 用默认位置。 */
  readonly file?: string | null
  /** `DSH_HOME` 的来路；缺省现取（不缓存：进程里没人改它）。 */
  readonly dshHome?: () => string
  readonly log?: (line: string) => void
  /** 时钟（只用于 `readAtMs` 这一项诊断字段）。 */
  readonly now?: () => number
  readonly readText?: (file: string) => Promise<string | null>
  readonly statFile?: (file: string) => Promise<RegistryFileStat | null>
}

/** 取用面：只有"读"和"忘掉缓存"，没有写。 */
export interface ParticipantRegistryHandle {
  /** 真正会读的那个文件；`null` = 连路径都算不出来。 */
  readonly file: string | null
  load(): Promise<RegistryLoad>
  /** 某个群的注册表；没登记、文件坏了、没有群号 → `null`（调用方据此把人当 `unknown`）。 */
  registryOf(groupId: number): Promise<GroupRegistry | null>
  /** 某个群**当前有效**的版本号；没有注册表 → `null`。 */
  version(groupId: number): Promise<string | null>
  /** 上一次成功加载的版本号（同步、零 IO；热路径已经 `load()` 过时用它）。 */
  versionSync(groupId: number): string | null
  /**
   * 上一次成功加载的**整份**注册表（同步、零 IO）；没加载过或上次是坏的 → `null`。
   *
   * 为什么需要它：采集路径（入站那一刻要冻结发送者身份）是**同步**的，没有地方等一次
   * `await`。有了这一项，装配侧只要在拿到消息时先 `load()` 一次，采集处就能同步取到
   * "这一刻有效的注册表版本"——而"每次采集都自己读一遍盘"正是要避免的。
   */
  fileSync(): RegistryFile | null
  /** 忘掉缓存：配置改了、或者文件被外面重写而 mtime 没变（拷进同 mtime 的文件）时用。 */
  invalidate(): void
}

/** 内容哈希前 16 位：够短能进日志，够长不会在同一天里撞上。 */
function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** 给没有版本号的群补上内容哈希；写了自己版本号的**原样保留**（操作者的版本号优先）。 */
function withVersions(file: RegistryFile, contentHash: string): RegistryFile {
  return {
    schemaVersion: 1,
    groups: file.groups.map((group) => (group.version === '' ? { ...group, version: contentHash } : group)),
  }
}

async function statOrNull(file: string): Promise<RegistryFileStat | null> {
  try {
    const stat = await fs.stat(file)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return null
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface CacheEntry {
  readonly mtimeMs: number
  readonly size: number
  readonly result: RegistryLoad
}

class RegistryReader implements ParticipantRegistryHandle {
  readonly file: string | null
  private readonly log: (line: string) => void
  private readonly now: () => number
  private readonly readText: (file: string) => Promise<string | null>
  private readonly statFile: (file: string) => Promise<RegistryFileStat | null>
  private cache: CacheEntry | null = null
  /** 并发 `load()` 共用同一次读盘（同一批消息会撞在同一个 tick 上）。 */
  private pending: Promise<RegistryLoad> | null = null
  private snapshot: RegistryFile | null = null

  constructor(options: ParticipantRegistryOptions) {
    this.log = options.log ?? ((): void => {})
    this.now = options.now ?? ((): number => Date.now())
    this.readText = options.readText ?? readTextFileOrNull
    this.statFile = options.statFile ?? statOrNull
    this.file = participantsFilePath({
      configured: options.file ?? '',
      dshHome: (options.dshHome ?? resolveDshHome)(),
    })
  }

  load(): Promise<RegistryLoad> {
    const running = this.pending
    if (running !== null) return running
    // `.catch` 是**最后一道**"绝不抛"：任何一处没想到的失败都收敛成"没有注册表"，
    // 而不是让一条群消息的处理链路炸在身份查询上。
    const job = this.readOnce()
      .catch((error: unknown) => this.missing(`注册表读取失败：${describe(error)}`))
      .finally(() => { this.pending = null })
    this.pending = job
    return job
  }

  async registryOf(groupId: number): Promise<GroupRegistry | null> {
    if (!Number.isSafeInteger(groupId) || groupId <= 0) return null
    const load = await this.load()
    return load.kind === 'loaded' ? registryFor(load.file, groupId) : null
  }

  async version(groupId: number): Promise<string | null> {
    return (await this.registryOf(groupId))?.version ?? null
  }

  versionSync(groupId: number): string | null {
    if (!Number.isSafeInteger(groupId) || groupId <= 0) return null
    return registryFor(this.snapshot, groupId)?.version ?? null
  }

  fileSync(): RegistryFile | null {
    return this.snapshot
  }

  invalidate(): void {
    this.cache = null
    this.snapshot = null
  }

  private missing(reason: string): RegistryLoad {
    return { kind: 'missing', problems: [reason], readAtMs: this.now() }
  }

  private invalid(problems: readonly string[]): RegistryLoad {
    for (const problem of problems.slice(0, 3)) this.log(`participants: 注册表不可用（${problem}）`)
    return { kind: 'invalid', problems, readAtMs: this.now() }
  }

  /** 读一次：先 stat，命中缓存就一个字节都不读。 */
  private async readOnce(): Promise<RegistryLoad> {
    const file = this.file
    if (file === null) return this.missing('无法确定注册表路径（DSH_HOME 不可用）')
    const stat = await this.statFile(file).catch(() => null)
    if (stat === null) {
      // 文件没了：缓存必须一起丢，否则"删掉注册表"在进程里不会生效。
      this.cache = null
      this.snapshot = null
      return this.missing(`注册表不存在：${file}`)
    }
    const cached = this.cache
    if (cached !== null && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result
    const result = await this.parse(file)
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, result }
    this.snapshot = result.kind === 'loaded' ? result.file : null
    return result
  }

  private async parse(file: string): Promise<RegistryLoad> {
    let text: string | null
    try {
      text = await this.readText(file)
    } catch (error) {
      // 读失败的原因（权限、被占用、路径是目录）必须留下来：否则日志里只剩"读不出来"，
      // 而这条路径出问题时的第一现场就是这个错误码。
      return this.missing(`注册表读不出来：${describe(error)}（${file}）`)
    }
    if (text === null) return this.missing(`注册表读不出来：${file}`)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      return this.invalid([`JSON 解析失败：${describe(error)}`])
    }
    const parsed = normalizeRegistryFile(raw)
    if (!parsed.ok) return this.invalid(parsed.problems)
    const file2 = withVersions(parsed.file, hashOf(text))
    if (parsed.dropped.length > 0) {
      this.log(`participants: ${file} 丢弃 ${String(parsed.dropped.length)} 条（${parsed.dropped.slice(0, 3).join('；')}）`)
    }
    this.log(`participants: 载入 ${String(file2.groups.length)} 个群的注册表（${file}）`)
    // 丢弃的条目照样回给调用方：它们是"这份文件里有东西没读懂"，值得进诊断，但不影响可用性。
    return { kind: 'loaded', file: file2, problems: parsed.dropped, readAtMs: this.now() }
  }
}

/** 造一个取用面（构造函数只解析路径，一次盘都不读：插件启动不该被一个文件拖住）。 */
export function createParticipantRegistry(options: ParticipantRegistryOptions = {}): ParticipantRegistryHandle {
  return new RegistryReader(options)
}
