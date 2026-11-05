/** 主动行为段（P6f `proactive.v2`：事件书取代写死的时刻表）。
 *
 * **默认关**：关着时走旧 `Scheduler`（`features/proactive/events.ts`），时刻表与
 * 行为逐字节不变；打开后由 `ProactiveExecutor` 读这本**书**（JSON，后台可编辑）——
 * 什么时间、往哪发、说什么，全部是数据。
 *
 * 段顺序是**线上配置文件键顺序**的一部分，段一旦加进去就不再挪位置（挪了 golden
 * 快照全红），所以本文件从 P5.6 起就占好了位。
 *
 * 两个字段都是 `reload`：选型（哪套实现）与书的校验都在子插件装配期完成——
 * 配一本坏书不该等到下一个整点才炸，保存时就该报。
 */

import { defaultEventBook } from '../../core/schedule/event-book.js'
import { b, json, type FieldGroup } from '../dsl.js'

// 类型本体（`ProactiveConfig`）在 `./switches.ts`：三个开关型段共处一处，
// 免得每加一段都要从贴着 400 行上限的 `config.ts` 里抠一行。本文件只有字段定义。

export const PROACTIVE_GROUPS: FieldGroup[] = [
  {
    id: 'proactive',
    label: '主动行为（事件书）',
    page: 'proactive',
    fields: {
      // 读法：proactive 子插件装配期把旧 `Scheduler` 的 `start()` 按它判一次（reload）。
      scheduler: b('旧定时行为（巡逻 / 做梦 / 自省 / 主动私聊 / 早报）', false, {
        hot: 'reload',
        help: '默认关。这是 v2 之前的写死时刻表：每 9 分钟巡逻一次主群、每 22 分钟主动私聊主人、'
          + '每天 04:xx 做梦、每 6 小时自省、06:00–11:59 早报、04:00–08:59 抽知识。'
          + '关着时**一个定时器都不注册**（不巡逻、不做梦、不自省、不主动私聊、不抽知识）。'
          + '要重新打开这套行为就显式勾上——它不是"插件装好就自动开始"的东西。'
          + '每项行为自己的开关（如「每日早报」）仍各自生效。',
      }),
      // 读法：proactive 子插件的 apply 按它选实现，watches 命中即重挂（live 语义但走 reload）。
      v2: b('事件书 v2', false, {
        hot: 'reload',
        help: '打开后：巡逻 / 早报 / 做梦 / 自省 / 主动私聊由下面这本书驱动（什么时间、往哪发、说什么都是数据）。'
          + '默认关——关着走内置时刻表，行为与从前一字不差。开关打开时早报与巡航的「开/关」以事件书为准（各事件自己的 enabled）。',
      }),
      book: json('事件书', defaultEventBook(), {
        hot: 'reload',
        advanced: true,
        help: '事件数组：每条有 id / enabled / kind（prompt·job·script）/ trigger（interval 或 window）/ quietHours，'
          + 'prompt 事件另有 target（primary-group·master-dm·group:<号>·dm:<号>）、template（人格包键名）、materials 与 requires。'
          + '保存时逐条校验，问题会一次列全（不合法会退回内置默认书并在日志里说明）。',
      }),
    },
  },
]
