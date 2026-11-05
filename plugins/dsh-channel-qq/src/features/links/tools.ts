/** 链接卡片：把 B站 / 网易云 / GitHub / 普通网页解析成「标题 + 简介 + 封面」。

 * 解析本身在 `adapters/providers/links/`（那是 provider：抓页面、读 meta、跟短链）；
 * 这里只有工具面。两者分开的原因很实际：解析逻辑要能换（B站的接口说变就变），
 * 而"模型怎么调用它"不该跟着一起动。
 *
 * 自动出卡（不经模型、白名单群直接发）也在 provider 里，由 `features/observers`
 * 在旁路观察里调用——**不走这里**，因为那条路径不需要模型参与。
 */

import { registerSpecs, params, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQChannelConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'
import { resolveLink, sendLinkCard } from '../../adapters/providers/links/index.js'

interface TargetLike {
  isGroup?: unknown
  target?: unknown
  groupId?: unknown
  userId?: unknown
}

/** 从工具入参推出"发到哪"。 */
function targetOf(args: Record<string, unknown>): { isGroup: boolean; target: number } {
  const bag = args as TargetLike
  const explicitGroup = typeof bag.isGroup === 'boolean' ? bag.isGroup : undefined
  const id = bag.target ?? bag.groupId ?? bag.userId
  const target = typeof id === 'number' ? id : Number(String(id ?? '').trim())
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error('发链接卡片失败：需要一个有效的会话号（群号或 QQ 号），可以从当前消息的会话 id 拿')
  }
  const isGroup = explicitGroup ?? (bag.groupId !== undefined)
  return { isGroup, target }
}

/**
 * 注册链接解析工具。
 *
 * 接线：`registerLinkTools(ctx, config, api, out, log)`，返回的 disposer 交给
 * cordis 的 effect/cleanup 即可（和 `registerQQTools` 一样，一行调用）。
 */
export function registerLinkTools(
  ctx: ToolHost,
  config: QQChannelConfig,
  api: QQApi,
  out: OutboundQueue,
  log: (line: string) => void,
): () => void {
  const cfg = config.linkResolve
  const disabled = (): { ok: false; note: string } => ({ ok: false, note: '链接解析已在配置里关闭' })

  const specs: ToolSpec[] = [
    {
      name: 'qq_resolve_link',
      description: '解析一条链接，拿到「标题 + 简介 + 封面图 URL」。群里有人甩链接、'
        + '你想知道那条 B站视频/网易云歌曲/GitHub 仓库讲的是什么，或者准备把链接做成卡片发出去时，先用它。'
        + '返回的是 { ok, card } 结构，封面在 card.cover（没有则为 null）。',
      parameters: params({
        url: { type: 'string', description: '要解析的链接（http(s):// 或 b23.tv 短链、裸 BV 号都可以）' },
      }, ['url']),
      run: async (args) => {
        if (!cfg.enabled) return disabled()
        const raw = String(args.url ?? '').trim()
        if (raw === '') throw new Error('链接解析失败：url 不能为空')
        const card = await resolveLink(raw, { bilibiliCookie: cfg.bilibiliCookie, log })
        return { ok: true, card }
      },
    },
    {
      name: 'qq_send_link_card',
      description: '把一条链接做成卡片发到指定群或私聊：先发封面图，再发「标题 + 简介 + 原链接」的文本。'
        + '什么时候用：群友甩了链接、你确认值得分享时（不要每一条都发，除非对方让你发）。'
        + '封面下载失败会自动降级成只发文本，不会报错。',
      parameters: params({
        url: { type: 'string', description: '要发送的链接' },
        isGroup: { type: 'boolean', description: 'true=群聊，false=私聊；不填时按 target/groupId 推断' },
        target: { type: 'number', description: '群号或 QQ 号' },
      }, ['url', 'target']),
      run: async (args) => {
        if (!cfg.enabled) return disabled()
        const raw = String(args.url ?? '').trim()
        if (raw === '') throw new Error('发链接卡片失败：url 不能为空')
        const { isGroup, target } = targetOf(args)
        const card = await resolveLink(raw, { bilibiliCookie: cfg.bilibiliCookie, log })
        // 发送逻辑与自动出卡共用同一份实现，避免两处走样。
        const sent = await sendLinkCard(api, out, card, { isGroup, target, log })
        return {
          ok: sent.ok,
          kind: card.kind,
          title: card.title,
          cover: card.cover,
          sentImage: sent.imageUrl !== null,
          ...(sent.note === undefined ? {} : { note: sent.note }),
        }
      },
    },
  ]

  return registerSpecs(ctx, specs, log, 'link-resolve')
}
