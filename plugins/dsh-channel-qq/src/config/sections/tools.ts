/** 工具段（P6d `tools.v2`：86 个工具面合并到 17 个 + 会话档位）。
 *
 * 段顺序是线上配置文件键顺序的一部分（schema.ts 的 groups 与 root.ts 的条目
 * 按它排），段一旦加进去就不再挪位置。开关的读法：注册面在 qq-tools 挂载时按
 * 它构建一次（改完需重启 dsh）；档位拒绝随工具闸门即时生效（每调用现取）。
 * 86→17 的映射、档位表与切换日说明都在 `src/features/tools-v2/`。
 */

import { b, type FieldGroup } from '../dsl.js'

export const TOOLS_GROUPS: FieldGroup[] = [
  {
    id: 'tools',
    label: '工具面',
    page: 'tools',
    help: 'QQ 工具面的取舍（P6d）。默认关：关着时与从前逐字节一致。',
    fields: {
      // 读法：工具面在插件挂载时按开关构建一次（qq-tools 的 registerQQTools）；
      // 档位拒绝由工具闸门按开关现取——面要重启、拒绝即时。
      v2: b('启用工具合并 v2（tools.v2）', false, {
        hot: 'restart',
        help: '打开后：QQ 工具从 86 个合并成 17 个（工具名 + action 参数），群会话只开放常用档位；'
          + '切换日会给已有会话投一次"工具已更名"说明，并把工具清单同步进工作区 AGENTS.md。需重启 dsh 生效。默认关。',
      }),
    },
  },
]
