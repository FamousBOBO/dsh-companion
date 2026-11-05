/** 合并面（三）：链接 / 生图 / 语录 / 提醒 / RSS。 */

import type { Face } from './types.js'

export const LINK_FACE: Face = {
  name: 'qq_link',
  description: '链接：解析一条链接拿「标题 + 简介 + 封面」（resolve）——群里有人甩链接、想知道那条 B站视频/歌曲/仓库讲的是什么时用；把链接做成卡片发到群或私聊（send_card，先发封面再发文本，封面失败自动降级成纯文本）。',
  branches: [
    { action: 'resolve', legacy: 'qq_resolve_link', required: ['url'] },
    { action: 'send_card', legacy: 'qq_send_link_card', required: ['url', 'target'], optional: ['isGroup'] },
  ],
}

export const IMAGE_FACE: Face = {
  name: 'qq_image',
  description: 'AI 生图：按提示词生成并直接发到会话（generate）、只生成保存到磁盘（generate_save）、查看生图后端配置（models）。提示词建议英文（主体+风格+氛围）；生图要 10~40 秒，别催。',
  branches: [
    { action: 'generate', legacy: 'qq_generate_image', required: ['prompt'], optional: ['isGroup', 'target'] },
    { action: 'generate_save', legacy: 'qq_generate_image_save', required: ['prompt'] },
    { action: 'models', legacy: 'qq_imagegen_models', required: [] },
  ],
}

export const QUOTE_FACE: Face = {
  name: 'qq_quote',
  description: '群语录：收录一条金句/群梗（save，原话照抄不要改写）、随机复读（random，可按 tag 过滤、可只查不发）、检索（search）、库统计（stats）、删除（delete）。',
  branches: [
    { action: 'save', legacy: 'qq_save_quote', required: ['text'], optional: ['speaker', 'speakerId', 'groupId', 'tags', 'note'] },
    { action: 'random', legacy: 'qq_random_quote', required: [], optional: ['tag', 'isGroup', 'target', 'send'] },
    { action: 'search', legacy: 'qq_search_quote', required: ['query'], optional: ['limit'] },
    { action: 'stats', legacy: 'qq_quote_stats', required: [] },
    { action: 'delete', legacy: 'qq_delete_quote', required: ['id'] },
  ],
}

export const REMIND_FACE: Face = {
  name: 'qq_remind',
  description: '提醒：用自然语言定提醒（add，"明天9点叫我起床"这类；认不出写法时会返回支持的写法列表）、用确切时间定（add_at，Unix 毫秒时间戳或 "YYYY-MM-DD HH:mm"）、列出（list）、取消（cancel）。到点由主控推送到指定房间。',
  branches: [
    { action: 'add', legacy: 'qq_remind', required: ['when', 'text'], optional: ['isGroup', 'target', 'sessionId', 'createdBy'] },
    { action: 'add_at', legacy: 'qq_remind_at', required: ['at', 'text'], optional: ['repeat', 'isGroup', 'target', 'sessionId', 'createdBy'] },
    { action: 'list', legacy: 'qq_remind_list', required: [], optional: ['limit'] },
    { action: 'cancel', legacy: 'qq_remind_cancel', required: ['id'] },
  ],
}

export const RSS_FACE: Face = {
  name: 'qq_rss',
  description: 'RSS/Atom 订阅：订阅一个源（add，会先真拉一次验证地址，拉不通不写配置）、列出全部（list）、按 id 取消（remove）、只预览地址最新 5 条不写订阅（preview）。有更新会自动推送到订阅里指定的房间。',
  branches: [
    { action: 'add', legacy: 'qq_rss_add', required: ['url'], optional: ['isGroup', 'target'] },
    { action: 'list', legacy: 'qq_rss_list', required: [] },
    { action: 'remove', legacy: 'qq_rss_remove', required: ['id'] },
    { action: 'preview', legacy: 'qq_rss_preview', required: ['url'] },
  ],
}

export const CONTENT_FACES: readonly Face[] = [LINK_FACE, IMAGE_FACE, QUOTE_FACE, REMIND_FACE, RSS_FACE]
