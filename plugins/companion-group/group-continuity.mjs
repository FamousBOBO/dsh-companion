// 群聊连续性（《DSH 群聊表现优化实施计划》P3 §7.2 的一半 + P4 §8.1 的一部分）：
// 让**被 @ 的正常回合**也看得到「她自己刚刚在这个群说过什么」与「这个群刚刚发生过什么」，
// 同时把群聊表达口径钉成短句口语、沉默合法、不重复自己、敏感场景优先沉默、推测不许说成事实。
//
// 三条硬规矩（与 core.mjs 同一条底线）：
//   1. **纯**：buildGroupContinuitySection 只做渲染——不读盘、不联网、不调服务、不读时钟。
//      数据（recentSelf / topic / recentlyMentioned）与时间（atMs）全部由调用方传进来；
//      index.mjs 里那层懒取（ctx.get('companionGroupEvents')）才是唯一碰服务的地方。
//   2. **人格中立**：这里只写「怎么在群里说话」，不写角色名、性格、经历、口癖；
//      人格在 config/persona.md，由 companion-foundation 的人格段负责。测试会钉住这一点。
//   3. **有上限**：整段 ≤ 400 字，超了从**最老**的一条开始丢——短期上下文不是记忆，
//      多出来的动作细节会挤掉真正要看的最近几句。

/** 提示词段名 / 位置：紧跟人格段（order 50）之后。 */
export const GROUP_CONTINUITY_SECTION_NAME = 'companion:group-continuity';
export const GROUP_CONTINUITY_ORDER = 51;

/** 可选服务名：由群事件时间线（GroupTimeline 那一层）提供；没有就整段降级，不报错。 */
export const GROUP_CONTINUITY_SERVICE_NAME = 'companionGroupEvents';

/** 渲染上限：整段字数、条数、单条正文、话题、被提到的名字。 */
export const GROUP_CONTINUITY_MAX_CHARS = 400;
export const GROUP_CONTINUITY_MAX_ITEMS = 6;
export const GROUP_CONTINUITY_ITEM_MAX_CHARS = 80;
export const GROUP_CONTINUITY_TOPIC_MAX_CHARS = 40;
export const GROUP_CONTINUITY_MENTION_MAX_CHARS = 24;
export const GROUP_CONTINUITY_MAX_MENTIONS = 5;

/**
 * 空输入的明确说法：没有记录就说没有记录，**不要**用"我刚才说过…""刚才聊到…"补空。
 * 这句话本身也要在 400 字以内，并且不含任何具体内容（否则等于编造）。
 */
export const GROUP_CONTINUITY_EMPTY =
  '【这个群最近的记录】还没有记录：这个群还没有你说过的话，也还没识别出当前话题。不要假装记得刚才聊过什么，也不要声称自己刚刚发过某句具体的话。';

/**
 * 给模型的群聊行为约定（人格中立）。人格段（companion:group-persona / config/persona.md）
 * 说"她是谁"，这一段只说"在公开群里怎么说话"。
 */
export const GROUP_CHAT_CONDUCT = [
  '【群聊表达约定】群聊是公开场合：默认用短句、口语，一到两句话说完；不写小作文，不写旁白式开场或解说（例如"我注意到你们在聊…""看大家在聊这个话题"），也不替别人总结。',
  '没有合适的机会就不接：沉默是正常结果，不是为了显得活跃而硬接一句；拿不准要不要说时就不说。',
  '不重复自己刚说过的话，同一件事不换句话再说一遍。',
  '遇到争执、隐私、钱和账号相关的话题，优先沉默：不站队、不评判、不打探。',
  '记忆或推测里的内容只要不确定就说不确定，不把猜测说成事实。',
].join('\n');

/** 服务缺失时的读取上限（与渲染上限一致：要么服务自己裁，要么渲染层再裁）。 */
export const GROUP_CONTINUITY_DEFAULT_LIMIT = GROUP_CONTINUITY_MAX_ITEMS;

/** 服务返回的行数硬上限：只保留最后这么多条，防御一个形状正确但无限增长的服务。 */
const SERVICE_ROW_CEILING = 64;

/** 空输入：`recentSelf` 空数组、`topic` null、`recentlyMentioned` 空数组。 */
function emptyInput() {
  return { recentSelf: [], topic: null, recentlyMentioned: [] };
}

/**
 * 从可选服务读一份渲染输入（纯函数，**无 IO、永不抛**）。
 *
 * 服务契约：`{ recentSelf(limit): Array<{text, atMs, kind}>, topic(): string|null }`。
 * 四种降级都返回空输入而不是报错，因为这段文本是**提示词**的一部分：宁可这一轮少一份
 * 背景，也不能让装配失败把整轮聊天打掉。
 *   - 服务不存在（`undefined` / `null`）→ 空输入；
 *   - 形状不对（两个方法不都是函数）→ 空输入；
 *   - 某个方法抛错 / 返回值类型不对 → 空输入（不是半个）；
 *   - 返回值不是数组 → 空数组。
 *
 * @param {unknown} service `ctx.get('companionGroupEvents')` 的结果
 * @param {number} [limit] 向服务请求的条数（夹在渲染上限内）
 * @returns {{ recentSelf: Array<{text: string, atMs: number, kind: string}>, topic: string|null, recentlyMentioned: string[] }}
 */
export function groupContinuityInputOf(service, limit = GROUP_CONTINUITY_DEFAULT_LIMIT) {
  try {
    if (!service || (typeof service !== 'object' && typeof service !== 'function')) return emptyInput();
    const recentSelf = service.recentSelf;
    const topic = service.topic;
    if (typeof recentSelf !== 'function' || typeof topic !== 'function') return emptyInput();
    const wanted = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, GROUP_CONTINUITY_DEFAULT_LIMIT) : GROUP_CONTINUITY_DEFAULT_LIMIT;
    const rows = recentSelf.call(service, wanted);
    const items = Array.isArray(rows) ? rows.slice(-SERVICE_ROW_CEILING) : [];
    const value = topic.call(service);
    return { recentSelf: items, topic: typeof value === 'string' ? value : null, recentlyMentioned: [] };
  } catch {
    return emptyInput();
  }
}

/** 服务的形状判定：两个方法都是函数才算接上了（形状不对就当没有）。 */
export function hasGroupContinuityService(service) {
  return Boolean(service)
    && (typeof service === 'object' || typeof service === 'function')
    && typeof service.recentSelf === 'function'
    && typeof service.topic === 'function';
}

/** 事件种类 → 中文标签（未知种类按"发言"渲染，不丢事件）。 */
const KIND_LABELS = Object.freeze({
  agent_reply: '回复',
  proactive_message: '主动发言',
  reaction: '反应',
  inbound_message: '发言',
  topic_change: '话题',
});

const HEADER = '【这个群最近的记录】你自己在这个群刚说过的话（由早到晚，最下面最近；不要重复它们）：';

/** 一行就够：压掉换行与 CQ 码，别让一条正文在提示词里变成多行结构。 */
function oneLine(value, max) {
  const text = String(value ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** 本地 HH:MM；时间不是有限数就不渲染（宁可不显示，也不要编一个时间）。 */
function clockOf(atMs) {
  if (!Number.isFinite(atMs)) return null;
  const date = new Date(atMs);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 单条记录归一化：没正文/没时间的直接丢，种类不认识就退回"发言"。 */
function itemOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const text = oneLine(entry.text, GROUP_CONTINUITY_ITEM_MAX_CHARS);
  if (!text) return null;
  const clock = clockOf(entry.atMs);
  if (clock === null) return null;
  const rawKind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
  // 注意：`??` 不能与 `||` 混写（语法错），所以先各自取名。
  const kind = KIND_LABELS[rawKind] ?? (oneLine(rawKind, 12) || '发言');
  return { atMs: entry.atMs, clock, kind, text };
}

function itemsOf(recentSelf) {
  if (!Array.isArray(recentSelf)) return [];
  const items = [];
  for (const entry of recentSelf) {
    const item = itemOf(entry);
    if (item) items.push(item);
  }
  // 服务本来就按时间正序给；这里再排一次是防御——顺序错了比少一条更糟。
  return items.sort((a, b) => a.atMs - b.atMs);
}

function normalizedTopic(topic) {
  if (typeof topic !== 'string') return null;
  return oneLine(topic, GROUP_CONTINUITY_TOPIC_MAX_CHARS) || null;
}

function mentionsOf(recentlyMentioned) {
  if (!Array.isArray(recentlyMentioned)) return [];
  const seen = new Set();
  const mentions = [];
  for (const value of recentlyMentioned) {
    if (typeof value !== 'string') continue;
    const name = oneLine(value, GROUP_CONTINUITY_MENTION_MAX_CHARS);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    mentions.push(name);
    if (mentions.length >= GROUP_CONTINUITY_MAX_MENTIONS) break;
  }
  return mentions;
}

function render(items, topic, mentions) {
  const lines = [HEADER];
  for (const item of items) lines.push(`- ${item.clock} ${item.kind}：${item.text}`);
  if (topic) lines.push(`当前话题：${topic}`);
  if (mentions.length > 0) lines.push(`最近被提到：${mentions.join('、')}`);
  return lines.join('\n');
}

/**
 * 渲染"这个群最近发生了什么"那几行（纯函数，无 IO）。
 *
 * @param {{
 *   recentSelf?: Array<{text: string, atMs: number, kind: string}>,
 *   topic?: string | null,
 *   recentlyMentioned?: string[]
 * }} [input] 缺省/形状不对一律按"没有记录"处理
 * @returns {string} 给模型看的文本；整段 ≤ 400 字，超了从**最老**的记录开始丢
 */
export function buildGroupContinuitySection(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const topic = normalizedTopic(source.topic);
  const mentions = mentionsOf(source.recentlyMentioned);
  const all = itemsOf(source.recentSelf);
  if (all.length === 0 && !topic && mentions.length === 0) return GROUP_CONTINUITY_EMPTY;

  let kept = all.slice(-GROUP_CONTINUITY_MAX_ITEMS);
  let text = render(kept, topic, mentions);
  // 从最老的一条开始丢，直到整段落进上限。
  while (text.length > GROUP_CONTINUITY_MAX_CHARS && kept.length > 0) {
    kept = kept.slice(1);
    text = render(kept, topic, mentions);
  }
  // 兜底（理论上到不了）：只剩话题/被提到仍然超长时，硬截断而不是交出超长段。
  if (text.length > GROUP_CONTINUITY_MAX_CHARS) {
    text = `${text.slice(0, GROUP_CONTINUITY_MAX_CHARS - 1)}…`;
  }
  return text;
}
