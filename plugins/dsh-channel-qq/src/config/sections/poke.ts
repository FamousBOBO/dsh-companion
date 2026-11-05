/** 戳一戳段：类型 + 字段。与 interaction 同理——`config.ts` 有体积硬上限，
 * 新增/搬迁一段时把类型一起放进 `sections/`，入口文件只留 `import(...)`。 */

import { b, n, type FieldGroup } from '../dsl.js'

export interface PokeConfig {
  enabled: boolean
  /**
   * Coalescing window: pokes inside it collapse into one adjudication, so a
   * sticker-tap storm does not submit a turn per tap.
   *
   * `patience` and `pokeBack` used to live here — "how many pokes before 诺诺
   * reacts" and "poke the sender back". Adjudication mode removed auto-reaction
   * entirely (the plugin never pokes or speaks on its own; the model decides via
   * `qq_send_poke`), so both were read by nothing while still being rendered as
   * live controls in the admin panel. They are gone rather than left lying.
   */
  windowSec: number
}

export const POKE_GROUPS: FieldGroup[] = [
  {
    id: 'poke',
    label: '戳一戳',
    page: 'events',
    fields: {
      // 读法：notice 处理每事件现取（live）。
      enabled: b('启用', true, { hot: 'live' }),
      windowSec: n('合并窗口（秒）', 300, { help: '窗口内的多次戳合并成一次处理。', min: 0, max: 3600, hot: 'live' }),
    },
  },
]
