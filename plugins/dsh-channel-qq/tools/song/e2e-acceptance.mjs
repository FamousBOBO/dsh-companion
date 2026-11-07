/**
 * 点歌链路的**真机验收脚本**（手动跑，不进 `npm test`）。
 *
 * 为什么要有它：`npm test` 里的点歌测试全部用假端口（不联网、不起 python、不发 QQ），
 * 那证明的是"代码逻辑"，不是"这条链路真的能出声音"。这个脚本把真实的四步全跑一遍：
 * B站搜索 → 下载音轨 → 副歌定位（真 python + librosa）→ RVC 翻唱（真显卡 + March7 模型）
 * → 经 NapCat 发一条 QQ 语音条。
 *
 * **它是显式触发的**：默认 `--dry` 只跑链路、把语音条复制到 `--keep` 供人试听；
 * 要真发必须显式 `--send`（并且还需要 NapCat 的环境变量）。
 *
 * 用法（在插件目录下，先 `npm run build`）：
 *   node tools/song/e2e-acceptance.mjs --song 晴天 --artist 周杰伦 --dry --keep out.mp3
 *   node tools/song/e2e-acceptance.mjs --song 晴天 --artist 周杰伦 --send
 *
 * 环境（缺一个就明确报错，不猜）：
 *   RVC_PYTHON / RVC_ROOT   RVC 解释器与仓库目录（必需）
 *   BILI_CREDENTIAL         bili_credential.json 路径（不给就匿名，搜索多半被风控）
 *   DSH_HOME                套件数据根（决定凭据与工作目录的默认位置）
 *   CHANNEL_QQ_E2E_URL      NapCat 的 OneBot 地址，如 ws://127.0.0.1:3001（--send 必需）
 *   CHANNEL_QQ_E2E_TOKEN    access token（NapCat 配了才有）
 *   CHANNEL_QQ_E2E_TARGET   收语音条的私聊 QQ 号（主人，--send 必需）
 *
 * 输出逐行给证据，不打印"成功"二字：选中的 BV / 副歌起点与置信度 / 语音条时长与体积 /
 * **平台回执 message_id**（那是"真的发出去了"的唯一证据）。
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(HERE, '..', '..', 'build', 'lib')
if (!existsSync(path.join(LIB, 'config.js'))) {
  console.error(`没有 ${LIB}：先跑 npm run build（这个脚本跑的是构建产物，不是源码）`)
  process.exitCode = 2
  throw new Error('no build')
}

const fromLib = async (rel) => await import(pathToFileURL(path.join(LIB, rel)).href)
const { resolveConfig } = await fromLib('config.js')
const { OneBotClient } = await fromLib('onebot.js')
const { createQQApi } = await fromLib(path.join('adapters', 'onebot', 'qq-api.js'))
const { OutboundQueue } = await fromLib('outbound.js')
const { systemHttp } = await fromLib(path.join('adapters', 'http', 'client.js'))
const { systemProcess } = await fromLib(path.join('adapters', 'song', 'process.js'))
const { createBiliPort } = await fromLib(path.join('adapters', 'song', 'bili.js'))
const { createChorusPort } = await fromLib(path.join('adapters', 'song', 'chorus.js'))
const { createCoverPort } = await fromLib(path.join('adapters', 'song', 'cover.js'))
const { createVoicePort } = await fromLib(path.join('adapters', 'song', 'voice.js'))
const { SongQueue } = await fromLib(path.join('features', 'song', 'queue.js'))
const { buildGate, resolveSongPaths, chorusScriptPath } = await fromLib(path.join('features', 'song', 'index.js'))
const { selectSource } = await fromLib(path.join('features', 'song', 'tools.js'))
const { songDayKey } = await fromLib(path.join('features', 'song', 'day.js'))
const { keyUpFor, genderText } = await fromLib(path.join('features', 'song', 'gender.js'))

const log = (line) => { console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`) }

/**
 * 收场哨兵。
 *
 * 为什么不用 `process.exit()`：Windows 上 WebSocket 句柄还没关完就 exit，libuv 会
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c` 并把退出码
 * 变成 1——脚本"失败"但看不出真正的退出码。抛哨兵 → 顶层 catch → 关连接 → 设 `exitCode`。
 */
class Stop extends Error {
  constructor(code) { super(`stop(${String(code)})`); this.code = code }
}
const die = (code) => { throw new Stop(code) }

/** 收参数（只认长选项，够用）。 */
function parseArgs(argv) {
  const out = { send: false, dry: false, song: '', artist: '', bvid: '', chorusSeconds: null, keep: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = () => argv[i + 1] ?? ''
    if (token === '--send') out.send = true
    else if (token === '--dry') out.dry = true
    else if (token === '--song') { out.song = next(); i += 1 }
    else if (token === '--artist') { out.artist = next(); i += 1 }
    else if (token === '--bvid') { out.bvid = next(); i += 1 }
    else if (token === '--chorus') { out.chorusSeconds = Number(next()); i += 1 }
    else if (token === '--keep') { out.keep = next(); i += 1 }
    else { console.error(`认不得的参数：${token}`); die(2) }
  }
  if (!out.send && !out.dry) { console.error('必须显式给 --dry（只做不发）或 --send（真发一条语音条）'); die(2) }
  if (out.song === '' && out.bvid === '') { console.error('要给 --song（歌名）或 --bvid'); die(2) }
  return out
}

/** 读环境变量；缺了就说清缺哪个（不猜默认值）。 */
function need(name) {
  const value = (process.env[name] ?? '').trim()
  if (value === '') { console.error(`缺环境变量 ${name}`); die(2) }
  return value
}

/** 演练模式：把成品复制到指定路径（人才能真的听一遍）。 */
function keepCopy(keep, file) {
  if (keep === '') return
  mkdirSync(path.dirname(keep), { recursive: true })
  copyFileSync(file, keep)
  log(`成品已复制到 ${keep}（${String(statSync(keep).size)} 字节）`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'song-e2e-'))

  // ── 配置：把点歌段指到这台机器上真实存在的东西 ──────────────────────────────
  const songPatch = {
    enabled: true,
    autoPick: false,
    // `--send` 才允许真发；`--dry` 走演练模式（跑完全链路但不投递）。
    dryRun: args.dry,
    allowExternalSend: args.send,
    pythonPath: need('RVC_PYTHON'),
    rvcRoot: need('RVC_ROOT'),
    chorusPython: process.env['RVC_PYTHON'] ?? '',
    biliCredentialFile: process.env['BILI_CREDENTIAL'] ?? '',
    workRoot,
    ffmpegPath: process.env['FFMPEG_PATH'] ?? 'ffmpeg',
  }
  const config = resolveConfig({}, { song: songPatch })
  log(`点歌段：seconds=${String(config.song.seconds)} dryRun=${String(config.song.dryRun)} allowExternalSend=${String(config.song.allowExternalSend)}`)
  const paths = resolveSongPaths(config.song, process.env['DSH_HOME'] ?? path.join(os.homedir(), '.dsh'))
  if (paths === null) { console.error('外部路径没配全'); die(2) }
  log(`RVC：python=${paths.pythonPath} root=${paths.rvcRoot} makeCover=${paths.makeCover}`)
  log(`凭据：${existsSync(paths.credentialFile) ? '找到' : '没找到（本次匿名，搜索大概率被风控）'} ${paths.credentialFile}`)

  // ── 真实适配器（除了发送，其余都是真的） ────────────────────────────────────
  const bili = createBiliPort({
    http: systemHttp, credentialFile: paths.credentialFile, ffmpegPath: paths.ffmpeg,
    process: systemProcess, log, workRoot,
  })
  const chorus = createChorusPort({
    process: systemProcess, pythonPath: paths.chorusPython, scriptPath: chorusScriptPath(),
    log, timeoutMs: config.song.chorusTimeoutMs,
  })
  const coverBase = createCoverPort({
    process: systemProcess, pythonPath: paths.pythonPath, rvcRoot: paths.rvcRoot, ffmpegPath: paths.ffmpeg,
    timeoutMs: { cut: 30_000, cover: config.song.coverTimeoutMs, trim: 30_000 }, log,
  })
  // 演练模式在闸门那里就被拦下（正确语义：不算发过），所以成品要在**离开任务目录之前**捞出来。
  const keep = args.keep
  const cover = {
    async render(input) {
      const result = await coverBase.render(input)
      if (args.dry) keepCopy(keep, result.voiceFile)
      return result
    },
  }

  // ── 选源（真实 B站搜索） ────────────────────────────────────────────────────
  const startedAt = Date.now()
  const selection = await selectSource(bili, args.song, args.artist, args.bvid, log, {
    preferFemale: config.song.preferFemale,
  })
  if (selection.chosen === null) {
    log(`没选出唯一原唱（候选 ${String(selection.shortlist.length)} 条，跳过 ${String(selection.skipped.length)} 条）`)
    for (const row of selection.shortlist) log(`  候选：${row.title} — ${row.author}（${row.bvid}）`)
    for (const row of selection.skipped) log(`  跳过：${row.bvid}（${row.reason}）`)
    die(3)
  }
  const chosen = selection.chosen
  // 与正式入口同一条准则：尽量女声；确定是男声才升八度。
  const keyUp = config.song.preferFemale ? keyUpFor(selection.gender, config.song.maleKeyUp) : 0
  log(`选中：${chosen.title} — ${chosen.author}（${chosen.bvid}，${String(Math.round(chosen.duration))}s）`)
  log(`性别判定：${selection.gender}；${genderText(selection.gender, keyUp)}（本次 keyUp=${String(keyUp)}）`)

  // ── QQ 发送（--send 才连 NapCat） ───────────────────────────────────────────
  let api = null
  let out = null
  let client = null
  try {
    if (args.send) {
      client = new OneBotClient(
        { mode: 'forward', url: need('CHANNEL_QQ_E2E_URL') },
        process.env['CHANNEL_QQ_E2E_TOKEN'] ?? undefined,
        log,
      )
      client.start()
      const deadline = Date.now() + 15_000
      while (!client.isConnected() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      if (!client.isConnected()) { console.error('连不上 NapCat（检查 CHANNEL_QQ_E2E_URL / token / NapCat 是否在跑）'); die(4) }
      log('NapCat 已连接')
      api = createQQApi(client)
      out = new OutboundQueue(api, config, log)
    } else {
      log('（--dry：不连 NapCat、不发语音条）')
    }

    // ── 队列：真实流水线本体 ──────────────────────────────────────────────────
    const target = args.send ? Number(need('CHANNEL_QQ_E2E_TARGET')) : 0
    const voice = args.send
      ? createVoicePort({ api, out, log, timeoutMs: config.song.sendTimeoutMs })
      : {
          // 演练模式的替身：到这里说明闸门**没有**拦（演练时会被拦，走不到这里）。
          async sendVoice() { return { ok: false, messageId: null, unknown: false, detail: '演练模式（脚本层没有真发）' } },
        }
    const gate = buildGate(() => config.song, async () => ({ allowed: true, reason: 'e2e-script' }), log)
    const queue = new SongQueue({
      bili, chorus, cover, voice, gate,
      clock: {
        now: () => Date.now(), date: () => new Date(),
        setTimeout: () => ({ cancel() {} }), setInterval: () => ({ cancel() {} }),
      },
      config: () => config.song,
      log,
      workRoot,
      ledgerFile: path.join(workRoot, 'ledger.json'),
      onFinish: (event) => {
        log(`终态：${event.stage}${event.detail === null ? '' : `（${event.detail}）`}`)
        log(`  副歌起点 ${String(event.chorusStart)}s，语音条 ${String(event.seconds)}s，B站 ${String(event.bvid)}`)
      },
    })
    await queue.load()

    const day = songDayKey(Date.now()) ?? ''
    const result = await queue.enqueue({
      id: `e2e-${stamp}`,
      entry: 'dm',
      room: args.send ? `dm-${String(target)}` : 'dm-0',
      chatId: target,
      dedupeKey: `e2e:${stamp}`,
      song: args.song === '' ? chosen.title : args.song,
      artist: args.artist,
      bvid: chosen.bvid,
      chorusAt: args.chorusSeconds,
      keyUp,
      requestedAt: Date.now(),
    })
    log(`入队：${result.accepted ? '受理' : '未受理'} ${result.taskId ?? ''}（${result.note}）`)
    if (!result.accepted) die(5)

    // 等终态（最长 10 分钟：分离 + 推理在这台机器上约 70–90 秒，慢机器要留余量）。
    const terminal = ['sent', 'dry-run', 'failed', 'unknown-send', 'cancelled']
    const waitUntil = Date.now() + 600_000
    for (;;) {
      const row = queue.status(20).find((task) => task.id === result.taskId)
      if (row !== undefined && terminal.includes(row.stage)) {
        log('———— 结论 ————')
        log(`阶段：${row.stage}`)
        log(`副歌起点：${String(row.chorusStart)}s，语音条长度：${String(row.seconds)}s`)
        log(`失败说明：${row.detail === null ? '（无）' : row.detail}`)
        log(`QQ 回执 message_id：${row.messageId === null ? '（没有回执）' : String(row.messageId)}`)
        log(`总耗时：${String(((Date.now() - startedAt) / 1000).toFixed(1))}s`)
        log(`账本：${path.join(workRoot, 'ledger.json')}（${day === '' ? '日键算不出' : `今天 ${day}`}）`)
        if (args.send && row.messageId !== null) {
          log('证据等级：real-send（平台给了 message_id）——请到 QQ 里听那一条语音条')
        } else if (args.send) {
          log('证据等级：不足——没有拿到 message_id，不能说"发出去了"')
        }
        return
      }
      if (Date.now() > waitUntil) { console.error('等超时：任务没有进终态'); die(6) }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  } finally {
    // 收尾：先停 WS，再让进程自己走（不 `process.exit`，见 `Stop` 的注释）。
    client?.stop()
  }
}

try {
  await main()
} catch (error) {
  if (error instanceof Stop) {
    process.exitCode = error.code
  } else {
    console.error(error)
    process.exitCode = 1
  }
}
