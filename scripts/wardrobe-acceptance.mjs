#!/usr/bin/env node
/**
 * Wardrobe v2 acceptance capture — offline, zero-cost, reproducible.
 *
 * What this does (and deliberately does not do):
 *   - calls the real resolver with injected instants, so the day/night table in the brief
 *     (22:20 / 22:40 / 02:00 / 06:50 / 07:10 / night outing) is reproduced against the
 *     actual code path the prompt and the media layer use;
 *   - renders the exact `agent/pre-step` snapshot text and the exact English clothing
 *     clause an image prompt would receive;
 *   - runs `companion_media_draw(subject=companion, dryRun=true)` through the real media
 *     service with a synthetic local config, which **sends nothing**;
 *   - writes one JSON evidence file plus a readable transcript under
 *     `<dataRoot>/logs/wardrobe-v2-<date>/`.
 *
 * It never starts the host, never opens a socket, never touches a real wardrobe: a
 * throwaway directory is used unless `--root` points at an explicit companion root.
 *
 * Usage:
 *   node scripts/wardrobe-acceptance.mjs [--root <companion data root>] [--out <dir>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : '';
};

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const suiteRoot = path.resolve(here, '..');
const { resolveDataRoot } = await import(new URL('../plugins/companion-foundation/suite-paths.mjs', import.meta.url).href);
const { resolveSuitePaths } = await import(new URL('../plugins/companion-foundation/suite-paths.mjs', import.meta.url).href);
const foundation = path.join(suiteRoot, 'plugins/companion-foundation');
const {
  loadWardrobeFor, seedWardrobe, saveWardrobeFor,
} = await import(new URL(`file://${foundation.replace(/\\/g, '/')}/wardrobe-schema.mjs`).href);
const {
  resolveWardrobeState, renderWardrobeSnapshot, wardrobeEnglishClause, wardrobeContextReport,
} = await import(new URL(`file://${foundation.replace(/\\/g, '/')}/wardrobe-state.mjs`).href);
const {
  resolveCompanionVisualState, visualStateReport,
} = await import(new URL(`file://${foundation.replace(/\\/g, '/')}/visual-identity.mjs`).href);
const { createMediaService } = await import(new URL(`file://${suiteRoot.replace(/\\/g, '/')}/plugins/companion-media/src/service.mjs`).href);

const explicitRoot = argOf('--root');
const temporary = !explicitRoot;
const root = explicitRoot ? path.resolve(explicitRoot) : fs.mkdtempSync(path.join(os.tmpdir(), 'wardrobe-acceptance-'));
const personaId = 'bot';

function prepare(root, { withIdentity }) {
  fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
  const seeded = seedWardrobe({ personaId, now: Date.now() });
  const document = { ...seeded };
  delete document.migratedFrom;
  delete document.normalizedAt;
  saveWardrobeFor({ root, personaId, wardrobe: document, now: Date.now() });
  fs.writeFileSync(path.join(root, 'home/companion/wardrobe.config.json'), JSON.stringify({
    timeZone: 'Asia/Shanghai',
    nightWindow: { enabled: true, start: '22:30', end: '07:00' },
    eveningFrom: '19:00',
  }, null, 2), 'utf8');
  if (withIdentity) {
    fs.writeFileSync(path.join(root, 'home/companion/visual-identity.json'), JSON.stringify({
      schemaVersion: 1,
      personas: {
        [personaId]: {
          name: { zh: '示例角色', en: 'Example Companion' },
          source: { zh: '示例作品', en: 'Example Work' },
          appearance: {
            zh: '银灰短发，蓝到粉的渐变瞳色，左耳一枚银色小耳钉。',
            en: 'short silver-grey hair, blue-to-pink gradient eyes, a small silver stud in her left ear',
          },
          provenance: { source: 'acceptance-fixture', updatedAt: new Date().toISOString() },
        },
      },
    }, null, 2), 'utf8');
  }
}

/** Local Asia/Shanghai instant on a fixed day; `at('22:40')` → epoch ms. */
const DAY = '2026-11-10';
const at = (hhmm, date = DAY) => new Date(`${date}T${hhmm}:00+08:00`).getTime();

const CLOCK_CASES = ['14:00', '19:30', '22:20', '22:40', '02:00', '06:50', '07:10'];
const results = { generatedAt: new Date().toISOString(), root, personaId, temporary, cases: [], dryRun: null, contexts: null, visualReport: null };

prepare(root, { withIdentity: true });

for (const clock of CLOCK_CASES) {
  const date = ['02:00', '06:50'].includes(clock) ? '2026-11-11' : DAY;
  const state = resolveWardrobeState({ root, personaId, now: at(clock, date) });
  results.cases.push({
    clock,
    localDate: date,
    ok: state.ok,
    context: state.context,
    contextLabel: state.contextLabel,
    reason: state.reason,
    reasons: state.reasons,
    outfitId: state.outfitId,
    pieces: Object.fromEntries(Object.entries(state.pieces ?? {}).map(([slot, piece]) => [slot, piece ? piece.id : null])),
    missing: state.missing,
    snapshot: renderWardrobeSnapshot(state),
    englishClause: wardrobeEnglishClause(state),
  });
}

// Night outing: an activity that is running *now* beats the night window.
const outing = resolveWardrobeState({
  root, personaId, now: at('23:10'),
  activity: { title: '出门散步', status: 'running', kind: 'activity', startAt: at('23:00'), endAt: at('23:40') },
});
results.cases.push({
  clock: '23:10 + 正在发生的外出活动',
  localDate: DAY,
  ok: outing.ok,
  context: outing.context,
  contextLabel: outing.contextLabel,
  reason: outing.reason,
  reasons: outing.reasons,
  outfitId: outing.outfitId,
  pieces: Object.fromEntries(Object.entries(outing.pieces ?? {}).map(([slot, piece]) => [slot, piece ? piece.id : null])),
  missing: outing.missing,
  snapshot: renderWardrobeSnapshot(outing),
  englishClause: wardrobeEnglishClause(outing),
});

// A plan that has not happened must not dress her for an outing.
const planned = resolveWardrobeState({
  root, personaId, now: at('14:00'),
  schedule: { title: '晚上出门吃饭', kind: 'plan', status: 'planned', startAt: at('20:00'), endAt: at('21:00') },
});
results.cases.push({
  clock: '14:00 + 未来的外出计划（不得生效）',
  localDate: DAY,
  ok: planned.ok,
  context: planned.context,
  reason: planned.reason,
  outfitId: planned.outfitId,
  note: '计划不是已发生：仍然是 everyday',
});

results.contexts = wardrobeContextReport({ root, personaId, now: at('14:00') });
results.visualReport = visualStateReport({ root, personaId, now: at('14:00') });

// ── media dry run: real service, synthetic config, no network ──────────────────
// Deliberately **not** in the caller's data root: a capture must never leave a media
// config behind in a real install (and `data-dev/` is not covered by the `data/`
// gitignore rule). A throwaway directory gets the same wardrobe + identity, so the
// resolver sees exactly the same inputs.
const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wardrobe-acceptance-media-'));
fs.mkdirSync(path.join(mediaRoot, 'home/companion'), { recursive: true });
for (const file of ['wardrobe.json', 'wardrobe.config.json', 'visual-identity.json']) {
  const from = path.join(root, 'home/companion', file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(mediaRoot, 'home/companion', file));
}
const mediaConfigPath = path.join(mediaRoot, 'media', 'config.json');
fs.mkdirSync(path.dirname(mediaConfigPath), { recursive: true });
fs.writeFileSync(mediaConfigPath, JSON.stringify({
  schemaVersion: 2,
  enabled: true,
  image: {
    enabled: true,
    provider: 'nai',
    nai: {
      // A synthetic fixture: every call below is dryRun, and `fetchImpl` refuses to run, so
      // this value can never be used to reach a provider.
      transport: 'official', baseUrl: 'https://image.novelai.net', apiKey: 'pst-acceptance-fixture-0123456789',
      model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 28, scale: 5,
      sampler: 'k_euler_ancestral', noiseSchedule: 'karras', seed: -1, timeoutMs: 5000,
    },
  },
  limits: { requestBudgetMs: 5000, connectTimeoutMs: 2000, maxResponseBytes: 1 << 20, maxImageBytes: 1 << 20, maxAudioBytes: 1 << 20, maxRedirects: 2, maxImagesPerRequest: 1, maxTextChars: 500 },
}, null, 2), 'utf8');

let networkAttempted = null;
const mediaServiceFor = instant => createMediaService({
  dataDir: mediaRoot,
  env: {},
  // Any attempt to actually reach the network is recorded and refused here: this script
  // must never produce a billed request.
  fetchImpl: async (url) => {
    networkAttempted = String(url);
    throw new Error('acceptance capture must not perform network requests');
  },
  now: () => new Date(instant),
});

// 14:00 and 22:40 on the same day: the *same* prompt must be drawn with daytime clothes at
// 14:00 and with pajamas at 22:40, which is the whole point of the upgrade.
const dayService = mediaServiceFor('2026-11-10T06:00:00Z');   // 14:00 Asia/Shanghai
const nightService = mediaServiceFor('2026-11-10T14:40:00Z'); // 22:40 Asia/Shanghai
const PROMPT = 'She sits on the bed with a book.';
results.dryRun = {
  at: { day: '2026-11-10T14:00+08:00', night: '2026-11-10T22:40+08:00' },
  day: await dayService.generateImage({ subject: 'companion', prompt: PROMPT, dryRun: true }),
  night: await nightService.generateImage({ subject: 'companion', prompt: PROMPT, dryRun: true }),
  // `subject` other/empty keeps the old behaviour: nothing about the companion is injected.
  other: await nightService.generateImage({ subject: '', prompt: 'A quiet street at night.', dryRun: true }),
  visualState: (() => {
    const state = resolveCompanionVisualState({ root, personaId, now: at('22:40') });
    return { ok: state.ok, identity: state.identity.state, context: state.wardrobe.context, outfitId: state.wardrobe.outfitId, imageClause: state.imageClause, missing: state.missing };
  })(),
  networkAttempted,
};
fs.rmSync(mediaRoot, { recursive: true, force: true });

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const outDir = argOf('--out') ? path.resolve(argOf('--out')) : path.join(root, 'logs', `wardrobe-v2-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });
const evidenceFile = path.join(outDir, 'acceptance.json');
const transcriptFile = path.join(outDir, 'acceptance.txt');

results.evidence = {
  sourceHashes: Object.fromEntries(
    ['wardrobe-schema.mjs', 'wardrobe-context.mjs', 'wardrobe-state.mjs', 'wardrobe-evidence.mjs', 'visual-identity.mjs', 'wardrobe.mjs']
      .map((file) => {
        const bytes = fs.readFileSync(path.join(foundation, file));
        return [file, crypto.createHash('sha256').update(bytes).digest('hex')];
      }),
  ),
  suite: resolveSuitePaths({ env: process.env }),
  dataRoot: resolveDataRoot({ env: process.env }).dataRoot,
};

fs.writeFileSync(evidenceFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8');

const lines = [
  'Wardrobe v2 acceptance capture',
  `generated: ${results.generatedAt}`,
  `root: ${root}`,
  '',
  '── clock table ──',
];
for (const row of results.cases) {
  lines.push(`${row.clock}  →  ${row.context ?? '(none)'}  [${row.reason ?? ''}]  outfit=${row.outfitId ?? ''}`);
  if (row.snapshot) lines.push(...String(row.snapshot).split('\n').map((line) => `    ${line}`));
  if (row.englishClause?.ok) lines.push(`    EN: ${row.englishClause.clause}`);
  lines.push('');
}
lines.push('── per-scene availability (14:00) ──');
for (const row of results.contexts.contexts) lines.push(`${row.context}: ok=${row.ok} code=${row.code} outfit=${row.outfitId}`);
lines.push('', '── media dryRun (same prompt, two times of day; no network) ──');
lines.push(`14:00 outfitSource = ${results.dryRun.day.visual?.outfitSource}`);
lines.push(`14:00 context      = ${results.dryRun.day.visual?.context}`);
lines.push(`14:00 injected     = ${results.dryRun.day.visual?.injectedClause}`);
lines.push(`22:40 context      = ${results.dryRun.night.visual?.context}`);
lines.push(`22:40 injected     = ${results.dryRun.night.visual?.injectedClause}`);
lines.push(`other.visual       = ${JSON.stringify(results.dryRun.other.visual ?? null)}`);
lines.push(`networkAttempted   = ${results.dryRun.networkAttempted ?? '(none — dryRun only)'}`);
lines.push(`same prompt, different clothes: ${results.dryRun.day.visual?.context !== results.dryRun.night.visual?.context ? 'YES' : 'NO'}`);
lines.push('', '── visual state ──');
lines.push(`identity=${results.dryRun.visualState.identity} context=${results.dryRun.visualState.context} outfit=${results.dryRun.visualState.outfitId}`);
lines.push(`imageClause = ${results.dryRun.visualState.imageClause}`);
fs.writeFileSync(transcriptFile, `${lines.join('\n')}\n`, 'utf8');

console.log(lines.join('\n'));
console.log(`\nevidence: ${evidenceFile}`);
console.log(`transcript: ${transcriptFile}`);
if (temporary) console.log(`(temporary root; pass --root <dataRoot> to capture against a real install)`);
