/**
 * OneBot v11 事件的形状校验与过滤（**在落盘之前**执行）。
 *
 * 三条纪律，顺序不能颠倒：
 *   1. **先验形状**：不是对象、没有 `post_type`、群号不像群号、正文超长 → 一律拒绝。
 *      形状不对的事件连"是不是白名单群"都判断不了，任何后续处理都建立在一个猜测上。
 *   2. **再筛类型**：只放行 `post_type=message` 且 `message_type=group`。私聊、好友申请、
 *      群邀请、管理通知、心跳等一律不进入镜像——计划 §G1 要求的就是这个唯一入口。
 *   3. **最后筛白名单**：空白名单 = 不转发任何群（不是"全部"）。这一步必须在写日志和
 *      入队之前，否则其它群的正文会先落到磁盘上再被丢弃。
 *
 * 这里**不做语义理解**：不自称、不猜群号、不从正文里推断"这是哪个群"。
 * 群号只从事件的 `group_id` 字段取。
 */

/** 一条事件被拒绝的原因（日志与统计用；测试断言这两个字段）。 */
export const REJECT = Object.freeze({
  SHAPE: 'shape',
  OVERSIZE: 'oversize',
  TYPE: 'type',
  GROUP: 'group',
})

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 正文长度：字符串直接算长度，数组按各段 `data.text` 累加（array 格式与 string 格式都要支持）。 */
function textLength(message) {
  if (typeof message === 'string') return message.length
  if (!Array.isArray(message)) return 0
  let total = 0
  for (const segment of message) {
    if (!isPlainObject(segment)) continue
    const data = segment.data
    if (isPlainObject(data) && typeof data.text === 'string') total += data.text.length
  }
  return total
}

/**
 * 校验一条原始事件的形状。通过则返回归一化后的字段，否则返回 `{ ok: false, reason }`。
 *
 * 归一化只做**取值与类型收敛**，不补默认值：缺 `message_id` 的事件在去重那层没有键，
 * 补一个合成 id 会让两条不同消息被当成同一条（或反过来），那是猜。
 */
export function validateEvent(raw, { maxEventBytes = 64 * 1024 } = {}) {
  if (!isPlainObject(raw)) return { ok: false, reason: REJECT.SHAPE, detail: 'not-an-object' }

  // 先卡体积：超长正文不该进入任何后续处理，也不该被算进"类型不对"里掩盖掉。
  let size = 0
  try {
    size = Buffer.byteLength(JSON.stringify(raw), 'utf8')
  } catch {
    return { ok: false, reason: REJECT.SHAPE, detail: 'not-serializable' }
  }
  if (size > maxEventBytes) return { ok: false, reason: REJECT.OVERSIZE, detail: size }

  const postType = typeof raw.post_type === 'string' ? raw.post_type : ''
  if (postType === '') return { ok: false, reason: REJECT.SHAPE, detail: 'no-post-type' }

  if (postType !== 'message') return { ok: false, reason: REJECT.TYPE, detail: postType }
  const messageType = typeof raw.message_type === 'string' ? raw.message_type : ''
  if (messageType !== 'group') return { ok: false, reason: REJECT.TYPE, detail: 'message/' + (messageType || 'unknown') }

  const groupId = Number(raw.group_id)
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return { ok: false, reason: REJECT.GROUP, detail: 'bad-group-id' }

  const selfId = Number(raw.self_id)
  const userId = Number(raw.user_id)
  const messageId = Number(raw.message_id)
  const time = Number(raw.time)

  return {
    ok: true,
    event: {
      postType,
      messageType,
      groupId,
      selfId: Number.isSafeInteger(selfId) && selfId > 0 ? selfId : null,
      userId: Number.isSafeInteger(userId) && userId > 0 ? userId : null,
      messageId: Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null,
      timeMs: Number.isFinite(time) && time > 0 ? time * 1000 : null,
      // 自发消息：留着当上下文，但**不会再触发主动发言判断**（由调用方决定）。
      self: Number.isSafeInteger(selfId) && Number.isSafeInteger(userId) && selfId > 0 && selfId === userId,
      textLength: textLength(raw.message),
      raw,
    },
  }
}

/**
 * 白名单判定。**空白名单 = 拒绝一切**（fail-closed，计划 §G1 明写）。
 *
 * @param {number} groupId
 * @param {readonly number[]} allowedGroups
 */
export function groupAllowed(groupId, allowedGroups) {
  if (!Array.isArray(allowedGroups) || allowedGroups.length === 0) return false
  return allowedGroups.includes(Number(groupId))
}

/**
 * 一次完整的"能不能进镜像"判定。顺序固定：形状 → 类型 → 白名单。
 *
 * @returns `{ accepted: true, event }` 或 `{ accepted: false, reason, detail }`
 */
export function admitEvent(raw, options = {}) {
  const checked = validateEvent(raw, options)
  if (!checked.ok) return { accepted: false, reason: checked.reason, detail: checked.detail }
  if (!groupAllowed(checked.event.groupId, options.allowedGroups ?? [])) {
    return { accepted: false, reason: REJECT.GROUP, detail: 'not-allowlisted' }
  }
  return { accepted: true, event: checked.event }
}
