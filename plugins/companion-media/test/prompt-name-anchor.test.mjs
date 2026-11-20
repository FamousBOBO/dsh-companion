// 生图 prompt 里必须出现角色名字 —— 2026-11-18 实测出的静默失败。
//
// 事故原样：`companion_media_visual` 正确返回了 `identityClause`
// （"March 7th from Honkai: Star Rail (Astral Express), shoulder-length pink hair…"），
// 模型读完却只写了外观：「A young woman with shoulder-length pink hair and blue-to-pink
// gradient eyes…」——1153 字符的 prompt，名字出现 **0 次**。生成出来的图是"一个粉发女孩"，
// 而链路上每一步（visual → draw → send）都返回成功。这种失败比报错难查得多。
//
// 这里钉的是三件事：
//   1. 没提名字时补上，且原画面描述一字不改（不是"追加身份串"）；
//   2. 已经提了就不再动（模型自己写了 march7th / March 7th 都算数）；
//   3. 补的那一句里不能有中文（正文必须全英文，NAI 会拒）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMediaService } from '../src/service.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-name-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 一份可用的 NAI 配置：所有请求都成功，返回 1×1 PNG。 */
function configured(dir) {
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'media', 'config.json'), JSON.stringify({
    schemaVersion: 2,
    enabled: true,
    personaId: 'bot',
    image: {
      enabled: true,
      provider: 'nai',
      nai: {
        baseUrl: 'https://nai.example.test', apiKey: 'test-key', model: 'nai-diffusion-5-full',
        transport: 'official', timeoutMs: 5000, width: 832, height: 1216, steps: 28, scale: 5,
        sampler: 'k_euler_ancestral', noiseSchedule: 'karras', seed: 42,
        qualityPreset: 'none', negativePreset: 'none', negativePrompt: 'lowres',
        artistString: '', autoResolution: false, aspect: 'portrait',
        generationPresets: [], activePresetId: '',
      },
    },
    tts: { enabled: false, provider: 'none', providers: {} },
    limits: { requestBudgetMs: 60000, connectTimeoutMs: 5000, maxResponseBytes: 16777216, maxImageBytes: 16777216, maxTextChars: 4000 },
  }, null, 2));
}

/**
 * 装一套能通过的配置。
 *
 * `personaId` 必须是 `bot` —— 那是 `resolvePersonaId()` 在没有 env / suite 配置时的默认值
 * （`config/suite.json` → `bot`）。写成 历史 persona id 会让 gate 报 `identity-missing-for-persona`，
 * 那样测的就不是"名字补丁"，而是"身份读不到"（踩过）。
 */
function seed(dir, { nameEn = 'Testa', nameZh = '测试角色', sourceEn = 'Synthetic Testwork', appearanceEn = 'short silver-grey hair' } = {}) {
  configured(dir);
  fs.mkdirSync(path.join(dir, 'home', 'companion'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'home', 'companion', 'wardrobe.json'), JSON.stringify({
    schemaVersion: 2,
    ownerPersona: 'bot',
    items: [
      { id: 'top', slot: 'whole', contexts: ['home', 'sleep', 'everyday', 'casual'], name: { zh: '上衣', en: 'a cream knit sweater' }, description: { zh: '上衣', en: 'a cream knit sweater' } },
    ],
    // 三个场景都配一套：这套测试钉的是「名字补丁」，不是「衣柜场景」。
    //
    // 只配 home 会让结果随 CI 跑在几点而变：`wardrobe-context.mjs` 默认 nightWindow
    // 22:30–07:00、eveningFrom 19:00，所以 19:00–22:30 判 home（能过），07:00–19:00 判
    // everyday（没有 everyday 组合 → no-outfits-for-context → 断言失败）。2026-11-20
    // 实测：同一个提交在 21:47 全过、17:51 连挂 5 项。补成三套后与时辰无关。
    outfits: [
      { id: 'home-default', context: 'home', pieces: { whole: 'top' } },
      { id: 'everyday-default', context: 'everyday', pieces: { whole: 'top' } },
      { id: 'sleep-default', context: 'sleep', pieces: { whole: 'top' } },
    ],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'home', 'companion', 'visual-identity.json'), JSON.stringify({
    schemaVersion: 1,
    personas: {
      bot: {
        name: { zh: nameZh, en: nameEn },
        source: { zh: '测试作品', en: sourceEn },
        appearance: { zh: '银灰短发', en: appearanceEn },
      },
    },
  }, null, 2));
}

/** 记下每一次请求的 body，避免真的联网。 */
function mockFetch() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : '' });
    return new Response(JSON.stringify({ image: PNG.toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

function sentPrompt(calls) {
  const call = calls.find(item => item.body.includes('"input"'));
  return call ? JSON.parse(call.body).input : null;
}

test('prompt 里没写角色名字 → 补在最前面，原画面描述一字不改', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    seed(dir);
    const { fetchImpl, calls } = mockFetch();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });

    const prompt = 'A young woman sits on a windowsill at night, holding a mug. Delicate linework, cool light.';
    const result = await service.generateImage({ subject: 'companion', prompt });

    assert.equal(result.ok, true, JSON.stringify(result.error));
    const sent = sentPrompt(calls);
    assert.equal(sent, `Testa from Synthetic Testwork, ${prompt}`);
    // 关键：原句必须还在里面，一个字都没被改写
    assert.ok(sent.includes(prompt), '原画面描述必须原样保留');
    assert.equal(result.injectedName, 'Testa from Synthetic Testwork');
  } finally { cleanup(); }
});

test('模型自己写了名字 → 一个字都不动，也不报 injectedName', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    seed(dir);
    const { fetchImpl, calls } = mockFetch();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });

    for (const prompt of [
      'Testa sits on a windowsill, holding a mug.',
      // 大小写与空格都不该影响判定 —— 严格相等会把"写了 march7th"误判成没写。
      'testa sits on a windowsill, holding a mug.',
      'Testa sits on a windowsill, holding a mug.',
    ]) {
      calls.length = 0;
      const result = await service.generateImage({ subject: 'companion', prompt });
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(sentPrompt(calls), prompt, `不该动：${prompt}`);
      assert.equal(result.injectedName, undefined);
    }
  } finally { cleanup(); }
});

test('中文名也能认出来（模型可能用中文名）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    seed(dir);
    const { fetchImpl, calls } = mockFetch();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });

    // 中文名出现在英文正文里会被 requireEnglish 拒（那是另一条规则，见下一个用例），
    // 所以这里只验证"认得出"这件事本身：补的是英文锚，不重复塞中文名。
    const result = await service.generateImage({ subject: 'companion', prompt: 'A quiet room at night, warm lamp light.' });
    assert.equal(result.ok, true);
    const sent = sentPrompt(calls);
    assert.ok(sent.startsWith('Testa from Synthetic Testwork,'), '用的是英文名');
    assert.doesNotMatch(sent, /[\u4e00-\u9fff]/, '补进去的锚不能有中文');
  } finally { cleanup(); }
});

test('dryRun 就把补齐后的 prompt 交出来，不必花钱才知道', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    seed(dir);
    const { fetchImpl, calls } = mockFetch();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });

    const preview = await service.generateImage({ subject: 'companion', prompt: 'A portrait.', dryRun: true });
    assert.equal(preview.ok, true);
    assert.equal(preview.injectedName, 'Testa from Synthetic Testwork');
    assert.equal(preview.prompt, 'Testa from Synthetic Testwork, A portrait.');
    assert.equal(calls.length, 0, 'dryRun 不发请求');
  } finally { cleanup(); }
});

test('身份里没有英文名 → 不补中文名（会破 requireEnglish），改为明确告诉调用方缺什么', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    seed(dir, { nameEn: '', nameZh: '沈幺' });
    const { fetchImpl, calls } = mockFetch();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });

    const result = await service.generateImage({ subject: 'companion', prompt: 'A portrait.' });
    // 生成照常进行（缺的只是名字，不是身份），但必须说出来。
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.injectedName, undefined, '不能把中文名拼进英文正文');
    assert.match(result.nameWarning, /英文名/);
    // 正文保持纯英文 —— 这正是"不补中文名"的理由。
    assert.doesNotMatch(sentPrompt(calls), /[\u4e00-\u9fff]/);
  } finally { cleanup(); }
});

test('subject 不是 companion 时完全不碰 prompt（别人的图不该被塞名字）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const { fetchImpl, calls } = mockFetch();
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });

    const prompt = 'A quiet cafe at dusk.';
    const result = await service.generateImage({ prompt });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(sentPrompt(calls), prompt);
    assert.equal(result.injectedName, undefined);
  } finally { cleanup(); }
});
