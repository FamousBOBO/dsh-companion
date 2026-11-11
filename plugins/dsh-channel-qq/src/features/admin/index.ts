/** 后端子插件（P5.1/P5.5）：管理面板的生命周期、状态快照、预设与会话管理。
 *
 * 面板本体在 `src/admin.ts`（HTTP 面、密码门禁、配置管线）——这里只做三件事：
 *   - 装配：把 `AdminDeps` 从服务袋与桥里接出来。资源表是**活对象**：每个功能
 *     子插件自己 `registerResource`（P5.3 之后这里不再认识任何 store）；
 *   - 热重载：`admin.port/host/enabled/password` 改了就地 `relisten()`（对齐旧
 *     `applyEffects` 的 admin 分支）。`admin.host` "重启才彻底生效"的语义在
 *     `admin.ts` 的 `touchedRestartPaths` 里，没动；
 *   - 工具数：直读 `adapters/dsh-host/tools.ts` 的注册表（P5.5 修 B11——旧实现
 *     去日志尾巴里数 `registered N/M tools`，日志一封顶数字就漂）。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { AdminServer, type AdminDeps } from '../../admin.js'
import { WorkspaceFiles } from '../../workspace-files.js'
import { sessionDir, encodeSegment } from '../../paths.js'
import { formatLocalStamp } from '../../core/schedule/stamp.js'
import { registeredToolCount } from '../../adapters/dsh-host/tools.js'
import { expressionDiagnosticsOf } from '../../adapters/dsh-host/expression-service.js'
import { expressionVisibilityOf } from './tool-visibility-probe.js'
import type { QQChannelConfig } from '../../config.js'
import type { RunnerStatus } from '../reminders/runner-status.js'
import type { SubHost, SubPlugin } from '../plugin-kit.js'
import { publishStudioBridge } from './studio-bridge.js'

/** host → 实例：apply 建、start 启、reload 重绑、dispose 收，四处拿同一个对象。 */
const servers = new WeakMap<SubHost, AdminServer>()

/** Tail of `channel-qq.log`, newest last. */
async function readLogTail(host: SubHost, lines: number): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(host.dshHome, 'channel-qq.log'), 'utf-8')
    return raw.split('\n').filter((line) => line !== '').slice(-lines)
  } catch {
    return []
  }
}

/** 群列表最多等这么久：NapCat 忙/卡时 `getGroupList` 可能永远不回，后台不能被它拖死。
 *
 * 2026-10-21 线上：`/api/snapshot` 因为这一步挂住 30 秒以上，而**所有页面**的
 * 资源表都以 snapshot 的 meta 为准——于是"好多页面看不到数据"。
 */
const GROUP_LIST_TIMEOUT_MS = 3_000

/** Live snapshot for the admin panel's overview tab（工具数直读注册表）。 */
/**
 * **提醒相关的四个数**（`buildStatus` 的一部分，抽出来压函数行数）。
 *
 * 口径（全部**同一份来源**，前端不自己算）：
 *   - `pendingReminders`：还没触发的条数；
 *   - `pendingDispatch`：`occurrence-dispatched` 积压（与 `/api/resource/reminders` 同源，
 *     runner 每拍还会打 `reminders: pendingDispatch value=… oldestAgeMs=… overLimit=…` 供 grep）；
 *   - `catchUp`：防雪崩（`backlog` 在等补发、`dropped` 因积压被丢）；
 *   - `remindersReadLock`（round9）：非 `null` ⇒ 盘上文件**读不出来**，此时内存是空表，
 *     **`待发提醒 0` 不代表"没有提醒"**；后台要显示"读失败，数据不可读"，不许拿 0 冒充。
 *   - `remindersRunner`（round18）：轮询器的**只读现场**（`halted` / `haltReason` / 软故障连击）。
 *     这一档以前**没有任何出口**：停表之后日志只有一行、而后台看起来"一切正常"（round17 §1-17.2）。
 */
function reminderStatusOf(host: SubHost): {
  pendingReminders: number
  pendingDispatch: { value: number; oldestAgeMs: number; overLimit: number }
  catchUp: { backlog: number; dropped: number; windowMs: number; maxTotal: number }
  remindersReadLock: { at: number; reason: string; source: string; detail: string } | null
  remindersRunner: RunnerStatus | null
} {
  const reminders = host.get('reminders')
  return {
    pendingReminders: reminders?.list(1000).filter((r) => !r.fired).length ?? 0,
    pendingDispatch: reminders?.dispatchDiagnostics() ?? { value: 0, oldestAgeMs: 0, overLimit: 0 },
    catchUp: reminders?.catchUpDiagnostics() ?? { backlog: 0, dropped: 0, windowMs: 0, maxTotal: 0 },
    remindersReadLock: reminders?.readFailure() ?? null,
    // 没有 runner（提醒子插件没装 / 装配失败）⇒ `null`，**不许**编一个 "halted: false" 冒充"在跑"。
    remindersRunner: host.get('remindersRunner')?.status() ?? null,
  }
}

export async function buildStatus(host: SubHost, startedAt: number): Promise<Record<string, unknown>> {
  const { config } = host
  const parts = host.get('platform')
  const client = parts?.client ?? null
  const platform = parts?.platform ?? null
  const connected = platform?.isConnected() === true
  const raw = platform !== null && connected
    ? await withTimeout(platform.api.getGroupList().catch(() => null), GROUP_LIST_TIMEOUT_MS)
    : null
  const groups = Array.isArray(raw) ? raw as Array<{ group_id?: number; group_name?: string }> : []
  const emoji = host.get('emoji')
  const flood = host.get('flood')
  const learn = host.get('learn')
  return {
    qqConnected: connected,
    selfId: client?.selfId ?? config.selfId,
    connection: `${config.connection.mode} · ${config.connection.url}`,
    groups: connected ? groups.length : '未连接',
    groupList: groups.slice(0, 30).map((g) => `${g.group_id ?? '?'} ${g.group_name ?? ''}`.trim()),
    /** 结构化群列表：后台「群聊与房间」页的逐群开关表要 id + 名字。 */
    groupsDetail: groups
      .map((g) => ({ id: Number(g.group_id ?? 0), name: String(g.group_name ?? '') }))
      .filter((g) => g.id > 0),
    primaryGroup: config.primaryGroup,
    master: config.admins[0] ?? null,
    workspace: config.workspacePath,
    tools: registeredToolCount(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    emojiIndexed: emoji?.library.list(100000).length ?? 0,
    quotes: host.get('quotes')?.stats().total ?? 0,
    ...reminderStatusOf(host),
    rssFeeds: config.rss.feeds.filter((f) => f.enabled).length,
    floodTracked: flood?.stats().tracked ?? 0,
    floodTriggered: flood?.stats().triggered ?? 0,
    learnedPhrases: learn?.stats().tracked ?? 0,
    linkResolve: config.linkResolve.enabled
      ? (config.linkResolve.autoGroups.length > 0 ? `自动出卡：${config.linkResolve.autoGroups.join(',')}` : '仅工具调用')
      : '已关闭',
    tts: config.tts.enabled ? config.tts.voice : '已关闭',
    imageGen: config.imageGen.enabled ? `${config.imageGen.provider}/${config.imageGen.model}` : '已关闭',
    // 表情包链路的三层证据（docs/11 P0-2 / P1）：模块挂没挂、工具注册没注册、会话与
    // 发送器可不可见。**脱敏**：只有工具名与三态，没有路径、URL、QQ 号、消息内容。
    expressionVisibility: expressionVisibilityOf(host),
    // 图库自己的只读状态：素材数、每个会话的可用面、最近一次候选/发图的结果码与回执。
    // 「配置已保存」与「真的发出去过」在这里是两格不同的字段。
    expression: expressionDiagnosticsOf(
      () => { try { return host.bridge.toolHost() } catch { return undefined } },
      expressionTargetsOf(host, config),
    ),
  }
}

/**
 * 诊断要看的会话目标：主人私聊（README/后台都按 `admins[0]` 认主人）与主群。
 *
 * 只取这两个**已知存在**的目标，不从群列表里猜：群列表是网络往返（`getGroupList`），
 * 诊断不该为此多付一次请求，也不该在没有授权的情况下把陌生群号写进状态里。
 */
function expressionTargetsOf(host: SubHost, config: QQChannelConfig): Array<{ kind: 'dm' | 'group'; chatId: number }> {
  const targets: Array<{ kind: 'dm' | 'group'; chatId: number }> = []
  const owner = config.admins[0]
  if (typeof owner === 'number' && owner > 0) targets.push({ kind: 'dm', chatId: owner })
  const group = config.primaryGroup
  if (typeof group === 'number' && group > 0) targets.push({ kind: 'group', chatId: group })
  return targets
}

/** 等一会儿；超时返回 null（调用方按"这次没拿到"处理，不抛错）。 */
async function withTimeout<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Adapter over the harness's `agentPresets` registry（文案与旧 `presetAdmin` 一字不差）。
 *
 * The registry is read-only by design; "editing the persona" goes through the
 * workspace files and `select` (which runs the panel's own applyConfigPatch so it
 * is persisted like any other setting).
 */
function presetAdmin(host: SubHost): NonNullable<AdminDeps['presets']> {
  const registry = host.bridge.presetRegistry()
  return {
    current: () => host.config.agentPreset,
    list: async () => {
      if (registry === undefined) throw new Error('预设注册表不可用')
      return (await registry.list()).map((preset) => ({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        broken: preset.broken,
      }))
    },
    doc: async (id) => {
      if (registry === undefined) throw new Error('预设注册表不可用')
      const document = await registry.readDocument(id)
      return {
        id: document.agentPreset,
        content: document.content,
        name: document.name,
        description: document.description,
      }
    },
    select: async (id) => {
      if (registry === undefined) throw new Error('预设注册表不可用')
      const wanted = id.trim()
      if (wanted === '') throw new Error('没有选择预设')
      // Resolving first turns "typo" into a clear error instead of a preset that
      // silently fails to mount on the next message.
      try {
        await registry.resolve(wanted)
      } catch {
        const available = (await registry.list().catch(() => [])).map((preset) => preset.id)
        throw new Error(`没有名为「${wanted}」的预设。可用的有：${available.join('、')}`)
      }
      const before = host.config.agentPreset
      if (before === wanted) return `已经在用「${wanted}」了`
      const result = await servers.get(host)?.applyConfigPatch({ agentPreset: wanted })
      return `预设「${before}」→「${wanted}」。对**新建**会话生效；已有会话要立刻生效，请用下面的「重建会话」。${result?.note ?? ''}`
    },
  }
}

/** 列出落盘的 `qq-*` 会话目录（后台「重建会话」页）。 */
async function sessionList(host: SubHost): Promise<Array<{ room: string; sessionId: string; files: number; bytes: number; mtime: number }>> {
  const projectDir = path.dirname(sessionDir(host.config.workspacePath ?? undefined, 'placeholder'))
  const names = await fs.readdir(projectDir).catch(() => [] as string[])
  const sessions: Array<{ room: string; sessionId: string; files: number; bytes: number; mtime: number }> = []
  for (const name of names) {
    // **只列 QQ 房间会话**：项目目录里还躺着 Web/自动化会话（UUID 名），
    // 把它们当房间列出来，点「重建」会拼成 `qq-<uuid>`——静默无效（2026-10-19 排查）。
    if (!name.startsWith('qq-')) continue
    const full = path.join(projectDir, name)
    const stat = await fs.stat(full).catch(() => null)
    if (stat === null || !stat.isDirectory()) continue
    const files = await fs.readdir(full).catch(() => [] as string[])
    let bytes = 0
    let mtime = stat.mtimeMs
    for (const file of files) {
      const info = await fs.stat(path.join(full, file)).catch(() => null)
      if (info !== null && info.isFile()) {
        bytes += info.size
        mtime = Math.max(mtime, info.mtimeMs)
      }
    }
    sessions.push({
      room: name.slice(3),
      sessionId: name,
      files: files.length,
      bytes,
      mtime,
    })
  }
  sessions.sort((a, b) => b.mtime - a.mtime)
  return sessions
}

/** 拆掉一个会话（活 agent / 内存记录 / 历史文件移到备份），让新指令从下一轮生效。 */
async function sessionRebuild(host: SubHost, room: string): Promise<{ room: string; moved: boolean; files: number; note: string }> {
  // 允许调用方传 `group-123` 或 `qq-group-123`，统一成房间键。
  const clean = room.trim().replace(/^qq-/, '')
  if (clean === '') throw new Error('没有指定会话')
  const sessionId = `qq-${clean}`
  const notes: string[] = []

  const agents = host.bridge.agentRegistry()
  const wasLive = agents?.get(sessionId) !== undefined

  // Tear the live agent down through the *bridge's own handle*：注册表的 get()
  // 返回的裸 Agent 拿不到 dispose，直接移走历史会让运行中的 agent 每轮 ENOENT。
  const registry = host.get('inbound')?.registry ?? null
  const dropped = registry !== null && await registry.dispose(clean)
  if (dropped) notes.push('已释放运行中的 agent')
  if (registry?.forget(clean) === true) notes.push('已清掉会话内存记录')

  if (agents?.get(sessionId) !== undefined) {
    notes.push(wasLive
      ? '这个会话的 dispose 能力不在本插件手里（是别的持有者创建的），历史文件保持不动——移走会让运行中的 agent 每轮都报 ENOENT。请重启插件后再重建。'
      : '注册表里仍挂着该会话，历史文件保持不动，请重启插件后再重建。')
    host.log(`admin: rebuilt session ${sessionId} REFUSED (agent still live) :: ${notes.join('; ')}`)
    return { room: clean, moved: false, files: 0, note: notes.join('；') }
  }

  const dir = sessionDir(host.config.workspacePath ?? undefined, sessionId)
  const exists = await fs.stat(dir).catch(() => null)
  // `files` 是真的移走了几个文件；旧字段 `removed` 是个 0/1 标志，审计里被当成
  // "文件数"读（2026-10-19 排查）。
  let movedFiles = 0
  if (exists !== null) {
    movedFiles = (await fs.readdir(dir).catch(() => [] as string[])).length
    const stamp = formatLocalStamp(new Date()).replace(/[:.]/g, '-')
    const backup = path.join(host.dshHome, 'channel-qq', 'backups', `session-${stamp}-${encodeSegment(sessionId)}`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(dir, backup)
    notes.push(`历史已移到备份：${backup}（${movedFiles} 个文件）`)
  } else {
    notes.push('没有找到该会话的历史文件')
  }
  host.log(`admin: rebuilt session ${sessionId} :: ${notes.join('; ')}`)
  return { room: clean, moved: exists !== null, files: movedFiles, note: notes.join('；') }
}

/** 面板依赖的装配（status/readLog/prompt/applyEffects/resources/files/presets/sessions）。 */
function adminDeps(host: SubHost, startedAt: number): AdminDeps {
  return {
    config: host.config,
    dshHome: host.dshHome,
    log: host.log,
    status: async () => await buildStatus(host, startedAt),
    readLog: async (lines: number) => await readLogTail(host, lines),
    prompt: async (text: string) => {
      const inbound = host.get('inbound')
      if (inbound === undefined) throw new Error('channel not ready')
      await inbound.turns.adminPrompt(text)
      return { submitted: text.slice(0, 80) }
    },
    applyEffects: async (patch: Record<string, unknown>) => await host.reloadSections(patch),
    resources: host.resources,
    files: new WorkspaceFiles(
      () => host.config.workspacePath,
      path.join(host.dshHome, 'channel-qq', 'backups'),
      host.log,
    ),
    presets: presetAdmin(host),
    sessions: {
      list: async () => await sessionList(host),
      rebuild: async (room: string) => await sessionRebuild(host, room),
    },
    providers: host.bridge.providersSurface(),
    // 发送侧探针：platform 提供；没有时这条路由回答 503（脚本据此判未知）。
    health: () => {
      const probe = host.get('health')
      if (probe === undefined) throw new Error('健康探测未就绪（platform 未挂载）')
      return probe.check()
    },
  }
}

export const adminPlugin: SubPlugin = {
  name: 'admin',
  // 与旧 `applyEffects` 的 admin 分支一一对应：这四把旋钮动了才重绑监听。
  watches: ['admin.port', 'admin.host', 'admin.enabled', 'admin.password'],
  requires: ['platform', 'inbound'],
  apply(host) {
    const server = new AdminServer(adminDeps(host, Date.now()))
    servers.set(host, server)
    const unpublish=publishStudioBridge(host,server)
    return () => {
      unpublish()
      const current = servers.get(host)
      servers.delete(host)
      current?.stop()
    }
  },
  async start(host) {
    const server = servers.get(host)
    if (server === undefined) return
    try {
      await server.start()
    } catch (error) {
      // A busy port must not take the whole channel down; the QQ side is the
      // product, the panel is an accessory.（失败后从表里摘掉 = 旧实现把
      // `this.admin` 置 null：后续 relisten 不再发生。）
      host.log(`admin panel failed to start: ${error instanceof Error ? error.message : String(error)}`)
      servers.delete(host)
    }
  },
  async reload(host) {
    const server = servers.get(host)
    if (server === undefined) return []
    return [await server.relisten()]
  },
}
