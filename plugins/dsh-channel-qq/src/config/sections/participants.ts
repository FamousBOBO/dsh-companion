/** 参与者身份段（`participants`）：告诉她**谁是已确认的机器人**，而不是让她自己猜。
 *
 * 为什么必须有这一段（P9-G4 §2.1）：身份只能来自显式登记，不能来自"措辞像 AI""回复很快"
 * 或昵称。这一段就是那份登记的**入口**：它指向一个按群组织 JSON 文件，打开之后
 * 代码层（`core/participant.ts` + `adapters/fs-store/participant-registry.ts`）会先查表，
 * 再把 `known_bot` / `known_human` / `unknown` 交给判断器。
 *
 * **默认关**：关着时所有人都是 `unknown`——这不是缺陷，而是"未确认"。计划 §2.1 的要求是
 * "身份未知不妨碍理解消息内容，但不得把未知身份当成已确认事实"；关着就正好是这个状态，
 * 与旧行为逐字节一致。
 *
 * 三个字段都标 `live`：取用面按 (路径, mtime, size) 缓存，改文件、开开关、换路径都在下一次
 * 查询时生效，不需要重启。
 */

import { b, s, type FieldGroup } from '../dsl.js'

/** `participants` 段的形状；字段定义与默认值见下面 `PARTICIPANTS_GROUPS`（唯一来源）。 */
export interface ParticipantsConfig {
  /** 总开关（默认 false）：关着 = 不读注册表，所有人 `unknown`。 */
  enabled: boolean
  /** 注册表文件路径；空串 = `<dataRoot>/home/companion/participants.json`。 */
  file: string
  /**
   * **恒为 false**，只作为显式拒绝的文档（P9-G4 §2.1 最后两条）。
   *
   * 代码里**没有**把它当真的分支：未登记成员一律 `unknown`。留这个字段是为了让"能不能
   * 把没登记的人当机器人"这件事在后台可见、并有明确答案——否则下一个人会去加一个
   * `assumeUnknownIsBot` 开关，而那样一来"未登记成员不会被自动推断为 Bot"这条验收
   * 就只剩提示词在兜了。
   */
  allowUnknownAsBot: false
}

export const PARTICIPANTS_GROUPS: FieldGroup[] = [
  {
    id: 'participants',
    label: '群成员身份',
    page: 'groups',
    help: '告诉她谁是被**显式登记**的机器人、谁是已确认的人类。**默认关**：关着时所有成员都是'
      + '"身份未确认"，她照常理解消息内容，但不会对任何人的身份下结论。'
      + '关闭不会影响别的功能；打开也不会增加任何发送权限。',
    fields: {
      // 读法：身份查询前现取（live）。关着时**连文件都不读**——一个坏文件不该影响群聊。
      enabled: b('启用参与者注册表', false, {
        hot: 'live',
        page: 'groups',
        help: '打开后按群号查下面那个文件：命中的人按登记的身份对待（机器人 / 人类），'
          + '没命中的人仍然是"身份未确认"。**不改变她能不能说话**，只改变她说话时'
          + '"对面是谁"这件事有没有依据；关着时与不装这一功能时完全一样。',
      }),
      // 读法：路径在每次 load 时解析（reload 语义被缓存吸收：mtime 变了就重读）。
      file: s('注册表文件', '', {
        hot: 'reload',
        page: 'groups',
        placeholder: '<dataRoot>/home/companion/participants.json',
        help: '按群组织 JSON 的注册表；留空 = 套件数据目录下的 home/companion/participants.json。'
          + '文件不存在不算错误（等于没登记任何人），坏 JSON 也只会记一行日志、让所有人回到'
          + '"身份未确认"，不会让插件起不来。**建议写绝对路径**：相对路径按进程工作目录解析，'
          + '换个目录启动就会读到另一个文件。改动文件后不需要重启（按 mtime 自动重读）。',
      }),
      // 这一项**只作文档**：没有消费者把它读成 true，也不许有人加出这样的分支。
      allowUnknownAsBot: b('把未登记成员当机器人（不可开启）', false, {
        hot: 'live',
        page: 'groups',
        advanced: true,
        help: '**恒为 false，且不可生效**。未登记的成员一律按"身份未确认"对待：'
          + '不得凭措辞、昵称、头像或回复速度推断谁是机器人（P9-G4 §2.1）。'
          + '保留这一项只是把"这件事有明确答案"写进配置，免得下一个人去加一个能打开的开关。',
      }),
    },
  },
]
