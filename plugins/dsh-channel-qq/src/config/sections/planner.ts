/** 群聊决策段（P6g `group.planner`：进主 agent 之前先判"该不该说话"）。
 *
 * 空壳先落地：`schema.ts` 的段顺序是**线上配置文件键顺序**的一部分，段一旦加进去
 * 就不再挪位置（挪了 golden 快照全红）。所以先占位、后填字段。
 */

import type { FieldGroup } from '../dsl.js'

export const PLANNER_GROUPS: FieldGroup[] = []
