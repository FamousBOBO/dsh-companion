/** 群成员的**身份模型**（P9-G4 §2）：把"这个人是谁"变成代码层的显式事实。
 *
 * 为什么必须是代码层而不是提示词层：计划 §2.1 写死了四条——不得凭消息内容、昵称、头像、
 * 回复速度或"像 AI 的措辞"推断 Bot 身份。任何"让模型自己判断谁是机器人"的做法都会在
 * 第一次遇到措辞规整的人类时翻车，而且翻车方式不可复现。所以身份只有两个来源：
 *
 *   1. **显式登记**的注册表（`known_bot` / `known_human`）；
 *   2. **她自己的号**（`self`，来自 `config.selfId`，属于可信平台身份）。
 *
 * 两者都不是 → `unknown`。**`unknown` 不是缺陷**：它只是"未确认"，而计划 §2.1 明写
 * "身份未知不妨碍理解消息内容，但不得将未知身份当成已确认事实"。
 *
 * 三条纪律：
 *   1. **不猜**：形状不对的注册表条目整条丢掉，而不是补一个默认 kind；
 *   2. **不跨群**：注册表按 `groupId + userId` 组织（§2.2），同一个号在 A 群登记为 bot
 *      不意味着它在 B 群也是——那是别人的号，或者干脆不是同一个实体；
 *   3. **纯**：不读盘、不读时钟、不联网（R8）。注册表的**字节**由适配层读，这里只认形状。
 */

/** 一个发言者的身份类别（§2.1 的联合）。 */
export type SenderKind = 'self' | 'known_bot' | 'known_human' | 'unknown'

/** 身份从哪来。`unknown` 的成员也带 `source: 'unknown'`，不省略字段。 */
export type ParticipantSource = 'manual_registry' | 'trusted_platform' | 'unknown'

/** 一名参与者的完整身份（§2.1）。 */
export interface GroupParticipant {
  readonly userId: number
  /** 展示名（群名片或昵称）；空串 = 不知道。**只用于展示，不作为身份依据**。 */
  readonly displayName: string
  readonly senderKind: SenderKind
  /** 注册表里的稳定标识（§2.2 的 `alias`）；只有 `known_bot` 可能带。 */
  readonly botProfileId?: string
  /** 登记/确认时间（毫秒）；`unknown` 没有。 */
  readonly verifiedAt?: number
  readonly source: ParticipantSource
}

/** 注册表里的一条成员记录（§2.2）。 */
export interface RegistryMember {
  /** 平台身份主键。 */
  readonly userId: number
  readonly kind: 'bot' | 'human'
  /** 展示用别名；**不作为身份依据**（§2.2）。 */
  readonly alias: string
  /** 可选元数据；未知就缺省，**禁止猜测**。 */
  readonly framework?: string
  readonly modelFamily?: string
  readonly interactionStyle?: string
  /** 登记/确认时间（毫秒）。 */
  readonly verifiedAt?: number
}

/** 一个群的注册表（§2.2：按 `groupId + userId` 管理，避免跨群身份泄漏）。 */
export interface GroupRegistry {
  readonly groupId: number
  /** 版本号或内容哈希：回放要用"事件发生时有效的那一版"（§2.3）。 */
  readonly version: string
  readonly members: readonly RegistryMember[]
}

/** 注册表文件的整体形状。 */
export interface RegistryFile {
  readonly schemaVersion: 1
  readonly groups: readonly GroupRegistry[]
}

/** 归一化结果：要么可用，要么给出**可进日志**的问题列表（绝不抛）。 */
export type RegistryParse =
  | { readonly ok: true; readonly file: RegistryFile; readonly dropped: readonly string[] }
  | { readonly ok: false; readonly problems: readonly string[] }

/** 正整数才算合法的号（群号、QQ 号同一判据）。 */
function positiveId(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : value
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null
}

/** 非空短字符串；超长或空串一律当"没有"。 */
function shortText(value: unknown, max = 80): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' || [...text].length > max ? undefined : text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 归一化一条成员记录。**形状不对就整条丢掉**（回 `null`），不补默认 kind。
 *
 * 为什么不宽容：注册表是"谁已确认"的唯一来源。补一个默认 `kind` 等于凭空确认了一个
 * 身份，而错误方向的确认（把人类标成 bot）会让她的社交判断建立在假事实上。
 */
export function normalizeMember(raw: unknown): RegistryMember | null {
  if (!isRecord(raw)) return null
  const userId = positiveId(raw['userId'])
  if (userId === null) return null
  const kind = raw['kind']
  if (kind !== 'bot' && kind !== 'human') return null
  const alias = shortText(raw['alias']) ?? ''
  const framework = shortText(raw['framework'])
  const modelFamily = shortText(raw['modelFamily'])
  const interactionStyle = shortText(raw['interactionStyle'])
  const verifiedAt = raw['verifiedAt']
  return {
    userId,
    kind,
    alias,
    ...(framework === undefined ? {} : { framework }),
    ...(modelFamily === undefined ? {} : { modelFamily }),
    ...(interactionStyle === undefined ? {} : { interactionStyle }),
    ...(typeof verifiedAt === 'number' && Number.isFinite(verifiedAt) && verifiedAt > 0 ? { verifiedAt } : {}),
  }
}

/**
 * 归一化一整个注册表文件。
 *
 * 三条：版本号可缺省（缺省时由适配层按内容算哈希）、重复的 `userId` 保留第一条并记一行、
 * 群号重复的整段丢掉（"同一个群两份注册表"是配置错误，挑一份等于猜）。
 */
export function normalizeRegistryFile(raw: unknown): RegistryParse {
  if (!isRecord(raw)) return { ok: false, problems: ['注册表根不是对象'] }
  if (raw['schemaVersion'] !== 1) return { ok: false, problems: ['schemaVersion 必须是 1'] }
  const groupsRaw = raw['groups']
  if (!Array.isArray(groupsRaw)) return { ok: false, problems: ['groups 必须是数组'] }

  const problems: string[] = []
  const dropped: string[] = []
  const groups: GroupRegistry[] = []
  const seenGroups = new Set<number>()

  for (const [index, entry] of groupsRaw.entries()) {
    if (!isRecord(entry)) { dropped.push('groups[' + String(index) + '] 不是对象'); continue }
    const groupId = positiveId(entry['groupId'])
    if (groupId === null) { dropped.push('groups[' + String(index) + '] 的 groupId 非法'); continue }
    if (seenGroups.has(groupId)) {
      // 同一个群两份注册表：不挑、不合并，整段丢掉（合并会让「版本号」失去意义）。
      problems.push('group ' + String(groupId) + ' 出现多次')
      continue
    }
    const membersRaw = entry['members']
    if (!Array.isArray(membersRaw)) { dropped.push('group ' + String(groupId) + ' 的 members 不是数组'); continue }
    const members: RegistryMember[] = []
    const seenUsers = new Set<number>()
    for (const memberRaw of membersRaw) {
      const member = normalizeMember(memberRaw)
      if (member === null) { dropped.push('group ' + String(groupId) + ' 有一条成员记录形状不对'); continue }
      if (seenUsers.has(member.userId)) { dropped.push('group ' + String(groupId) + ' 的 ' + String(member.userId) + ' 重复'); continue }
      seenUsers.add(member.userId)
      members.push(member)
    }
    const version = shortText(entry['version'], 64)
    seenGroups.add(groupId)
    // 版本号缺省时留空串：适配层会按**内容**补一个哈希（§2.2「版本号或内容哈希」二选一）。
    groups.push({ groupId, version: version ?? '', members })
  }

  if (groups.length === 0 && problems.length === 0 && dropped.length > 0) {
    return { ok: false, problems: ['没有任何可用的群注册表（丢弃 ' + String(dropped.length) + ' 条）', ...dropped] }
  }
  return { ok: true, file: { schemaVersion: 1, groups }, dropped }
}

/** 取一个群的注册表；没有就是 `null`（调用方据此把所有人当 `unknown`）。 */
export function registryFor(file: RegistryFile | null, groupId: number): GroupRegistry | null {
  if (file === null) return null
  return file.groups.find((group) => group.groupId === groupId) ?? null
}

/**
 * 解析**一名**参与者的身份。
 *
 * 判据顺序（顺序有意义）：
 *   1. `selfId` 命中 → `self`（她自己的号来自配置，是可信平台身份）；
 *   2. 注册表命中 → `known_bot` / `known_human`；
 *   3. 其余 → `unknown`。
 *
 * `selfId` 缺省（`undefined`）时**不猜**：不会拿 0 或别人的号顶替，那条消息就按注册表判。
 */
export function resolveParticipant(input: {
  readonly userId: number
  readonly displayName?: string
  readonly selfId?: number | undefined
  readonly registry: GroupRegistry | null
}): GroupParticipant {
  const displayName = shortText(input.displayName) ?? ''
  const selfId = positiveId(input.selfId)
  if (selfId !== null && input.userId === selfId) {
    return { userId: input.userId, displayName, senderKind: 'self', source: 'trusted_platform' }
  }
  const member = input.registry?.members.find((entry) => entry.userId === input.userId) ?? null
  if (member !== null) {
    const senderKind: SenderKind = member.kind === 'bot' ? 'known_bot' : 'known_human'
    return {
      userId: input.userId,
      displayName,
      senderKind,
      // `botProfileId` 只有 bot 带：人类没有"人格标识"这种东西，给了反而会被模型当成一种分类。
      ...(member.kind === 'bot' && member.alias !== '' ? { botProfileId: member.alias } : {}),
      ...(member.verifiedAt === undefined ? {} : { verifiedAt: member.verifiedAt }),
      source: 'manual_registry',
    }
  }
  return { userId: input.userId, displayName, senderKind: 'unknown', source: 'unknown' }
}
