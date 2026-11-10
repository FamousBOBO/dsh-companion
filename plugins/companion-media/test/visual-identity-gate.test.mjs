/**
 * P0-A regression: a companion picture without a usable Visual Identity must be **refused
 * before any provider request**.
 *
 * The acceptance run in `docs/15-wardrobe-host-acceptance.md` §6 found that the media layer
 * only refused when the *clothing* was unknown. With `home/companion/visual-identity.json`
 * removed it reported `missing: ["identity"]` in `dryRun` and then still issued
 * `POST /v1/images/generations` — a billed picture of "the companion" with no face.
 *
 * Every test here counts network calls. `mockFetch` throws on an unmatched URL, so a call
 * that should not happen is visible twice: as `calls.length === 0` and as a hard failure if
 * the adapter ever tried anyway.
 *
 * Nothing here reaches a real provider: the transport is a local mock and the provider
 * config points at `https://image.novelai.net`, which `mockFetch` intercepts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMediaService } from '../src/service.mjs';
import { Code } from '../src/errors.mjs';
import { tempDataDir, mockFetch, makePng, makeZip, writeConfig, writeIdentity, DEFAULT_IDENTITY } from './helpers.mjs';
import { saveWardrobe } from '../../companion-foundation/wardrobe.mjs';

const KEY = 'pst-nai-0123456789abcdef';
const PNG = makePng({ width: 832, height: 1216 });
const IMAGE_URL = 'https://image.novelai.net/ai/generate-image';

function configured(dir) {
  writeConfig(dir, {
    schemaVersion: 2,
    image: {
      enabled: true,
      provider: 'nai',
      nai: {
        transport: 'official',
        baseUrl: 'https://image.novelai.net',
        apiKey: KEY,
        model: 'nai-diffusion-4-5-full',
        width: 832,
        height: 1216,
        steps: 28,
        scale: 5,
        sampler: 'k_euler_ancestral',
        noiseSchedule: 'karras',
        seed: -1,
        timeoutMs: 5000,
      },
    },
    limits: { requestBudgetMs: 5000, connectTimeoutMs: 2000, maxResponseBytes: 1 << 20, maxImageBytes: 1 << 20, maxAudioBytes: 1 << 20, maxRedirects: 2, maxImagesPerRequest: 1, maxTextChars: 500 },
  });
}

/** A v2 wardrobe with English descriptions for every slot of the everyday outfit. */
function everydayWardrobe(dir) {
  saveWardrobe(dir, {
    schemaVersion: 2,
    ownerPersona: 'bot',
    items: [
      { id: 'cardigan', slot: 'upper', contexts: ['everyday'], name: { zh: '开衫', en: 'a blue cardigan' }, description: { zh: '蓝色针织开衫', en: 'a blue knitted cardigan' } },
      { id: 'trousers', slot: 'lower', contexts: ['everyday'], name: { zh: '长裤', en: 'grey trousers' }, description: { zh: '灰色直筒长裤', en: 'plain grey trousers' } },
    ],
    outfits: [{ id: 'everyday-a', context: 'everyday', pieces: { upper: 'cardigan', lower: 'trousers' } }],
  });
}

/** A midday clock, so the resolver picks the everyday outfit no matter when CI runs. */
const NOON = () => new Date('2026-11-07T04:00:00Z');

function successRoutes() {
  return mockFetch([{
    match: IMAGE_URL,
    response: { status: 200, bytes: makeZip([{ name: 'image_0.png', bytes: PNG }]), headers: { 'content-type': 'application/zip' }, mime: 'application/zip' },
  }]);
}

/** The one shape every refusal has to have. */
function assertRefusedBeforeNetwork(result, calls, { code, missing }) {
  assert.equal(result.ok, false, 'refusal must not report success');
  assert.equal(result.error.code, code, `unexpected code: ${result.error.code} — ${result.error.message}`);
  assert.deepEqual(result.error.details.missing, missing, 'the refusal must name what is missing');
  assert.equal(calls.length, 0, `no provider request may be sent on refusal, saw ${calls.length}`);
}

test('P0-A：identity 文件不存在 → 真实调用拒绝，POST 次数为 0', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    everydayWardrobe(dir);
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: NOON });

    const result = await service.generateImage({ subject: 'companion', prompt: 'She reads by a window.' });

    assertRefusedBeforeNetwork(result, calls, { code: Code.VISUAL_IDENTITY_REQUIRED, missing: ['identity'] });
    assert.equal(result.error.details.identity.code, 'identity-missing');
    assert.equal(result.error.details.personaId, 'bot');
    assert.match(result.error.message, /视觉身份/);
    // The clothes were fine — the refusal is about the character, and it says so.
    assert.equal(result.error.details.wardrobe.code, 'ok');
  } finally {
    cleanup();
  }
});

test('P0-A：dryRun 与真实调用用同一套校验，dryRun 报的 refusal 与真实 error 一致', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    everydayWardrobe(dir);
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: NOON });

    const preview = await service.generateImage({ subject: 'companion', prompt: 'A portrait.', dryRun: true });
    const real = await service.generateImage({ subject: 'companion', prompt: 'A portrait.' });

    assert.equal(preview.ok, true, 'dryRun 是无副作用的预览，不是失败');
    assert.equal(preview.dryRun, true);
    assert.equal(preview.visualRequired, true);
    assert.equal(preview.wouldSend, '不发起任何网络请求');
    assert.deepEqual(preview.refusal.details.missing, real.error.details.missing, 'dryRun 与真实调用必须判定一致');
    assert.equal(preview.refusal.code, real.error.code, 'dryRun 与真实调用必须给同一个 code');
    assert.equal(calls.length, 0, '两个分支都不许发请求');
  } finally {
    cleanup();
  }
});

test('P0-A：identity 文件损坏 → 拒绝，POST 次数为 0', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    everydayWardrobe(dir);
    const file = path.join(dir, 'home', 'companion', 'visual-identity.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: NOON });

    const result = await service.generateImage({ subject: 'companion', prompt: 'A portrait.' });

    assertRefusedBeforeNetwork(result, calls, { code: Code.VISUAL_IDENTITY_REQUIRED, missing: ['identity'] });
    assert.equal(result.error.details.identity.code, 'identity-unreadable');
  } finally {
    cleanup();
  }
});

test('P0-A：identity 结构无效（personas 不是对象）→ 拒绝，POST 次数为 0', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    everydayWardrobe(dir);
    const file = path.join(dir, 'home', 'companion', 'visual-identity.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, personas: [] }), 'utf8');
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: NOON });

    const result = await service.generateImage({ subject: 'companion', prompt: 'A portrait.' });

    assertRefusedBeforeNetwork(result, calls, { code: Code.VISUAL_IDENTITY_REQUIRED, missing: ['identity'] });
    assert.equal(result.error.details.identity.code, 'identity-invalid');
  } finally {
    cleanup();
  }
});

test('P0-A：Persona 不匹配 → 拒绝，不借用别人格的身份，POST 次数为 0', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    everydayWardrobe(dir);
    // The file has an identity, but only for a different persona. Falling back to it would
    // draw the wrong character with the right clothes, which is the failure this guards.
    writeIdentity(dir, { 'someone-else': { name: { zh: '别人格', en: 'Other Persona' }, appearance: { zh: '黑长发', en: 'long black hair' } } });
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: { DSH_COMPANION_PERSONA_ID: 'bot' }, fetchImpl, now: NOON });

    const result = await service.generateImage({ subject: 'companion', prompt: 'A portrait.' });

    assertRefusedBeforeNetwork(result, calls, { code: Code.VISUAL_IDENTITY_REQUIRED, missing: ['identity'] });
    assert.equal(result.error.details.identity.code, 'identity-missing-for-persona');
    assert.equal(result.error.details.personaId, 'bot');
  } finally {
    cleanup();
  }
});

test('P0-A：身份只有中文外观（没有英文子句）→ 拒绝，不发中文提示词', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    everydayWardrobe(dir);
    writeIdentity(dir, { bot: { name: { zh: '测试角色' }, appearance: { zh: '银灰短发' } } });
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: NOON });

    const result = await service.generateImage({ subject: 'companion', prompt: 'She reads by a window.' });

    assertRefusedBeforeNetwork(result, calls, { code: Code.VISUAL_IDENTITY_REQUIRED, missing: ['identity-english'] });
    assert.match(result.error.message, /英文/);
  } finally {
    cleanup();
  }
});

test('P0-A：身份有效 → 通过校验，注入身份子句并正常发一次请求', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    everydayWardrobe(dir);
    writeIdentity(dir, DEFAULT_IDENTITY);
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: NOON });

    const result = await service.generateImage({ subject: 'companion', prompt: 'She reads by a window.' });

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(calls.length, 1, '有效身份只发一次生成请求');
    const input = JSON.parse(calls[0].body).input;
    assert.match(input, /Testa from Synthetic Testwork/, '身份子句要进提示词');
    assert.match(input, /short silver-grey hair/);
    assert.match(input, /The companion wears a blue knitted cardigan/);
    assert.equal(result.visual.identity, 'configured');
    assert.equal(result.visual.identityName, '测试角色');
  } finally {
    cleanup();
  }
});

test('P0-A：身份缺失时显式 outfit 也不能绕过（旧行为会绕过身份）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    everydayWardrobe(dir);
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: NOON });

    const result = await service.generateImage({ subject: 'companion', prompt: 'A portrait.', outfit: 'a red coat' });

    assertRefusedBeforeNetwork(result, calls, { code: Code.VISUAL_IDENTITY_REQUIRED, missing: ['identity'] });
    assert.equal(result.error.details.outfitSource, 'explicit-arg', '拒绝时要说明调用方传了 outfit');
  } finally {
    cleanup();
  }
});

test('P0-A：subject=other 不继承陪伴角色身份，也不发请求', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    everydayWardrobe(dir);
    writeIdentity(dir, DEFAULT_IDENTITY);
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: NOON });

    const result = await service.generateImage({ subject: 'other', prompt: 'A quiet street at night.' });

    // `other` is not a supported subject: the tool contract only defines `companion`, and the
    // safest reading of an unknown subject is "refuse", never "draw the companion anyway".
    assert.equal(result.ok, false);
    assert.equal(result.error.code, Code.BAD_INPUT);
    assert.equal(calls.length, 0, 'other 不发请求');
    assert.ok(!JSON.stringify(result).includes('Testa'), '不得注入陪伴角色身份');
    assert.ok(!JSON.stringify(result).includes('silver-grey'), '不得注入陪伴角色外观');
  } finally {
    cleanup();
  }
});

test('P0-A：空 subject 保持旧行为（不注入身份，也不被拒绝）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    everydayWardrobe(dir);
    writeIdentity(dir, DEFAULT_IDENTITY);
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: NOON });

    const preview = await service.generateImage({ prompt: 'A quiet street at night.', dryRun: true });
    assert.equal(preview.ok, true);
    assert.equal(preview.visual, undefined, '空 subject 不产生 visual 块');

    const result = await service.generateImage({ prompt: 'A quiet street at night.' });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.visual, null);
    assert.equal(calls.length, 1);
    const input = JSON.parse(calls[0].body).input;
    assert.doesNotMatch(input, /Testa|silver-grey|The companion wears/, '空 subject 不注入任何陪伴角色内容');
  } finally {
    cleanup();
  }
});

test('P0-A：衣柜读不出来 + 身份缺失时，拒绝信息同时报出 identity 与 wardrobe', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    // A corrupt wardrobe is `wardrobe-unreadable`; with no identity file either, both halves
    // of the claim are missing and the refusal must name both. (A merely absent wardrobe is
    // *not* a gap: the foundation seeds one on first run, by design.)
    const wardrobeFile = path.join(dir, 'home', 'companion', 'wardrobe.json');
    fs.mkdirSync(path.dirname(wardrobeFile), { recursive: true });
    fs.writeFileSync(wardrobeFile, '{ broken', 'utf8');
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: { DSH_COMPANION_PERSONA_ID: 'bot' }, fetchImpl, now: NOON });

    const result = await service.generateImage({ subject: 'companion', prompt: 'A portrait.' });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, Code.VISUAL_IDENTITY_REQUIRED, '身份缺失优先报告');
    assert.deepEqual(result.error.details.missing, ['identity', 'wardrobe']);
    assert.equal(result.error.details.wardrobe.code, 'wardrobe-unreadable');
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test('P0-A：衣柜文件不存在（首次运行）不算缺失——由 foundation 播种，只报 identity', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: { DSH_COMPANION_PERSONA_ID: 'bot' }, fetchImpl, now: NOON });

    const preview = await service.generateImage({ subject: 'companion', prompt: 'A portrait.', dryRun: true });

    // Seeding on first run is the documented behaviour, so the only gap here is the identity.
    assert.deepEqual(preview.refusal.details.missing, ['identity']);
    assert.equal(preview.visual.wardrobe, undefined, 'the report keeps the wardrobe block out of `missing`');
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test('P0-A：群聊会话不解析私人衣柜，缺身份时同样拒绝', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    everydayWardrobe(dir);
    writeIdentity(dir, DEFAULT_IDENTITY);
    const { fetchImpl, calls } = successRoutes();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: NOON });

    // A group session may not read the private wardrobe, so even a configured identity is not
    // enough: there is no authoritative clothing answer inside a group.
    const result = await service.generateImage({ subject: 'companion', prompt: 'A portrait.', sessionId: 'qq-group-123' });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, Code.BAD_INPUT);
    assert.deepEqual(result.error.details.missing, ['wardrobe']);
    assert.equal(result.error.details.wardrobe.code, 'wardrobe-unavailable-in-group');
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});
