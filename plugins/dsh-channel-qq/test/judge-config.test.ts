/** `judge` 段（判断模型）的配置契约：**默认值、字段数、热生效、页面归属**。
 *
 * 为什么值得单独钉：这一段的每个默认值都是一次实测换来的结论
 * （见 `docs/groups/p10-jev-judge.md` §3、§5），而默认值一旦被谁顺手改掉，
 * 表现不是"报错"，是"显存多占 786 MB"或"第一次判断变慢"——两种都不会有人发现。
 *
 * 三条断言的分工：
 *   - **字段数**：防止"加了个字段但文档/后台没跟上"；
 *   - **默认值**：那几条被实测校准过的（`contextSize`、`nGpuLayers`、`minFreeVramMb`、
 *     `phraseMinProbability`）逐条写死，改它们必须同时改这份测试与文档；
 *   - **热生效 + 页面**：`hot:'live'` 是"后台改完下一轮生效"的前提。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ALL_GATES, GATE_IDS, JUDGE_GROUPS } from '../src/config/sections/judge.js'
import { resolveConfig } from '../src/config.js'
import { SCHEMA, groupOf, sectionIds } from '../src/config/schema.js'

/** 全部字段（顺序即后台渲染顺序，同时也是 golden 快照的顺序）。 */
const CONTRACT = [
  'backend',
  'remoteBaseUrl',
  'remoteModel',
  'remoteApiKeyRef',
  'remoteTimeoutMs',
  'remoteUserAgent',
  'scorerPath',
  'modelPath',
  'tokenizerPath',
  'contextSize',
  'ubatch',
  'seqMax',
  'outputsMax',
  'nGpuLayers',
  'threads',
  'minFreeVramMb',
  'timeoutMs',
  'phraseMinProbability',
  'gatesEnabled',
] as const

/** 这几条的默认值是实测校准过的，改它们必须改文档。 */
const CALIBRATED: Record<string, string | number | boolean> = {
  backend: 'host',
  remoteBaseUrl: 'https://opencode.ai/inference/systemone/v1/systemone',
  remoteModel: 'jev-1.13',
  remoteApiKeyRef: 'OPENCODE_API_KEY',
  remoteTimeoutMs: 8000,
  remoteUserAgent: 'dsh-companion/jev-opencode',
  scorerPath: '',
  modelPath: '',
  tokenizerPath: '',
  contextSize: 2048,
  ubatch: 256,
  seqMax: 4,
  outputsMax: 64,
  nGpuLayers: 99,
  threads: 6,
  minFreeVramMb: 512,
  timeoutMs: 3000,
  phraseMinProbability: 0.3,
  gatesEnabled: ALL_GATES,
}

test('judge 段：19 个字段，顺序与契约一致', () => {
  const fields = Object.keys(JUDGE_GROUPS[0]?.fields ?? {})
  assert.deepEqual(fields, [...CONTRACT])
  assert.equal(fields.length, 19)
})

test('judge 段：默认值与实测校准值一致', () => {
  const resolved = resolveConfig()
  const judge = resolved.judge as unknown as Record<string, unknown>
  assert.deepEqual(Object.keys(judge), [...CONTRACT], '解出来的键必须与契约同序（golden 快照按这个顺序）')
  for (const [key, want] of Object.entries(CALIBRATED)) {
    assert.equal(judge[key], want, `${key} 的默认值变了（实测结论在 docs/groups/p10-jev-judge.md §3）`)
  }
})

test('judge 段：默认是"不启用任何 typed 后端"', () => {
  const judge = resolveConfig().judge
  // 装上插件不等于换了判断路径：换后端是操作者的显式决定。
  assert.equal(judge.backend, 'host')
  // 三个本地路径默认空串 = 未配置。**不许**填一个"看起来能用"的绝对路径：
  // 换台机器就是一句静默的 ENOENT，而空值会让后台明确显示"未配置"。
  assert.equal(judge.scorerPath, '')
  assert.equal(judge.modelPath, '')
  assert.equal(judge.tokenizerPath, '')
  // 云端那一段默认值是"能用的公开端点"：端点与模型 id 是公开常量，本机不需要任何资产。
  // 但 `backend` 仍是 `host`，所以装上插件不会自动开始花钱。
  assert.equal(judge.remoteModel, 'jev-1.13')
  assert.equal(judge.remoteApiKeyRef, 'OPENCODE_API_KEY')
})

test('judge 段：云端 User-Agent 默认非空（留着空串会被 Cloudflare 挡 1010）', () => {
  // 实测：不带自定义 UA 的请求会被挡成 403 `error code 1010`，而错误体里没有任何提示。
  // 所以默认值必须**非空**，而且注释里要写明为什么——否则下一个人会把它清空。
  assert.notEqual(resolveConfig().judge.remoteUserAgent, '')
})

test('judge 段：九门全开是默认，且顺序与 GATE_IDS 一致', () => {
  // 全开是唯一有实测数据支撑的配置；关掉一门等于让决策表看不见一条事实。
  assert.equal(ALL_GATES, GATE_IDS.join(','))
  assert.deepEqual(GATE_IDS, [
    'tech_issue', 'help_open', 'one_to_one', 'conflict', 'privacy',
    'inject', 'closed', 'casual', 'share',
  ])
})

test('judge 段：全部 hot=live、page=groups、有中文标签与帮助', () => {
  for (const [key, field] of Object.entries(JUDGE_GROUPS[0]?.fields ?? {})) {
    // 热生效：后台改完下一轮就按新值判，不需要重启（`judge-host` 每次现取）。
    assert.equal(field.hot, 'live', `${key} 必须 hot:'live'`)
    // 页面归属：与它的实际作用一致（群聊页），不是"工具"或"连接"。
    assert.equal(field.page, 'groups', `${key} 必须挂在 groups 页`)
    assert.ok(typeof field.label === 'string' && field.label !== '', `${key} 缺中文标签`)
    assert.ok(typeof field.help === 'string' && field.help.length > 20, `${key} 的帮助太短（它要解释为什么）`)
  }
})

test('judge 段：注册进 schema，且 presence 仍是最后一个段', () => {
  const ids = sectionIds()
  assert.ok(ids.includes('judge'), 'judge 段没有注册进 schema')
  assert.equal(groupOf(SCHEMA, 'judge')?.label, '判断模型')
  // `presence` 必须留在最后（它的键位记录与 golden 快照依赖这条），所以新段只能往前插。
  assert.equal(ids.at(-1), 'presence')
  // 顺序：judge 在 presence 之前（`root.ts` 的插入位置）。
  assert.ok(ids.indexOf('judge') < ids.indexOf('presence'))
})

test('judge 段：字段组只有一个，id 与段名一致', () => {
  assert.equal(JUDGE_GROUPS.length, 1)
  assert.equal(JUDGE_GROUPS[0]?.id, 'judge')
  assert.equal(JUDGE_GROUPS[0]?.page, 'groups')
})
