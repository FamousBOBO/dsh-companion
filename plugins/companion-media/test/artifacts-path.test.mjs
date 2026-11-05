import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMediaService } from '../src/service.mjs';
import { defaultArtifactRoot, resolveArtifactRoot } from '../src/ledger.mjs';
import { tempDataDir, mockFetch, makePng, makeWav, writeConfig } from './helpers.mjs';

const PNG = makePng();

const LIMITS = {
  requestBudgetMs: 3000,
  connectTimeoutMs: 1000,
  maxResponseBytes: 1 << 20,
  maxImageBytes: 1 << 20,
  maxAudioBytes: 1 << 20,
  maxRedirects: 2,
  maxImagesPerRequest: 1,
  maxTextChars: 500,
};

function imageConfig(dir, extra = {}) {
  writeConfig(dir, {
    schemaVersion: 2,
    image: {
      enabled: true,
      provider: 'openai',
      openai: { baseUrl: 'https://api.example.test/v1', apiKey: 'placeholder-key', model: 'm', timeoutMs: 2000 },
    },
    limits: LIMITS,
    ...extra,
  });
}

test('产物默认落在工作区：<dataDir>/workspace/media（通道能读的边界内）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    imageConfig(dir);
    const { fetchImpl } = mockFetch([{ match: () => true, response: { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'workspace boundary probe' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    const workspace = path.join(dir, 'workspace');
    assert.equal(result.artifact.absolutePath.startsWith(path.join(workspace, 'media') + path.sep), true,
      `产物必须落在 <dataDir>/workspace/media 下，实际：${result.artifact.absolutePath}`);
    assert.equal(result.handoff.file, result.artifact.absolutePath);
    assert.equal(result.handoff.delivered, false);
    // 状态里必须显式说明通道边界，UI/文档据此提示用户
    const status = service.status();
    assert.equal(status.paths.artifactRoot, defaultArtifactRoot(dir));
    assert.equal(status.paths.artifactRootSource, 'default');
    assert.ok(status.paths.channelBoundary.includes(workspace));
    assert.match(status.paths.channelBoundaryNote, /outside-boundary|越界/);
  } finally {
    cleanup();
  }
});

test('语音产物同样落在工作区', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    writeConfig(dir, {
      schemaVersion: 2,
      tts: {
        enabled: true,
        provider: 'breeze-tts-2',
        providers: { 'breeze-tts-2': { enabled: true, baseUrl: 'http://127.0.0.1:7860', timeoutMs: 2000 } },
      },
      limits: LIMITS,
    });
    const wav = makeWav();
    const { fetchImpl } = mockFetch([{ match: () => true, response: { status: 200, bytes: wav, mime: 'audio/wav', headers: { 'content-type': 'audio/wav' } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.synthesize({ text: '边界测试' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(result.artifact.absolutePath.startsWith(path.join(dir, 'workspace', 'media', 'speech')), true);
  } finally {
    cleanup();
  }
});

test('可以配置改产物目录（绝对路径 / 相对 dataDir 两种写法）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const absolute = path.join(dir, 'elsewhere');
    imageConfig(dir, { paths: { artifactsDir: absolute } });
    const { fetchImpl } = mockFetch([{ match: () => true, response: { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'custom dir' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(result.artifact.absolutePath.startsWith(absolute), true);
    assert.equal(service.status().paths.artifactRootSource, 'config');

    // 相对路径按 dataDir 解析
    imageConfig(dir, { paths: { artifactsDir: 'custom/pics' } });
    const relative = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const second = await relative.generateImage({ prompt: 'relative dir' });
    assert.equal(second.ok, true, JSON.stringify(second.error ?? {}));
    assert.equal(second.artifact.absolutePath.startsWith(path.join(dir, 'custom', 'pics')), true);
  } finally {
    cleanup();
  }
});

test('resolveArtifactRoot：空配置走默认，非字符串被校验拒绝', () => {
  assert.deepEqual(resolveArtifactRoot('/data', {}), { root: path.join('/data', 'workspace', 'media'), source: 'default' });
  assert.deepEqual(resolveArtifactRoot('/data', { paths: { artifactsDir: '   ' } }), { root: path.join('/data', 'workspace', 'media'), source: 'default' });
  const absoluteRoot = path.join(path.parse(process.cwd()).root, 'srv', 'media');
  assert.equal(resolveArtifactRoot('/data', { paths: { artifactsDir: absoluteRoot } }).root, absoluteRoot);
  assert.equal(resolveArtifactRoot('/data', { paths: { artifactsDir: 'rel/media' } }).root, path.resolve('/data', 'rel/media'));

  const { dir, cleanup } = tempDataDir();
  try {
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl: mockFetch([{ match: () => true, response: { status: 200, json: {} } }]).fetchImpl });
    const saved = service.saveConfig({ paths: { artifactsDir: 42 } });
    assert.equal(saved.ok, false);
    assert.ok(saved.errors.some(item => item.path === 'paths.artifactsDir'));
  } finally {
    cleanup();
  }
});

test('产物目录被清空后重新生成仍然可用（目录自动创建）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    imageConfig(dir, { paths: { artifactsDir: 'custom/artifacts' } });
    const { fetchImpl } = mockFetch([{ match: () => true, response: { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const first = await service.generateImage({ prompt: 'first' });
    assert.equal(first.ok, true);
    fs.rmSync(path.join(dir, 'custom'), { recursive: true, force: true });
    const second = await service.generateImage({ prompt: 'second' });
    assert.equal(second.ok, true, JSON.stringify(second.error ?? {}));
    assert.ok(fs.existsSync(second.artifact.absolutePath));
  } finally {
    cleanup();
  }
});

test('账本与日志仍留在 <dataDir>/media（不进工作区，不进仓库）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    imageConfig(dir);
    const { fetchImpl } = mockFetch([{ match: () => true, response: { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    await service.generateImage({ prompt: 'ledger probe' });
    assert.equal(service.ledger.file.startsWith(path.join(dir, 'media')), true);
    assert.equal(fs.existsSync(path.join(dir, 'workspace', 'media', 'image')), true);
  } finally {
    cleanup();
  }
});
