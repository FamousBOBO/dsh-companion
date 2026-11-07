/** 点歌子插件：把「配置里的外部路径 → 四个适配器 → 串行队列 → 工具面 + 自主入口」接起来。
 *
 * 这个文件只做装配，不写业务判据。业务在：
 *   - `select.ts` 选哪条视频（纯函数，可测）；
 *   - `pipeline.ts` 一条任务怎么跑（四步顺序与失败边界）；
 *   - `queue.ts` 串行、去重、日上限、清理、终态通知；
 *   - `auto.ts` 自主选歌（由主动联系在它自己的节拍上调用）；
 *   - `adapters/song/*` 外部世界（B站 / ffmpeg / python / QQ 发送）。
 *
 * 三个装配期决定值得写下来：
 *
 *   1. **外部路径"空 = 未配置"，绝不猜盘符**。`pythonPath` / `rvcRoot` 空着时子插件照样
 *      挂载、工具也照样注册（模型看得到这段功能，诊断看得到"没配"），只是入队一律拒绝。
 *      构造一半的适配器更糟：那会把"没配置"变成"第一次点歌时才炸"。
 *   2. **闸门接 contact 的共享门控**，不另写一套。免打扰/额度/冷却/通道本来就在那里判；
 *      点歌再抄一份就是两套账。私聊入口（用户刚点了歌）只过配置两道闸；
 *      自主入口（机器人自己想发）**再加一道** `outboundBudget`。
 *   3. **自主选歌不起定时器**：它挂在主动联系已有的节拍上（`auto.ts::autoPickOnce`）。
 *      自己再起一个 `setInterval` 就是第二套节拍，两套节拍互相不知道对方刚发过什么
 *      ——那正是重复外发的来源。
 */

import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { systemHttp } from '../../adapters/http/client.js'
import { resolveDshHome } from '../../paths.js'
import { systemClock } from '../../ports/clock.js'
import { systemProcess } from '../../adapters/song/process.js'
import { createBiliPort } from '../../adapters/song/bili.js'
import { createChorusPort } from '../../adapters/song/chorus.js'
import { createCoverPort } from '../../adapters/song/cover.js'
import { createNoticePort } from '../../adapters/song/notice.js'
import { createVoicePort } from '../../adapters/song/voice.js'
import { registerSpecs } from '../../adapters/dsh-host/tools.js'
import { registerSongResource, runtimes } from './auto.js'
import { SongQueue, type SongFinished } from './queue.js'
import { songTools } from './tools.js'
import type { SendGatePort, SendVerdict, SongEntry } from './types.js'
import type { SongConfig } from '../../config/sections/song.js'
import type { SubHost, SubPlugin } from '../plugin-kit.js'
import { autoPickOnce } from './auto.js'

/** 自主选歌的对外入口（判断与候选池在 `auto.ts`，这里只转发，免得两个入口各写一遍）。 */
export { autoPickOnce, splitPoolEntry } from './auto.js'

/** 从本模块往上找 `tools/song/find_chorus.py`（源码树与 build 产物深度不同，所以逐层找）。 */
export function chorusScriptPath(dir: string = import.meta.dirname): string {
  let cursor = dir
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(cursor, 'tools', 'song', 'find_chorus.py')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  // 找不到也返回一个值：适配器跑起来会失败并把原因写进日志，比启动时抛错更容易解释。
  return path.join(dir, 'tools', 'song', 'find_chorus.py')
}

/** 解析后的外部路径。 */
export interface SongPaths {
  readonly pythonPath: string
  readonly chorusPython: string
  readonly rvcRoot: string
  readonly makeCover: string
  readonly credentialFile: string
  readonly workRoot: string
  readonly ffmpeg: string
}

/** 空串 → `null`（配置里的"未配置"就是这么表达的）。 */
function filled(value: string | undefined): string | null {
  const text = (value ?? '').trim()
  return text === '' ? null : text
}

/**
 * 外部路径解析。**缺任何一项就整段 `null`**：只配了 python 而没有 RVC 仓库，
 * 构造出来的适配器必然在第一次跑的时候失败；那不如现在就说"没配全"。
 *
 * 凭据与工作目录的默认值都落在 `dshHome` 下（那是套件的运行期数据根，已 gitignore）；
 * 凭据默认位置与 B站插件自己的家一致（`home/bili-duty/bili_credential.json`），
 * 因为那是操作者已经登录过的地方。**读不到凭据时 B站适配器会降级匿名**。
 */
export function resolveSongPaths(config: SongConfig, dshHome: string): SongPaths | null {
  const pythonPath = filled(config.pythonPath)
  const rvcRoot = filled(config.rvcRoot)
  if (pythonPath === null || rvcRoot === null) return null
  return {
    pythonPath,
    chorusPython: filled(config.chorusPython) ?? pythonPath,
    rvcRoot,
    makeCover: filled(config.makeCover) ?? path.join(rvcRoot, 'make_cover.py'),
    credentialFile: filled(config.biliCredentialFile)
      ?? path.join(dshHome, '..', 'bili-duty', 'bili_credential.json'),
    workRoot: filled(config.workRoot) ?? path.join(dshHome, 'channel-qq', 'song'),
    ffmpeg: filled(config.ffmpegPath) ?? 'ffmpeg',
  }
}

/**
 * 发送闸。
 *
 * 私聊入口只过配置两道闸（与 `contact/gate.ts::authorizeOutbound` 同义同序）；
 * 自主入口再加 `contact.outboundBudget()`。`contact` 没装时自主入口**一律拒绝**：
 * 主动消息的闸门不存在，就不该有第二条外发路径自己判断"现在能不能发"。
 */
export function buildGate(
  config: () => SongConfig,
  budget: (room: string) => Promise<{ allowed: boolean; reason: string }>,
  log: (line: string) => void,
): SendGatePort {
  return {
    async authorize(room: string, entry: SongEntry): Promise<SendVerdict> {
      if (config().dryRun) return { verdict: 'dry-run', reason: 'dry-run' }
      if (!config().allowExternalSend) return { verdict: 'denied', reason: 'external-send-denied' }
      if (entry === 'dm') return { verdict: 'allowed', reason: 'ok' }
      let decision: { allowed: boolean; reason: string }
      try {
        decision = await budget(room)
      } catch (error) {
        log(`song: 自主选歌问门控时出错（${error instanceof Error ? error.message : String(error)}）`)
        return { verdict: 'denied', reason: 'gate-error' }
      }
      if (!decision.allowed) {
        log(`song: 自主选歌被门控拦下（${decision.reason}）`)
        return { verdict: 'denied', reason: decision.reason }
      }
      return { verdict: 'allowed', reason: 'ok' }
    },
  }
}

/** 未配置时的替身：`enqueue` 一律拒绝并说明"没配环境"，其余如实回答空。 */
export function refusingService(): import('./queue.js').SongService {
  return {
    enqueue: async () => ({
      accepted: false, taskId: null,
      note: '还没配置 RVC 环境（后台「音乐」页填「RVC 的 Python」与「RVC 仓库目录」）',
    }),
    status: () => [],
    cancel: async () => false,
    autoQuotaLeft: async () => 0,
    autoUsedToday: async () => 0,
    noteAutoSent: async () => {},
    load: async () => {},
    autoPickOnce: async () => false,
  }
}

/** 未配置时的 B站替身：调用即抛，工具面会把它翻译成一句话。 */
export function unavailableBili(): import('./types.js').BiliPort {
  const fail = (): never => { throw new Error('点歌翻唱还没有配置（后台「音乐」页）') }
  return {
    search: async () => fail(),
    videoInfo: async () => fail(),
    downloadAudio: async () => fail(),
  }
}

/** 终态 → 私聊里的一句话。**成功与演练不说话**（语音条本身就是回答）。 */
export function finishText(
  stage: 'sent' | 'dry-run' | 'failed' | 'unknown-send' | 'cancelled',
  detail: string | null,
): string | null {
  switch (stage) {
    case 'sent':
    case 'dry-run':
      return null
    case 'cancelled':
      return '那首歌取消了。'
    case 'unknown-send':
      return `语音条可能没送到（${detail ?? '回执未知'}）。为了不让你收到两条一样的，我不会自动重发；要我再来一次就说一声。`
    case 'failed':
      return `这次没做成：${detail ?? '未知原因'}`
  }
}

/** 子插件本体。 */
export const songPlugin: SubPlugin = {
  name: 'song',
  // 只有"启用 / 自主选歌开关 / 自主选歌曲目"改了要重挂（它们决定工具面注册与自主候选池）。
  // 其余字段都通过 `config()` 现取，改完立刻生效。
  watches: ['song.enabled', 'song.autoPick', 'song.autoSongs'],
  requires: ['platform'],
  apply(host) {
    const log = (line: string): void => { host.log(line) }
    const config = (): SongConfig => host.config.song
    const clock = systemClock
    const dshHome = resolveDshHome()
    const ownerId = host.config.admins[0] ?? null
    const paths = resolveSongPaths(config(), dshHome)

    if (paths === null) {
      log('song: 未配置（后台「音乐」页填「RVC 的 Python」与「RVC 仓库目录」之前，点歌只会回"没配置"）')
      return registerSpecs(host.bridge.toolHost(), songTools({
        queue: refusingService(), bili: unavailableBili(), config, clock, log, ownerId,
      }), log, 'song')
    }
    return wire(host, { paths, config, clock, log, ownerId, dshHome })
  },
  start(host) {
    // 关着的时候什么都不说（安装即静默）；开着才提醒一句配置上容易漏的事。
    if (!host.config.song.enabled) return
    if (host.config.song.autoPick && host.config.song.autoSongs.length === 0) {
      host.log('song: autoPick 打开了但「自主选歌曲目」是空的——自主选歌什么都不做（填几首歌名即可）')
    }
  },
}

/** 一次性装配所需的事实（`apply` 收集，`wire` 使用）。 */
interface Wiring {
  readonly paths: SongPaths
  readonly config: () => SongConfig
  readonly clock: typeof systemClock
  readonly log: (line: string) => void
  readonly ownerId: number | null
  readonly dshHome: string
}

/** 建四个外部适配器（B站 / 副歌 / 翻唱 / 发送 + 文字通知）。 */
function buildAdapters(host: SubHost, wiring: Wiring): {
  bili: ReturnType<typeof createBiliPort>
  chorus: ReturnType<typeof createChorusPort>
  cover: ReturnType<typeof createCoverPort>
  voice: ReturnType<typeof createVoicePort>
  notice: ReturnType<typeof createNoticePort>
} {
  const { paths, config, log } = wiring
  const { api, out } = host.need('platform')
  const bili = createBiliPort({
    http: systemHttp,
    credentialFile: paths.credentialFile,
    ffmpegPath: paths.ffmpeg,
    process: systemProcess,
    log,
    workRoot: paths.workRoot,
  })
  const chorus = createChorusPort({
    process: systemProcess,
    pythonPath: paths.chorusPython,
    scriptPath: chorusScriptPath(),
    log,
    timeoutMs: config().chorusTimeoutMs,
  })
  const cover = createCoverPort({
    process: systemProcess,
    pythonPath: paths.pythonPath,
    rvcRoot: paths.rvcRoot,
    ffmpegPath: paths.ffmpeg,
    // 三段各自超时：切口与裁剪是秒级，分离+推理是分钟级（本机实测 ~70 s / 45 s 片段）。
    timeoutMs: { cut: 30_000, cover: config().coverTimeoutMs, trim: 30_000 },
    log,
  })
  const voice = createVoicePort({ api, out, log, timeoutMs: config().sendTimeoutMs })
  const notice = createNoticePort({ api, out, log })
  return { bili, chorus, cover, voice, notice }
}

/** 终态通知：私聊要说明卡在哪一步；自主入口成功要记一次日额度。 */
function buildOnFinish(
  queueOf: () => SongQueue,
  notice: ReturnType<typeof createNoticePort>,
  clock: typeof systemClock,
): (event: SongFinished) => Promise<void> {
  return async (event) => {
    if (event.stage === 'sent' && event.request.entry === 'auto') {
      const day = (await import('./day.js')).songDayKey(clock.now())
      if (day !== null) await queueOf().noteAutoSent(day)
    }
    if (event.request.entry !== 'dm') return
    const text = finishText(event.stage, event.detail)
    if (text === null) return
    await notice.sendText(event.request.room, event.request.chatId, text)
  }
}

/** 建适配器 + 队列，provide 服务，注册工具面与后台资源，返回卸载器。 */
function wire(host: SubHost, wiring: Wiring): () => void {
  const { paths, config, clock, log, ownerId, dshHome } = wiring
  const adapters = buildAdapters(host, wiring)
  const gate = buildGate(
    config,
    async (room) => await host.get('contact')?.outboundBudget({ room, sender: 'song' })
      ?? { allowed: false, reason: 'contact-unavailable' },
    log,
  )
  const queue: SongQueue = new SongQueue({
    ...adapters,
    gate, clock, config, log,
    workRoot: paths.workRoot,
    ledgerFile: path.join(dshHome, 'channel-qq', 'song-ledger.json'),
    onFinish: buildOnFinish(() => queue, adapters.notice, clock),
    // 自主选歌实现注入到队列：主动联系经服务面调它，因此不必 import 这个目录。
    autoPick: async () => await autoPickOnce(host, clock, log),
  })
  runtimes.set(host, { queue, bili: adapters.bili })

  void queue.load().then(() => {
    log(`song: 就绪（队列上限 ${String(config().maxQueue)}，语音条 ${String(config().seconds)}s，`
      + `自主选歌曲目 ${String(config().autoSongs.length)} 条）`)
  }).catch((error: unknown) => {
    log(`song: 账本载入失败（${error instanceof Error ? error.message : String(error)}），按空账本跑`)
  })

  host.provide('song', queue)
  const removeTools = registerSpecs(host.bridge.toolHost(), songTools({
    queue, bili: adapters.bili, config, clock, log, ownerId,
  }), log, 'song')
  registerSongResource(host, queue, config, dshHome)
  return () => { removeTools() }
}
