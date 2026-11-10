/** Persona wardrobe + today's outfit.
 *
 * Kept deliberately small and local to the foundation: a JSON file, no model call,
 * no network, no memory write. The prompt always gets the same deterministic outfit
 * for a local day; an explicit `companion_outfit_set` overrides it for that day.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const WARDROBE_VERSION = 1;
export const WARDROBE_SLOTS = Object.freeze(['upper', 'lower', 'whole', 'feet', 'extra']);
export const WARDROBE_SLOT_LABELS = Object.freeze({ upper: '上身', lower: '下身', whole: '整身', feet: '鞋', extra: '配件' });

const DEFAULT_ITEMS = [
  { id: 'w-upper-hoodie', name: '白色连帽卫衣', slot: 'upper', description: '柔软的白色连帽卫衣，袖口有一点磨毛，出门时常穿。', tags: ['日常', '清爽'] },
  { id: 'w-upper-shirt', name: '浅蓝色衬衫', slot: 'upper', description: '浅蓝色薄衬衫，天气暖的时候会卷起袖子。', tags: ['清爽'] },
  { id: 'w-upper-cardigan', name: '粉色针织开衫', slot: 'upper', description: '粉色薄针织开衫，降温时搭在卫衣外面。', tags: ['柔软'] },
  { id: 'w-lower-shorts', name: '深蓝牛仔短裤', slot: 'lower', description: '深蓝色牛仔短裤，口袋边有浅色缝线。', tags: ['日常'] },
  { id: 'w-lower-skirt', name: '灰色百褶裙', slot: 'lower', description: '灰色短款百褶裙，走动时褶子会轻轻散开。', tags: ['轻快'] },
  { id: 'w-lower-pants', name: '白色休闲长裤', slot: 'lower', description: '白色直筒休闲长裤，裤脚收得干净。', tags: ['日常'] },
  { id: 'w-feet-sneakers', name: '白色运动鞋', slot: 'feet', description: '白色低帮运动鞋，鞋侧有一道浅蓝线条。', tags: ['出门'] },
  { id: 'w-feet-canvas', name: '浅蓝帆布鞋', slot: 'feet', description: '浅蓝色帆布鞋，鞋带系得很随意。', tags: ['轻便'] },
  { id: 'w-extra-camera', name: '相机挂绳', slot: 'extra', description: '一条深色相机挂绳，挂着随身的小相机。', tags: ['拍照'] },
  { id: 'w-extra-hairpin', name: '银色小发卡', slot: 'extra', description: '一枚银色小发卡，夹在侧边头发上。', tags: ['小物件'] },
  { id: 'w-extra-scarf', name: '浅粉色围巾', slot: 'extra', description: '浅粉色薄围巾，起风时会绕一圈。', tags: ['保暖'] },
];

function emptyWardrobe() {
  return { version: WARDROBE_VERSION, tendency: '偏爱清爽的蓝白粉配色，日常以舒服、方便活动为主，出门会带相机。', items: DEFAULT_ITEMS.map(item => ({ ...item, tags: [...item.tags] })), current: null };
}

function fileFor(root) {
  return path.join(root, 'home/companion/wardrobe.json');
}

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeItem(input, index) {
  if (!input || typeof input !== 'object') return null;
  const name = text(input.name, 40);
  if (!name) return null;
  const slot = WARDROBE_SLOTS.includes(input.slot) ? input.slot : 'extra';
  return {
    id: text(input.id, 80) || `w-${String(index + 1)}`,
    name,
    slot,
    description: text(input.description, 300),
    tags: Array.isArray(input.tags) ? [...new Set(input.tags.map(tag => text(tag, 16)).filter(Boolean))].slice(0, 8) : [],
  };
}

export function normalizeWardrobe(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem).filter(Boolean).slice(0, 80) : [];
  return {
    version: WARDROBE_VERSION,
    tendency: text(raw.tendency, 500),
    items,
    current: raw.current && typeof raw.current === 'object' ? {
      date: text(raw.current.date, 10),
      itemIds: Array.isArray(raw.current.itemIds) ? [...new Set(raw.current.itemIds.map(id => text(id, 80)).filter(Boolean))] : [],
      instruction: text(raw.current.instruction, 200),
      updatedAt: Number(raw.current.updatedAt) || 0,
    } : null,
  };
}

export function loadWardrobe(root) {
  try {
    return normalizeWardrobe(JSON.parse(fs.readFileSync(fileFor(root), 'utf8')));
  } catch {
    return normalizeWardrobe(emptyWardrobe());
  }
}

export function saveWardrobe(root, wardrobe) {
  const normalized = normalizeWardrobe(wardrobe);
  const file = fileFor(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return normalized;
}

function localDate(now, timeZone = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

function hashIndex(seed, length) {
  const digest = crypto.createHash('sha256').update(seed).digest();
  return digest.readUInt32BE(0) % Math.max(1, length);
}

/** Deterministic one-per-slot outfit for the local day, unless an explicit current matches. */
export function currentOutfit(wardrobe, now, timeZone = 'Asia/Shanghai') {
  const date = localDate(now, timeZone);
  const normalized = normalizeWardrobe(wardrobe);
  if (normalized.current?.date === date && normalized.current.itemIds.length > 0) {
    const picked = normalized.current.itemIds.map(id => normalized.items.find(item => item.id === id)).filter(Boolean);
    if (picked.length > 0) return { date, source: 'explicit', instruction: normalized.current.instruction, items: picked };
  }
  const picked = [];
  for (const slot of WARDROBE_SLOTS) {
    const candidates = normalized.items.filter(item => item.slot === slot);
    if (candidates.length === 0) continue;
    picked.push(candidates[hashIndex(`${date}|${slot}|${normalized.tendency}`, candidates.length)]);
  }
  return { date, source: 'daily', instruction: '', items: picked };
}

function itemLine(item, { withDescription = true } = {}) {
  const label = WARDROBE_SLOT_LABELS[item.slot] ?? item.slot;
  const description = withDescription && item.description ? `（${item.description}）` : '';
  return `${label}：${item.name}${description}`;
}

/**
 * The wardrobe section, deliberately compact.
 *
 * It runs in every request, and the per-item descriptions are the expensive part: they are
 * flavour text the character needs only when actually describing an outfit. So the section
 * carries the slot → item names plus the tendency (enough to answer "今天穿什么" consistently),
 * and `companion_wardrobe_detail` supplies the descriptions on demand. The factual constraint
 * ("this is real, do not invent") stays because it is what stops an invented outfit.
 */
export function renderWardrobePrompt(root, now, timeZone = 'Asia/Shanghai', maxChars = 900) {
  const wardrobe = loadWardrobe(root);
  const outfit = currentOutfit(wardrobe, now, timeZone);
  if (wardrobe.items.length === 0 && wardrobe.tendency === '') return '';
  const lines = ['【衣柜与当前衣物】'];
  if (wardrobe.tendency) lines.push(`整体服饰倾向：${wardrobe.tendency}`);
  if (outfit.items.length > 0) {
    lines.push(`今天穿（${outfit.date}${outfit.source === 'explicit' ? '，用户/剧情指定' : '，按衣柜轮换'}）：`);
    for (const item of outfit.items) lines.push(`- ${itemLine(item, { withDescription: false })}`);
    if (outfit.instruction) lines.push(`换装说明：${outfit.instruction}`);
  } else {
    lines.push('衣柜里还没有可穿的衣物；不要凭空编造穿着。');
  }
  lines.push('这是当前真实着装；需要衣物的细节描述再调用 companion_wardrobe_detail，不要声称衣柜里没有的衣服。');
  return lines.join('\n').slice(0, maxChars);
}

export function wardrobeDetail(root, { scope = 'today', slot = '', now = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  const wardrobe = loadWardrobe(root);
  const cleanScope = text(scope, 20) || 'today';
  if (cleanScope === 'slot') {
    if (!WARDROBE_SLOTS.includes(slot)) return { ok: false, code: 'need-slot', text: `请给出部位：${WARDROBE_SLOTS.join(' / ')}` };
    const rows = wardrobe.items.filter(item => item.slot === slot);
    return { ok: true, scope: 'slot', slot, count: rows.length, items: rows, text: rows.map(itemLine).join('\n') || '这个部位还没有衣物。' };
  }
  if (cleanScope === 'all') {
    return { ok: true, scope: 'all', tendency: wardrobe.tendency, count: wardrobe.items.length, items: wardrobe.items, text: wardrobe.items.map(itemLine).join('\n') || '衣柜是空的。' };
  }
  const outfit = currentOutfit(wardrobe, now, timeZone);
  return { ok: true, scope: 'today', date: outfit.date, source: outfit.source, instruction: outfit.instruction, items: outfit.items, text: outfit.items.map(itemLine).join('\n') || '今天还没有可穿的衣物。' };
}

export function setOutfit(root, { itemIds = [], instruction = '', now = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  const wardrobe = loadWardrobe(root);
  const ids = Array.isArray(itemIds) ? itemIds.map(id => text(id, 80)).filter(Boolean) : [];
  const resolved = ids.map(id => wardrobe.items.find(item => item.id === id || item.name === id)).filter(Boolean);
  if (resolved.length === 0) return { ok: false, code: 'item-not-found', text: '没有找到这些衣物；先用 companion_wardrobe_detail 查看衣柜。' };
  const date = localDate(now, timeZone);
  const saved = saveWardrobe(root, {
    ...wardrobe,
    current: { date, itemIds: resolved.map(item => item.id), instruction: text(instruction, 200), updatedAt: now },
  });
  return { ok: true, date, items: resolved, instruction: saved.current?.instruction ?? '', text: `今天换成：${resolved.map(item => item.name).join('、')}` };
}

export const wardrobeDefaults = Object.freeze({ items: DEFAULT_ITEMS, tendency: '偏爱清爽的蓝白粉配色，日常以舒服、方便活动为主，出门会带相机。' });
