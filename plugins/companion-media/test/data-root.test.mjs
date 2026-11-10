/**
 * P0-C regression: the media layer must use the suite's authoritative data root.
 *
 * The bug (`docs/15-wardrobe-host-acceptance.md` §9): `companion-media/src/persona.mjs` had its
 * own `resolveDataDir()` that answered `option → DSH_COMPANION_DATA_DIR → <suiteRoot>/data` and
 * **never read `config/suite.json`**. With `"dataDir": "data-dev"` the foundation stored the
 * wardrobe and identity under `data-dev/home/companion/`, while the media layer mounted at
 * `<suiteRoot>/data/media`. The operator enabled image generation in
 * `data-dev/media/config.json`, and the host answered `MEDIA_DISABLED` forever, because it was
 * reading a file that did not exist. The stale `data/media/config.json` would silently win.
 *
 * The fix is not a second implementation with better rules: `resolveDataDir()` now delegates to
 * `companion-foundation/suite-paths.mjs#resolveDataRoot()`, so there is exactly one authority.
 * These tests pin the resolution order, the cross-module agreement, and the fact that a config
 * written under the *default* root cannot override one under the configured root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '../src/persona.mjs';
import { resolveDataRoot, resolveSuitePaths } from '../../companion-foundation/suite-paths.mjs';
import { createMediaService } from '../src/service.mjs';
import { mockFetch, writeConfig } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../../..');

/** A throwaway suite checkout: `package.json` with the suite name, plus optional config. */
function tempSuite(t, { suiteConfig = null, packageDataDir = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-data-root-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'dsh-companion-suite',
    version: '0.0.0-test',
    ...(packageDataDir ? { dsh: { suite: { dataDir: packageDataDir } } } : {}),
  }, null, 2), 'utf8');
  if (suiteConfig) {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'suite.json'), JSON.stringify(suiteConfig, null, 2), 'utf8');
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('P0-C：config/suite.json 的 dataDir 被采纳（原缺陷：被忽略，永远落到 <suiteRoot>/data）', (t) => {
  const suite = tempSuite(t, { suiteConfig: { dataDir: 'data-dev' } });
  try {
    const resolved = resolveDataDir({ env: {}, suiteRoot: suite.root });
    assert.equal(resolved.dir, path.resolve(suite.root, 'data-dev'), '必须使用 suite 配置的数据根');
    assert.equal(resolved.source, 'config/suite.json:dataDir');
  } finally {
    suite.cleanup();
  }
});

test('P0-C：dataDir 用绝对路径也照原样采纳', (t) => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-data-abs-'));
  const suite = tempSuite(t, { suiteConfig: { dataDir: elsewhere } });
  try {
    // `resolveFrom()` must keep an absolute `dataDir` as-is instead of nesting it under suiteRoot.
    assert.equal(resolveDataDir({ env: {}, suiteRoot: suite.root }).dir, path.resolve(elsewhere));
  } finally {
    suite.cleanup();
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('P0-C：未配置 dataDir 时仍然是默认的 <suiteRoot>/data（向后兼容）', (t) => {
  const suite = tempSuite(t, {});
  try {
    const resolved = resolveDataDir({ env: {}, suiteRoot: suite.root });
    assert.equal(resolved.dir, path.resolve(suite.root, 'data'));
    assert.equal(resolved.source, 'suite-root:data');
  } finally {
    suite.cleanup();
  }
});

test('P0-C：优先级 option > DSH_COMPANION_DATA_DIR > config/suite.json > package.json > 默认', (t) => {
  const suite = tempSuite(t, { suiteConfig: { dataDir: 'data-dev' }, packageDataDir: 'data-packaged' });
  const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-data-opt-'));
  try {
    assert.equal(resolveDataDir({ dataDir: explicit, env: {}, suiteRoot: suite.root }).dir, path.resolve(explicit));
    const fromEnv = resolveDataDir({ env: { DSH_COMPANION_DATA_DIR: 'data-env' }, suiteRoot: suite.root });
    assert.equal(fromEnv.dir, path.resolve(suite.root, 'data-env'), '相对路径按 suiteRoot 解析');
    assert.equal(fromEnv.source, 'env');

    fs.rmSync(path.join(suite.root, 'config', 'suite.json'));
    const packaged = resolveDataDir({ env: {}, suiteRoot: suite.root });
    assert.equal(packaged.dir, path.resolve(suite.root, 'data-packaged'), 'suite.json 缺席时用 package.json');
    assert.equal(packaged.source, 'package.json:dsh.suite.dataDir');
  } finally {
    suite.cleanup();
    fs.rmSync(explicit, { recursive: true, force: true });
  }
});

test('P0-C：媒体层与 foundation 解析出同一个数据根（同一权威，不是两套实现）', (t) => {
  const suite = tempSuite(t, { suiteConfig: { dataDir: 'data-dev' } });
  try {
    const media = resolveDataDir({ env: {}, suiteRoot: suite.root });
    const foundation = resolveDataRoot({ env: {}, suiteRoot: suite.root });
    assert.equal(media.dir, foundation.dataRoot, '媒体层与 foundation 必须指向同一个目录');
    assert.equal(media.source, foundation.source === 'env:DSH_COMPANION_DATA_DIR' ? 'env' : foundation.source);
    assert.equal(path.basename(media.dir), 'data-dev');
  } finally {
    suite.cleanup();
  }
});

test('P0-C：本仓库自身的解析也一致（dataDir=data-dev 时两边都指向 data-dev）', () => {
  // The checkout this branch lives in is the operator's own: it has `config/suite.json` with
  // `dataDir: "data-dev"`. If it does not, the assertions below hold for whatever it does say.
  const media = resolveDataDir({ env: {}, suiteRoot: repositoryRoot });
  const foundation = resolveSuitePaths({ env: { DSH_COMPANION_DATA_DIR: '' } });
  // `resolveSuitePaths()` walks up from the foundation module, so it discovers the same root.
  assert.equal(media.dir, foundation.dataRoot, `media=${media.dir} foundation=${foundation.dataRoot}`);
  assert.ok(path.isAbsolute(media.dir));
  assert.ok(!media.dir.endsWith(`${path.sep}data` + path.sep), '不得解析成带尾斜杠的路径');
});

test('P0-C：data-config 不会互相覆盖——<dataDir>/media/config.json 生效，data/media/config.json 不被读取', async (t) => {
  const suite = tempSuite(t, { suiteConfig: { dataDir: 'data-dev' } });
  try {
    // The configured root: image generation is ON.
    const service = createMediaService({
      dataDir: resolveDataDir({ env: {}, suiteRoot: suite.root }).dir,
      env: {},
      fetchImpl: mockFetch([]).fetchImpl,
      suiteRoot: suite.root,
    });
    writeConfig(path.join(suite.root, 'data-dev'), {
      schemaVersion: 2,
      enabled: true,
      image: { enabled: true, provider: 'nai', nai: { transport: 'openai-relay', baseUrl: 'https://image.example.test', apiKey: 'k'.repeat(24), model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', seed: -1, timeoutMs: 5000 } },
      limits: { requestBudgetMs: 5000, connectTimeoutMs: 2000, maxResponseBytes: 1 << 20, maxImageBytes: 1 << 20, maxAudioBytes: 1 << 20, maxRedirects: 2, maxImagesPerRequest: 1, maxTextChars: 500 },
    });
    // The default root: a stale config that says everything is OFF.
    fs.mkdirSync(path.join(suite.root, 'data'), { recursive: true });
    writeConfig(path.join(suite.root, 'data'), { schemaVersion: 2, enabled: false, image: { enabled: false, provider: 'none' } });

    const status = service.status();
    assert.equal(status.config.enabled, true, '必须读到 <dataDir>/media/config.json，而不是 <suiteRoot>/data/media/config.json');
    assert.equal(status.config.image.enabled, true);

    // And the reverse direction: reading the default root would have said DISABLED.
    const stale = createMediaService({ dataDir: path.join(suite.root, 'data'), env: {}, fetchImpl: mockFetch([]).fetchImpl });
    assert.equal(stale.status().config.enabled, false, '对照组：默认根下的旧配置确实是关闭的');
  } finally {
    suite.cleanup();
  }
});

test('P0-C：媒体层不再有自己的一套默认值——未配置媒体时保持默认行为（全关）', (t) => {
  const suite = tempSuite(t, { suiteConfig: { dataDir: 'data-dev' } });
  try {
    const dir = resolveDataDir({ env: {}, suiteRoot: suite.root }).dir;
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl: mockFetch([]).fetchImpl, suiteRoot: suite.root });
    const status = service.status();
    assert.equal(status.config.image.enabled, false, '没有配置文件时生图默认关闭');
    assert.equal(status.config.image.provider, 'none');
    assert.equal(status.config.tts.enabled, false);
  } finally {
    suite.cleanup();
  }
});
