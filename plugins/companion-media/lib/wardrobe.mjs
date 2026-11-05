/**
 * Read the outfit the character is actually wearing and turn it into an English
 * clause for the image prompt.
 *
 * The wardrobe lives in `companion-foundation` and is deliberately deterministic:
 * today's outfit is either an explicit `companion_outfit_set` for the local day or
 * a stable per-day pick from the item list. Image generation used to ignore it
 * entirely, so the model invented clothes (observed 2026-11-04: an outfit that
 * was not the wardrobe's at all). This module makes the wardrobe authoritative
 * for pictures the same way it already is for the system prompt.
 *
 * Cross-plugin import is on purpose: duplicating the selection logic would let the
 * prompt section and the picture drift apart again.
 */
import path from 'node:path';

// Relative to this file (plugins/companion-media/lib/), so two levels up reaches
// the sibling plugin directory.
const FOUNDATION = '../../companion-foundation/wardrobe.mjs';

// English names for the stock wardrobe. Unknown ids fall back to their Chinese
// name; the prompt translator covers that case.
const EN_NAMES = {
  'w-upper-hoodie': 'a soft white hoodie',
  'w-upper-shirt': 'a light blue shirt',
  'w-upper-cardigan': 'a pink knitted cardigan',
  'w-lower-shorts': 'navy denim shorts',
  'w-lower-skirt': 'a light grey knee-length skirt',
  'w-lower-pants': 'white casual trousers',
  'w-feet-sneakers': 'white low-top sneakers',
  'w-feet-canvas': 'light blue canvas shoes',
  'w-extra-camera': 'a camera lanyard with a small camera',
  'w-extra-hairpin': 'a small silver hairpin',
  'w-extra-scarf': 'a pale pink thin scarf',
};

let modulePromise = null;

async function loadFoundation() {
  if (modulePromise === null) {
    const url = new URL(FOUNDATION, import.meta.url);
    url.searchParams.set('v', String(Date.now()));
    modulePromise = import(url.href).catch(() => null);
  }
  return modulePromise;
}

function englishName(item) {
  return EN_NAMES[item.id] ?? String(item.name ?? '').trim();
}

/** Build the clause, or a reason why there is nothing to inject. */
export async function resolveOutfit({ root, now = Date.now(), timeZone = 'Asia/Shanghai', prompt = '' } = {}) {
  const foundation = await loadFoundation();
  if (!foundation?.loadWardrobe || !foundation?.currentOutfit) {
    return { ok: false, reason: 'wardrobe module unavailable', clause: '', items: [] };
  }
  let outfit;
  let wardrobe;
  try {
    wardrobe = foundation.loadWardrobe(root);
    outfit = foundation.currentOutfit(wardrobe, now, timeZone);
  } catch (error) {
    return { ok: false, reason: `wardrobe unreadable: ${error?.message ?? error}`, clause: '', items: [] };
  }
  const items = Array.isArray(outfit?.items) ? outfit.items : [];
  if (items.length === 0) return { ok: false, reason: 'wardrobe has no items', clause: '', items: [] };

  const names = items.map(englishName).filter(Boolean);
  const clause = names.join(', ');
  // If the caller already described one of the real items, do not stack a second
  // outfit on top of it — that would fight the prompt instead of grounding it.
  const lowered = String(prompt ?? '').toLowerCase();
  const mentioned = names.some(name => name.length > 3 && lowered.includes(name.toLowerCase()));
  if (mentioned) {
    return { ok: true, source: 'prompt', date: outfit.date, clause, items: items.map(item => item.id), injected: false };
  }
  return {
    ok: true,
    source: outfit.source === 'explicit' ? 'explicit' : 'daily',
    date: outfit.date,
    clause,
    instruction: outfit.instruction ?? '',
    items: items.map(item => item.id),
    injected: true,
  };
}

/** Absolute path of the wardrobe file, for diagnostics. */
export function wardrobePath(root) {
  return path.join(root, 'home/companion/wardrobe.json');
}
