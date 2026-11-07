/** 表情段：让 QQ 把一张图**当成表情**显示，而不是当成一张图片。
 *
 * 为什么需要这个文件
 * ------------------
 * OneBot 的 `image` 段有个 `sub_type` 字段（QQNT / NapCat 侧的原生含义）：`0` 是普通图片，
 * `1` 是**表情**。发出去的两张图字节完全一样，用户看到的却是两种东西——普通图片会占一屏、
 * 带白底/黑边、点开是大图预览；表情则是那个小方框，跟 QQ 表情面板里发出来的一样。
 *
 * 2026-11-07 实测（NapCat 4.18.19 / protocol v11，`send_private_msg` + `get_msg` 回读）：
 *
 * | 发出的段 | 回读的 `sub_type` | 用户看到的 |
 * |---|---|---|
 * | `{file}` | `0` | 一张图片 ← 这就是当时的问题 |
 * | `{file, summary:'[表情]'}` | `0` | 一张图片 |
 * | `{file, sub_type:1}` | `1` | **一个表情** |
 * | `{file, sub_type:1, summary:'[表情]'}` | `1` | **一个表情** |
 *
 * 结论：决定是不是表情的是 **`sub_type: 1`**，`summary` 只影响列表里的占位文字。
 * 两个都带上：规矩的客户端看 `sub_type`，只认文本的客户端至少看到 `[表情]`。
 */

import type { OneBotMessageSegment } from '../../types.js'

/** 图片段的 `sub_type`：0 = 图片，1 = 表情（QQNT 原生语义）。 */
export const IMAGE_SUBTYPE_STICKER = 1

/**
 * 把已经处理好的 `file`（`base64://` / `file://…` / 绝对路径）包成**表情段**。
 *
 * 只影响显示形态，不改字节、不改体积、不改出站边界——`file` 必须已经过
 * `napcatFileArg()`（它负责边界校验与内联）。这里不做任何 IO。
 */
export function stickerSegment(file: string): OneBotMessageSegment {
  return { type: 'image', data: { file, sub_type: IMAGE_SUBTYPE_STICKER, summary: '[表情]' } }
}
