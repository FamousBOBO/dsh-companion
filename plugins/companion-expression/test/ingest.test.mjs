/**
 * ingest / analyzer 的离线测试。全部依赖注入：假 http（计数调用，绝不真发请求）、假 vision、
 * 固定时钟与盐；数据库 `:memory:`，素材落 mkdtemp 临时目录，跑完删掉。
 *
 * 覆盖：未授权 0 下载 0 视觉调用、配额、体积超限、私图门控进隔离区、source_key 幂等、
 * 两个来源一份文件，以及 analyzer 的 vision-not-allowed / vision-failed / 隐私分类。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openExpressionDb } from '../src/db.mjs';
import { createLibrary } from '../src/library.mjs';
import { createIngest, hourSlot, sourceKeyFor, JOB_STATES } from '../src/ingest.mjs';
import { analyze, analyzeWithHeuristics, classifyPrivacy, moderationFor, NOT_IMPLEMENTED } from '../src/analyzer.mjs';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.mjs';
import { privateScope, QUARANTINE } from '../src/scopes.mjs';

const SALT = 'test-salt-0123456789abcdef';
const OWNER_CHAT = 10001;
const STRANGER_CHAT = 30003;
const GROUP_CHAT = 90001;
const CLOCK = 1_700_000_000_000;

/** 最小合法 PNG 头（签名 + IHDR），尺寸可指定。 */
function makePng({ width = 64, height = 64, extra = 0 } = {}) {
  const buffer = Buffer.alloc(33 + extra, 0x11);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** 可配置的假 http：记录调用（绝不真发请求），并像真实现那样执行字节上限。 */
function fakeHttp(handler = () => ({ bytes: makePng(), mime: 'image/png' })) {
  const calls = [];
  const fail = code => { const error = new Error(`fake http: ${code}`); error.code = code; return error; };
  return {
    calls,
    get: async (url, options = {}) => {
      calls.push({ url: String(url), maxBytes: options.maxBytes });
      const value = handler(String(url), options);
      if (value instanceof Error) throw value;
      if (value?.rejectCode) throw fail(value.rejectCode);
      const bytes = value.bytes ?? makePng();
      if (Number(options.maxBytes) > 0 && bytes.length > Number(options.maxBytes)) throw fail('too-large');
      return {
        ok: value.ok ?? true, status: value.status ?? 200, bytes,
        mime: value.mime ?? 'image/png', finalUrl: String(url), hops: [String(url)],
      };
    },
  };
}

/** 建一套管道。config 用规范化后的真实默认值，再按用例覆盖。 */
function harness({ configOverrides = {}, http = fakeHttp(), vision = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-ingest-'));
  const db = openExpressionDb({ file: ':memory:', now: () => CLOCK });
  const library = createLibrary({ db, assetsDir: path.join(dir, 'assets'), now: () => CLOCK });
  const { config } = normalizeConfig({ ...DEFAULT_CONFIG, ...configOverrides });
  const ingest = createIngest({ db, library, config, http, vision, now: () => CLOCK });
  return { db, library, config, ingest, http, dir, job: sourceKey => db.get('SELECT * FROM ingest_jobs WHERE source_key = ?', [sourceKey]),
    cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function ownerScope() {
  return privateScope({ kind: 'owner_private', chatId: OWNER_CHAT, salt: SALT });
}

const baseInput = { kind: 'dm', chatId: OWNER_CHAT, isOwner: true, salt: SALT, url: 'https://cdn.example.com/a.png', messageHash: 'm-1' };

test('未授权来源：0 下载、0 视觉调用，且落一条 skipped 的 job', async () => {
  let visionCalls = 0;
  const vision = async () => { visionCalls += 1; return { literal: 'x' }; };
  const http = fakeHttp();
  // 陌生人私聊：默认 privatePeers='opt_in' 且 peers 为空 → 不收集
  const env = harness({ configOverrides: { capture: { ...DEFAULT_CONFIG.capture, cloudVision: 'allow' } }, http, vision });
  try {
    const result = await env.ingest.ingestOne({
      kind: 'dm', chatId: STRANGER_CHAT, isOwner: false, salt: SALT,
      url: 'https://cdn.example.com/stranger.png', messageHash: 'm-2',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'unauthorized');
    assert.equal(result.downloads, 0);
    assert.equal(result.visionCalls, 0);
    assert.equal(http.calls.length, 0, '未授权来源绝不发网络请求');
    assert.equal(visionCalls, 0, '未授权来源绝不调用视觉模型');
    assert.equal(result.message.includes('没有下载'), true);

    const scope = privateScope({ kind: 'peer_private', chatId: STRANGER_CHAT, salt: SALT });
    const job = env.job(sourceKeyFor({ scope, messageHash: 'm-2', url: 'https://cdn.example.com/stranger.png' }));
    assert.equal(job.state, 'skipped');
    assert.match(String(job.last_error), /unauthorized/);
  } finally {
    env.cleanup();
  }
});

test('授权之后同一来源可以重新收；配额 0 也是 0 下载', async () => {
  const http = fakeHttp();
  // 授权前：陌生对端既不在 peers，privatePeers 又是 opt_in → 不收集
  const ungranted = harness({ http });
  try {
    const before = await ungranted.ingest.ingestOne({
      kind: 'dm', chatId: STRANGER_CHAT, isOwner: false, salt: SALT,
      url: 'https://cdn.example.com/p.png', messageHash: 'm-3',
    });
    assert.equal(before.reasonCode, 'unauthorized');
    assert.equal(http.calls.length, 0);
  } finally {
    ungranted.cleanup();
  }

  // 授权后：正向路径成立（同一个假 http，调用数从 0 变 1）
  const granted = harness({
    configOverrides: { capture: { ...DEFAULT_CONFIG.capture, privatePeers: 'opt_in', peers: [{ chatId: STRANGER_CHAT, approved: true }] } },
    http,
  });
  try {
    const result = await granted.ingest.ingestOne({
      kind: 'dm', chatId: STRANGER_CHAT, isOwner: false, salt: SALT,
      url: 'https://cdn.example.com/p.png', messageHash: 'm-3',
    });
    assert.equal(result.ok, true);
    assert.equal(result.downloads, 1);
    assert.equal(http.calls.length, 1);
  } finally {
    granted.cleanup();
  }

  const noQuota = harness({ configOverrides: { capture: { ...DEFAULT_CONFIG.capture, maxPerHour: 0 } }, http });
  try {
    const callsBefore = http.calls.length;
    const result = await noQuota.ingest.ingestOne(baseInput);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'quota-off');
    assert.equal(result.downloads, 0);
    assert.equal(http.calls.length, callsBefore, '配额为 0 时不下载');
  } finally {
    noQuota.cleanup();
  }
});

test('配额用满之后不再下载（按作用域 + 小时桶）', async () => {
  const http = fakeHttp();
  const env = harness({ configOverrides: { capture: { ...DEFAULT_CONFIG.capture, maxPerHour: 2 } }, http });
  try {
    assert.equal((await env.ingest.ingestOne({ ...baseInput, messageHash: 'q-1' })).ok, true);
    assert.equal((await env.ingest.ingestOne({ ...baseInput, messageHash: 'q-2' })).ok, true);
    const third = await env.ingest.ingestOne({ ...baseInput, messageHash: 'q-3' });
    assert.equal(third.ok, false);
    assert.equal(third.reasonCode, 'quota-exceeded');
    assert.equal(http.calls.length, 2);

    const status = env.ingest.quotaStatus(ownerScope());
    assert.equal(status.used, 2);
    assert.equal(status.limit, 2);
    assert.equal(status.slot, hourSlot(CLOCK));
    assert.equal(JOB_STATES.includes('quota'), true);
  } finally {
    env.cleanup();
  }
});

test('体积超限：http 层已拒，入库 0 张、0 条 asset', async () => {
  // config 会把 maxDownloadBytes 夹到下限 64 KiB，所以这里用超下限的字节来验证同一道闸门。
  const big = makePng({ extra: 70_000 });
  const http = fakeHttp(() => ({ bytes: big, mime: 'image/png' }));
  const env = harness({ configOverrides: { capture: { ...DEFAULT_CONFIG.capture, maxDownloadBytes: 64 * 1024 } }, http });
  try {
    const result = await env.ingest.ingestOne(baseInput);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'too-large');
    assert.equal(result.state, 'failed');
    assert.equal(result.downloads, 0);
    assert.equal(env.db.get('SELECT count(*) AS total FROM assets')?.total, 0);
    // http 拿到的是同一个上限（不是「先全下再截」）
    assert.equal(http.calls[0].maxBytes, 64 * 1024);
  } finally {
    env.cleanup();
  }
});

test('下载失败/非图片：记 failed，重试接口只对 failed 生效', async () => {
  const env = harness({
    http: fakeHttp(() => ({ rejectCode: 'transport', message: '网络断了' })),
  });
  try {
    const result = await env.ingest.ingestOne(baseInput);
    assert.equal(result.ok, false);
    assert.equal(result.state, 'failed');
    const retried = env.ingest.retryJob(result.jobId);
    assert.equal(retried.ok, true);
    // 再跑一次：失败过的 job 允许重来（没有被永久钉死）
    const again = await env.ingest.ingestOne(baseInput);
    assert.equal(again.ok, false);
    const notFailed = env.ingest.retryJob('job_missing_nope');
    assert.equal(notFailed.ok, false);
  } finally {
    env.cleanup();
  }
});

test('私图门控：照片/截图进隔离区，即使开了视觉也不送模型', async () => {
  let visionCalls = 0;
  const vision = async () => { visionCalls += 1; return { intents: ['none'] }; };
  const env = harness({
    configOverrides: { capture: { ...DEFAULT_CONFIG.capture, cloudVision: 'allow' }, analysis: { ...DEFAULT_CONFIG.analysis, mode: 'host-vision' } },
    vision,
  });
  try {
    const photo = await env.ingest.ingestOne({
      ...baseInput, messageHash: 'photo-1',
      url: 'https://cdn.example.com/photo.jpg', fileNameHint: 'selfie_photo.jpg',
    });
    assert.equal(photo.ok, true);
    assert.equal(photo.moderationState, 'quarantined');
    assert.equal(photo.privacy.classification, 'photo');
    assert.equal(visionCalls, 0, '照片绝不送视觉模型');
    assert.equal(photo.visionReasonCode, 'vision-blocked-by-privacy');

    const asset = env.library.getAsset(photo.assetId);
    assert.deepEqual(asset.visibility, [{ scope: QUARANTINE, approval: 'quarantined' }]);
    assert.equal(env.library.gateFor(photo.assetId, [ownerScope()]).ok, false, '隔离区素材不能被投递');

    const sticker = await env.ingest.ingestOne({
      ...baseInput, messageHash: 'sticker-1',
      url: 'https://cdn.example.com/s.png', summaryHint: 'QQ 表情',
    });
    assert.equal(sticker.moderationState, 'review');
    assert.equal(visionCalls, 1, '非私图才允许走视觉');
    assert.equal(sticker.modeUsed, 'host-vision');
  } finally {
    env.cleanup();
  }
});

test('uncertain 去向跟随 capture.uncertain：review 或 quarantine', async () => {
  // `flash` 子类型只是弱线索（+1）：判不准，去向由配置决定，不能默认放行。
  for (const [mode, expected] of [['review', 'review'], ['quarantine', 'quarantined']]) {
    const env = harness({ configOverrides: { capture: { ...DEFAULT_CONFIG.capture, uncertain: mode } } });
    try {
      const result = await env.ingest.ingestOne({
        ...baseInput, messageHash: `uncertain-${mode}`,
        url: 'https://cdn.example.com/u.png', subType: 'flash',
      });
      assert.equal(result.privacy.classification, 'uncertain');
      assert.equal(result.moderationState, expected);
      const row = env.library.getVisibility(result.assetId);
      assert.equal(row.length, 1);
      assert.equal(row[0].scope, expected === 'quarantined' ? QUARANTINE : ownerScope());
    } finally {
      env.cleanup();
    }
  }
});

test('source_key 幂等：同一条消息同一张图第二次投递不下载、不入库', async () => {
  const http = fakeHttp();
  const env = harness({ http });
  try {
    const first = await env.ingest.ingestOne(baseInput);
    assert.equal(first.ok, true);
    assert.equal(first.downloads, 1);
    assert.equal(http.calls.length, 1);

    const second = await env.ingest.ingestOne(baseInput);
    assert.equal(second.duplicate, true);
    assert.equal(second.reasonCode, 'already-ingested');
    assert.equal(second.downloads, 0);
    assert.equal(http.calls.length, 1, '重复投递不能二次下载');
    assert.equal(env.db.get('SELECT count(*) AS total FROM ingest_jobs')?.total, 1);
    assert.equal(env.db.get('SELECT count(*) AS total FROM assets')?.total, 1);

    // 不同消息号则视为不同素材（但同字节仍物理去重）
    const third = await env.ingest.ingestOne({ ...baseInput, messageHash: 'm-1b' });
    assert.equal(third.ok, true);
    assert.equal(third.deduped, true, '不同消息但同字节：复用同一份文件');
    assert.equal(env.db.get('SELECT count(*) AS total FROM assets')?.total, 1);
    assert.equal(env.db.get('SELECT count(*) AS total FROM asset_sources')?.total, 2);
  } finally {
    env.cleanup();
  }
});

test('两个来源同一字节：一份文件、两条权限，互不影响', async () => {
  const env = harness({
    configOverrides: { capture: { ...DEFAULT_CONFIG.capture, groupEnabled: true, groups: [{ chatId: GROUP_CHAT, capture: true, store: true, use: true }] } },
  });
  try {
    const owner = await env.ingest.ingestOne(baseInput);
    const group = await env.ingest.ingestOne({
      kind: 'group', chatId: GROUP_CHAT, salt: SALT,
      url: 'https://cdn.example.com/a.png', messageHash: 'g-1',
    });
    assert.equal(owner.assetId, group.assetId);
    assert.equal(group.deduped, true);
    const asset = env.library.getAsset(owner.assetId);
    assert.equal(asset.sources.length, 2);
    assert.equal(asset.visibility.length, 2);

    // 群作用域通过、主人作用域还是 review：互不影响
    env.library.setVisibility({ assetId: owner.assetId, scope: ownerScope(), approval: 'approved' });
    const groupScopeKey = asset.visibility.find(row => row.scope.startsWith('group:'))?.scope;
    assert.equal(env.library.gateFor(owner.assetId, [ownerScope()]).ok, true);
    assert.equal(env.library.gateFor(owner.assetId, [groupScopeKey]).ok, false);
  } finally {
    env.cleanup();
  }
});

test('缺盐：结构化拒绝，不下载也不抛', async () => {
  const http = fakeHttp();
  const env = harness({ http });
  try {
    const result = await env.ingest.ingestOne({ ...baseInput, salt: '' });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'salt-missing');
    assert.equal(http.calls.length, 0);
  } finally {
    env.cleanup();
  }
});

/* ---------- analyzer ---------- */

test('analyzer：默认 heuristics 不碰网络，vision-not-allowed 标清楚', async () => {
  const { config } = normalizeConfig(DEFAULT_CONFIG);
  const result = await analyze({ config, literal: '哈哈哈 笑死', hint: '开心' });
  assert.equal(result.modeUsed, 'heuristics');
  assert.equal(result.reasonCode, '');
  assert.equal(result.card.ocr, '', 'OCR 未实现，必须是空串');
  assert.ok(result.card.intents.includes('laugh'));
  assert.ok(result.card.emotions.includes('joy'));

  const visionMode = await analyze({
    config: { ...config, analysis: { ...config.analysis, mode: 'host-vision' } },
    literal: '早',
    vision: async () => { throw new Error('不该被调用'); },
  });
  assert.equal(visionMode.modeUsed, 'heuristics');
  assert.equal(visionMode.reasonCode, 'vision-not-allowed');
  assert.ok(visionMode.warnings.some(line => line.includes('cloudVision')));
  assert.equal(visionMode.card.modelVersion, 'heuristics-v1');
});

test('analyzer：开了 allow 且注入 vision 才真的调用；失败退回 heuristics', async () => {
  const base = { ...DEFAULT_CONFIG, analysis: { ...DEFAULT_CONFIG.analysis, mode: 'host-vision' }, capture: { ...DEFAULT_CONFIG.capture, cloudVision: 'allow' } };
  const { config } = normalizeConfig(base);
  let payload = null;
  const ok = await analyze({ config, literal: '谢谢', vision: async input => { payload = input; return { intents: ['thanks'], confidence: 0.9 }; } });
  assert.equal(ok.modeUsed, 'host-vision');
  assert.deepEqual(ok.card.intents, ['thanks']);
  assert.equal(ok.reasonCode, '');
  assert.equal(typeof payload.bytes, 'undefined');
  assert.equal(Object.keys(payload).includes('file_path'), false, '视觉函数拿不到任何路径');

  const broken = await analyze({ config, literal: '谢谢', vision: async () => { throw new Error('模型挂了'); } });
  assert.equal(broken.modeUsed, 'heuristics');
  assert.equal(broken.reasonCode, 'vision-failed');
  assert.ok(broken.warnings.some(line => line.includes('模型挂了')));
  assert.equal((await analyze({ config, literal: '谢谢' })).reasonCode, 'vision-not-injected');
});

test('analyzer：off 模式、heuristics 输出稳定、未实现项写明', () => {
  const card = analyzeWithHeuristics({ literal: '哈哈 开心' });
  assert.equal(card.source, 'heuristics');
  assert.equal(card.aggression, 0);
  assert.ok(card.confidence > 0 && card.confidence <= 1);
  assert.deepEqual(analyzeWithHeuristics({ literal: '哈哈 开心' }), card, '同一输入必须同一输出');
  assert.match(NOT_IMPLEMENTED.ocr, /OCR 未实现/);
  assert.match(NOT_IMPLEMENTED.gifKeyframes, /GIF/);
  assert.match(NOT_IMPLEMENTED.embedding, /向量/);

  const aggressive = analyzeWithHeuristics({ literal: '滚 傻逼 去死' });
  assert.ok(aggressive.aggression > 0);
  assert.ok(aggressive.avoidWhen.includes('serious-conflict'));
});

test('analyzer：隐私分类与去向', async () => {
  assert.equal(classifyPrivacy({ fileNameHint: 'selfie.jpg' }).classification, 'photo');
  assert.equal(classifyPrivacy({ summaryHint: '这是截图' }).classification, 'screenshot');
  assert.equal(classifyPrivacy({ summaryHint: 'mface 表情' }).classification, 'sticker');
  assert.equal(classifyPrivacy({}).classification, 'sticker');

  assert.equal(moderationFor({ classification: 'photo' }).moderation, 'quarantined');
  assert.equal(moderationFor({ classification: 'sticker' }).moderation, 'review');
  assert.equal(moderationFor({ classification: 'uncertain', uncertainMode: 'quarantine' }).moderation, 'quarantined');
  assert.equal(moderationFor({ classification: 'uncertain', uncertainMode: 'review' }).moderation, 'review');

  const { config } = normalizeConfig({ ...DEFAULT_CONFIG, analysis: { ...DEFAULT_CONFIG.analysis, mode: 'off' } });
  const off = await analyze({ config, literal: '哈哈' });
  assert.equal(off.modeUsed, 'off');
  assert.equal(off.reasonCode, 'analysis-off');
});

test('采集配额与投递配额分桶：收图不许吃掉发图额度', async () => {
  // 2026-11-07 实测缺陷：群作用域收了 2 张图之后，decision.quotaState() 读到 reserved=2
  // （= maxGroupPerHour）于是直接 abstain-hourly-quota —— 采集的账记在了投递的桶里。
  // 两个用途必须分命名空间：采集只影响采集，投递只影响投递。
  const http = fakeHttp();
  const env = harness({ configOverrides: { capture: { ...DEFAULT_CONFIG.capture, maxPerHour: 3 } }, http });
  try {
    for (const hash of ['ns-1', 'ns-2']) {
      assert.equal((await env.ingest.ingestOne({ ...baseInput, messageHash: hash })).ok, true);
    }
    const scope = ownerScope();
    // 采集侧看得到用量（带 capture: 前缀的那个桶）。
    assert.equal(env.ingest.quotaStatus(scope).used, 2);
    // 投递侧的同名字段必须是空的：会话作用域这个桶不许被采集写脏。
    const deliveryRow = env.db.get('SELECT used FROM quotas WHERE bucket = ? AND slot = ?', [scope, hourSlot(CLOCK)]);
    assert.equal(deliveryRow, null, '会话作用域这个桶是投递用的，采集不许往里写');
    const captureRow = env.db.get('SELECT used FROM quotas WHERE bucket = ? AND slot = ?', [`capture:${scope}`, hourSlot(CLOCK)]);
    assert.equal(Number(captureRow.used), 2, '采集的账记在 capture: 前缀的桶里');
  } finally {
    env.cleanup();
  }
});
