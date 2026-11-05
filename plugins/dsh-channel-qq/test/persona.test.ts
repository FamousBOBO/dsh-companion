/** 人格包与模板引擎的测试。
 *
 * 这一步（P3.4 / 路线里的 2.8）把面向模型的文案从 `bridge.ts` 的模板字面量搬进了
 * `assets/persona/default/**`。搬家的唯一判据是"黄金快照逐字节不变"，那条由
 * `golden.test.ts` 看着；这里盯的是搬家之后**才可能出现**的问题：
 *
 *   - 模板里拼错一个变量名 → 提示词里会留下 `{{contex}}` 这种东西；
 *   - 包里少了一段 → 提示词直接缺一整块；
 *   - 末尾多/少一个换行 → 每条提示词多/少一个空行。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { renderTemplate, templateVars } = await import('../src/core/text/template.js')
const { createPersonaPack, resolvePersonaDir, findPackageRoot } = await import('../src/adapters/persona/fs-pack.js')
const { PromptComposer } = await import('../src/app/conversation/prompt-composer.js')
const { rewriteLegacyToolNames } = await import('../src/features/tools-v2/mapping.js')
const { MissingTemplateError } = await import('../src/ports/persona.js')

// ── 模板引擎 ────────────────────────────────────────────────────────────────

test('renderTemplate：换掉已知变量，原样留下未知变量', () => {
  assert.equal(renderTemplate('a={{x}} b={{y}}', { x: '1' }), 'a=1 b={{y}}')
  assert.equal(renderTemplate('{{ x }}', { x: '1' }), '1', '花括号里允许空格')
  assert.equal(renderTemplate('{{x}}-{{x}}', { x: '7' }), '7-7', '同一个变量出现几次都换')
  assert.equal(renderTemplate('没有变量', {}), '没有变量')
  // 空串是**合法的**值：它和"没给"是两回事。
  assert.equal(renderTemplate('[{{x}}]', { x: '' }), '[]')
})

test('templateVars：列出用到的变量（不重复、保序）', () => {
  assert.deepEqual(templateVars('{{b}} {{a}} {{b}}'), ['b', 'a'])
  assert.deepEqual(templateVars('无'), [])
})

// ── 人格包 ──────────────────────────────────────────────────────────────────

test('人格包：默认目录能找到、包含全部模板、末尾换行不进模板', () => {
  const pack = createPersonaPack()
  const keys = pack.keys()
  // 每一段都是"被代码按名字取用"的，少一段就是提示词缺一块。
  for (const key of [
    'packet/group', 'packet/group-called', 'packet/group-tail', 'packet/time',
    'packet/dm-tail', 'packet/image-note',
    'inject/called-header', 'inject/ambient-header', 'inject/called-tail', 'inject/ambient-tail',
    'notice/poke', 'notice/events', 'retry/gateway-nudge',
    'room/group', 'room/dm',
    'proactive/patrol', 'proactive/dream', 'proactive/evolve',
  ]) {
    assert.ok(keys.includes(key), `包里有 ${key}`)
  }
  // 文件末尾那个换行是文件格式，不许进模板（否则每条提示词都多一个空行）。
  assert.equal(pack.template('packet/image-note'), '（图见附件）')
  assert.equal(pack.template('notice/events')?.endsWith('\n'), false)
})

test('人格包：缺一段时 render 抛一个说得清的错误，template 返回 undefined', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'persona-'))
  try {
    writeFileSync(path.join(dir, 'a.txt'), 'A\n')
    const pack = createPersonaPack({ dir })
    assert.deepEqual(pack.keys(), ['a'])
    assert.equal(pack.template('b'), undefined)
    assert.throws(() => pack.render('b'), (error: unknown) => {
      assert.ok(error instanceof MissingTemplateError)
      assert.equal((error as InstanceType<typeof MissingTemplateError>).key, 'b')
      return true
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('人格包：改文件之后不用重启（按 mtime 重读）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'persona-'))
  try {
    const file = path.join(dir, 'x.txt')
    writeFileSync(file, '第一版\n')
    const pack = createPersonaPack({ dir })
    assert.equal(pack.template('x'), '第一版')
    writeFileSync(file, '第二版\n')
    // 同一毫秒内写入时 mtime 可能不变，显式往前推一点，让测试不依赖时钟精度。
    const later = new Date(Date.now() + 2000)
    utimesSync(file, later, later)
    assert.equal(pack.template('x'), '第二版')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('人格包：包根是从模块位置往上找的，不依赖 cwd', () => {
  const root = findPackageRoot(path.dirname(resolvePersonaDir()))
  assert.ok(root !== null)
  assert.equal(root, findPackageRoot(process.cwd()), '两种起点应当找到同一个包根')
})

// ── 组包器 ──────────────────────────────────────────────────────────────────

const composer = new PromptComposer(createPersonaPack())

test('私聊图注仅随真实附件出现', () => {
  const input = { line: '晚上了呢', knowledgeHint: '', room: 'dm' }
  assert.equal(composer.dmPacket(input).includes('（图见附件）'), false)
  assert.equal(composer.dmPacket({ ...input, hasImages: true }).includes('（图见附件）'), true)
})

test('组包器：房间指令按群 / 私聊给出不同的 target 与 isGroup', () => {
  const group = composer.roomDirective(true, 107)
  const dm = composer.roomDirective(false, 280)
  assert.ok(group.includes('群号 107'))
  assert.ok(group.includes('isGroup=true、target=107'))
  assert.ok(dm.includes('对方 QQ 280'))
  assert.ok(dm.includes('isGroup=false、target=280'))
  assert.equal(dm.includes('{{'), false, '不许把没换掉的占位符发给模型')
})

test('组包器：群包的两段可选素材只在有内容时才占一行', () => {
  const base = {
    context: '14:31 小明(999)：在吗',
    room: composer.roomDirective(true, 107),
    period: '下午',
    emotionHint: '',
    knowledgeHint: '',
    sentBlock: '',
  }
  const bare = composer.groupPacket({ ...base, called: false })
  assert.equal(bare.includes('\n\n'), false, '没有素材时不留空行')
  const full = composer.groupPacket({ ...base, called: true, emotionHint: 'E', knowledgeHint: 'K', sentBlock: 'S' })
  assert.equal(full.includes('\nE\nK\nS\n'), true, '有素材时按原顺序各占一行')
  assert.ok(full.includes('最后一条[@咱]是叫咱'), '被叫到时用另一段抬头')
  assert.ok(bare.includes('最近时段群里的消息'))
})

test('组包器：注入包按"叫咱 / 没叫咱"分成两种抬头与收尾', () => {
  const room = composer.roomDirective(true, 107)
  const called = composer.injectPacket({ called: true, room, body: 'X' })
  const ambient = composer.injectPacket({ called: false, room, body: 'X' })
  assert.ok(called.startsWith('【有人叫咱，这条要回应】\n'))
  assert.ok(ambient.startsWith('【群里的新消息】\n'))
  assert.ok(called.endsWith('也可以只更新记忆，不发言。）'))
  assert.ok(ambient.endsWith('不需要发言就不调用发送工具。）'))
})

test('组包器：每一段用到的模板都存在（少一段就在这里炸，而不是等线上）', () => {
  const room = composer.roomDirective(true, 1)
  assert.doesNotThrow(() => composer.groupPacket({
    called: true, context: 'c', room, period: '下午', emotionHint: '', knowledgeHint: '', sentBlock: '',
  }))
  assert.doesNotThrow(() => composer.injectPacket({ called: false, room, body: 'b' }))
  assert.doesNotThrow(() => composer.dmPacket({ line: 'l', knowledgeHint: '', room }))
  assert.doesNotThrow(() => composer.pokeNotice({ pokerId: 1, minutes: 5, count: 2 }))
  assert.doesNotThrow(() => composer.eventNotice(['a', 'b']))
  assert.doesNotThrow(() => composer.proactive('下午', room, 'P'))
  assert.doesNotThrow(() => composer.gatewayNudge())
  assert.doesNotThrow(() => composer.render('proactive/dream', { flavor: 'F' }))
})

test('组包器：群事件只带最近 12 条', () => {
  const many = Array.from({ length: 20 }, (_, i) => `事件${i}`)
  const prompt = composer.eventNotice(many)
  assert.ok(prompt.includes('事件19'))
  assert.equal(prompt.includes('事件7'), false, '第 8 条起被截掉（保留最近 12 条）')
})

test('房间指令跟着工具面走：tools.v2 开时指向 qq_message，关时保持旧文案', () => {
  const pack = createPersonaPack()
  const off = new PromptComposer(pack)
  assert.match(off.roomDirective(false, 42), /qq_send_text \/ qq_reply_quote/)

  const on = new PromptComposer(pack, () => true, rewriteLegacyToolNames)
  const dm = on.roomDirective(false, 42)
  assert.match(dm, /qq_message/)
  assert.match(dm, /isGroup=false/)
  assert.equal(dm.includes('qq_send_text'), false, '不能同时报旧工具名——模型会找不到它')
  const group = on.roomDirective(true, 7)
  assert.match(group, /qq_message/)
  assert.match(group, /isGroup=true/)
  assert.equal(group.includes('qq_send_text'), false)
})

test('tools.v2 开着时：所有含旧工具名的提示词都被改写成新名字', () => {
  const pack = createPersonaPack()
  const on = new PromptComposer(pack, () => true, rewriteLegacyToolNames)
  // 早报 06:00 会真的执行——这条以前会教模型调用不存在的工具。
  const report = on.render('events/morning-report', { master: '42' })
  assert.equal(report.includes('qq_send_text'), false)
  assert.match(report, /qq_message（action=send）/)
  const patrol = on.render('proactive/patrol')
  assert.equal(patrol.includes('qq_send_text'), false)
  assert.equal(patrol.includes('qq_reply_quote'), false)
  // 对照表本身必须保持原样，否则会把"旧名 → 新名"改成"新名 → 新名"。
  const renamed = on.render('notice/tools-renamed', { mapping: 'qq_send_text → qq_message' })
  assert.match(renamed, /qq_send_text → qq_message/)
})

test('AGENTS.md 受管区：tools.v2 下写进去的是新工具名（不能再留旧名）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-agents-'))
  try {
    const pack = createPersonaPack()
    const host = {
      config: { workspacePath: dir, context: { v2: true }, tools: { v2: true } },
      need: () => ({ pack, composer: new PromptComposer(pack, () => true, rewriteLegacyToolNames) }),
    }
    const { syncInstructionRegion } = await import('../src/features/inbound/index.js')
    const status = await syncInstructionRegion(host as never)
    assert.equal(status, 'created')
    const text = readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')
    assert.equal(text.includes('qq_send_text'), false, '受管区不能出现旧工具名')
    assert.match(text, /qq_message（action=send）/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
