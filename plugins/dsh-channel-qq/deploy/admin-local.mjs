/** 本地后台实例：给「管理后台 E2E」起一个带假依赖的真后台（端口默认 8791）。
 *
 * 为什么需要它（内部文档 §9）：真后台只在服务器上跑，`deploy/admin-test.mjs`
 * 从开发机连不到。这个脚本用**真实的** AdminServer + 真实的生成 UI（`/ui/**`），
 * 只把"插件世界"换成一组桩：状态、资源表、工作区文件（真 WorkspaceFiles，指向临时
 * 目录）、预设、会话、日志尾部、applyEffects（重听端口）。于是：
 *
 *   node deploy/admin-local.mjs start     # 后台起在 8791，打印 URL 与密码
 *   DSH_ADMIN_BASE=http://127.0.0.1:8791 DSH_ADMIN_PASSWORD=… DSH_ADMIN_SKIP_PUBLIC=1 \
 *     node deploy/admin-test.mjs          # 跑 E2E
 *   node deploy/admin-local.mjs stop
 *
 * 也可被 `scripts/probe-admin-layout.mjs` 直接 import（`startLocalAdmin`）。
 * 密码默认 `admin-local-test-password`（≥12 位）；可用 DSH_ADMIN_PASSWORD 覆盖。
 * 数据全在临时目录（DSH_ADMIN_LOCAL_HOME 可指到别处），进程退出即丢。
 */

import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STATE_FILE = path.join(os.tmpdir(), 'dsh-admin-local-state.json')
export const LOCAL_PASSWORD_DEFAULT = 'admin-local-test-password'
/** 与 AuthManager 的约定（`channel-qq/admin-password.json` 之外的第一来源）。 */
const PASSWORD_ENV = 'CHANNEL_QQ_ADMIN_PASSWORD'

/** `lib/` 是部署产物；本地 E2E 依赖它，缺了就先构建（幂等，构建过就跳过）。 */
function ensureBuilt() {
  if (existsSync(path.join(root, 'build', 'lib', 'admin.js'))) return
  console.log('[admin-local] build/lib 不存在，先执行 npm run build …')
  execSync('npm run build', { cwd: root, stdio: 'inherit', shell: true })
}

async function loadModules() {
  ensureBuilt()
  const admin = await import('#lib/admin.js')
  const configModule = await import('#lib/config.js')
  const filesModule = await import('#lib/workspace-files.js')
  return { AdminServer: admin.AdminServer, resolveConfig: configModule.resolveConfig, WorkspaceFiles: filesModule.WorkspaceFiles }
}

/** 一份像样的工作区（人格页的文件树、AGENTS.md 字节数断言都吃它）。 */
function seedWorkspace(workspace) {
  mkdirSync(path.join(workspace, 'memory'), { recursive: true })
  mkdirSync(path.join(workspace, 'notes'), { recursive: true })
  mkdirSync(path.join(workspace, 'scripts'), { recursive: true })
  writeFileSync(path.join(workspace, 'AGENTS.md'), [
    '# 玲儿（本地测试实例）',
    '',
    '你是 QQ 群「测试群」里的助手机器人，说话简短、自然。',
    '这个文件是本地后台 E2E 的种子内容，随便改——改完记得用「重建会话」让新指令生效。',
    '',
    '## 约定',
    '- 群聊默认 @ 才回复；私聊直接回。',
    '- 不确定的事不要编。',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(path.join(workspace, 'MEMORY.md'), '# 长期记忆\n\n- 学弟喜欢在深夜写代码。\n- 主群是 1000000003。\n', 'utf8')
  writeFileSync(path.join(workspace, 'memory', '2026-10-17.md'), '# 2026-10-17\n\n今天在调管理后台。\n', 'utf8')
  writeFileSync(path.join(workspace, 'notes', 'todo.md'), '# TODO\n\n- [ ] 验证配置保存的 diff 展示\n', 'utf8')
  writeFileSync(path.join(workspace, 'scripts', 'heartbeat.mjs'), "console.log('alive')\n", 'utf8')
}

/** 合成日志尾部（含错误行，错误聚合/概览页有东西可看）。 */
const LOG_LINES = [
  '2026-10-17T02:58:11.120+08:00 [info] channel-qq: admin panel ready (local instance)',
  '2026-10-17T02:58:11.480+08:00 [info] channel-qq: OneBot connected (ws://127.0.0.1:3001)',
  '2026-10-17T02:58:12.330+08:00 [info] channel-qq: registered 86/86 tools',
  '2026-10-17T02:58:40.010+08:00 [info] inbound: group 1000000003 message from 1000000002（@了机器人）',
  '2026-10-17T02:58:40.050+08:00 [info] batching: window opened (1200ms)',
  '2026-10-17T02:58:41.260+08:00 [info] outbound: reply sent to group 1000000003 (segment 1/1)',
  '2026-10-17T02:59:02.870+08:00 [info] tool: qq_imagegen invoked by master',
  '2026-10-17T02:59:09.910+08:00 [warn] rss: feed poll timeout, will retry in 5 min',
  '2026-10-17T02:59:31.410+08:00 [info] memory: diary appended (memory/2026-10-17.md)',
  '2026-10-17T03:00:44.900+08:00 [error] linkResolve: bilibili card fetch failed（本地实例的合成错误行）',
  '2026-10-17T03:01:10.220+08:00 [info] admin: config updated (imageGen)',
  '2026-10-17T03:01:12.650+08:00 [info] channel-qq: heartbeat ok',
]

/**
 * 起一个本地后台。
 * @param {{ port?: number, home?: string, password?: string, verbose?: boolean, keepHome?: boolean }} [opts]
 */
export async function startLocalAdmin(opts = {}) {
  const port = Number(opts.port ?? process.env.DSH_ADMIN_LOCAL_PORT ?? process.env.DSH_ADMIN_PORT ?? 8791)
  const password = opts.password ?? process.env.DSH_ADMIN_PASSWORD ?? LOCAL_PASSWORD_DEFAULT
  const home = opts.home ?? process.env.DSH_ADMIN_LOCAL_HOME ?? mkdtempSync(path.join(os.tmpdir(), 'dsh-admin-local-'))
  const workspace = path.join(home, 'workspace')
  const keepHome = opts.keepHome ?? process.env.DSH_ADMIN_LOCAL_KEEP === '1'
  const { AdminServer, resolveConfig, WorkspaceFiles } = await loadModules()

  mkdirSync(home, { recursive: true })
  seedWorkspace(workspace)

  // 口令走 P0 就支持的明文 env（AuthManager 来源链的第二档）；没设就是生成式，
  // 那种情况下密码只在日志里出现一次，本地 E2E 需要稳定值，所以显式设上。
  process.env[PASSWORD_ENV] = password

  const config = resolveConfig()
  config.admin.enabled = true
  config.admin.port = port
  config.admin.host = '127.0.0.1'
  config.workspacePath = workspace
  config.selfId = 10000
  config.admins = [1000000002]
  config.primaryGroup = 1000000003

  const logs = []
  const log = (line) => {
    logs.push(line)
    if (opts.verbose === true) console.log(`[admin-local] ${line}`)
  }
  const startedAt = Date.now()
  const ref = { server: null }
  const groupList = ['群 1000000003（主群）', '群 987654321', '群 123456789', '群 555000111', '群 777888999', '群 246810121', '群 135791113']

  const fileStore = new WorkspaceFiles(() => config.workspacePath, path.join(home, 'channel-qq', 'backups'), log)

  const memQuotes = [{ id: 'q_seed', text: '这个梗我记下了', speaker: '学弟', groupId: 1000000003, tags: ['测试'], at: Date.now() - 60000 }]
  const memPhrases = [{ id: 'p1', text: '绷不住了', count: 12, groupId: 1000000003 }]
  const resources = {
    emoji: {
      label: '表情包库',
      list: () => ({ count: 2, entries: [
        { id: 'e1', file: 'happy.png', tags: ['开心'], addedAt: Date.now() - 90000 },
        { id: 'e2', file: 'thinking.png', tags: ['思考'], addedAt: Date.now() - 30000 },
      ] }),
      remove: async (id) => ({ removed: id === 'e1' || id === 'e2' }),
      actions: { rescan: async () => ({ added: 0, duplicates: 2 }) },
    },
    quotes: {
      label: '群语录',
      list: () => ({ count: memQuotes.length, quotes: memQuotes }),
      create: async (body) => {
        const quote = { id: `q_${Date.now().toString(36)}`, text: String(body.text ?? ''), speaker: String(body.speaker ?? '匿名'), groupId: Number(body.groupId ?? config.primaryGroup ?? 0), tags: Array.isArray(body.tags) ? body.tags.map(String) : [], at: Date.now() }
        memQuotes.unshift(quote)
        return quote
      },
      remove: async (id) => {
        const index = memQuotes.findIndex((q) => q.id === id)
        if (index < 0) return { removed: false }
        memQuotes.splice(index, 1)
        return { removed: true }
      },
    },
    memories: {
      label: '长期记忆',
      list: () => ({ count: 2, entries: [
        { id: 'm1', type: 'fact', content: '学弟在做 dsh-channel-qq', tags: ['项目'], source: '群聊' },
        { id: 'm2', type: 'preference', content: '喜欢简洁的回复', tags: ['偏好'], source: '群聊' },
      ] }),
      create: async (body) => ({ added: String(body.content ?? '') !== '' }),
      remove: async () => ({ removed: true }),
    },
    reminders: {
      label: '提醒',
      list: () => ({ count: 3, reminders: [
        { id: 'r1', text: '提醒学弟喝水', at: Date.now() + 3600000, room: 'group-1000000003' },
        { id: 'r2', text: '明天 9 点早报', at: Date.now() + 7200000, room: 'group-1000000003' },
        { id: 'r3', text: '周报', at: Date.now() + 86400000, room: 'dm-1000000002' },
      ] }),
      remove: async () => ({ removed: true }),
    },
    rss: {
      label: '订阅源',
      list: () => ({ count: config.rss.feeds.length, feeds: config.rss.feeds }),
      create: async (body) => {
        const feed = { id: `rss_${Date.now().toString(36)}`, url: String(body.url ?? ''), room: 'group', target: Number(body.target ?? config.primaryGroup ?? 0), enabled: true, lastGuid: null, title: String(body.title ?? body.url ?? '') }
        config.rss.feeds.push(feed)
        return feed
      },
      remove: async (id) => {
        const index = config.rss.feeds.findIndex((f) => f.id === id)
        if (index < 0) return { removed: false }
        config.rss.feeds.splice(index, 1)
        return { removed: true }
      },
    },
    learned: {
      label: '学到的口癖',
      list: () => ({ count: memPhrases.length, phrases: memPhrases }),
      create: async (body) => { const p = { id: `p_${Date.now().toString(36)}`, text: String(body.text ?? ''), count: 1, groupId: Number(body.groupId ?? config.primaryGroup ?? 0) }; memPhrases.push(p); return p },
      remove: async (id) => { const i = memPhrases.findIndex((p) => p.id === id); if (i >= 0) memPhrases.splice(i, 1); return { removed: i >= 0 } },
    },
    sendl: {
      label: '机器人发送记录',
      list: async () => ({ 'group-1000000003': ['（本地实例）她最近发出去的消息 1', '（本地实例）消息 2'] }),
    },
    playlist: {
      label: '歌单',
      list: async () => ({ count: 1, songs: [{ id: '186016', name: '晴天', artists: '周杰伦', addedAt: Date.now() - 120000 }] }),
      create: async (body) => ({ added: String(body.songId ?? '') !== '', total: 2 }),
      remove: async () => ({ removed: 1 }),
    },
    diary: {
      label: '日记',
      list: async (query) => {
        const date = (query.get('date') ?? '').replace(/[^0-9-]/g, '')
        if (date !== '') return { date, content: `# ${date}\n\n（本地实例）${date} 的日记内容。\n` }
        return { count: 2, diaries: [{ date: '2026-10-17', file: path.join(workspace, 'memory', '2026-10-17.md') }, { date: '2026-10-16', file: path.join(workspace, 'memory', '2026-10-16.md') }] }
      },
    },
    affection: {
      label: '好感度与阶段',
      list: () => ({ score: 42, stage: '熟悉', events: [{ at: Date.now() - 600000, delta: 2, reason: '被夸了' }], stageHistory: [{ at: Date.now() - 86400000, from: '认识', to: '熟悉' }] }),
    },
  }

  const deps = {
    config,
    dshHome: home,
    log,
    status: async () => ({
      qqConnected: true,
      selfId: config.selfId,
      connection: `ws://127.0.0.1:3001（${config.connection.mode}）`,
      primaryGroup: config.primaryGroup,
      master: config.admins[0],
      workspace: config.workspacePath,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      tools: 86,
      groups: groupList.length,
      groupList,
      emojiIndexed: 812,
      quotes: memQuotes.length,
      pendingReminders: 3,
      rssFeeds: config.rss.feeds.filter((f) => f.enabled !== false).length,
      floodTracked: 12,
      floodTriggered: 1,
      learnedPhrases: memPhrases.length,
      tts: `${config.tts.provider ?? 'edge-tts'}/${config.tts.voice ?? 'zh-CN-XiaoxiaoNeural'}`,
      imageGen: `${config.imageGen.provider ?? 'pollinations'}/${config.imageGen.model ?? ''}`,
      linkResolve: config.linkResolve?.enabled === false ? '关闭' : '开启',
    }),
    readLog: async (lines) => LOG_LINES.slice(Math.max(0, LOG_LINES.length - lines)),
    prompt: async (text) => ({ submitted: String(text).slice(0, 80) }),
    resources,
    applyEffects: async (patch) => {
      const notes = []
      const adminPatch = typeof patch.admin === 'object' && patch.admin !== null ? patch.admin : null
      if (adminPatch !== null && ['port', 'host', 'enabled', 'password'].some((key) => key in adminPatch) && ref.server !== null) {
        notes.push(await ref.server.relisten())
      }
      if ('connection' in patch || 'accessToken' in patch) {
        notes.push(`已重连 OneBot（mode=${config.connection.mode} url=${config.connection.url}）`)
      }
      if ('affectionPort' in patch) notes.push('好感度面板已按新端口重听（本地实例模拟）')
      const emojiPatch = typeof patch.emoji === 'object' && patch.emoji !== null ? patch.emoji : null
      if (emojiPatch !== null && ('dir' in emojiPatch || 'registeredDir' in emojiPatch)) notes.push('表情目录已重读（本地实例模拟）')
      return notes
    },
    files: fileStore,
    presets: {
      current: () => config.agentPreset,
      list: async () => [
        { id: 'standard', name: '标准' },
        { id: 'coder', name: '编码' },
      ],
      doc: async (id) => ({ id, name: id === 'coder' ? '编码' : '标准', content: `name: ${id}\ndescription: 本地实例的示例预设\ninstructions:\n  - 保持简短\n  - 不确定就说不确定\n` }),
      select: async (id) => {
        const ids = ['standard', 'coder']
        if (!ids.includes(id)) throw new Error(`没有名为「${id}」的预设。可用的有：${ids.join('、')}`)
        const before = config.agentPreset
        if (before === id) return `已经在用「${id}」了`
        await ref.server.applyConfigPatch({ agentPreset: id }, { source: 'internal' })
        return `预设「${before}」→「${id}」。对新建会话生效；已有会话要立刻生效，请用下面的「重建会话」。`
      },
    },
    sessions: {
      list: async () => [
        { room: 'group-1000000003', sessionId: 'sess_local_alpha', files: 14, bytes: 182734, mtime: Date.now() - 120000 },
        { room: 'dm-1000000002', sessionId: 'sess_local_beta', files: 6, bytes: 41233, mtime: Date.now() - 600000 },
      ],
      rebuild: async (room) => ({ room, removed: room === 'group-1000000003' ? 14 : 0, note: `（本地实例）房间 ${room} 的会话已重建；新指令文件立即生效。` }),
    },
  }

  const server = new AdminServer(deps)
  ref.server = server
  await server.start()

  const base = `http://127.0.0.1:${port}`
  return {
    server,
    base,
    port,
    password,
    home,
    workspace,
    logs,
    stop: () => {
      server.stop()
      if (!keepHome) rmSync(home, { recursive: true, force: true })
    },
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}

function pidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function main() {
  const command = process.argv[2] ?? 'run'
  if (command === 'run') {
    const instance = await startLocalAdmin({ verbose: true, keepHome: true })
    writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: instance.port, home: instance.home, password: instance.password }, null, 2))
    console.log(`[admin-local] 后台已在 ${instance.base}/（密码：${instance.password}）`)
    console.log(`[admin-local] E2E：DSH_ADMIN_BASE=${instance.base} DSH_ADMIN_PASSWORD=${instance.password} DSH_ADMIN_SKIP_PUBLIC=1 node deploy/admin-test.mjs`)
    const shutdown = () => { try { instance.server.stop() } catch { /* ignore */ } rmSync(STATE_FILE, { force: true }); process.exit(0) }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return
  }
  if (command === 'start') {
    const existing = readState()
    if (existing !== null && pidAlive(existing.pid)) {
      console.log(`[admin-local] 已在运行：http://127.0.0.1:${existing.port}/（pid ${existing.pid}，密码 ${existing.password}）`)
      return
    }
    const port = Number(process.env.DSH_ADMIN_PORT ?? 8791)
    const password = process.env.DSH_ADMIN_PASSWORD ?? LOCAL_PASSWORD_DEFAULT
    const home = process.env.DSH_ADMIN_LOCAL_HOME ?? mkdtempSync(path.join(os.tmpdir(), 'dsh-admin-local-'))
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run'], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DSH_ADMIN_LOCAL_PORT: String(port), DSH_ADMIN_LOCAL_HOME: home, DSH_ADMIN_PASSWORD: password, DSH_ADMIN_LOCAL_KEEP: '1' },
    })
    child.unref()
    console.log(`[admin-local] 已启动（pid ${child.pid}）：http://127.0.0.1:${port}/  密码：${password}`)
    console.log(`[admin-local] 停止：node deploy/admin-local.mjs stop`)
    return
  }
  if (command === 'stop') {
    const state = readState()
    if (state === null || !pidAlive(state.pid)) {
      console.log('[admin-local] 没有在运行（或 state 文件已过期）。')
      rmSync(STATE_FILE, { force: true })
      return
    }
    process.kill(state.pid)
    rmSync(STATE_FILE, { force: true })
    console.log(`[admin-local] 已停止（pid ${state.pid}）。`)
    return
  }
  if (command === 'status') {
    const state = readState()
    if (state === null || !pidAlive(state.pid)) { console.log('[admin-local] 未运行。'); return }
    console.log(`[admin-local] 运行中：http://127.0.0.1:${state.port}/（pid ${state.pid}，home ${state.home}）`)
    return
  }
  console.error(`未知命令：${command}（可用：start / stop / status / run）`)
  process.exit(2)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[admin-local] 失败：', error)
    process.exit(1)
  })
}
