/** 技能段：仓库位置、脚本与导入的开关（page: skills）。
 *
 * 技能的**可见范围不在这里**——它随技能本身写在 SKILL.md 的 `metadata` 里
 * （`channel-qq.visibility` 等），因为每个技能各不相同，而配置是一份全局值。
 * 这里只有"整个仓库怎么用"的三个开关。
 */

import { b, n, s, type FieldGroup } from '../dsl.js'

/** 技能相关的全局配置。 */
export interface SkillsConfig {
  /** 总开关：关掉后不注册 provider、不启用 `/name` 触发（后台仍可编辑）。 */
  enabled: boolean
  /** 仓库根目录；留空 = `<dshHome>/channel-qq/skills`。 */
  dir: string
  /** 是否允许技能包携带并在会话里执行 `scripts/`。 */
  allowScripts: boolean
  /** 是否允许从 URL / 粘贴导入（导入一律先落到待审区）。 */
  allowImport: boolean
  /** 单个导入包的大小上限（字节）。 */
  maxImportBytes: number
}

export const SKILLS_GROUPS: FieldGroup[] = [
  {
    id: 'skills',
    label: '技能',
    page: 'skills',
    fields: {
      // 读法：子插件挂载时读一次；改开关要重载（watch 到这一段就会重挂）。
      enabled: b('启用技能', true, {
        hot: 'reload',
        help: '关闭后模型看不到技能目录、`/名字` 也不会触发；后台仍可编辑技能。',
      }),
      dir: s('技能目录', '', {
        hot: 'reload',
        help: '留空 = `~/.dsh/channel-qq/skills`。**不要指到工作区里**——'
          + '工作区对模型可写，技能正文会进系统提示，等于给注入留后门。',
      }),
      allowScripts: b('允许技能脚本', false, {
        hot: 'live',
        help: '打开后带 `scripts/` 的技能可以在会话里执行脚本（仍受工作区沙箱约束）。',
      }),
      allowImport: b('允许导入', true, {
        hot: 'live',
        help: '允许从 URL / 粘贴导入技能。导入一律先进待审区，管理员确认后才启用。',
      }),
      maxImportBytes: n('导入包上限', 2 * 1024 * 1024, {
        hot: 'live', min: 64 * 1024, max: 32 * 1024 * 1024, unit: 'B',
        advanced: true,
        help: '单个导入包（含 scripts/references）的总字节上限。',
      }),
    },
  },
]
