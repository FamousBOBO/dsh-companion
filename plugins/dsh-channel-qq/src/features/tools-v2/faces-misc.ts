/** 合并面（四）：记忆 / 口癖学习 / 刷屏风控 / 好感度。 */

import type { Face } from './types.js'

export const MEMORY_FACE: Face = {
  name: 'qq_memory',
  description: '长期记忆：主动召回（recall，带类型过滤，命中的条目会被强化）、把一条事实写进记忆（memorize）、检索知识库（retrieve）、从一段文字批量提取入库（extract）。回答"你还记得…""上次那个"之前先 recall 或 retrieve；日常寒暄不要写记忆。',
  branches: [
    { action: 'recall', legacy: 'qq_recall_memory', required: ['query'], optional: ['type', 'limit', 'reinforce'] },
    { action: 'memorize', legacy: 'qq_memorize_fact', required: ['content'], optional: ['type', 'tags', 'source'] },
    // 05 §6.1 的合并表漏列了两个旧工具（retrieve_knowledge / extract_knowledge，
    // 在今天的注册面上确实存在）。为保持"合并不丢能力"，各自给一个动作——
    // 表覆盖的 86 个 + 这两个 = 全部 88 个，工具数仍是 17。
    { action: 'retrieve', legacy: 'retrieve_knowledge', required: ['query'] },
    { action: 'extract', legacy: 'extract_knowledge', required: ['source', 'text'] },
    // 深召回：原文块（600 字）+ 出处，一次 5–8 条。不进自动注入预算，由 agent 主动调。
    { action: 'search', legacy: 'qq_memory_search', required: ['query'], optional: ['limit', 'asOf'] },
  ],
}

export const LEARN_FACE: Face = {
  name: 'qq_learn',
  description: '群聊口癖学习：看群友最近在复读什么（top，带次数与语境）、手动记住一句梗（learn）、忘掉某句（forget）、运行状态（stats）。学到的话在合适的时候自然用出来，别生硬堆砌、也别拿来冒充别人说话。',
  branches: [
    { action: 'top', legacy: 'qq_learned_phrases', required: [], optional: ['limit', 'groupId'] },
    { action: 'learn', legacy: 'qq_learn_phrase', required: ['text'], optional: ['groupId'] },
    { action: 'forget', legacy: 'qq_forget_phrase', required: ['text'] },
    { action: 'stats', legacy: 'qq_learn_stats', required: [] },
  ],
}

export const FLOOD_FACE: Face = {
  name: 'qq_flood',
  description: '刷屏风控：看当前状态（stats，跟踪人数/累计触发/阈值/动作）、把某个 QQ 号加进或移出豁免名单（exempt，改的是内存配置，重启回到文件值）。',
  branches: [
    { action: 'stats', legacy: 'qq_flood_stats', required: [] },
    { action: 'exempt', legacy: 'qq_flood_exempt', required: ['userId'], optional: ['remove'] },
  ],
}

export const AFFECTION_FACE: Face = {
  name: 'qq_affection',
  description: '好感度：给一次让你起波澜的事记账（book，delta -30~30）、阶段宣言（set_stage，阶段名和理由由自己定义）、重写悬浮窗页面（write_dashboard，整页 HTML）。仅主人私聊的回合能用；每次变化都要记账，绝不漏账。',
  branches: [
    { action: 'book', legacy: 'qq_set_affection', required: ['delta', 'reason'] },
    { action: 'set_stage', legacy: 'qq_set_stage', required: ['stage', 'event'] },
    { action: 'write_dashboard', legacy: 'qq_write_dashboard', required: ['html'] },
  ],
}

export const MISC_FACES: readonly Face[] = [MEMORY_FACE, LEARN_FACE, FLOOD_FACE, AFFECTION_FACE]
