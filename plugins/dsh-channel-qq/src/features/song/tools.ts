/** 点歌工具面：`qq_song_cover`（点一首）/ `qq_song_status`（看进度）/ `qq_song_cancel`（取消）。
 *
 * 为什么三件而不是一件：点歌是**异步**的（一首歌两三分钟），模型必须能立刻回一句
 * "收到"然后不管它。如果只有一个 `qq_song_cover` 且它等待完成，模型会卡三分钟——
 * 那期间用户说的话没人接。所以"入队"与"查进度"必然是两件事。
 *
 * 一条必须写明的边界：**工具不回话给用户，它只回答模型**。真正的"收到啦"是模型自己说的
 * （它拿到的就是一句人话）。所以这里的返回值全部是给人看的句子，不是错误码——
 * 模型照着念就行，不必再翻译一遍。
 *
 * **同名歌交给用户选**：搜索里"分不出哪条是你要的"是常态（同名不同歌、同名不同版本）。
 * 猜错一次发出去的是别的歌做的翻唱，撤不回。所以分不出来时返回候选清单，
 * 让用户给 BV 号——那也比猜好。
 */

import type { SongService } from './queue.js'
import { stageText, taskIdOf } from './queue.js'
import { describeCandidate, lookupSong, pickFemaleCover } from './select.js'
import { femaleCoverQuery, keyUpFor, singerGender, type SingerGender } from './gender.js'
import type { BiliPort, SongCandidate, SongEntry } from './types.js'
import type { SongConfig } from '../../config/sections/song.js'
import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { Clock } from '../../ports/clock.js'
import { splitRoom } from '../../core/room.js'

/** 工具需要的全部东西。 */
export interface SongToolDeps {
  /**
   * 队列面（就是 `SongService`，**不是** `SongQueue` 类）。
   *
   * 为什么收窄到接口：未配置外部路径时也要注册工具面（否则模型看不到这段功能存在），
   * 那时没有真队列、只有一个"一律拒绝"的替身。用类当类型就逼着实现里塞转型，
   * 而转型正是这套分层要防的东西。
   */
  readonly queue: SongService
  readonly bili: BiliPort
  readonly config: () => SongConfig
  readonly clock: Clock
  readonly log: (line: string) => void
  /** 主人在哪个 QQ（`admins[0]`；没有就是 null）。只进日志，不改变任何判定。 */
  readonly ownerId: number | null
}

/** 搜索结果最多留几条（再多用户也挑不过来）。 */
const SEARCH_LIMIT = 8

/** 从工具参数里收一个秒数（只认秒；认不出就当没给）。 */
function secondsArg(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(String(value))
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

/** 文本参数（去空白；空串当没给）。 */
function textArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 工具调用发生在哪个**私聊**房间里。
 *
 * 点歌只在私聊里成立：群聊点歌会把语音条发到群里、排两分钟队、还会被群友反复触发。
 * 所以对群聊/非 QQ 会话一律拒绝并说明原因——比"群里也能点但很吵"更好。
 */
export function dmRoomOfContext(agentId: string | undefined): string | null {
  if (agentId === undefined || !agentId.startsWith('qq-')) return null
  const room = agentId.slice('qq-'.length)
  const split = splitRoom(room)
  return split === null || split.isGroup ? null : room
}

/** 一次选歌的结果：`chosen === null` 表示要用户自己挑。 */
export interface Selection {
  readonly chosen: SongCandidate | null
  readonly shortlist: readonly SongCandidate[]
  readonly skipped: readonly { bvid: string; reason: string }[]
  /** 这次用的是男声源还是女声源（决定要不要升八度）；`unknown` = 证据不足。 */
  readonly gender: SingerGender
}

/**
 * 选源：有 BV 就直接确认它；否则搜 + 打分 + 判定"够不够确定"。失败抛（工具那边兜）。
 *
 * **女声优先**（`preferFemale`）走的是一条两段式搜索，顺序刻意写死：
 *   1. 先按用户给的（`歌名 歌手`）搜一次——**这是最准的一次**，别一上来就加"女声翻唱"，
 *      那会把原唱挤出前几名；
 *   2. 若选出来的那条是**男声**，再搜一次 `歌名 女声 翻唱`：找到就用它（女声源等价于
 *      "不用升调"）；找不到就退回原曲，由上层按 `maleKeyUp` 升八度。
 *
 * 第 2 步失败**不算失败**：它只是为了少升一次调。所以那里的异常只记日志、不进结果。
 */
export async function selectSource(
  bili: BiliPort,
  song: string,
  artist: string,
  bvid: string,
  log: (line: string) => void,
  options: { readonly preferFemale?: boolean } = {},
): Promise<Selection> {
  if (bvid !== '') {
    const info = await bili.videoInfo(bvid)
    log(`song: 指定 BV ${bvid}（${info.title} / ${info.author}）`)
    const fixed: SongCandidate = {
      bvid, title: info.title, author: info.author,
      duration: info.duration, play: 0, description: '',
    }
    return { chosen: fixed, shortlist: [], skipped: [], gender: singerGender(fixed) }
  }
  const query = artist === '' ? song : `${song} ${artist}`
  const found = await bili.search(query, SEARCH_LIMIT)
  const lookup = lookupSong(found, song, artist)
  for (const skip of lookup.skipped) log(`song: 跳过 ${skip.bvid}（${skip.reason}）`)
  if (lookup.chosen === null) {
    return { chosen: null, shortlist: lookup.candidates, skipped: lookup.skipped, gender: 'unknown' }
  }
  const gender = singerGender(lookup.chosen)
  log(`song: 初选 ${lookup.chosen.bvid} 是${gender === 'female' ? '女声' : gender === 'male' ? '男声' : '性别不明'}`)
  if (options.preferFemale !== true || gender !== 'male') {
    return { chosen: lookup.chosen, shortlist: lookup.candidates, skipped: lookup.skipped, gender }
  }
  // 男声原唱：再找一次女声翻唱。找到就换成它（女声源不用升调）。
  const alt = await searchFemaleCover(bili, song, artist, log)
  if (alt !== null) {
    log(`song: 改用女声翻唱 ${alt.bvid}（${alt.title}）`)
    return { chosen: alt, shortlist: [], skipped: lookup.skipped, gender: 'female' }
  }
  log(`song: 没有合适的女声翻唱，用原曲并把音轨升高八度（keyUp）`)
  return { chosen: lookup.chosen, shortlist: lookup.candidates, skipped: lookup.skipped, gender }
}

/**
 * 搜一次女声翻唱并挑一条。**挑不出来就返回 `null`**（不抛）：
 * 这一步是"锦上添花"，它失败只意味着接下来要升调，不意味着这次点歌失败。
 *
 * 判据在 `select.ts::pickFemaleCover`（与"点歌选原唱"刻意不同，理由写在那儿）。
 */
async function searchFemaleCover(
  bili: BiliPort,
  song: string,
  artist: string,
  log: (line: string) => void,
): Promise<SongCandidate | null> {
  let found: readonly SongCandidate[]
  try {
    found = await bili.search(femaleCoverQuery(song, artist), SEARCH_LIMIT)
  } catch (error) {
    log(`song: 找女声翻唱时搜索失败（${error instanceof Error ? error.message : String(error)}），退回原曲`)
    return null
  }
  const picked = pickFemaleCover(found, song)
  if (picked === null) {
    log(`song: 女声翻唱里没有能用的（${String(found.length)} 条都不像这首歌的女声版），退回原曲`)
    return null
  }
  return picked
}

/** 一句话说明"我为什么不能做"（每种原因都给出下一步）。 */
export function explainUnavailable(found: number, skipped: readonly { reason: string }[]): string {
  if (found === 0) return 'B站上没搜到这首歌（换个写法试试，或者直接给我 BV 号）'
  if (skipped.length > 0) {
    const reasons = [...new Set(skipped.map((item) => item.reason))].slice(0, 3).join('；')
    return `搜到的都不适合当原唱（${reasons}）。给我一条 BV 号，或者换个歌名写法`
  }
  return '搜到的都不像这首歌，给我一条 BV 号吧'
}

/** 候选清单的唯一拼法（工具返回、私聊回复、自主选歌失败提示共用一份）。 */
export function candidateLines(candidates: readonly SongCandidate[]): string {
  return candidates.map((candidate) => `- ${describeCandidate(candidate)}`).join('\n')
}

function qqSongCover(deps: SongToolDeps): ToolSpec {
  return {
    name: 'qq_song_cover',
    description: '点歌：去B站找原唱，下载音轨，找出副歌，用机器人的音色翻唱，然后把副歌那一段'
      + '发成语音条。**只在私聊里可用**。这一步只受理（会立刻回答），做好之后才发语音条；'
      + '同名歌分不出来时会把候选列出来让主人挑。',
    parameters: {
      type: 'object',
      properties: {
        song: { type: 'string', description: '歌名，例如「晴天」' },
        artist: { type: 'string', description: '歌手（给了就更准，例如「周杰伦」）' },
        bvid: { type: 'string', description: '已经选定的 B站视频 BV 号（有就跳过搜索）' },
        chorusSeconds: {
          type: 'number',
          description: '用户自己知道的副歌开始时间（秒）。给了就不再自动定位',
        },
        messageId: {
          type: 'string',
          description: '触发这次点歌的那条入站消息 id（用于去重；拿不到就不填）',
        },
      },
      required: ['song'],
    },
    run: async (args, context) => {
      const config = deps.config()
      const song = textArg(args.song)
      const artist = textArg(args.artist)
      const bvid = textArg(args.bvid)
      if (song === '' && bvid === '') throw new Error('点歌需要歌名或 BV 号')

      const refusal = refuseReason(config.enabled, context?.agentId)
      if (refusal !== null) return { accepted: false, note: refusal }
      const room = dmRoomOfContext(context?.agentId)
      if (room === null) return { accepted: false, note: '点歌只在私聊里可用' }

      const found = await pickCandidate(deps, song, artist, bvid)
      if (found.kind === 'error') return { accepted: false, note: found.note }
      if (found.kind === 'choose') {
        return {
          accepted: false,
          note: `这几条分不出哪条是你要的，挑一条告诉我（给我 BV 号就行）：\n${candidateLines(found.candidates)}`,
          candidates: found.candidates.map((candidate) => ({
            bvid: candidate.bvid, title: candidate.title, author: candidate.author,
          })),
        }
      }
      return await submit(deps, { room, song, artist, config }, { chosen: found.chosen, gender: found.gender }, args)
    },
  }
}

/** 能不能做这一步（返回拒收原因；能就 `null`）。 */
export function refuseReason(enabled: boolean, agentId: string | undefined): string | null {
  if (!enabled) return '点歌翻唱没有启用（后台「音乐」页打开「启用点歌翻唱」就能用了）'
  if (dmRoomOfContext(agentId) === null) {
    return '点歌只在私聊里可用：群里点歌会把语音条发到群里，也太吵了'
  }
  return null
}

/** 选源的三态结论（`choose` = 要用户挑，`error` = B站那边没成）。 */
type Picked =
  | { readonly kind: 'ok'; readonly chosen: SongCandidate; readonly gender: SingerGender }
  | { readonly kind: 'choose'; readonly candidates: readonly SongCandidate[] }
  | { readonly kind: 'error'; readonly note: string }

async function pickCandidate(
  deps: SongToolDeps,
  song: string,
  artist: string,
  bvid: string,
): Promise<Picked> {
  let selection: Selection
  try {
    selection = await selectSource(deps.bili, song, artist, bvid, deps.log, {
      preferFemale: deps.config().preferFemale,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    deps.log(`song: 选源失败：${reason}`)
    return { kind: 'error', note: `B站那边没成：${reason}` }
  }
  if (selection.chosen !== null) {
    return { kind: 'ok', chosen: selection.chosen, gender: selection.gender }
  }
  if (selection.shortlist.length === 0) {
    return { kind: 'error', note: explainUnavailable(0, selection.skipped) }
  }
  return { kind: 'choose', candidates: selection.shortlist }
}

/** 入队并回答（受理 / 去重 / 队列满都由队列判定）。 */
async function submit(
  deps: SongToolDeps,
  facts: { room: string; song: string; artist: string; config: SongConfig },
  picked: { readonly chosen: SongCandidate; readonly gender: SingerGender },
  args: Record<string, unknown>,
): Promise<unknown> {
  const chosen = picked.chosen
  const split = splitRoom(facts.room)
  if (split === null) return { accepted: false, note: `房间键不可用：${facts.room}` }
  const inbound = textArg(args.messageId)
  // 去重键：入站消息 id 优先（同一条消息被重放时得到同一个任务 id）。
  // 没有 message_id 时才退回"房间+歌名+毫秒"，那时确实无法判定是不是同一次。
  const dedupeKey = inbound === '' ? `dm:${facts.room}:${facts.song}:${String(deps.clock.now())}` : `msg:${inbound}`
  // 男声源升八度（`preferFemale` 关掉时也不升——那是操作员选的"别动我的音高"）。
  const keyUp = facts.config.preferFemale ? keyUpFor(picked.gender, facts.config.maleKeyUp) : 0
  const result = await deps.queue.enqueue({
    id: taskIdOf(dedupeKey),
    entry: 'dm' as SongEntry,
    room: facts.room,
    chatId: split.chatId,
    dedupeKey,
    song: facts.song === '' ? chosen.title : facts.song,
    artist: facts.artist,
    bvid: chosen.bvid,
    chorusAt: secondsArg(args.chorusSeconds),
    keyUp,
    requestedAt: deps.clock.now(),
  })
  deps.log(`song: qq_song_cover ${result.accepted ? '入队' : '未受理'}（${chosen.bvid}，keyUp=${String(keyUp)}）`)
  return {
    accepted: result.accepted,
    taskId: result.taskId,
    note: result.accepted
      ? `收到：用 B站「${chosen.title}」（${chosen.bvid}）做，`
        + `最多 ${String(facts.config.seconds)} 秒，收在一句歌词结束处`
        + `${keyUp > 0 ? `（男声源，人声升高 ${String(keyUp)} 个半音）` : ''}，做好就发`
      : result.note,
    source: { bvid: chosen.bvid, title: chosen.title, author: chosen.author, keyUp },
  }
}

function qqSongStatus(deps: SongToolDeps): ToolSpec {
  return {
    name: 'qq_song_status',
    description: '查看最近几条点歌的进度：卡在哪一步、发了没有、为什么失败。'
      + '用户问"我的歌好了没"时用它。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '看几条（默认 5，最多 20）' } },
      required: [],
    },
    run: async (args) => {
      const raw = Number(args.limit ?? 5)
      const limit = Number.isFinite(raw) ? Math.min(20, Math.max(1, Math.round(raw))) : 5
      const config = deps.config()
      const rows = deps.queue.status(limit)
      return {
        enabled: config.enabled,
        autoPick: config.autoPick,
        tasks: rows.map((row) => ({
          taskId: row.id,
          entry: row.entry,
          song: row.song,
          artist: row.artist,
          stage: row.stage,
          stageText: stageText(row.stage),
          bvid: row.bvid,
          chorusStart: row.chorusStart,
          seconds: row.seconds,
          detail: row.detail,
          messageId: row.messageId,
        })),
        note: rows.length === 0 ? '还没有点过歌' : `${String(rows.length)} 条记录`,
      }
    },
  }
}

function qqSongCancel(deps: SongToolDeps): ToolSpec {
  return {
    name: 'qq_song_cancel',
    description: '取消一首还在排队或正在做的点歌。已经发出去的语音条撤不回来。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '`qq_song_status` 里看到的 taskId' },
        reason: { type: 'string', description: '为什么取消（只进日志）' },
      },
      required: ['taskId'],
    },
    run: async (args) => {
      const taskId = textArg(args.taskId)
      if (taskId === '') throw new Error('taskId 不能为空')
      const reason = textArg(args.reason)
      const done = await deps.queue.cancel(taskId, reason === '' ? '被要求取消' : reason)
      return {
        cancelled: done,
        note: done ? '取消了' : '没有找到这条在排队/正在做的任务（可能已经结束）',
      }
    },
  }
}

/** 组装这一组工具。 */
export function songTools(deps: SongToolDeps): ToolSpec[] {
  return [qqSongCover(deps), qqSongStatus(deps), qqSongCancel(deps)]
}
