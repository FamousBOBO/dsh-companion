import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMediaService } from '../src/service.mjs';
import { tempDataDir, mockFetch, makePng, makeZip, writeConfig, writeIdentity } from './helpers.mjs';
import { Code } from '../src/errors.mjs';
import { saveWardrobe } from '../../companion-foundation/wardrobe.mjs';

const KEY = 'pst-nai-0123456789abcdef';
const PNG = makePng({ width: 832, height: 1216 });

function configured(dir, nai = {}, extra = {}) {
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
        ...nai,
      },
    },
    limits: { requestBudgetMs: 5000, connectTimeoutMs: 2000, maxResponseBytes: 1 << 20, maxImageBytes: 1 << 20, maxAudioBytes: 1 << 20, maxRedirects: 2, maxImagesPerRequest: 1, maxTextChars: 500 },
    ...extra,
  });
}

test('NAI official：ZIP 响应 → 解出 PNG；请求体是 {input, model, action, parameters}', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const zip = makeZip([{ name: 'image_0.png', bytes: PNG }]);
    const { fetchImpl, calls } = mockFetch([{
      match: 'https://image.novelai.net/ai/generate-image',
      response: { status: 200, bytes: zip, headers: { 'content-type': 'application/zip' }, mime: 'application/zip' },
    }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'a quiet library' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(result.artifact.mime, 'image/png');
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].body);
    assert.equal(body.input, 'a quiet library');
    assert.equal(body.model, 'nai-diffusion-4-5-full');
    assert.equal(body.action, 'generate');
    assert.equal(body.parameters.steps, 28, '步数默认 28');
    assert.equal(body.parameters.width, 832);
    assert.equal(body.parameters.v4_prompt.caption.base_caption, 'a quiet library');
    assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  } finally {
    cleanup();
  }
});

// 2026-11-10 合同变更（wardrobe v2 / visual identity）：陪绊角色生图不再要求模型在 `outfit`
// 参数里自己写英文衣物。身份与当前服装由 `resolveCompanionVisualState()` 统一注入，理由见
// plugins/companion-foundation/WARDROBE-STATE-CONTRACT.md §6：模型与媒体层各写一遍衣服，正是
// 「生图与衣柜不一致」的根因。旧调用（显式传 `outfit`）仍然有效，并且仍然优先。
test('official queue injects the resolved outfit automatically and keeps an explicit outfit override', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const queue = 'https://queue.example.test';
    const image = 'https://image.novelai.net/ai/generate-image';
    configured(dir, { queueEnabled: true, queueBaseUrl: queue, queueUserId: 'operator' });
    const { fetchImpl, calls } = mockFetch([
      { match: queue + '/join-queue', response: { status: 200, json: {} } },
      { match: url => url.startsWith(queue + '/my-turn?'), response: { status: 200, json: { is_my_turn: true, lock_token: 'lease' } } },
      { match: image, response: { status: 200, json: { image: PNG.toString('base64') } } },
      { match: queue + '/complete', response: { status: 200, json: {} } },
    ]);
    // A v2 wardrobe with English descriptions, which are the authoritative text for images.
    saveWardrobe(dir, {
      schemaVersion: 2,
      ownerPersona: 'bot',
      items: [
        { id: 'blue', slot: 'upper', contexts: ['everyday'], name: { zh: '蓝色开衫', en: 'a blue cardigan' }, description: { zh: '蓝色开衫', en: 'a blue knitted cardigan' } },
        { id: 'white', slot: 'upper', contexts: ['everyday'], name: { zh: '白色衬衫', en: 'a white shirt' }, description: { zh: '白色衬衫', en: 'a white cotton shirt' } },
      ],
      outfits: [{ id: 'everyday-a', context: 'everyday', pieces: { upper: 'blue' } }],
    });
    // A picture of the companion needs both halves: who she is, and what she wears. The
    // identity is mandatory (see the gate in src/service.mjs), so this fixture has one.
    writeIdentity(dir, { bot: { name: { zh: '测试角色', en: 'Testa' }, appearance: { zh: '银灰短发', en: 'short silver-grey hair' } } });
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: () => new Date('2026-11-07T02:00:00Z') });
    const args = { subject: 'companion', prompt: 'A woman smiles by a cafe window.', requireEnglish: true };
    const preview = await service.generateImage({ ...args, dryRun: true });
    assert.equal(preview.visual.outfitSource, 'wardrobe-resolver');
    assert.equal(preview.visual.context, 'everyday');
    assert.match(preview.visual.injectedClause, /blue knitted cardigan/);
    assert.equal(calls.length, 0, 'dryRun 不发请求');

    // No `outfit` argument at all: the resolver supplies the clothes and the call succeeds.
    const result = await service.generateImage(args);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.visual.outfitSource, 'wardrobe-resolver');
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/join-queue', '/my-turn', '/ai/generate-image', '/complete']);
    const actual = JSON.parse(calls[2].body);
    assert.match(actual.input, /The companion wears a blue knitted cardigan/);
    assert.match(actual.parameters.v4_prompt.caption.base_caption, /blue knitted cardigan/);

    // An explicit English outfit still wins (old callers / "draw her in this outfit").
    assert.equal((await service.generateImage({ ...args, outfit: '蓝色开衫' })).ok, false, '中文 outfit 仍被拒绝');
    calls.length = 0;
    const explicit = await service.generateImage({ ...args, outfit: 'a blue cardigan' });
    assert.equal(explicit.ok, true, JSON.stringify(explicit.error));
    assert.equal(explicit.visual.outfitSource, 'explicit-arg');
    assert.match(JSON.parse(calls[2].body).input, /The companion wears a blue cardigan\./);

    // The coordination metadata never carries the clothes or the key.
    for (const call of calls.filter(call => call.url.startsWith(queue))) {
      assert.equal(call.headers.Authorization, undefined);
      assert.ok(!JSON.stringify(call).includes(KEY));
      assert.ok(!JSON.stringify(call).includes('blue cardigan'));
    }
    assert.equal(JSON.parse(calls[3].body).lock_token, 'lease');
  } finally {
    cleanup();
  }
});

test('companion 生图在衣柜里没有英文描述时明确拒绝，不编造衣服', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: { image: PNG.toString('base64') } } }]);
    // This test is about the *clothing* half of the gate: the identity is present, the
    // wardrobe only has a Chinese name, so there is no English clothing clause to draw.
    writeIdentity(dir, { bot: { name: { zh: '测试角色', en: 'Testa' }, appearance: { zh: '银灰短发', en: 'short silver-grey hair' } } });
    saveWardrobe(dir, { items: [{ id: 'zh-only', name: '蓝色开衫', slot: 'upper' }] });
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: () => new Date('2026-11-07T02:00:00Z') });
    const preview = await service.generateImage({ subject: 'companion', prompt: 'A portrait.', dryRun: true });
    assert.equal(preview.visualRequired, true);
    assert.deepEqual(preview.refusal.details.missing, ['wardrobe']);
    const result = await service.generateImage({ subject: 'companion', prompt: 'A portrait.' });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /无法确定角色着装/);
    assert.equal(calls.length, 0, '没有英文衣物就不发请求');
  } finally {
    cleanup();
  }
});

test('companion 生图自动注入视觉身份，且身份与服装都按当前 persona 取', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: { image: PNG.toString('base64') } } }]);
    saveWardrobe(dir, {
      schemaVersion: 2,
      ownerPersona: 'bot',
      items: [
        { id: 'pajama-top', slot: 'upper', contexts: ['sleep'], name: { zh: '睡衣上衣', en: 'a pale blue pajama top' }, description: { zh: '睡衣上衣', en: 'a pale blue cotton pajama top with white piping' } },
        { id: 'pajama-bottom', slot: 'lower', contexts: ['sleep'], name: { zh: '睡裤', en: 'matching pajama bottoms' }, description: { zh: '睡裤', en: 'loose matching pajama bottoms' } },
      ],
      outfits: [{ id: 'sleepwear', context: 'sleep', pieces: { upper: 'pajama-top', lower: 'pajama-bottom' } }],
    });
    fs.mkdirSync(path.join(dir, 'home/companion'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'home/companion/visual-identity.json'), JSON.stringify({
      schemaVersion: 1,
      personas: {
        bot: {
          name: { zh: '测试角色', en: 'Testa' },
          source: { zh: '测试作品', en: 'Synthetic Testwork' },
          appearance: { zh: '银灰短发', en: 'short silver-grey hair and blue-to-pink gradient eyes' },
        },
        other: {
          name: { zh: '别人格', en: 'Other Persona' },
          source: { zh: '别处', en: 'Elsewhere' },
          appearance: { zh: '黑长发', en: 'long black hair' },
        },
      },
    }, null, 2), 'utf8');

    // 02:00 Asia/Shanghai → the night window, so the injected clothes are the pajamas.
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, now: () => new Date('2026-11-06T18:00:00Z') });
    const preview = await service.generateImage({ subject: 'companion', prompt: 'A girl reads by a lamp.', dryRun: true });
    assert.equal(preview.visual.identity, 'configured');
    assert.equal(preview.visual.name, '测试角色');
    assert.equal(preview.visual.context, 'sleep');
    assert.match(preview.visual.injectedClause, /pajama/);
    assert.deepEqual(preview.visual.missing, []);

    const result = await service.generateImage({ subject: 'companion', prompt: 'A girl reads by a lamp.' });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    const input = JSON.parse(calls[0].body).input;
    assert.match(input, /Testa from Synthetic Testwork/);
    assert.match(input, /short silver-grey hair/);
    assert.match(input, /The companion wears .*pajama top/);
    assert.doesNotMatch(input, /Other Persona|long black hair/, '不能注入别人格的身份');
    assert.doesNotMatch(input, /[\u4e00-\u9fff]/, '画面提示词必须全英文');
  } finally {
    cleanup();
  }
});

test('queue refusal releases its request and sends no paid generation', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir, { queueEnabled: true, queueBaseUrl: 'https://queue.example.test', queueUserId: 'operator' });
    const { fetchImpl, calls } = mockFetch([
      { match: 'https://queue.example.test/join-queue', response: { status: 503, json: {} } },
      { match: 'https://queue.example.test/leave-queue', response: { status: 200, json: {} } },
    ]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'A quiet cafe.' });
    assert.equal(result.ok, false);
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/join-queue', '/leave-queue']);
  } finally {
    cleanup();
  }
});

// 2026-11-06 真实接口回归：同样是这一个体，只有 seed 不同 —— `seed:-1` 得到
// HTTP 500 {"statusCode":500,"message":"Internal Server Error"}，具体整数得到 200+ZIP。
// 这条测试把"绝不把 -1 发出去"锁进请求体，避免再靠真实扣费请求去发现它。
test('NAI：seed:-1 必须落成具体非负整数（发 -1 会被服务端 500）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir, { seed: -1 });
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: { image: PNG.toString('base64') } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const first = await service.generateImage({ prompt: 'subject' });
    const second = await service.generateImage({ prompt: 'subject' });
    assert.equal(first.ok, true, JSON.stringify(first.error ?? {}));
    assert.equal(second.ok, true, JSON.stringify(second.error ?? {}));

    const seedA = JSON.parse(calls[0].body).parameters.seed;
    const seedB = JSON.parse(calls[1].body).parameters.seed;
    for (const seed of [seedA, seedB]) {
      assert.equal(Number.isInteger(seed), true, `seed 必须是整数，实际 ${JSON.stringify(seed)}`);
      assert.notEqual(seed, -1, 'seed:-1 必须由插件解析成随机种子再发送');
      assert.equal(seed >= 0 && seed <= 0xffff_ffff, true, `seed 越界：${seed}`);
    }
    assert.notEqual(seedA, seedB, '两次随机生图不应复用同一个种子');
    assert.equal(first.artifact.seed, seedA, '产物里记录实际使用的 seed，便于复现');
  } finally {
    cleanup();
  }
});

test('NAI：配置里给了具体 seed 就原样发送（可复现）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir, { seed: 3141592653 });
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: { image: PNG.toString('base64') } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'subject' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(JSON.parse(calls[0].body).parameters.seed, 3141592653);
  } finally {
    cleanup();
  }
});

test('NAI：V4+/V5 请求带 params_version=3，且 uc 与 negative_prompt 同文', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir, { model: 'nai-diffusion-5-full', negativePrompt: 'lowres, bad quality' });
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: { image: PNG.toString('base64') } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'subject' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    const { parameters } = JSON.parse(calls[0].body);
    assert.equal(parameters.params_version, 3);
    assert.equal(typeof parameters.uc, 'string');
    assert.equal(parameters.uc, parameters.negative_prompt, 'uc 与 negative_prompt 必须是同一份文本');
    assert.match(parameters.uc, /lowres/);
  } finally {
    cleanup();
  }
});

test('NAI official：SSE 响应（分片 base64）也能拼出图片', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    // base64 分片只有在"前一帧长度为 3 的倍数"时才能安全拼接：这里按真实流式的切片方式构造
    const half = Math.floor(PNG.length / 2 / 3) * 3;
    const sse = [
      `data: ${JSON.stringify({ image: PNG.subarray(0, half).toString('base64') })}`,
      '',
      `data: ${JSON.stringify({ image: PNG.subarray(half).toString('base64'), final: true })}`,
      '',
    ].join('\n');
    const { fetchImpl } = mockFetch([{
      match: () => true,
      response: { status: 200, bytes: Buffer.from(sse, 'utf8'), mime: 'text/event-stream', headers: { 'content-type': 'text/event-stream' } },
    }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'x' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(result.artifact.mime, 'image/png');
  } finally {
    cleanup();
  }
});

test('NAI openai-relay：body 是 {prompt, size, n, parameters}，不发 official 的 input/action', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir, { transport: 'openai-relay', baseUrl: 'https://relay.example.test' });
    const { fetchImpl, calls } = mockFetch([{
      match: 'https://relay.example.test/v1/images/generations',
      response: { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } },
    }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'a relay prompt' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    const body = JSON.parse(calls[0].body);
    assert.equal(body.prompt, 'a relay prompt');
    assert.equal(body.size, '832x1216');
    assert.equal(body.n, 1);
    assert.equal('input' in body, false);
    assert.equal('action' in body, false);
    assert.equal(body.parameters.steps, 28);
    assert.equal(result.meta.transport, 'openai-relay');
  } finally {
    cleanup();
  }
});

test('NAI：V5 预设不会出现在 4.5 请求里（切换模型不串用）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir, {
      model: 'nai-diffusion-4-5-full',
      presets: {
        '5': { applyDefaults: true, positive: 'V5-ONLY-POSITIVE', negative: 'V5-ONLY-NEGATIVE' },
        '4.5': { applyDefaults: false, positive: 'V45-POSITIVE', negative: 'V45-NEGATIVE' },
      },
    });
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: { image: PNG.toString('base64') } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const first = await service.generateImage({ prompt: 'subject' });
    assert.equal(first.ok, true, JSON.stringify(first.error ?? {}));
    const body45 = JSON.parse(calls[0].body);
    assert.equal(JSON.stringify(body45).includes('V5-ONLY'), false, '4.5 请求不得带 V5 预设');

    // 切到 V5：应当只用 V5 族
    configured(dir, {
      model: 'nai-diffusion-5-full',
      presets: {
        '5': { applyDefaults: true, positive: 'V5-ONLY-POSITIVE', negative: 'V5-ONLY-NEGATIVE' },
        '4.5': { applyDefaults: false, positive: 'V45-POSITIVE', negative: 'V45-NEGATIVE' },
      },
    });
    const second = await service.generateImage({ prompt: 'subject' });
    assert.equal(second.ok, true);
    const body5 = JSON.parse(calls[1].body);
    const text5 = JSON.stringify(body5);
    assert.equal(text5.includes('V5-ONLY-POSITIVE'), true);
    assert.equal(text5.includes('V45-'), false, 'V5 请求不得带 4.5 预设');
    assert.equal(body5.parameters.v4_prompt.caption.base_caption.startsWith('V5-ONLY-POSITIVE'), true);
  } finally {
    cleanup();
  }
});

test('NAI：402 无订阅 → ENTITLEMENT，不重试', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 402, json: { message: 'subscription required' } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'x' });
    assert.equal(result.error.code, Code.ENTITLEMENT);
    assert.equal(calls.length, 1);
  } finally {
    cleanup();
  }
});

test('NAI：流中报告错误 → UPSTREAM，且不落盘', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const sse = `data: ${JSON.stringify({ error: 'nsfw content blocked' })}\n\n`;
    const { fetchImpl } = mockFetch([{
      match: () => true,
      response: { status: 200, bytes: Buffer.from(sse, 'utf8'), mime: 'text/event-stream', headers: { 'content-type': 'text/event-stream' } },
    }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, Code.UPSTREAM);
    assert.equal(service.ledger.listArtifacts(5).length, 0);
  } finally {
    cleanup();
  }
});

test('NAI：dryRun 报出预设族与解析后的提示词，不发请求', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: {} } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'subject', dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.preset.family, '4.5');
    assert.equal(result.transport, 'official');
    assert.equal(result.resolution.ok, true);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test('NAI 连接测试只做可达性探测，并明说凭据未验证', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const { fetchImpl } = mockFetch([{ match: () => true, response: { status: 401, json: {} } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.testProvider({ kind: 'image', id: 'nai' });
    assert.equal(result.ok, true, '可达即算通过（401 恰好证明主机在）');
    assert.equal(result.level, 'reachability');
    assert.match(result.note, /不等于端到端/);
  } finally {
    cleanup();
  }
});
