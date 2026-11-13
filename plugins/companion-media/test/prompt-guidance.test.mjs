import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountMedia } from '../index.mjs';
import { createMediaService } from '../src/service.mjs';
import { tempDataDir, mockFetch, makePng, writeConfig } from './helpers.mjs';

/**
 * 回归：提示词写法由 `docs/image-prompt-guide.md` 唯一承载。
 *
 * 约定（2026-11-13 起）：
 *   - 工具说明**不**复述解剖词表，只指向指南；
 *   - `companion_media_visual` 返回 `promptGuide`，指向磁盘上真实存在的指南文件；
 *   - 指南是英文的，并且确实含第 4 节的身体部位词表；
 *   - 服务端不改写、不过滤 prompt。
 *
 * 这样做的原因：词表放在两处必然漂移，而工具说明每次请求都要占用上下文。
 * 指南是唯一权威，测试只锁"指针有效"与"指南内容在"。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const SUITE_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const GUIDE = path.join(SUITE_ROOT, 'docs', 'image-prompt-guide.md');

/** 指南第 4 节必须覆盖的解剖名词。 */
const REQUIRED_TERMS = ['nipples', 'areola', 'breasts', 'pussy', 'labia', 'clitoris', 'vaginal opening', 'anus', 'pubic hair', 'inner thighs', 'glans', 'testicles'];

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

test('提示词写法指南存在、是英文、且含第 4 节身体部位词表', () => {
  assert.ok(fs.existsSync(GUIDE), `指南必须存在：${GUIDE}`);
  const text = fs.readFileSync(GUIDE, 'utf8');
  assert.equal(/[\u4e00-\u9fff]/.test(text), false, '指南必须是英文（示例 prompt 也是英文）');
  for (const term of REQUIRED_TERMS) {
    assert.ok(text.includes(term), `指南第 4 节必须覆盖 ${term}`);
  }
  // 裸露、位置、反向三节都在，才能撑起"照指南写"这句话
  assert.match(text, /completely nude/, '第 5 节必须给裸露写法');
  assert.match(text, /nothing cropped out of the picture/, '第 6 节必须给构图约束');
  assert.match(text, /rating:general/, '第 8 节必须列反向压制词');
  // 明确声明这是写 prompt 前必读
  assert.match(text, /before writing an image prompt/i, '指南开头必须声明使用时机');
});

test('companion_media_visual 返回真实存在的 promptGuide 路径，instruction 指向它', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const service = createMediaService({ dataDir: dir, env: {}, suiteRoot: SUITE_ROOT });
    const { promptGuide, instruction } = service.readVisual();
    assert.equal(promptGuide, GUIDE, 'promptGuide 必须是指南的绝对路径');
    assert.ok(fs.existsSync(promptGuide), 'promptGuide 指向的文件必须可读');
    assert.ok(instruction.includes(promptGuide), 'instruction 必须把绝对路径写出来，模型才能直接读');
  } finally {
    cleanup();
  }
});

test('指南缺失时 promptGuide 报 missing，instruction 退回内联规则而不是给出坏路径', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    // suiteRoot 指向一个没有 docs/ 的空目录
    const service = createMediaService({ dataDir: dir, env: {}, suiteRoot: dir });
    const { promptGuide, instruction } = service.readVisual();
    assert.equal(promptGuide, 'missing');
    assert.equal(instruction.includes(path.join('docs', 'image-prompt-guide.md')), true);
    assert.match(instruction, /nipples/, '退回分支仍要给出可直接用的解剖词');
  } finally {
    cleanup();
  }
});

test('工具说明指向指南，不再复述词表（避免两处漂移）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { ctx, tools } = fakeHost();
    const service = await mountMedia(ctx, { dataDir: dir, fetchImpl: mockFetch([{ match: () => true, response: { status: 200, json: {} } }]).fetchImpl });
    assert.ok(service && !service.error, `挂载不应失败：${JSON.stringify(service)}`);

    const draw = tools.find(tool => tool.name === 'companion_media_draw');
    const visual = tools.find(tool => tool.name === 'companion_media_visual');
    assert.ok(draw && visual, '两个工具都必须注册');

    const drawText = `${draw.description}\n${draw.parameters.properties.prompt.description}`;
    assert.ok(drawText.includes('docs/image-prompt-guide.md'), 'draw 说明必须点名指南');
    assert.ok(drawText.includes('第 4 节') || drawText.includes('section 4'), 'draw 说明必须指向词表所在章节');
    assert.ok(visual.description.includes('docs/image-prompt-guide.md'), 'visual 说明必须点名指南');

    // 词表只在指南里：工具说明不再自带一整份解剖词清单
    for (const term of ['areola', 'labia', 'pubic hair']) {
      assert.equal(drawText.includes(term), false, `工具说明不应再复述 ${term}，词表归指南`);
    }
  } finally {
    cleanup();
  }
});

test('dryRun 报出 promptGuide，且服务端不改写直白 prompt', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    writeConfig(dir, {
      schemaVersion: 2,
      enabled: true,
      image: {
        enabled: true,
        provider: 'nai',
        nai: {
          transport: 'official',
          baseUrl: 'https://image.novelai.net',
          apiKey: 'pst-nai-0123456789abcdef',
          model: 'nai-diffusion-4-5-full',
          width: 832, height: 1216, steps: 28, scale: 5,
          sampler: 'k_euler_ancestral', noiseSchedule: 'karras', seed: -1, timeoutMs: 5000,
        },
      },
      limits: { requestBudgetMs: 5000, connectTimeoutMs: 2000, maxResponseBytes: 1 << 20, maxImageBytes: 1 << 20, maxAudioBytes: 1 << 20, maxRedirects: 2, maxImagesPerRequest: 1, maxTextChars: 800 },
    });

    const png = makePng({ width: 832, height: 1216 });
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: { image: png.toString('base64') } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl, suiteRoot: SUITE_ROOT });

    const prompt = 'She lies on her back, completely nude, bare breasts with hard pink nipples and full areola in full view; her fingers spread her wet pink pussy lips wide open toward the camera, labia pulled apart, clitoris exposed, pussy centered in frame, nothing cropped out of the picture.';

    const dry = await service.generateImage({ prompt, dryRun: true });
    assert.equal(dry.ok, true, JSON.stringify(dry));
    assert.equal(dry.promptGuide, GUIDE, 'dryRun 必须报出指南路径，便于调用方先读再写');

    const result = await service.generateImage({ prompt });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    const sent = JSON.parse(calls[0].body).input;
    assert.ok(sent.includes(prompt), 'prompt 必须原样提交，服务端不追加也不过改写');
  } finally {
    cleanup();
  }
});
