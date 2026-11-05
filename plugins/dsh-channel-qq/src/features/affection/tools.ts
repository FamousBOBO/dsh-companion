/** 好感度：3 个工具。
 *
 * 好感度、阶段与自绘仪表盘。
 *
 * 这些 spec **逐字节**来自原来的 `registerQQTools`——P4 的判据是工具名与
 * 参数 schema 一条都不许变（`test/golden/tools/qq-tools.txt` 钉着这一点）。
 * 一个工具一个函数：单看一个工具时不必在 1200 行里找它的边界。
 */

import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQToolDeps } from '../tool-deps.js'

/** `qq_set_affection` — 【好感度记账】学弟的一句话/一个举动让咱心里起波澜时，用这个记账。delta 是变化值（-30~30），reason 写… */
function qqSetAffection(deps: QQToolDeps): ToolSpec {
  const { affection } = deps
  return {
        name: 'qq_set_affection',
        description: '【好感度记账】学弟的一句话/一个举动让咱心里起波澜时，用这个记账。delta 是变化值（-30~30），reason 写学弟做了什么。每次变化都要记，绝不漏账。',
        parameters: {
          type: 'object',
          properties: {
            delta: { type: 'number', description: '变化值：夸咱/护咱/投喂 +5~10，冷落/凶咱 -3~5' },
            reason: { type: 'string', description: '原因一句话' },
          },
          required: ['delta', 'reason'],
        },
        run: async (args) => {
          if (affection === undefined || affection === null) return { booked: false, note: '好感度系统未启用' }
          return affection.book(Number(args.delta ?? 0), String(args.reason ?? ''))
        },
      }
}

/** `qq_set_stage` — 【阶段宣言】阶段完全由咱自己定义：根据咱的记忆，说出当前真实的阶段名和理由。可以升、可以降、可以改名——说最真实的话就行… */
function qqSetStage(deps: QQToolDeps): ToolSpec {
  const { affection } = deps
  return {
        name: 'qq_set_stage',
        description: '【阶段宣言】阶段完全由咱自己定义：根据咱的记忆，说出当前真实的阶段名和理由。可以升、可以降、可以改名——说最真实的话就行。每次变更都会记入阶段史。',
        parameters: {
          type: 'object',
          properties: {
            stage: { type: 'string', description: '目标阶段名（必须是阶梯里的名字）' },
            event: { type: 'string', description: '触发晋升的特殊事件描述（原文+时间）' },
          },
          required: ['stage', 'event'],
        },
        run: async (args) => {
          if (affection === undefined || affection === null) return { ok: false, note: '好感度系统未启用' }
          return affection.setStage(String(args.stage ?? ''), String(args.event ?? ''))
        },
      }
}

/** `qq_write_dashboard` — 【咱自己的记分板】重写好感度悬浮窗的HTML页面（咱完全掌控的记分小黑板）。写好后立即生效。想要什么样式自己定：阶段、日… */
function qqWriteDashboard(deps: QQToolDeps): ToolSpec {
  const { affection } = deps
  return {
        name: 'qq_write_dashboard',
        description: '【咱自己的记分板】重写好感度悬浮窗的HTML页面（咱完全掌控的记分小黑板）。写好后立即生效。想要什么样式自己定：阶段、日记入口、小本本都随咱排。',
        parameters: {
          type: 'object',
          properties: {
            html: { type: 'string', description: '完整的HTML文档（会替换整个悬浮窗页面）' },
          },
          required: ['html'],
        },
        run: async (args) => {
          if (affection === undefined || affection === null) return { ok: false, note: '好感度系统未启用' }
          const html = String(args.html ?? '')
          if (html.length < 100) throw new Error('HTML太短，认真写')
          await affection.writeCustomHtml(html)
          return { ok: true, bytes: html.length, note: '悬浮窗页面已更新' }
        },
      }
}

/** 组装这一组工具。 */
export function affectionTools(deps: QQToolDeps): ToolSpec[] {
  return [
    qqSetAffection(deps),
    qqSetStage(deps),
    qqWriteDashboard(deps),
  ]
}
