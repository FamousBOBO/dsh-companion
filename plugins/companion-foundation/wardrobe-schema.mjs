/** Wardrobe data model v2 — items, context-scoped outfits, timed overrides.
 *
 * Why this file exists (audit, 2026-11-10): `wardrobe.mjs` v1 could only answer
 * "which clothes do I own" and "what is today's deterministic outfit". It had no
 * concept of a **context** (everyday / home / sleep / outdoor / special), so at
 * 02:40 the character was still described in her daytime clothes, and there was no
 * sleepwear inventory at all. This module is the v2 persisted shape plus the
 * lossless, reversible migration from v1. Selection logic does not live here: see
 * `wardrobe-context.mjs` (time/scene classification) and `wardrobe-state.mjs`
 * (priority resolution).
 *
 * Hard rules encoded here:
 *  - `contexts` is a **condition on a combination**, never a sixth clothing slot.
 *  - five slots stay `upper | lower | whole | feet | extra`; any piece may be null.
 *  - `whole` and `upper`/`lower` are mutually exclusive (a one-piece dress has no
 *    separate top); the resolver enforces it, the normalizer keeps the input honest.
 *  - every item carries both a Chinese and an English description; **English is the
 *    authoritative text for image generation**.
 *  - `season` is stored but never used for selection in this phase (no weather data
 *    has been validated).
 *  - provenance is explicit, so seeded clothes can never be presented as something
 *    the character has "always owned". Nothing here writes to user memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const WARDROBE_SCHEMA_VERSION = 2;
export const WARDROBE_SLOTS = Object.freeze(['upper', 'lower', 'whole', 'feet', 'extra']);
export const WARDROBE_SLOT_LABELS = Object.freeze({ upper: '上装', lower: '下装', whole: '整身', feet: '鞋袜', extra: '配饰' });
export const WARDROBE_CONTEXTS = Object.freeze(['everyday', 'home', 'sleep', 'outdoor', 'special']);
export const WARDROBE_CONTEXT_LABELS = Object.freeze({
  everyday: '日常常服',
  home: '居家服',
  sleep: '睡衣',
  outdoor: '外出服',
  special: '特殊服装',
});
/** An override without a context applies to whatever context the resolver picks. */
export const OVERRIDE_CONTEXT_ANY = 'any';
/** The seed revision is a version label, not a claim about when anything happened. */
export const SEED_REVISION = '2026-11-10.1';

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function oneOf(value, allowed, fallback) {
  const clean = String(value ?? '').trim();
  return allowed.includes(clean) ? clean : fallback;
}

/** `{zh,en}` pair; a bare string is read as Chinese (v1 files stored plain text). */
function localeText(value, zhMax = 300, enMax = 300) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { zh: text(value.zh, zhMax), en: text(value.en, enMax) };
  }
  return { zh: text(value, zhMax), en: '' };
}

function normalizeContexts(value, fallback = ['everyday']) {
  const rows = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  const clean = [...new Set(rows.map(row => oneOf(row, WARDROBE_CONTEXTS, '')).filter(Boolean))];
  return clean.length ? clean : [...fallback];
}

function normalizeSeasons(value) {
  const rows = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  const clean = [...new Set(rows.map(row => text(row, 12).toLowerCase()).filter(Boolean))];
  return clean.length ? clean.slice(0, 4) : ['all'];
}

function normalizeProvenance(value, fallback) {
  const raw = value && typeof value === 'object' ? value : {};
  const out = { source: text(raw.source, 40) || fallback };
  if (raw.seedRevision) out.seedRevision = text(raw.seedRevision, 40);
  if (raw.initializedAt) out.initializedAt = text(raw.initializedAt, 40);
  if (raw.migratedFrom !== undefined) out.migratedFrom = text(raw.migratedFrom, 20);
  if (raw.note) out.note = text(raw.note, 160);
  return out;
}

/** One clothing item in v2 shape. v1 items (name/description/tags) are accepted as-is. */
export function normalizeItem(input, index = 0) {
  if (!input || typeof input !== 'object') return null;
  const nameZh = text(input.name?.zh ?? (typeof input.name === 'string' ? input.name : ''), 60);
  const nameEn = text(input.name?.en, 80);
  if (!nameZh && !nameEn) return null;
  const description = localeText(input.description);
  return {
    id: text(input.id, 80) || `w-${String(index + 1)}`,
    slot: oneOf(input.slot, WARDROBE_SLOTS, 'extra'),
    contexts: normalizeContexts(input.contexts),
    name: { zh: nameZh, en: nameEn },
    description,
    season: normalizeSeasons(input.season),
    enabled: input.enabled !== false,
    tags: Array.isArray(input.tags) ? [...new Set(input.tags.map(tag => text(tag, 16)).filter(Boolean))].slice(0, 8) : [],
    provenance: normalizeProvenance(input.provenance, 'user'),
  };
}

/** `pieces` maps slot → item id. Missing slots stay explicit `null`. */
export function normalizePieces(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const pieces = {};
  for (const slot of WARDROBE_SLOTS) {
    const id = text(raw[slot], 80);
    pieces[slot] = id || null;
  }
  // A one-piece garment wins over a separate top/bottom: both cannot be worn at once
  // and silently keeping one of the two is exactly the kind of drift this model exists
  // to prevent.
  if (pieces.whole) {
    pieces.upper = null;
    pieces.lower = null;
  }
  return pieces;
}

export function normalizeOutfit(input, index = 0) {
  if (!input || typeof input !== 'object') return null;
  const context = oneOf(input.context, WARDROBE_CONTEXTS, '');
  if (!context) return null;
  const pieces = normalizePieces(input.pieces);
  if (!Object.values(pieces).some(Boolean)) return null;
  return {
    id: text(input.id, 80) || `outfit-${context}-${index + 1}`,
    context,
    pieces,
    enabled: input.enabled !== false,
    provenance: normalizeProvenance(input.provenance, 'user'),
  };
}

export function normalizeOverride(input) {
  if (!input || typeof input !== 'object') return null;
  const pieces = normalizePieces(input.pieces);
  if (!Object.values(pieces).some(Boolean)) return null;
  const until = Number(input.until);
  const createdAt = Number(input.createdAt);
  const context = oneOf(input.context, [...WARDROBE_CONTEXTS, OVERRIDE_CONTEXT_ANY], OVERRIDE_CONTEXT_ANY);
  return {
    id: text(input.id, 80) || `ovr_${crypto.randomUUID()}`,
    personaId: text(input.personaId, 60),
    context,
    pieces,
    instruction: text(input.instruction, 200),
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
    until: Number.isFinite(until) && until > 0 ? until : 0,
    source: text(input.source, 40) || 'companion_outfit_set',
  };
}

/**
 * Normalize any wardrobe document into v2.
 *
 * `current` is v1's "today's outfit" mirror. It is kept **untouched** for round-trip
 * (a rollback must not lose it) and is additionally exposed through `legacyOverrides()`
 * so the resolver can honour it without rewriting the file.
 */
export function normalizeWardrobe(input, { personaId = '', now = Date.now() } = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem).filter(Boolean).slice(0, 200) : [];
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }
  const outfits = Array.isArray(raw.outfits) ? raw.outfits.map(normalizeOutfit).filter(Boolean) : [];
  const overrides = Array.isArray(raw.overrides) ? raw.overrides.map(normalizeOverride).filter(Boolean) : [];
  const current = raw.current && typeof raw.current === 'object'
    ? {
      date: text(raw.current.date, 10),
      itemIds: Array.isArray(raw.current.itemIds) ? [...new Set(raw.current.itemIds.map(id => text(id, 80)).filter(Boolean))] : [],
      instruction: text(raw.current.instruction, 200),
      updatedAt: Number(raw.current.updatedAt) || 0,
    }
    : null;
  const version = Number(raw.schemaVersion ?? raw.version);
  return {
    schemaVersion: WARDROBE_SCHEMA_VERSION,
    ownerPersona: text(raw.ownerPersona, 60) || text(personaId, 60),
    tendency: text(raw.tendency, 500),
    timeZone: text(raw.timeZone, 60),
    items: deduped,
    outfits,
    overrides,
    current,
    // Present only in memory: what the document looked like on disk, so a caller can
    // tell "upgraded this read" from "already v2" without guessing.
    migratedFrom: Number.isFinite(version) && version > 0 && version < WARDROBE_SCHEMA_VERSION ? version : (version >= WARDROBE_SCHEMA_VERSION ? 0 : 1),
    normalizedAt: Number(now) || 0,
  };
}

/** v1's `current` as a read-only override for its own local day. Never persisted. */
export function legacyOverrides(wardrobe, { now = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  const current = wardrobe?.current;
  if (!current || !current.date || !current.itemIds?.length) return [];
  const endOfDay = endOfLocalDay(current.date, timeZone);
  if (!endOfDay) return [];
  return [{
    id: 'legacy-current',
    personaId: text(wardrobe.ownerPersona, 60),
    context: OVERRIDE_CONTEXT_ANY,
    pieces: piecesFromItemIds(wardrobe, current.itemIds),
    instruction: current.instruction ?? '',
    createdAt: Number(current.updatedAt) || 0,
    until: endOfDay,
    source: 'legacy-current',
    legacy: true,
  }];
}

function piecesFromItemIds(wardrobe, itemIds) {
  const bySlot = {};
  for (const id of itemIds ?? []) {
    const item = wardrobe.items?.find(row => row.id === id);
    if (!item) continue;
    const slot = WARDROBE_SLOTS.includes(item.slot) ? item.slot : 'extra';
    if (slot === 'whole') {
      bySlot.whole = item.id;
    } else if (!bySlot[slot]) {
      bySlot[slot] = item.id;
    }
  }
  return normalizePieces(bySlot);
}

/** End of the given local `YYYY-MM-DD` (exclusive), resolved in `timeZone`. */
export function endOfLocalDay(date, timeZone = 'Asia/Shanghai') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return 0;
  // 23:59:59.999 local: the offset at that boundary is what matters, and asking the
  // formatter for the zone's offset at the candidate instant is the only portable way
  // to get it without a date library.
  try {
    const probe = new Date(`${date}T23:59:59.999Z`);
    const offsetMinutes = zoneOffsetMinutes(probe, timeZone);
    return probe.getTime() - offsetMinutes * 60_000;
  } catch {
    return 0;
  }
}

function zoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(date));
  const pick = type => Number(parts.find(part => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
  return Math.round((asUtc - new Date(date).getTime()) / 60_000);
}

/* ─────────────────────────── seed wardrobe ─────────────────────────── */

/**
 * The stock wardrobe: everyday + home + sleep + outdoor + special.
 *
 * Every entry is marked `source: 'seeded-default'` with a `seedRevision`. That is the
 * whole point: these are the clothes this build ships so a fresh install is not naked,
 * **not** a record of anything the character factually bought or wore. An operator
 * replaces or extends them via `companion_outfit_set` and by editing the JSON; nothing
 * here is written into fact/health/sleep memory.
 *
 * Sleepwear deliberately carries no camera lanyard, no outdoor shoes and no scarf —
 * see `sleep-extra` being absent and `sleep-feet-001` being indoor slippers.
 */
const SEED_ITEMS = [
  // everyday
  { id: 'w-upper-hoodie', slot: 'upper', contexts: ['everyday', 'outdoor'], name: { zh: '白色连帽卫衣', en: 'a soft white hoodie' }, description: { zh: '柔软的白色连帽卫衣，袖口有一点磨毛。', en: 'A soft white hoodie with a slightly worn cuff' }, tags: ['日常', '清爽'] },
  { id: 'w-upper-shirt', slot: 'upper', contexts: ['everyday'], name: { zh: '浅蓝色衬衫', en: 'a light blue shirt' }, description: { zh: '浅蓝色薄衬衫，天暖时会把袖子卷起来。', en: 'A thin pale blue shirt, sleeves rolled up on warm days' }, tags: ['清爽'] },
  { id: 'w-upper-cardigan', slot: 'upper', contexts: ['everyday', 'outdoor'], name: { zh: '粉色针织开衫', en: 'a pink knitted cardigan' }, description: { zh: '粉色薄针织开衫，降温时搭在卫衣外面。', en: 'A thin pink knitted cardigan worn over the hoodie when it gets cold' }, tags: ['柔软'] },
  { id: 'w-lower-shorts', slot: 'lower', contexts: ['everyday', 'home'], name: { zh: '深蓝牛仔短裤', en: 'navy denim shorts' }, description: { zh: '深蓝色牛仔短裤，口袋边有浅色缝线。', en: 'Navy denim shorts with pale stitching along the pockets' }, tags: ['日常'] },
  { id: 'w-lower-skirt', slot: 'lower', contexts: ['everyday', 'special'], name: { zh: '灰色百褶裙', en: 'a grey pleated skirt' }, description: { zh: '灰色短款百褶裙，走动时褶子会轻轻散开。', en: 'A short grey pleated skirt that fans out slightly when she walks' }, tags: ['轻快'] },
  { id: 'w-lower-pants', slot: 'lower', contexts: ['everyday', 'outdoor'], name: { zh: '白色休闲长裤', en: 'white casual trousers' }, description: { zh: '白色直筒休闲长裤，裤脚收得干净。', en: 'Straight white casual trousers with a clean hem' }, tags: ['日常'] },
  { id: 'w-feet-sneakers', slot: 'feet', contexts: ['everyday', 'outdoor'], name: { zh: '白色运动鞋', en: 'white low-top sneakers' }, description: { zh: '白色低帮运动鞋，鞋侧有一道浅蓝线条。', en: 'White low-top sneakers with a pale blue stripe on the side' }, tags: ['出门'] },
  { id: 'w-feet-canvas', slot: 'feet', contexts: ['everyday', 'special'], name: { zh: '浅蓝帆布鞋', en: 'light blue canvas shoes' }, description: { zh: '浅蓝色帆布鞋，鞋带系得很随意。', en: 'Light blue canvas shoes with loosely tied laces' }, tags: ['轻便'] },
  { id: 'w-extra-camera', slot: 'extra', contexts: ['everyday', 'outdoor'], name: { zh: '相机挂绳', en: 'a thin camera strap with a small camera' }, description: { zh: '一条深色相机挂绳，挂着随身的小相机。', en: 'A dark thin strap holding a small everyday camera' }, tags: ['拍照'] },
  { id: 'w-extra-hairpin', slot: 'extra', contexts: ['everyday', 'special'], name: { zh: '银色小发卡', en: 'a small silver hairpin' }, description: { zh: '一枚银色小发卡，夹在侧边头发上。', en: 'A small silver hairpin clipped on one side' }, tags: ['小物件'] },
  { id: 'w-extra-scarf', slot: 'extra', contexts: ['everyday', 'outdoor'], name: { zh: '浅粉色围巾', en: 'a pale pink thin scarf' }, description: { zh: '浅粉色薄围巾，起风时会绕一圈。', en: 'A pale pink thin scarf, wrapped once when it is windy' }, tags: ['保暖'] },

  // home
  { id: 'home-top-001', slot: 'upper', contexts: ['home'], name: { zh: '浅灰棉质家居上衣', en: 'a light grey cotton loungewear top' }, description: { zh: '浅灰色棉质长袖家居上衣，领口很软，在家基本都穿它。', en: 'A light grey cotton long-sleeve loungewear top with a very soft collar' }, tags: ['居家', '舒适'] },
  { id: 'home-bottom-001', slot: 'lower', contexts: ['home'], name: { zh: '深蓝宽松家居长裤', en: 'navy loose lounge trousers' }, description: { zh: '深蓝色宽松家居长裤，腰口是松紧的。', en: 'Loose navy lounge trousers with an elastic waist' }, tags: ['居家'] },
  { id: 'home-feet-001', slot: 'feet', contexts: ['home', 'sleep'], name: { zh: '米白室内拖鞋', en: 'soft off-white indoor slippers' }, description: { zh: '米白色软底室内拖鞋，走路几乎没有声音。', en: 'Soft off-white indoor slippers that barely make a sound' }, tags: ['室内'] },

  // sleep — the inventory that did not exist before this change
  { id: 'sleep-top-001', slot: 'upper', contexts: ['sleep'], name: { zh: '浅蓝棉质睡衣上衣', en: 'a pale blue cotton pajama top' }, description: { zh: '浅蓝色柔软棉质长袖睡衣上衣，白色滚边，少量浅粉色装饰。', en: 'A relaxed pale blue cotton pajama top with white piping and a little pale pink trim' }, tags: ['睡衣', '柔软'] },
  { id: 'sleep-bottom-001', slot: 'lower', contexts: ['sleep'], name: { zh: '浅蓝宽松睡裤', en: 'matching pale blue loose pajama bottoms' }, description: { zh: '与上衣同色系的宽松睡裤，裤脚是白色滚边。', en: 'Loose pale blue pajama bottoms that match the top, with white piping at the ankle' }, tags: ['睡衣', '舒适'] },
  { id: 'sleep-feet-001', slot: 'feet', contexts: ['sleep'], name: { zh: '室内棉拖鞋', en: 'soft indoor cotton slippers' }, description: { zh: '床边的一双软底棉拖鞋，躺下休息时可以不穿。', en: 'A pair of soft cotton slippers kept by the bed; not worn when she lies down' }, tags: ['室内'] },

  // special
  { id: 'special-whole-001', slot: 'whole', contexts: ['special'], name: { zh: '淡粉色连衣裙', en: 'a soft pink one-piece dress' }, description: { zh: '淡粉色连身裙，裙摆到膝盖，袖口有白色细边。', en: 'A soft pink knee-length one-piece dress with thin white cuffs' }, tags: ['特殊'] },
];

const SEED_OUTFITS = [
  {
    id: 'everyday-default',
    context: 'everyday',
    pieces: { upper: 'w-upper-hoodie', lower: 'w-lower-pants', feet: 'w-feet-sneakers', extra: 'w-extra-camera' },
  },
  {
    id: 'everyday-casual',
    context: 'everyday',
    pieces: { upper: 'w-upper-shirt', lower: 'w-lower-skirt', feet: 'w-feet-canvas', extra: 'w-extra-hairpin' },
  },
  {
    id: 'home-default',
    context: 'home',
    pieces: { upper: 'home-top-001', lower: 'home-bottom-001', feet: 'home-feet-001' },
  },
  {
    id: 'sleepwear-default',
    context: 'sleep',
    pieces: { upper: 'sleep-top-001', lower: 'sleep-bottom-001', feet: 'sleep-feet-001' },
  },
  {
    id: 'outdoor-default',
    context: 'outdoor',
    pieces: { upper: 'w-upper-cardigan', lower: 'w-lower-pants', feet: 'w-feet-sneakers', extra: 'w-extra-camera' },
  },
  {
    id: 'special-default',
    context: 'special',
    pieces: { whole: 'special-whole-001', feet: 'w-feet-canvas', extra: 'w-extra-hairpin' },
  },
];

export const WARDROBE_TENDENCY = '偏爱清爽的蓝白粉配色，日常以舒服、方便活动为主；出门会带相机，在家和睡前换成宽松的棉质衣服。';

/** A fresh v2 document. Pure: no filesystem, no clock beyond what is passed in. */
export function seedWardrobe({ personaId = '', now = Date.now() } = {}) {
  const provenance = { source: 'seeded-default', seedRevision: SEED_REVISION };
  return normalizeWardrobe({
    schemaVersion: WARDROBE_SCHEMA_VERSION,
    ownerPersona: personaId,
    tendency: WARDROBE_TENDENCY,
    items: SEED_ITEMS.map(item => ({ ...item, enabled: true, season: ['all'], provenance })),
    outfits: SEED_OUTFITS.map(outfit => ({ ...outfit, enabled: true, provenance })),
    overrides: [],
    current: null,
  }, { personaId, now });
}

/**
 * v1 → v2 migration as a **pure** function over the parsed document.
 *
 * Reversible by construction: the v1 fields (`version`, `items[].name`,
 * `items[].description`, `current`) are all preserved verbatim; the migration only
 * *adds* `contexts`, `schemaVersion`, `outfits` and `overrides`. `wardrobe.mjs`
 * commits it only through an explicit call, and every commit first writes a
 * `<file>.v1.bak` copy.
 *
 * `outfits` is **not** fabricated from v1 items: inferring "these three items form a
 * home outfit" from a flat list is exactly the guess this project forbids. A migrated
 * v1 wardrobe therefore has zero outfits until the operator (or the seed) supplies
 * them, and the resolver reports the gap instead of dressing her in something wrong.
 * The one exception is `contexts`: v1 had no scene concept, so its items are labelled
 * `everyday` — the only claim the data actually supports.
 */
export function migrateWardrobeV1(input, { personaId = '', now = Date.now() } = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const items = (Array.isArray(raw.items) ? raw.items : []).map((item, index) => {
    const base = normalizeItem(item, index);
    if (!base) return null;
    return {
      ...base,
      // v1 items were whatever the day's rotation needed: treat as everyday, keep tags.
      contexts: Array.isArray(item?.contexts) ? normalizeContexts(item.contexts) : ['everyday'],
      name: base.name,
      description: base.description,
      season: base.season,
      provenance: item?.provenance
        ? normalizeProvenance(item.provenance, 'migrated-v1')
        : { source: 'migrated-v1', migratedFrom: 'v1', initializedAt: new Date(now).toISOString() },
    };
  }).filter(Boolean);
  const outfits = Array.isArray(raw.outfits) ? raw.outfits.map(normalizeOutfit).filter(Boolean) : [];
  const overrides = Array.isArray(raw.overrides) ? raw.overrides.map(normalizeOverride).filter(Boolean) : [];
  const document = normalizeWardrobe({
    schemaVersion: WARDROBE_SCHEMA_VERSION,
    ownerPersona: raw.ownerPersona ?? personaId,
    tendency: raw.tendency,
    timeZone: raw.timeZone,
    items,
    outfits,
    overrides,
    current: raw.current ?? null,
  }, { personaId, now });
  return { ...document, migratedFrom: 1 };
}

/* ─────────────────────────── file locations ─────────────────────────── */

export function baseWardrobeFile(root) {
  return path.join(root, 'home/companion/wardrobe.json');
}

/** Per-persona wardrobe path. Never returns another persona's file. */
export function wardrobeFileFor(root, personaId = '') {
  const base = baseWardrobeFile(root);
  const persona = text(personaId, 60);
  if (!persona) return { file: base, shared: true, reason: 'no-persona' };
  let owner = '';
  try {
    const parsed = JSON.parse(fs.readFileSync(base, 'utf8').replace(/^\uFEFF/, ''));
    owner = text(parsed?.ownerPersona, 60);
  } catch {
    // Missing file = first run: the base file will be created for whoever mounts first.
    return { file: base, shared: true, reason: 'first-run' };
  }
  if (!owner) return { file: base, shared: true, reason: 'unowned-v1-file' };
  if (owner === persona) return { file: base, shared: true, reason: 'owner' };
  return { file: path.join(root, 'home/companion', `wardrobe.${persona.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), shared: false, reason: 'persona-scoped' };
}

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, code: 'missing' };
    return { ok: false, code: 'unreadable', detail: String(error?.message ?? error).slice(0, 200) };
  }
}

/**
 * Read the wardrobe for one persona.
 *
 * Read-only: a missing file never writes anything. The caller gets the seed document
 * in memory plus `seeded: true`, so tools and prompts can answer immediately while the
 * report can still say "nothing has been initialised on disk yet".
 */
export function loadWardrobeFor({ root, personaId = '', now = Date.now() } = {}) {
  const located = wardrobeFileFor(root, personaId);
  const read = readJson(located.file);
  if (!read.ok) {
    if (read.code === 'missing' && located.reason === 'persona-scoped') {
      return { ok: false, code: 'wardrobe-missing-for-persona', personaId, file: located.file, seeded: false, wardrobe: null };
    }
    if (read.code === 'missing') {
      return { ok: true, code: 'seeded', personaId, file: located.file, seeded: true, created: false, wardrobe: seedWardrobe({ personaId, now }) };
    }
    return { ok: false, code: 'wardrobe-unreadable', personaId, file: located.file, seeded: false, wardrobe: null, detail: read.detail ?? '' };
  }
  const version = Number(read.value?.schemaVersion ?? read.value?.version);
  const wardrobe = version >= WARDROBE_SCHEMA_VERSION && Array.isArray(read.value?.outfits)
    ? normalizeWardrobe({ ...read.value, schemaVersion: WARDROBE_SCHEMA_VERSION }, { personaId, now })
    : migrateWardrobeV1(read.value, { personaId, now });
  return {
    ok: true,
    code: wardrobe.migratedFrom ? 'migrated' : 'ok',
    personaId,
    file: located.file,
    seeded: false,
    created: true,
    migratedFrom: wardrobe.migratedFrom || 0,
    wardrobe,
  };
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

/** Persist a v2 document. Writes a `.previous` copy of whatever was there. */
export function saveWardrobeFor({ root, personaId = '', wardrobe, now = Date.now() } = {}) {
  const located = wardrobeFileFor(root, personaId);
  const normalized = (Number(wardrobe?.schemaVersion) >= WARDROBE_SCHEMA_VERSION
    ? normalizeWardrobe(wardrobe, { personaId, now })
    : migrateWardrobeV1(wardrobe, { personaId, now }));
  const document = { ...normalized, ownerPersona: normalized.ownerPersona || text(personaId, 60) };
  delete document.migratedFrom;
  delete document.normalizedAt;
  try {
    if (fs.existsSync(located.file)) fs.copyFileSync(located.file, `${located.file}.previous`);
  } catch { /* the backup is a convenience, not a precondition */ }
  atomicWrite(located.file, document);
  return { file: located.file, wardrobe: normalizeWardrobe(document, { personaId, now }) };
}

/**
 * Commit a v1 → v2 upgrade **on disk**, keeping a byte copy of the original.
 *
 * This is the only function in the module that rewrites an existing document, and it
 * refuses to run when the file is already v2. Reverting is `Copy-Item wardrobe.json.v1.bak
 * wardrobe.json` — documented in the migration note that ships with the report.
 */
export function commitMigration({ root, personaId = '', now = Date.now() } = {}) {
  const located = wardrobeFileFor(root, personaId);
  const read = readJson(located.file);
  if (!read.ok) return { ok: false, code: read.code === 'missing' ? 'no-wardrobe-file' : 'wardrobe-unreadable' };
  const version = Number(read.value?.schemaVersion ?? read.value?.version);
  if (version >= WARDROBE_SCHEMA_VERSION) return { ok: true, code: 'already-v2', file: located.file, backup: null };
  const backup = `${located.file}.v1.bak`;
  fs.copyFileSync(located.file, backup);
  const migrated = migrateWardrobeV1(read.value, { personaId, now });
  const document = { ...migrated };
  delete document.migratedFrom;
  delete document.normalizedAt;
  atomicWrite(located.file, document);
  return { ok: true, code: 'migrated', file: located.file, backup, from: version || 1 };
}

/** Write the seed document for a persona that has none yet (explicit, never on read). */
export function ensureWardrobeFile({ root, personaId = '', now = Date.now() } = {}) {
  const located = wardrobeFileFor(root, personaId);
  if (fs.existsSync(located.file)) return { ok: true, code: 'exists', file: located.file };
  const wardrobe = seedWardrobe({ personaId, now });
  const document = { ...wardrobe };
  delete document.migratedFrom;
  delete document.normalizedAt;
  atomicWrite(located.file, document);
  return { ok: true, code: 'seeded', file: located.file };
}

export function resolvePiece(wardrobe, itemId) {
  if (!itemId) return null;
  return wardrobe?.items?.find(item => item.id === itemId && item.enabled !== false) ?? null;
}

/** Slot → resolved item objects, keeping the slot order. */
export function resolvePieces(wardrobe, pieces) {
  const out = {};
  for (const slot of WARDROBE_SLOTS) out[slot] = resolvePiece(wardrobe, pieces?.[slot] ?? null);
  return out;
}

export function outfitCandidates(wardrobe, context) {
  return (wardrobe?.outfits ?? []).filter(outfit => outfit.enabled !== false && outfit.context === context);
}

/** Deterministic per (local date, persona, context) pick; the same day never re-rolls. */
export function selectOutfitForContext(wardrobe, { context, date, personaId = '' }) {
  const candidates = outfitCandidates(wardrobe, context);
  if (!candidates.length) return null;
  const seed = `${date}|${personaId}|${context}`;
  const digest = crypto.createHash('sha256').update(seed).digest();
  return candidates[digest.readUInt32BE(0) % candidates.length];
}

export const wardrobeSeed = Object.freeze({ items: SEED_ITEMS, outfits: SEED_OUTFITS, tendency: WARDROBE_TENDENCY, revision: SEED_REVISION });

export function localDate(now, timeZone = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}
