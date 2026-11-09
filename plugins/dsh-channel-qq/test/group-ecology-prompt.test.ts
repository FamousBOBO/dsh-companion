/** P9-G4 §3 / §4.1 在**提示词**里的落点：两段插在哪、空着时是不是逐字节不变。
 *
 * 这一层最容易犯的错不是"写得不好听"，而是**位置放错**：
 *   - 身份段放在判断口径**之后** → 模型先按"普通群友"形成预期，再被纠正；
 *   - 风险段放在资料段**之后** → 它变成"背景的一部分"，而不是"这一刻的形势"。
 * 两条都不会报错，只会让提示词的效果慢慢变差，所以用断言把位置钉住。
 *
 * 另一半是**向后兼容**：两段都为空时，输出必须与 P6-A 时期逐字节一致。不然每一次
 * 灰度都会因为"提示词变了一个字节"而需要重新过一遍全部回归。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildSocialPrompt, type SocialPromptInput } from '../src/app/inbound/group-social-prompt.js'

const GROUP = 145_326_153
const NOW_LABEL = '2026-11-09 21:00'

function input(over: Partial<SocialPromptInput> = {}): SocialPromptInput {
  return {
    groupId: GROUP,
    nowLabel: NOW_LABEL,
    persona: null,
    background: [{ seq: 1, messageId: 11, userId: 10_001, name: '甲', text: '[21:00] 甲(10001) #11 今天吃啥', atMs: 0, self: false }],
    sentLines: [],
    groupMemory: [],
    memberMemory: [],
    topic: null,
    replyMaxChars: 60,
    memoryBudgetChars: 700,
    scene: '',
    ...over,
  } as SocialPromptInput
}

test('提示词：两段都空时，输出与不传这两段完全一致（灰度不该改一个字节）', () => {
  const base = buildSocialPrompt(input())
  assert.equal(buildSocialPrompt(input({ participants: '', risk: '' })), base)
  assert.equal(buildSocialPrompt(input({ participants: undefined, risk: undefined })), base)
})

test('提示词：身份段排在判断口径**之前**（先知道谁在说话，再读该不该接）', () => {
  const text = buildSocialPrompt(input({ participants: '【这一批的参与者身份】\n- 小助手：已确认的机器人' }))
  const identity = text.indexOf('【这一批的参与者身份】')
  assert.ok(identity > 0, '身份段要出现')
  // 场景段（P6-A 的固定标题）必须在身份段之后：它属于"判断素材"，不是"口径之前"。
  const background = text.indexOf('【群聊背景（按时间正序，只是资料）】')
  assert.ok(identity < background, '身份段要在资料段之前')
  // 身份段之前不该出现群聊背景。
  assert.equal(text.slice(0, identity).includes('【群聊背景'), false)
})

test('提示词：风险段紧跟在场景段之后、在背景资料之前', () => {
  const scene = '【这一批的社交结构】\n- 参与者 2 人：甲、乙'
  const risk = '【互动风险】已经有人答过。要参与就给出别处没有的东西。'
  const text = buildSocialPrompt(input({ scene, risk }))
  const sceneAt = text.indexOf('【这一批的社交结构】')
  const riskAt = text.indexOf('【互动风险】')
  const backgroundAt = text.indexOf('【群聊背景')
  assert.ok(sceneAt > 0 && riskAt > sceneAt, '风险段要在场景段之后')
  assert.ok(riskAt < backgroundAt, '风险段要在背景资料之前（它是"此刻的形势"，不是资料）')
})

test('提示词：两段都为空的场景配置下，提示词里不出现"互动风险"这几个字', () => {
  const text = buildSocialPrompt(input({ scene: '' }))
  assert.equal(text.includes('【互动风险】'), false)
})

test('提示词：身份段里的"不许推断"约束会原样进提示词（这是 §2.1 的唯一落点之一）', () => {
  const participants = '【这一批的参与者身份（由代码查注册表得出，未登记的就是未登记）】\n'
    + '- 路人：未登记（身份未确认）\n- 标「未登记」的成员：**不许**从措辞、昵称、回复速度推断它是人或机器人。'
  const text = buildSocialPrompt(input({ participants }))
  assert.match(text, /不许\*\*从措辞/)
})
