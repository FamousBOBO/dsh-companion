import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createConfigStore, keyEnvName, writeFileAtomic } from '../src/config-store.mjs';
import { tempDataDir, writeConfig } from './helpers.mjs';
import { Code } from '../src/errors.mjs';

const OPENAI_KEY = 'sk-test-0123456789abcdefghij';

test('原子保存：写入同目录临时文件后 rename，不残留 tmp', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const target = path.join(dir, 'media', 'config.json');
    writeFileAtomic(target, '{"a":1}\n');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}\n');
    const leftovers = fs.readdirSync(path.dirname(target)).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    // 600：配置文件里有密钥，不能让同机其他用户读到（Windows 不兑现 POSIX 位，故只在 POSIX 断言）
    if (process.platform !== 'win32') {
      const mode = fs.statSync(target).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    cleanup();
  }
});

test('保存 → 读取：GET 视图是掩码，明文只从 secret() 取', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const store = createConfigStore({ dataDir: dir, env: {} });
    const saved = store.save({
      image: { enabled: true, provider: 'openai', openai: { baseUrl: 'https://api.example.test/v1', apiKey: OPENAI_KEY, model: 'gpt-image-test' } },
    });
    assert.equal(saved.ok, true, JSON.stringify(saved.errors ?? []));
    const read = store.read();
    assert.equal(read.exists, true);
    const text = JSON.stringify(read.masked);
    assert.equal(text.includes(OPENAI_KEY), false, 'GET 视图不得含明文');
    assert.equal(read.masked.image.openai.apiKey.configured, true);
    assert.equal(store.secret('openai').value, OPENAI_KEY);
    assert.equal(store.secret('openai').source, 'config');
  } finally {
    cleanup();
  }
});

test('掩码回传不清空已保存的密钥', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const store = createConfigStore({ dataDir: dir, env: {} });
    store.save({ image: { openai: { baseUrl: 'https://api.example.test/v1', apiKey: OPENAI_KEY, model: 'm', enabled: true }, enabled: true, provider: 'openai' } });
    // 前端把 GET 拿到的掩码对象原样 POST 回来
    const readBack = store.read().masked;
    const saved = store.save({ image: { openai: { apiKey: readBack.image.openai.apiKey } } });
    assert.equal(saved.ok, true);
    assert.equal(store.secret('openai').value, OPENAI_KEY);
    // 空字符串同样表示"不修改"
    store.save({ image: { openai: { apiKey: '' } } });
    assert.equal(store.secret('openai').value, OPENAI_KEY);
  } finally {
    cleanup();
  }
});

test('环境变量兜底：配置文件没写 key 时从 DSH_MEDIA_<SCOPE>_API_KEY 取', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const env = { [keyEnvName('nai')]: 'placeholder-value-not-a-real-key' };
    const store = createConfigStore({ dataDir: dir, env });
    const secret = store.secret('nai');
    assert.equal(secret.value, 'placeholder-value-not-a-real-key');
    assert.equal(secret.source, 'env');
    // 掩码视图应提示"将尝试读取该环境变量"
    assert.equal(store.read().masked.image.nai.apiKey.envVar, 'DSH_MEDIA_NAI_API_KEY');
  } finally {
    cleanup();
  }
});

test('校验失败不写盘，返回逐字段错误', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const store = createConfigStore({ dataDir: dir, env: {} });
    const before = store.exists();
    const result = store.save({ image: { enabled: true, provider: 'openai' } });
    assert.equal(result.ok, false);
    assert.equal(result.saved, false);
    assert.ok(result.errors.length > 0);
    assert.equal(store.exists(), before, '校验失败时不得创建配置文件');
  } finally {
    cleanup();
  }
});

test('保存会留下 .bak 备份（迁移前可回滚）', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const store = createConfigStore({ dataDir: dir, env: {} });
    store.save({ limits: { maxImagesPerRequest: 1 } });
    store.save({ limits: { maxImagesPerRequest: 2 } });
    assert.ok(fs.existsSync(`${store.file}.bak`));
  } finally {
    cleanup();
  }
});

test('配置文件损坏时降级为默认值 + 诊断，而不是抛错', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const file = path.join(dir, 'media', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json', 'utf8');
    const store = createConfigStore({ dataDir: dir, env: {} });
    const loaded = store.load();
    assert.equal(loaded.validation.ok, false);
    assert.ok(loaded.error);
    assert.equal(loaded.config.image.enabled, false);
  } finally {
    cleanup();
  }
});

test('旧 schemaVersion 的文件在读取时自动迁移，且不读旧密钥', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    writeConfig(dir, {
      schemaVersion: 1,
      image: { enabled: true, backend: 'novelai-pipeline-bridge', apiKey: 'legacy-key-should-not-survive', model: 'nai-diffusion-4-5-full', steps: 28 },
      speech: { enabled: false, backend: { baseUrl: 'http://127.0.0.1:8139/breeze' } },
    });
    const store = createConfigStore({ dataDir: dir, env: {} });
    const loaded = store.load();
    assert.equal(loaded.migrated, true);
    assert.equal(loaded.config.image.provider, 'nai');
    assert.equal(store.secret('nai').value, '', '旧 apiKey 字段不被读取');
    assert.ok(loaded.dropped.some(item => item.includes('novelai-pipeline-bridge')));
  } finally {
    cleanup();
  }
});

test('reset 可清空密钥（默认）或保留（keepSecrets）', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const store = createConfigStore({ dataDir: dir, env: {} });
    store.save({ image: { openai: { apiKey: OPENAI_KEY, baseUrl: 'https://api.example.test/v1', model: 'm' } } });
    store.reset({ keepSecrets: true });
    assert.equal(store.secret('openai').value, OPENAI_KEY);
    store.reset();
    assert.equal(store.secret('openai').value, '');
  } finally {
    cleanup();
  }
});

test('vision 无法通过保存被打开', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const store = createConfigStore({ dataDir: dir, env: {} });
    const result = store.save({ vision: { enabled: true, model: 'x' } });
    assert.equal(result.ok, true, '保存本身成功，但 enabled 被强制拉回 false');
    assert.equal(store.load().config.vision.enabled, false);
    // 直接改文件也没用：normalize 会拉回 false
    const file = path.join(dir, 'media', 'config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.vision.enabled = true;
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
    assert.equal(store.load().config.vision.enabled, false);
  } finally {
    cleanup();
  }
});
