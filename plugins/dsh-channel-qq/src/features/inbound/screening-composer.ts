/** 组包包装（P6c）：`policy.v2` 打开时，三条入站路径（群攒批 / 私聊直投 / 注入）
 * 都附上注入信号，并把本包的发送者污点预登记进回合账本。
 *
 * 从 `inbound/index.ts` 搬出来的唯一理由：那个文件的装配已经很长（`check:size` 对单文件
 * 有硬上限），而这个类是可独立阅读的一小块——它只做"扫描 + 合流 + 记账"三件事，
 * 与装配顺序无关。
 *
 * 关着时三条路径原样透传：扫描器一次都不被调用，输出与旧版逐字节一致。
 */

import { PacketComposer } from '../../app/inbound/packet-composer.js'
import type {
  ComposeInput, DmComposeInput, InjectComposeInput, PacketComposerDeps,
} from '../../app/inbound/packet-composer.js'
import type { PolicyScreening } from '../../app/policy/tool-policy.js'
import type { ConversationRecord } from '../../app/conversation/registry.js'

export class ScreeningPacketComposer extends PacketComposer {
  constructor(deps: PacketComposerDeps, private readonly screening: PolicyScreening) {
    super(deps)
  }

  override async compose(
    conversation: ConversationRecord,
    input: ComposeInput = {},
  ): Promise<{ text: string; imageRefs: unknown[] }> {
    const scan = this.screening.scan(conversation.queue.join('\n'))
    const result = await super.compose(conversation, this.screening.merge(input, scan))
    this.screening.stage(conversation.sessionId, result.text)
    return result
  }

  override async composeDm(conversation: ConversationRecord, input: DmComposeInput): Promise<string> {
    const scan = this.screening.scan(input.line ?? '')
    const result = await super.composeDm(conversation, this.screening.merge(input, scan))
    this.screening.stage(conversation.sessionId, result)
    return result
  }

  override composeInject(conversation: ConversationRecord, input: InjectComposeInput): string {
    const scan = this.screening.scan(input.body)
    const result = super.composeInject(conversation, this.screening.merge(input, scan))
    this.screening.stage(conversation.sessionId, result)
    return result
  }
}
