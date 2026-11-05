import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaService } from '../src/service.mjs';
import { tempDataDir, mockFetch, makePng, makeZip, writeConfig } from './helpers.mjs';
import { Code } from '../src/errors.mjs';

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
