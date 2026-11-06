import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMediaService } from '../src/service.mjs';
import { tempDataDir, mockFetch } from './helpers.mjs';
import { Code } from '../src/errors.mjs';

function fakeHost() {
  const tools = [];
  const ctx = {
    tools: { register: tool => tools.push(tool) },
    get: () => ({ fetch: { register: () => {} } }),
    provide: () => {},
    effect: runner => runner(),
  };
  return { ctx, tools };
}

test('插件挂载：注册的工具只有 4 个，且没有识图 / 没有模型预热工具', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const plugin = await import('../index.mjs');
    const { ctx, tools } = fakeHost();
    const service = await plugin.mountMedia(ctx, { dataDir: dir, fetchImpl: mockFetch([{ match: () => true, response: { status: 200, json: {} } }]).fetchImpl });
    assert.ok(service && !service.error, `挂载不应失败：${JSON.stringify(service)}`);
    const names = tools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['companion_media_draw', 'companion_media_job', 'companion_media_speak', 'companion_media_status']);
    // 任何"识图 / 预热 / 释放"入口都不存在
    assert.equal(names.some(name => /inspect|vision|warm|release/i.test(name)), false);
    for (const tool of tools) {
      assert.equal(tool.parameters.type, 'object', `${tool.name} 必须是 JSON Schema object`);
    }
  } finally {
    cleanup();
  }
});

test('零配置：生图 / 语音都返回 DISABLED，且一次网络都不发', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: {} } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const image = await service.generateImage({ prompt: 'a cat' });
    assert.equal(image.ok, false);
    assert.equal(image.error.code, Code.DISABLED);
    const speech = await service.synthesize({ text: 'hello' });
    assert.equal(speech.ok, false);
    assert.equal(speech.error.code, Code.DISABLED);
    assert.equal(calls.length, 0, '默认关闭时不得发起任何请求');

    const status = service.status();
    assert.equal(status.states.image.enabled, false);
    assert.equal(status.states.tts.enabled, false);
    assert.equal(status.states.vision.enabled, false);
    assert.equal(status.states.vision.status, 'reserved-disabled');
    assert.equal(status.persona.id, 'bot', '不得硬编码作者的人格 id');
    assert.equal(status.persona.source, 'default');
  } finally {
    cleanup();
  }
});

test('personaId 可从环境变量 / 套件配置解析', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const service = createMediaService({ dataDir: dir, env: { DSH_COMPANION_PERSONA_ID: 'custom-bot' } });
    assert.equal(service.status().persona.id, 'custom-bot');
    assert.equal(service.status().persona.source, 'env');
  } finally {
    cleanup();
  }
});

test('识图：合同可见，但任何入口都拒绝，且不接受 enabled=true', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const service = createMediaService({ dataDir: dir, env: {} });
    const refusal = service.inspectImage();
    assert.equal(refusal.ok, false);
    assert.equal(refusal.error.code, Code.DISABLED);
    assert.equal(refusal.contract.status, 'reserved-disabled');
    assert.equal(refusal.contract.locked, true);
    assert.equal(service.vision({}).enabled, false);
  } finally {
    cleanup();
  }
});

test('mount 失败也不会抛：坏掉的数据目录降级为 {error}', async () => {
  const plugin = await import('../index.mjs');
  const { ctx } = fakeHost();
  const result = await plugin.mountMedia(ctx, { dataDir: '\u0000invalid\u0000' });
  assert.ok(result && typeof result === 'object');
  // 要么挂载成功（服务对象），要么返回 {error}；两种情况都不得抛出
  assert.ok('error' in result === false || typeof result.error === 'string');
});

test('作业账本只落数据目录，不进源码树', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const service = createMediaService({ dataDir: dir, env: {} });
    const jobs = service.jobs(5);
    assert.deepEqual(jobs.jobs, []);
    assert.equal(service.ledger.file.startsWith(dir), true);
    assert.equal(fs.existsSync(service.store.file), false);
  } finally {
    cleanup();
  }
});
