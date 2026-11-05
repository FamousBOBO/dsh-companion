/** 安全段：风控 / 群事件 / 上下文预算 / 高危群管 / 策略与信任（page: flood / events / messages / tools）。
 *
 * `groupAdmin.dangerous` 是危险能力开关（D10）：默认 false，消费方在每次工具
 * 调用时现取（live），所以后台把它放在「工具与策略」页的配置段里，危险区另有
 * 二次确认。**`policy.v2` 打开且工具闸门真的挂上时，这个开关不再参与判定**——
 * 那时由"本回合是谁发起的"按信任表决定（只有主人回合能执行）；闸门装不上时
 * 自动退回这个开关（fail-closed，不是 fail-open）。
 */

import { b, e, list, n, type FieldGroup } from '../dsl.js'

export const SAFETY_GROUPS: FieldGroup[] = [
  {
    id: 'flood',
    label: '刷屏风控',
    page: 'flood',
    fields: {
      // 读法：FloodGuard 每次检查现取 this.config.flood（live）。
      enabled: b('启用', true, { hot: 'live' }),
      windowSec: n('统计窗口（秒）', 30, { min: 1, max: 3600, hot: 'live' }),
      maxMessages: n('窗口内条数上限', 12, { min: 1, max: 200, hot: 'live' }),
      action: e('动作', 'warn', [
        ['warn', '只在群里提醒'],
        ['mute', '禁言'],
        ['both', '提醒 + 禁言'],
      ], { hot: 'live' }),
      muteSeconds: n('禁言时长（秒）', 120, { min: 1, max: 2_592_000, hot: 'live' }),
      exempt: list('豁免 QQ 号', [], { help: '管理员永远豁免。', hot: 'live', itemsKind: 'number' }),
    },
  },
  {
    id: 'eventMonitor',
    label: '群事件',
    page: 'events',
    help: '哪些群事件会变成 agent 的话题素材。',
    fields: {
      // 读法：通知处理每事件经 config() 现取（live）。
      enabled: b('启用', true, { hot: 'live' }),
      kinds: list('事件类型', ['poke', 'group_increase', 'group_decrease', 'group_admin', 'group_ban', 'group_recall', 'friend_add'], { hot: 'live', itemsKind: 'string' }),
      windowSec: n('合并窗口（秒）', 120, { min: 0, max: 3600, hot: 'live' }),
    },
  },
  {
    id: 'contextBudget',
    label: '上下文预算',
    page: 'messages',
    fields: {
      // 读法：入站组包每包现取（live）。
      maxSteps: n('每轮最多几步', 0, { help: '0 = 用宿主的默认值。', min: 0, max: 100, hot: 'live', advanced: true }),
      compactChars: n('注入包压缩阈值（字）', 12_000, { help: '0 = 不压缩。', min: 0, max: 200_000, hot: 'live', advanced: true }),
    },
  },
  {
    id: 'groupAdmin',
    label: '高危群管',
    page: 'tools',
    help: '踢人 / 全员禁言 / 设管理员。目标由模型给，而模型的输入包含群友说的话，所以默认关闭。',
    fields: {
      // 读法：工具执行前的闸门每次现取（qq-tools.ts）——改动立即生效（live）。
      // policy.v2 打开且工具闸门生效时本开关被绕过（由信任表判），所以 help 里写明。
      dangerous: b('允许执行', false, {
        hot: 'live',
        help: 'policy.v2 打开且工具闸门生效时，这个开关不再参与判定——那时由"本回合是谁发起的"按信任表决定（只有主人回合能执行）。',
      }),
    },
  },
  {
    id: 'policy',
    label: '策略与信任（policy.v2）',
    page: 'tools',
    help: '信任分级 + 工具放行表 + 注入特征扫描与出站拦截。默认关，关着时行为与从前逐字节一致。',
    fields: {
      // 读法：闸门由根服务按开关现挂/现卸（plugin.ts 的 syncToolGate），
      // 入站扫描与出站判据每包/每调用现取——live。
      v2: b('启用策略 v2（policy.v2）', false, {
        hot: 'live',
        help: '打开后：按"本回合是谁发起的"决定高危群管 / 群文件写 / 好感度 / 宿主文件写入能不能做；入站消息做注入特征打标；出站文本拦广告前缀与连续复读开头。默认关。',
      }),
    },
  },
]
