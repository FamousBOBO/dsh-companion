/** 群聊人格快照的**契约与取用面**（P0 §4.1）单测。
 *
 * 三个文件被测：`src/app/inbound/group-persona.ts`（归一化 + 提示词渲染）、
 * `src/adapters/dsh-host/group-persona.ts`（三条解析路径）、以及
 * `presence-runtime` 是否真的把快照交到了提示词里。
 *
 * 纪律：不读真人格文件、不碰真注册表（用 `Object.defineProperty(process, ...)` 装一个
 * 假注册表并在用例结束时删掉）、不发真 QQ。
 *
 * 这里钉住的是 P0 的验收项：
 *   - 快照形状不对 → 归一化成 `null`（宁可少一段，也不拼一个看起来像真的值）；
 *   - 字段超长/重复 → 被夹、被去重（提示词不能被一份长人格撑爆）；
 *   - 取不到 → 提示词里明说降级，且**不**混进任何编造的人格；
 *   - 三条解析路径（ctx / 进程注册表 / 服务桥）任一命中就够，全落空才降级；
 *   - 人格文件换了（版本号变了）→ 下一轮判断立刻用新的（不缓存快照）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEGRADED_PERSONA_LINES,
  PERSONA_LIMITS,
  normalizePersonaSnapshot,
  personaPromptLines,
  type GroupPersonaSnapshot,
} from '../src/app/inbound/group-persona.js'
import {
  GROUP_PERSONA_SERVICE,
  PORTS_SYMBOL,
  dataRootOfDshHome,
  readGroupPersona,
  type GroupPersonaDeps,
} from '../src/adapters/dsh-host/group-persona.js'

const FULL: GroupPersonaSnapshot = {
  version: 'abc12345',
  personaId: 'bot',
  identity: '叫阿七，喜欢拍照。',
  personality: '话不多，但会说具体的。',
  speakingStyle: '短句、口语。',
  interests: ['摄影参数', '显影'],
  knownExperiences: ['拍过一整年的月亮'],
  publicFacts: ['住在杭州'],
  interactionBoundaries: ['不谈别人的家事'],
  source: 'config/persona.md',
}

test('正常快照：字段原样保留，缺 emotionalState 就不带这个键', () => {
  const snapshot = normalizePersonaSnapshot({ ...FULL })
  assert.ok(snapshot !== null)
  assert.deepEqual(snapshot, FULL)
  assert.equal('emotionalState' in snapshot, false, '没有状态就不要出现一个空字符串的键')
})

test('带 emotionalState 时正常读出（这一条是"可公开的状态"，不是私聊原文）', () => {
  const snapshot = normalizePersonaSnapshot({ ...FULL, emotionalState: '今天有点困' })
  assert.equal(snapshot?.emotionalState, '今天有点困')
})

test('一个字都没有 → null（空快照等于没有快照，别拿它去组空标题）', () => {
  assert.equal(normalizePersonaSnapshot(null), null)
  assert.equal(normalizePersonaSnapshot(undefined), null)
  assert.equal(normalizePersonaSnapshot('bot'), null)
  assert.equal(normalizePersonaSnapshot({}), null)
  assert.equal(normalizePersonaSnapshot({ interests: ['摄影'] }), null)
})

test('形状不对的字段被丢掉，不猜、不补默认值', () => {
  const snapshot = normalizePersonaSnapshot({
    version: 'v1',
    identity: 123, // 不是字符串 → 当作没有
    personality: '稳',
    interests: ['摄影', '', '摄影', 42, null], // 空串/重复/非字符串都要丢
    knownExperiences: '不是数组',
    publicFacts: null,
  })
  assert.equal(snapshot?.identity, '')
  assert.equal(snapshot?.personality, '稳')
  assert.deepEqual(snapshot?.interests, ['摄影'], '去空、去重、非字符串丢掉')
  assert.deepEqual(snapshot?.knownExperiences, [])
  assert.deepEqual(snapshot?.publicFacts, [])
  // 没有版本号也不能空着：诊断里"unversioned"比空串更能说明问题
  assert.equal(snapshot?.version, 'v1')
  assert.equal(normalizePersonaSnapshot({ identity: 'x' })?.version, 'unversioned')
})

test('超长字段被夹到上限（提示词不会被一份长人格撑爆）', () => {
  const snapshot = normalizePersonaSnapshot({
    version: 'v1',
    identity: '甲'.repeat(PERSONA_LIMITS.identity + 50),
    personality: '乙'.repeat(PERSONA_LIMITS.personality + 50),
    speakingStyle: '丙'.repeat(PERSONA_LIMITS.speakingStyle + 50),
    interests: Array.from({ length: 20 }, (_, i) => `兴趣${String(i)}`),
  })
  assert.equal([...(snapshot?.identity ?? '')].length, PERSONA_LIMITS.identity)
  assert.equal([...(snapshot?.personality ?? '')].length, PERSONA_LIMITS.personality)
  assert.equal([...(snapshot?.speakingStyle ?? '')].length, PERSONA_LIMITS.speakingStyle)
  assert.equal(snapshot?.interests.length, PERSONA_LIMITS.items)
})

test('多行字段被压成一行：提示词里一行一条，模型才不会读成两段', () => {
  const snapshot = normalizePersonaSnapshot({ version: 'v1', identity: '第一行\n第二行\t第三列' })
  assert.equal(snapshot?.identity, '第一行 第二行 第三列')
})

// ── 提示词渲染 ──────────────────────────────────────────────────────────────

test('提示词带上身份/性格/说话方式/兴趣/经历/公开事实/边界与版本号', () => {
  const lines = personaPromptLines(FULL).join('\n')
  assert.match(lines, /【你是谁（群聊可见的人格快照）】/)
  assert.match(lines, /身份：叫阿七/)
  assert.match(lines, /性格：话不多/)
  assert.match(lines, /说话方式：短句/)
  assert.match(lines, /你更有话说的方向/)
  assert.match(lines, /- 摄影参数/)
  assert.match(lines, /你真实的经历（只能用这些，别编）/)
  assert.match(lines, /可以在群里公开的事实/)
  assert.match(lines, /群聊里的边界/)
  assert.match(lines, /快照版本 abc12345，来源 config\/persona\.md/)
})

test('没有快照 → 只有降级段，且明确禁止编造', () => {
  const lines = personaPromptLines(null)
  assert.deepEqual(lines, [...DEGRADED_PERSONA_LINES])
  const text = lines.join('\n')
  assert.match(text, /这次拿不到完整人格/)
  assert.match(text, /不要编造自己的名字、身份、经历、喜好/)
})

test('整段总长有上限：八条各八十字的边界也淹不掉判断提示词', () => {
  const fat = normalizePersonaSnapshot({
    version: 'v1',
    identity: '甲'.repeat(200),
    personality: '乙'.repeat(300),
    speakingStyle: '丙'.repeat(300),
    interests: Array.from({ length: 8 }, () => '丁'.repeat(80)),
    knownExperiences: Array.from({ length: 8 }, () => '戊'.repeat(80)),
    publicFacts: Array.from({ length: 8 }, () => '己'.repeat(80)),
    interactionBoundaries: Array.from({ length: 8 }, () => '庚'.repeat(80)),
  })
  const text = personaPromptLines(fat).join('\n')
  assert.ok([...text].length <= PERSONA_LIMITS.total, `总长 ${String([...text].length)} 超过上限`)
  // 截断按段丢，不能把第一段（身份）丢掉
  assert.match(text, /【你是谁（群聊可见的人格快照）】/)
})

// ── 三条解析路径 ────────────────────────────────────────────────────────────

/** 装一个假的进程级注册表；返回卸载函数（用例结束必须调用）。 */
function installRegistry(entries: Array<[string, { service: unknown; ready?: () => boolean }]>): () => void {
  const map = new Map<string, { service: unknown; ready: () => boolean }>()
  for (const [key, value] of entries) {
    map.set(key, { service: value.service, ready: value.ready ?? (() => true) })
  }
  const previous = Reflect.get(process, PORTS_SYMBOL)
  Reflect.set(process, PORTS_SYMBOL, map)
  return () => {
    if (previous === undefined) Reflect.deleteProperty(process, PORTS_SYMBOL)
    else Reflect.set(process, PORTS_SYMBOL, previous)
  }
}

function deps(over: Partial<GroupPersonaDeps> = {}): GroupPersonaDeps {
  return {
    context: () => undefined,
    bridge: () => null,
    dataRoot: () => '/suite/data',
    log: () => {},
    ...over,
  }
}

test('路径一：ctx.get 拿得到就用它（同子树最确定）', () => {
  const read = readGroupPersona(deps({ context: () => ({ get: () => ({ get: () => FULL }) }) }))
  assert.equal(read.via, 'ctx')
  assert.equal(read.snapshot?.identity, FULL.identity)
})

test('路径二：ctx 没有时走进程级注册表（兄弟插件行的唯一可靠通道）', () => {
  const release = installRegistry([['/suite/data', { service: { get: () => FULL } }]])
  try {
    const read = readGroupPersona(deps())
    assert.equal(read.via, 'registry')
    assert.equal(read.snapshot?.version, 'abc12345')
  } finally {
    release()
  }
})

test('路径二：注册表里 ready() 是 false / 抛错 → 当作不可用（不拿半初始化对象组提示词）', () => {
  const notReady = installRegistry([['/suite/data', { service: { get: () => FULL }, ready: () => false }]])
  try {
    assert.equal(readGroupPersona(deps()).snapshot, null)
  } finally {
    notReady()
  }
  const throws = installRegistry([['/suite/data', { service: { get: () => FULL }, ready: () => { throw new Error('x') } }]])
  try {
    assert.equal(readGroupPersona(deps()).snapshot, null)
  } finally {
    throws()
  }
})

test('路径三：服务桥（可选通道）；三条全落空才降级，并且原因写得出来', () => {
  const viaBridge = readGroupPersona(deps({
    bridge: () => ({ publish: () => () => {}, resolve: (name) => (name === GROUP_PERSONA_SERVICE ? { get: () => FULL } : null) }),
  }))
  assert.equal(viaBridge.via, 'bridge')
  assert.equal(viaBridge.snapshot?.identity, FULL.identity)

  const none = readGroupPersona(deps())
  assert.equal(none.snapshot, null)
  assert.equal(none.via, 'none')
  assert.match(none.reason, /ctx:absent/)
  assert.match(none.reason, /registry:absent/)
  assert.match(none.reason, /bridge:absent/)
})

test('端口形状不对 / get() 抛错 / 快照为空 → 继续试下一条，最终降级（绝不抛）', () => {
  const read = readGroupPersona(deps({
    context: () => ({ get: () => ({ nope: true }) }), // not-a-port
    bridge: () => ({ publish: () => () => {}, resolve: () => ({ get: () => { throw new Error('boom') } }) }),
  }))
  assert.equal(read.snapshot, null)
  assert.match(read.reason, /ctx:not-a-port/)
  assert.match(read.reason, /bridge:threw\(boom\)/)
})

test('注册表：复合键优先——健康服务抢了裸 dataRoot 键也照样拿得到人格', () => {
  // 复现生产形态：companion-health 后挂载，把裸 dataRoot 键覆盖成它自己的服务。
  const release = installRegistry([
    [`${GROUP_PERSONA_SERVICE}\u0000/suite/data`, { service: { get: () => FULL } }],
    ['/suite/data', { service: { qqCareCandidate: () => null } }],
  ])
  try {
    const read = readGroupPersona(deps())
    assert.equal(read.via, 'registry')
    assert.equal(read.snapshot?.version, 'abc12345', '复合键里的才是人格端口')
  } finally {
    release()
  }
})

test('注册表：只有裸键时也能用（健康服务没装的那套部署）', () => {
  const release = installRegistry([['/suite/data', { service: { get: () => FULL } }]])
  try {
    assert.equal(readGroupPersona(deps()).snapshot?.version, 'abc12345')
  } finally {
    release()
  }
})

test('注册表键必须与发布方一致：别的键不算（否则会静默拿到另一套部署的人格）', () => {
  const release = installRegistry([['/other/data', { service: { get: () => FULL } }]])
  try {
    assert.equal(readGroupPersona(deps()).snapshot, null)
  } finally {
    release()
  }
})

test('dataRootOfDshHome：DSH_HOME 的父目录；路径不存在时返回 null（不猜）', () => {
  assert.equal(dataRootOfDshHome('/definitely/not/here/home'), null)
})
