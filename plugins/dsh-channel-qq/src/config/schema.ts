/** 配置 schema：一份**声明**，多处消费。
 *
 *   1. `DEFAULT_CONFIG` 由它生成（不再手写一份，避免"默认值两处不一致"）；
 *   2. `resolveConfig` 由它驱动（哪一段怎么合并、哪一列是整体替换，写在 schema 里）；
 *   3. 管理后台由它渲染（中文标签、说明、取值范围、热生效等级、页面归属）。
 *
 * P5.6 起字段定义拆到 `sections/*`（每个模块一段）：新增一个配置项的成本 =
 * 改一处（`test/admin-schema.test.ts` 会校验每个字段都有页面与热生效标注）。
 *
 * **顺序即线上配置文件的键顺序**（`DEFAULT_CONFIG` 的键序、快照逐字节比对都
 * 依赖它）：`root` 里顶层字段与段的交错顺序、每个段内的字段顺序，都不是审美
 * 问题——改顺序会让 `test/golden/config/*.txt` 全红。
 */

import type { ConfigSchema, FieldGroup, FieldSpec, SectionFieldSpec } from './dsl.js'
import { CONTENT_GROUPS } from './sections/content.js'
import { MEMORY_GROUPS } from './sections/memory.js'
import { MUSIC_GROUPS } from './sections/music.js'
import { SKILLS_GROUPS } from './sections/skills.js'
import { CHAT_GROUPS } from './sections/chat.js'
import { MEDIA_GROUPS } from './sections/media.js'
import { NETWORK_GROUPS } from './sections/network.js'
import { SAFETY_GROUPS } from './sections/safety.js'
import { SYSTEM_GROUPS } from './sections/system.js'
import { TOOLS_GROUPS } from './sections/tools.js'
import { PROACTIVE_GROUPS } from './sections/proactive.js'
import { PLANNER_GROUPS } from './sections/planner.js'
import { ROOT_ENTRIES } from './sections/root.js'
import { SESSION_RESET_GROUPS } from './sections/session-reset.js'
import { KB_GROUPS } from './sections/kb.js'
import { CONTACT_GROUPS } from './sections/contact.js'
import { PRESENCE_GROUPS } from './sections/presence.js'
import { SONG_GROUPS } from './sections/song.js'

export type {
  ConfigSchema, FieldGroup, FieldKind, FieldSpec, HotLevel, SectionFieldSpec,
} from './dsl.js'
export { NO_DEFAULT } from './dsl.js'

export const SCHEMA: ConfigSchema = {
  root: Object.fromEntries(ROOT_ENTRIES) as Record<string, FieldSpec | SectionFieldSpec>,
  // 段的拼接顺序 = 历史上的 groups 顺序（sectionIds 的消费方按它分页/分栏）。
  groups: [
    ...CHAT_GROUPS,
    ...SYSTEM_GROUPS,
    ...MEDIA_GROUPS,
    ...NETWORK_GROUPS,
    ...CONTENT_GROUPS,
    ...MEMORY_GROUPS,
    ...MUSIC_GROUPS,
    ...SKILLS_GROUPS,
    ...SAFETY_GROUPS,
    ...TOOLS_GROUPS,
    ...PROACTIVE_GROUPS,
    ...PLANNER_GROUPS,
    ...SESSION_RESET_GROUPS,
    ...KB_GROUPS,
    // A2 主动消息（门控）：追加在末尾，与 root.ts 里的段入口同一序位。
    ...CONTACT_GROUPS,
    // 点歌翻唱：插在 `presence` 之前（`presence-config.test.ts` 钉着"presence 是最后一个段"）。
    ...SONG_GROUPS,
    // 群聊旁听与自主接话：同样**只追加在末尾**（段顺序 = 线上配置键顺序）。
    ...PRESENCE_GROUPS,
  ],
}

/** 按 id 找一段。 */
export function groupOf(schema: ConfigSchema, id: string): FieldGroup | undefined {
  return schema.groups.find((g) => g.id === id)
}

/** schema 里所有"段"的 id（后台分页与逐段热加载都按它来）。 */
export function sectionIds(schema: ConfigSchema = SCHEMA): string[] {
  return schema.groups.map((g) => g.id)
}
