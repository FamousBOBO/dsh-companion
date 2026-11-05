import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 媒体能力设置页的**逻辑**测试。
 *
 * 页面是浏览器片段（纯脚本 + P 原语），所以这里在 Node 里用一个最小 P 把片段执行一遍，
 * 只测它导出的纯函数：视图模型（descriptor + config 合并）、保存 patch 的构造、
 * 密钥只写语义、provider 切换保留、错误路径映射。DOM 交互由 scripts/smoke-client.mjs
 * 覆盖，两处不重复。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '..');
const source = fs.readFileSync(path.join(moduleRoot, 'src/client/pages-media.js'), 'utf8');

function loadPageModule() {
  const P = {
    css() {},
    registerPage() {},
    h(type, props, ...children) { return { type, props: { ...(props || {}), children } }; },
    useApi() { return { data: null, error: null, loading: true }; },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useEffect() {},
    useMemo(factory) { return factory(); },
    ui: {},
    failText: error => String((error && error.message) || error || ''),
    confirm: () => true,
    notice: () => {},
  };
  // 片段是 IIFE：`(function (P) { ... })(P)`，用 P 当参数执行即可拿到 P.mediaPage。
  // eslint-disable-next-line no-new-func
  new Function('P', source)(P);
  return P.mediaPage;
}

const page = loadPageModule();

// ---------------------------------------------------------------------------
// 受控 descriptor/config（形状取自 companion-media 的 /page + /config）
// ---------------------------------------------------------------------------

const STATES = [
  { id: 'disabled', label: '功能关闭' },
  { id: 'unconfigured', label: '未配置' },
  { id: 'not-connected', label: '尚未接入' },
  { id: 'saved-untested', label: '已保存、未测试' },
  { id: 'test-ok', label: '测试通过' },
  { id: 'test-failed', label: '测试失败' },
];

const API = {
  config: 'GET /api/companion-media/config',
  save: 'POST /api/companion-media/config',
  test: 'POST /api/companion-media/test',
  preview: 'GET /api/companion-media/preview',
};

function field(pathParts, label, { type = 'text', value = null, writable = true, hint = '' } = {}) {
  return { path: pathParts.join('.'), pathParts, label, type, value, writable, ...(hint ? { hint } : {}) };
}

function descriptorFixture() {
  const secret = configured => ({ configured, mask: configured ? 'sk…abcd' : '', source: 'config' });
  return {
    id: 'companion-media',
    title: '媒体能力',
    states: STATES,
    api: API,
    meta: { testPolicy: 'explicit-only' },
    sections: [
      {
        id: 'vision',
        title: '识图',
        status: 'reserved-disabled',
        locked: true,
        note: '预留，当前关闭。',
        toggle: { path: 'vision.enabled', label: '启用识图', disabled: true, value: false, why: '本期只保留合同' },
        fields: [
          field(['vision', 'baseUrl'], 'Base URL', { type: 'url', value: '' }),
          field(['vision', 'apiKey'], 'API Key', { type: 'secret', value: secret(false) }),
        ],
      },
      {
        id: 'image',
        title: '生图',
        status: 'on',
        note: '计费能力：默认关闭。',
        toggle: { path: 'image.enabled', label: '启用生图', value: true },
        selector: {
          path: 'image.provider',
          label: '协议',
          value: 'openai-compatible',
          options: [{ value: 'none', label: '未选择' }, { value: 'openai-compatible', label: 'OpenAI-compatible 生图' }, { value: 'nai', label: 'NovelAI' }],
        },
        preview: { label: '自动分辨率预览', values: { mode: 'auto', aspect: 'portrait', targetPixels: 1011712 } },
        presets: {
          path: 'image.nai.presets',
          note: 'V5 与 4.5 分开存储。',
          families: [
            { family: '5', label: 'V5', field: field(['image', 'nai', 'presets', '5', 'positive'], 'V5 正向预设', { type: 'textarea', value: '' }) },
            { family: '4.5', label: '4.5', field: field(['image', 'nai', 'presets', '4.5', 'positive'], '4.5 正向预设', { type: 'textarea', value: 'OLD-45' }) },
          ],
          artistString: field(['image', 'nai', 'artistString'], '画师串', { type: 'textarea', value: 'old-artist' }),
        },
        providers: [
          {
            id: 'openai-compatible',
            label: 'OpenAI-compatible 生图',
            status: 'connected',
            state: 'saved-untested',
            stateNote: '配置已保存但从未测试',
            canTest: true,
            canEnable: true,
            key: { configured: true, source: 'config' },
            endpoint: 'POST {baseUrl}/images/generations',
            fields: [
              field(['image', 'openai-compatible', 'enabled'], 'OpenAI-compatible 生图：启用', { type: 'boolean', value: null }),
              field(['image', 'openai-compatible', 'baseUrl'], 'Base URL', { type: 'url', value: 'https://api.example.test/v1' }),
              field(['image', 'openai-compatible', 'apiKey'], 'API Key', { type: 'secret', value: secret(true) }),
              field(['image', 'openai-compatible', 'model'], '模型', { value: 'gpt-image-2' }),
            ],
          },
          {
            id: 'nai',
            label: 'NovelAI',
            status: 'connected',
            state: 'unconfigured',
            canTest: true,
            canEnable: true,
            key: { configured: false, source: 'none' },
            fields: [
              field(['image', 'nai', 'enabled'], 'NovelAI：启用', { type: 'boolean', value: null }),
              field(['image', 'nai', 'baseUrl'], 'Base URL', { type: 'url', value: '' }),
              field(['image', 'nai', 'steps'], '步数（默认 28）', { type: 'number', value: 28 }),
              field(['image', 'nai', 'apiKey'], 'Access Token', { type: 'secret', value: secret(false) }),
            ],
          },
        ],
      },
      {
        id: 'tts',
        title: '语音合成',
        status: 'on',
        note: '只产出音频文件。',
        toggle: { path: 'tts.enabled', label: '启用语音合成', value: true },
        selector: {
          path: 'tts.provider',
          label: '默认后端',
          value: 'breeze-tts2',
          options: [{ value: 'none', label: '未选择' }, { value: 'breeze-tts2', label: 'Breeze TTS 2' }, { value: 'index-tts', label: 'Index-TTS' }],
        },
        providers: [
          {
            id: 'breeze-tts2',
            label: 'Breeze TTS 2',
            status: 'connected',
            state: 'saved-untested',
            canTest: true,
            canEnable: true,
            key: { configured: false, source: 'config' },
            fields: [
              field(['tts', 'providers', 'breeze-tts2', 'enabled'], 'Breeze TTS 2：启用', { type: 'boolean', value: true }),
              field(['tts', 'providers', 'breeze-tts2', 'baseUrl'], '服务地址', { value: 'http://127.0.0.1:7860' }),
            ],
          },
          {
            id: 'index-tts',
            label: 'Index-TTS',
            status: 'not-connected',
            state: 'not-connected',
            stateNote: '协议证据不足，未实现 adapter',
            canTest: false,
            canEnable: false,
            key: { configured: false, source: 'none' },
            fields: [
              field(['tts', 'providers', 'index-tts', 'enabled'], 'Index-TTS：启用', { type: 'boolean', value: false }),
            ],
          },
        ],
      },
    ],
  };
}

const configFixture = () => ({
  image: {
    enabled: true,
    provider: 'openai-compatible',
    'openai-compatible': { enabled: null, baseUrl: 'https://api.example.test/v1', apiKey: { configured: true, mask: 'sk…abcd' }, model: 'gpt-image-2' },
    nai: { baseUrl: '', steps: 28, presets: { '5': { positive: '' }, '4.5': { positive: 'OLD-45' } }, artistString: 'old-artist' },
  },
  tts: {
    enabled: true,
    provider: 'breeze-tts2',
    providers: { 'breeze-tts2': { enabled: true, baseUrl: 'http://127.0.0.1:7860' }, 'index-tts': { enabled: false } },
  },
});

const build = () => page.buildView(descriptorFixture(), configFixture());

// ---------------------------------------------------------------------------

test('状态文案映射：六个状态照抄 descriptor，未知值不猜', () => {
  assert.equal(page.stateLabel(STATES, 'disabled'), '功能关闭');
  assert.equal(page.stateLabel(STATES, 'unconfigured'), '未配置');
  assert.equal(page.stateLabel(STATES, 'not-connected'), '尚未接入');
  assert.equal(page.stateLabel(STATES, 'saved-untested'), '已保存、未测试');
  assert.equal(page.stateLabel(STATES, 'test-ok'), '测试通过');
  assert.equal(page.stateLabel(STATES, 'test-failed'), '测试失败');
  assert.equal(page.stateLabel(STATES, 'made-up-state'), '未知');
  // descriptor 改了文案就跟着改，说明不是页面自己的常量在说话
  assert.equal(page.stateLabel([{ id: 'test-ok', label: '测试通过（新口径）' }], 'test-ok'), '测试通过（新口径）');
  assert.equal(page.stateTone('test-failed'), 'danger');
  assert.equal(page.stateTone('not-connected'), 'neutral');
});

test('端点取自 descriptor.api，不手写路径', () => {
  assert.equal(page.apiPath(API.config, 'config'), 'api/companion-media/config');
  assert.equal(page.apiPath(API.save, 'config'), 'api/companion-media/config');
  assert.equal(page.apiPath(API.preview, 'preview'), 'api/companion-media/preview');
  assert.equal(page.apiPath('', 'test'), 'api/companion-media/test');
});

test('视图模型：descriptor 的值优先，缺值时回落到 config；密钥永不带明文', () => {
  const view = build();
  const image = view.sections.find(section => section.id === 'image');
  const openai = image.providers.find(provider => provider.id === 'openai-compatible');
  const baseUrl = openai.fields.find(field => field.path === 'image.openai-compatible.baseUrl');
  assert.equal(baseUrl.value, 'https://api.example.test/v1');
  const key = openai.fields.find(field => field.path === 'image.openai-compatible.apiKey');
  assert.equal(key.secret, true);
  assert.equal(key.value, '', '密钥字段的值必须恒为空');
  assert.equal(key.configured, true);
  assert.equal(key.mask, 'sk…abcd');
  // 回落路径：descriptor 的 value 为 null 时读 config
  assert.equal(page.configAt(configFixture(), 'image.nai.steps'), 28);
  assert.equal(page.configAt(configFixture(), 'tts.providers.breeze-tts2.enabled'), true);
});

test('识图：整块锁定，开关与字段都不可编辑', () => {
  const view = build();
  const vision = view.sections.find(section => section.id === 'vision');
  assert.equal(vision.locked, true);
  assert.equal(vision.toggle.disabled, true);
  assert.ok(vision.fields.every(field => field.locked === true));
  assert.match(vision.note, /预留/);
});

test('Index-TTS：canTest / canEnable 为 false，开关与测试都被禁用（不硬编码 id）', () => {
  const view = build();
  const tts = view.sections.find(section => section.id === 'tts');
  const indexTts = tts.providers.find(provider => provider.id === 'index-tts');
  assert.equal(indexTts.canTest, false);
  assert.equal(indexTts.canEnable, false);
  assert.equal(indexTts.state, 'not-connected');
  assert.equal(indexTts.stateNote, '协议证据不足，未实现 adapter');
  const breeze = tts.providers.find(provider => provider.id === 'breeze-tts2');
  assert.equal(breeze.canTest, true, '能力关闭时也要允许测试（canTest 只看协议）');
  assert.equal(breeze.fields.find(field => field.path.endsWith('.enabled')).original, true);
});

test('生图 provider 不会渲染写不存在的 enabled 键（避免把配置写坏）', () => {
  const view = build();
  const image = view.sections.find(section => section.id === 'image');
  image.providers.forEach((provider) => {
    assert.equal(provider.fields.some(field => field.path.endsWith('.enabled')), false, `${provider.id} 不该有 enabled 字段`);
  });
  const draft = page.draftFrom(view);
  assert.equal(Object.keys(draft).some(path => path.includes('openai-compatible.enabled')), false);
});

test('环境变量来的密钥：输入框锁定并标出来源', () => {
  const descriptor = descriptorFixture();
  const openai = descriptor.sections.find(section => section.id === 'image').providers.find(provider => provider.id === 'openai-compatible');
  openai.key = { configured: true, source: 'env', envVar: 'DSH_MEDIA_OPENAI_COMPATIBLE_API_KEY' };
  const view = page.buildView(descriptor, configFixture());
  const provider = view.sections.find(section => section.id === 'image').providers.find(item => item.id === 'openai-compatible');
  const key = provider.fields.find(field => field.secret);
  assert.equal(provider.keyFromEnv, true);
  assert.equal(key.fromEnv, true);
  assert.equal(key.locked, true);
  assert.equal(key.envVar, 'DSH_MEDIA_OPENAI_COMPATIBLE_API_KEY');
  // 草稿里不出现这个字段，保存也不会覆盖它
  assert.equal(page.draftFrom(view)['image.openai-compatible.apiKey'], undefined);
  assert.equal(JSON.stringify(page.patchFrom(view, page.draftFrom(view), {}, {})), '{}');
});

test('表单初值：密钥恒空，其余取当前值', () => {
  const view = build();
  const draft = page.draftFrom(view);
  assert.equal(draft['image.openai-compatible.apiKey'], undefined, '密钥不进草稿');
  assert.equal(draft['image.openai-compatible.baseUrl'], 'https://api.example.test/v1');
  assert.equal(draft['image.nai.steps'], '28');
  assert.equal(draft['image.enabled'], true);
  assert.equal(draft['tts.providers.breeze-tts2.enabled'], true);
  assert.equal(draft['image.nai.presets.4.5.positive'], 'OLD-45');
});

test('保存 patch：只带改动；数字/字符串不产生假改动', () => {
  const view = build();
  const draft = page.draftFrom(view);
  assert.deepEqual(page.patchFrom(view, draft, {}, {}), {}, '什么都没改 = 空 patch');

  const steps = page.patchFrom(view, { ...draft, 'image.nai.steps': '30' }, {}, {});
  assert.deepEqual(steps, { image: { nai: { steps: 30 } } });

  // 输入框回传字符串 '28'（没改）不该被当成修改
  assert.deepEqual(page.patchFrom(view, { ...draft, 'image.nai.steps': '28' }, {}, {}), {});
});

test('保存 patch：密钥只写——输入过才发，掩码对象永不回传', () => {
  const view = build();
  const draft = page.draftFrom(view);
  const withSecret = page.patchFrom(view, draft, { 'image.openai-compatible.apiKey': 'sk-new-key-123456' }, {});
  assert.deepEqual(withSecret, { image: { 'openai-compatible': { apiKey: 'sk-new-key-123456' } } });

  // 把掩码对象塞进草稿（模拟有人想回传 GET 的结果）：因为字段是 secret，不会被写进 patch
  const polluted = { ...draft, 'image.openai-compatible.apiKey': { configured: true, mask: 'sk…abcd' } };
  assert.deepEqual(page.patchFrom(view, polluted, {}, {}), {});

  // 清除走显式动作
  assert.deepEqual(
    page.patchFrom(view, draft, {}, { 'image.openai-compatible.apiKey': true }),
    { image: { 'openai-compatible': { apiKey: { clear: true } } } },
  );
});

test('切换 provider：只发 provider 一项，另一个 provider 的配置不进 patch', () => {
  const view = build();
  const draft = page.draftFrom(view);
  const patch = page.patchFrom(view, { ...draft, 'image.provider': 'nai' }, {}, {});
  assert.deepEqual(patch, { image: { provider: 'nai' } });
  assert.equal(patch.image['openai-compatible'], undefined);
  assert.equal(patch.tts, undefined);

  const ttsPatch = page.patchFrom(view, { ...draft, 'tts.provider': 'index-tts' }, {}, {});
  assert.deepEqual(ttsPatch, { tts: { provider: 'index-tts' } });
});

test('只保存某个 provider：前缀过滤生效，可强制附带"先关能力"的路径', () => {
  const view = build();
  const draft = page.draftFrom(view);
  const both = { ...draft, 'image.nai.steps': '31', 'image.openai-compatible.baseUrl': 'https://other.test/v1' };
  assert.deepEqual(page.patchFrom(view, both, {}, {}, 'image.nai'), { image: { nai: { steps: 31 } } });
  // forced：清密钥时把 section 开关带进来
  const forced = page.patchFrom(view, { ...draft, 'image.enabled': false }, {}, {}, 'image.openai-compatible', ['image.enabled']);
  assert.deepEqual(forced, { image: { enabled: false } });
});

test('NAI 预设两族互不串用：4.5 的路径不会被拆成 4 → 5', () => {
  const view = build();
  const draft = page.draftFrom(view);
  const five = page.patchFrom(view, { ...draft, 'image.nai.presets.5.positive': 'GEN-V5' }, {}, {});
  assert.deepEqual(five, { image: { nai: { presets: { 5: { positive: 'GEN-V5' } } } } });
  const fourFive = page.patchFrom(view, { ...draft, 'image.nai.presets.4.5.positive': 'GEN-45' }, {}, {});
  assert.deepEqual(fourFive, { image: { nai: { presets: { 4.5: { positive: 'GEN-45' } } } } });
  assert.equal(fourFive.image.nai.presets[4], undefined, '不能被拆成 {4:{5:…}}');
  // 画师串独立保存
  const artist = page.patchFrom(view, { ...draft, 'image.nai.artistString': 'artist-x' }, {}, {});
  assert.deepEqual(artist, { image: { nai: { artistString: 'artist-x' } } });
});

test('预设渲染：两族各自带 label，族之间不共享字段对象', () => {
  const view = build();
  const presets = view.sections.find(section => section.id === 'image').presets;
  assert.deepEqual(presets.families.map(family => family.family), ['5', '4.5']);
  assert.equal(presets.families[0].fields[0].path, 'image.nai.presets.5.positive');
  assert.equal(presets.families[1].fields[0].path, 'image.nai.presets.4.5.positive');
  assert.notEqual(presets.families[0].fields[0], presets.families[1].fields[0]);
  assert.equal(presets.artist.path, 'image.nai.artistString');
});

test('错误路径映射：直接落到对应字段，没有 path 的归到 $', () => {
  const map = page.errorMap([
    { path: 'image.nai.baseUrl', message: 'Base URL 必须是 http(s) 绝对地址' },
    { path: 'tts.providers.breeze-tts2.refText', message: '缺少必填项' },
    { path: 'image.nai.baseUrl', message: '第二条不该覆盖第一条' },
    { message: '整体失败' },
  ]);
  assert.equal(map['image.nai.baseUrl'], 'Base URL 必须是 http(s) 绝对地址');
  assert.equal(map['tts.providers.breeze-tts2.refText'], '缺少必填项');
  assert.equal(map.$, '整体失败');
});

test('模块未启用：404 / no-connection 才归为"没启用"，500 不算', () => {
  assert.equal(page.isModuleDisabled({ status: 404 }), true);
  assert.equal(page.isModuleDisabled({ code: 'no-connection' }), true);
  assert.equal(page.isModuleDisabled({ code: 'module-disabled' }), true);
  assert.equal(page.isModuleDisabled({ status: 500 }), false);
  assert.equal(page.isModuleDisabled(null), false);
  assert.match(page.ENABLE_SNIPPET, /"media": true/);
});

test('诊断区脱敏：apiKey 只留 configured，不明显泄漏', () => {
  const redacted = page.redactForDebug({
    image: { nai: { apiKey: 'sk-plain-0123456789' }, 'openai-compatible': { apiKey: { configured: true, mask: 'sk…abcd' } } },
    tts: { providers: { x: { apiKey: 'yes', baseUrl: 'http://h' } } },
  });
  const text = JSON.stringify(redacted);
  assert.equal(text.includes('sk-plain-0123456789'), false);
  assert.equal(redacted.image.nai.apiKey.configured, true);
  assert.equal(redacted.image['openai-compatible'].apiKey.configured, true);
  assert.equal(redacted.tts.providers.x.baseUrl, 'http://h');
});

test('patch 计数用于"已保存 N 项"的文案', () => {
  assert.equal(page.errorCount({}), 0);
  assert.equal(page.errorCount({ image: { provider: 'nai' } }), 1);
  assert.equal(page.errorCount({ image: { nai: { steps: 30, width: 832 } } }), 2);
  assert.equal(page.errorCount({ image: { 'openai-compatible': { apiKey: { clear: true } } } }), 1);
});

test('真 descriptor 也能吃下（companion-media 在场时）', async (t) => {
  const mediaRoot = path.resolve(moduleRoot, '..', 'companion-media');
  if (!fs.existsSync(path.join(mediaRoot, 'src/ui-page.mjs'))) {
    t.skip('companion-media 不在同级目录，跳过形状兼容性检查');
    return;
  }
  const { mediaPageDescriptor } = await import(pathToFileURL(path.join(mediaRoot, 'src/ui-page.mjs')).href);
  const { createMediaService } = await import(pathToFileURL(path.join(mediaRoot, 'src/service.mjs')).href);
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-media-test-'));
  try {
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });
    service.saveConfig({
      image: { enabled: true, provider: 'openai-compatible', 'openai-compatible': { baseUrl: 'https://api.example.test/v1', apiKey: 'sk-real-key-0123456789', model: 'gpt-image-2' } },
      tts: { enabled: false, provider: 'breeze-tts2', providers: { 'breeze-tts2': { enabled: true, baseUrl: 'http://127.0.0.1:7860' } } },
    });
    const view = page.buildView(mediaPageDescriptor(service.status()), service.readConfig().config);
    const ids = view.sections.flatMap(section => section.providers.map(provider => provider.id));
    assert.deepEqual(ids.sort(), ['breeze-tts2', 'drama3', 'fish-audio', 'gpt-sovits', 'index-tts', 'nai', 'openai-compatible'].sort());
    const draft = page.draftFrom(view);
    const steps = page.patchFrom(view, { ...draft, 'image.nai.steps': '30' }, {}, {});
    assert.deepEqual(steps, { image: { nai: { steps: 30 } } });
    const presets = view.sections.find(section => section.id === 'image').presets;
    assert.deepEqual(presets.families.map(family => family.family), ['5', '4.5']);
    const indexTts = view.sections.find(section => section.id === 'tts').providers.find(provider => provider.id === 'index-tts');
    assert.equal(indexTts.canTest, false);
    assert.equal(indexTts.canEnable, false);
    // 真 descriptor 里的密钥同样不带明文
    assert.equal(JSON.stringify(view).includes('sk-real-key-0123456789'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
