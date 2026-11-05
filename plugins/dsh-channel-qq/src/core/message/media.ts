/** 图片字节 → 媒体类型。
 *
 * 按**魔数**判断而不是看响应头：附件服务会按这个类型校验解码后的字节，而群友发的
 * 链接的 `Content-Type` 是不可信的（也是常见的一类"看起来是图、其实是别的"）。
 * 认不出来时按 jpeg 处理——这是原来就在做的兜底，行为未变。
 */

/** 从字节前缀判断媒体类型。认不出来返回 `image/jpeg`。 */
export function sniffMediaType(bytes: Uint8Array): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  return 'image/jpeg'
}

/** 媒体类型 → 文件后缀（存附件时给它起个像样的名字）。 */
export function extensionOf(mediaType: string): string {
  return mediaType.slice(mediaType.indexOf('/') + 1)
}
