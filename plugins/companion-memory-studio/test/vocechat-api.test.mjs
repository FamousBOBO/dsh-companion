import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStudioHandlers, API_PREFIX } from '../server.mjs';
import { VOCECHAT_PATHS, PREVIEW_CHARS, MAX_ROWS, preview } from '../lib/vocechat-route.mjs';

/**
 * Fixture: a data root shaped like the one the two VoceChat rows write into.
 *
 *   <root>/home/channel-vocechat/diag/mount.json
 *   <root>/home/channel-vocechat/state/last-processed.json
 *   <root>/home/channel-vocechat/events/events.jsonl
 *   <root>/home/channel-vocechat/events/gap.jsonl
 *   <root>/home/vocechat-adapter/sent-log.jsonl
 *
 * The paths come from `VOCECHAT_PATHS` on purpose: if a plugin ever moves the layout, this test
 * breaks instead of the page silently showing nothing.
 */
function fixture({ withFiles = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-vc-'));
  const dir = (...parts) => path.join(root, ...parts);

  if (withFiles) {
    fs.mkdirSync(dir('home', 'channel-vocechat', 'diag'), { recursive: true });
    fs.mkdirSync(dir('home', 'channel-vocechat', 'state'), { recursive: true });
    fs.mkdirSync(dir('home', 'channel-vocechat', 'events'), { recursive: true });
    fs.mkdirSync(dir('home', 'vocechat-adapter'), { recursive: true });

    fs.writeFileSync(dir(...VOCECHAT_PATHS.mount), JSON.stringify({
      version: '0.2.0',
      enabled: true,
      baseHost: 'http://127.0.0.1:3009',
      uid: 4,
      deviceName: 'dsh-companion',
      problems: [],
      keys: { bare: ['secret-ish-key-names'] },
      credentialSource: 'D:/DSH/vocechat/vocechat-data/db/db.sqlite',
    }));
    fs.writeFileSync(dir(...VOCECHAT_PATHS.cursor), JSON.stringify({ mid: 545, at: 1794928697175 }));

    const events = [
      { at: 1794928697000, event: { mid: 544, fromUid: 1, target: { channel: 1 }, content: '短消息', contentType: 'text/plain', kind: 'chat' } },
      { at: 1794928697175, event: { mid: 545, fromUid: 4, target: { channel: 1 }, content: '开机演练（PS7 执行器）后验证 15:18:17', contentType: 'text/plain', kind: 'chat' } },
      // 一条超长正文：页面要能证明它被截断了，而不是原样吐出来。
      { at: 1794928698000, event: { mid: 546, fromUid: 1, target: { user: 4 }, content: '长'.repeat(400), contentType: 'text/plain', kind: 'chat' } },
    ];
    fs.writeFileSync(dir(...VOCECHAT_PATHS.events), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    fs.writeFileSync(dir(...VOCECHAT_PATHS.gaps), JSON.stringify({ at: 1794928000000, from: 500, to: 520, reason: 'sse-append-failed' }) + '\n');

    const deliveries = [
      { at: 1794928697000, kind: 'turn-start', room: 'vc-chan-1', mid: 545, resumed: true, created: false },
      { at: 1794928697100, kind: 'sent', room: 'vc-chan-1', target: { channel: 1 }, mid: 546, phase: 'final', ok: true, chars: 12, preview: '回复一', segment: 1, of: 2 },
      { at: 1794928697200, kind: 'skipped', room: 'vc-chan-1', mid: 547, reason: 'from-self', fromUid: 4 },
      { at: 1794928697300, kind: 'sent', room: 'vc-chan-1', target: { channel: 1 }, mid: 548, phase: 'final', ok: false, chars: 0, error: 'timeout' },
    ];
    fs.writeFileSync(dir(...VOCECHAT_PATHS.deliveries), deliveries.map((d) => JSON.stringify(d)).join('\n') + '\n');
  }

  const options = { root, chatBase: {}, engine: { internal: () => ({ viewer: () => ({ userId: 'owner', personaId: 'bot' }) }) } };
  const handlers = createStudioHandlers(options);
  return {
    root,
    async call(route, query = '') {
      const url = `http://localhost${API_PREFIX}/${route}${query}`;
      const response = await handlers[`GET ${API_PREFIX}/${route}`](new Request(url));
      return { status: response.status, ...(await response.json()) };
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('status reports what exists and never invents health it cannot observe', async () => {
  const f = fixture();
  try {
    const r = await f.call('vocechat');
    assert.equal(r.ok, true);
    assert.equal(r.data.available, true);

    // 传输侧的挂载事实
    assert.equal(r.data.transport.mounted, true);
    assert.equal(r.data.transport.uid, 4);
    assert.equal(r.data.transport.deviceName, 'dsh-companion');
    assert.equal(r.data.transport.cursorMid, 545);

    // 注册表键名与凭据来源路径属于实现细节，不该出现在响应里
    assert.equal(JSON.stringify(r.data).includes('secret-ish-key-names'), false);
    assert.equal(JSON.stringify(r.data).includes('vocechat-data'), false);

    // 入站/出站/断口三块都在，且各自带"能不能读"
    assert.equal(r.data.events.readable, true);
    assert.equal(r.data.events.stored, 3);
    assert.equal(r.data.gaps.readable, true);
    assert.equal(r.data.gaps.count, 1);
    // 补播断口是真实丢消息的唯一直接证据，必须原样露出
    assert.equal(r.data.gaps.recent[0].reason, 'sse-append-failed');
    assert.equal(r.data.gaps.recent[0].from, 500);

    // 出站的计数明确标成"窗口内"
    assert.equal(r.data.deliveries.window.sent, 1);
    assert.equal(r.data.deliveries.window.turns, 1);
    assert.equal(r.data.deliveries.window.skipped, 1);
    assert.equal(r.data.deliveries.lastSent.mid, 546);
  } finally { f.cleanup(); }
});

test('status with no plugin files says "nothing to see", not "all good"', async () => {
  // 这一条是页面的诚实性基线：插件行没挂载时，`available` 必须是 false，
  // 而且每一侧都要能说出自己为什么没有内容。
  const f = fixture({ withFiles: false });
  try {
    const r = await f.call('vocechat');
    assert.equal(r.data.available, false);
    assert.equal(r.data.transport.mounted, false);
    assert.equal(r.data.events.readable, false);
    assert.equal(r.data.events.reason, 'missing');
    assert.equal(r.data.deliveries.readable, false);
    assert.equal(r.data.transport.cursorMid, null);
  } finally { f.cleanup(); }
});

test('events are newest-first, bodies are previews, and channel vs DM targets stay distinguishable', async () => {
  const f = fixture();
  try {
    const r = await f.call('vocechat-events');
    assert.equal(r.data.available, true);
    assert.equal(r.data.total, 3);
    assert.equal(r.data.returned, 3);
    assert.equal(r.data.previewChars, PREVIEW_CHARS);

    // 倒序：最新的 mid 在前
    assert.deepEqual(r.data.events.map((e) => e.mid), [546, 545, 544]);

    // 频道目标与私聊目标必须是判别式，不能压成布尔
    assert.deepEqual(r.data.events[0].target, { user: 4 });
    assert.deepEqual(r.data.events[1].target, { channel: 1 });

    // 超长正文被截断，并且**明说**被截断了
    const long = r.data.events[0];
    assert.equal(long.previewTruncated, true);
    assert.equal(long.chars, 400);
    assert.equal(long.preview.endsWith('…'), true);
    assert.equal(long.preview.length <= PREVIEW_CHARS + 1, true);

    // 短正文不截断
    assert.equal(r.data.events[2].previewTruncated, false);
  } finally { f.cleanup(); }
});

test('full body needs an explicit mid, and only returns that one', async () => {
  const f = fixture();
  try {
    // 不带 mid 就不给全文 —— 不做"批量开口"
    const bulk = await f.call('vocechat-events', '?full=1');
    assert.equal(bulk.data.full, null);
    assert.equal(bulk.data.events.length, 3);

    const one = await f.call('vocechat-events', '?full=1&mid=546');
    assert.equal(one.data.full.mid, 546);
    assert.equal(one.data.full.content.length, 400);
    assert.equal(one.data.full.target.user, 4);
    // 全文模式只给那一条，不再顺带返回整页
    assert.equal(one.data.events.length, 0);

    // 不在窗口内的 mid：如实说"窗口内没有"，不是"消息不存在"
    const missing = await f.call('vocechat-events', '?full=1&mid=1');
    assert.equal(missing.data.full, null);
    assert.equal(missing.data.reason, 'mid-not-in-window');
  } finally { f.cleanup(); }
});

test('deliveries expose every ledger kind and filter by a known one', async () => {
  const f = fixture();
  try {
    const all = await f.call('vocechat-deliveries');
    assert.equal(all.data.total, 4);
    // 倒序：时间最新的在前。fixture 按时间正序写入，所以倒过来是 sent(548) / skipped / sent(546) / turn-start。
    assert.deepEqual(all.data.entries.map((e) => e.kind), ['sent', 'skipped', 'sent', 'turn-start']);
    assert.deepEqual(all.data.kinds, ['sent', 'skipped', 'turn-start', 'undelivered']);

    // 成功/失败必须可分辨；失败那条带 error
    const sent = all.data.entries.filter((e) => e.kind === 'sent');
    assert.equal(sent.some((e) => e.ok === true), true);
    assert.equal(sent.some((e) => e.ok === false && e.error === 'timeout'), true);

    // 分段上下文透出来（"这条为什么只发了一半"要靠它查）
    assert.equal(sent.find((e) => e.ok === true).segment, 1);
    assert.equal(sent.find((e) => e.ok === true).of, 2);

    const filtered = await f.call('vocechat-deliveries', '?kind=skipped');
    assert.equal(filtered.data.kind, 'skipped');
    assert.equal(filtered.data.entries.length, 1);
    assert.equal(filtered.data.entries[0].reason, 'from-self');

    // 不认识 kind 就不过滤，而不是返回空列表
    const bogus = await f.call('vocechat-deliveries', '?kind=nonsense');
    assert.equal(bogus.data.kind, '');
    assert.equal(bogus.data.entries.length, 4);
  } finally { f.cleanup(); }
});

test('a malformed ledger line is skipped and counted, not fatal', async () => {
  const f = fixture();
  try {
    const file = path.join(f.root, ...VOCECHAT_PATHS.deliveries);
    fs.appendFileSync(file, 'this is not json\n');
    const r = await f.call('vocechat-deliveries');
    assert.equal(r.data.available, true);
    assert.equal(r.data.skipped, 1);
    assert.equal(r.data.entries.length, 4);
  } finally { f.cleanup(); }
});

test('the window is bounded and said out loud', async () => {
  const f = fixture();
  try {
    const file = path.join(f.root, ...VOCECHAT_PATHS.deliveries);
    const rows = [];
    for (let i = 0; i < MAX_ROWS + 25; i += 1) {
      rows.push(JSON.stringify({ at: 1794928697000 + i, kind: 'sent', room: 'vc-chan-1', mid: i, phase: 'final', ok: true, chars: 1, preview: 'x' }));
    }
    fs.writeFileSync(file, rows.join('\n') + '\n');
    const r = await f.call('vocechat-deliveries');
    assert.equal(r.data.total, MAX_ROWS + 25);
    assert.equal(r.data.returned, MAX_ROWS);
    assert.equal(r.data.window, MAX_ROWS);
    // 最新那条在第一位（倒序）
    assert.equal(r.data.entries[0].mid, MAX_ROWS + 24);
  } finally { f.cleanup(); }
});

test('preview collapses whitespace and marks truncation', () => {
  assert.deepEqual(preview('abc'), { text: 'abc', truncated: false, chars: 3 });
  const long = preview('a'.repeat(PREVIEW_CHARS + 1));
  assert.equal(long.truncated, true);
  // 多行正文在列表里压成一行（否则一行消息会把整个列表撑开）
  assert.equal(preview('第一行\n第二行').text, '第一行 第二行');
});

test('every route is owner-gated: a non-owner viewer is refused', async () => {
  // 三条路由都走 kernel.viewer(...)：没有 owner 时必须被拒，而不是把账本读给任何调用者。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-vc-deny-'));
  try {
    const options = { root, chatBase: {}, engine: { internal: () => ({ viewer: () => null }) } };
    const handlers = createStudioHandlers(options);
    for (const route of ['vocechat', 'vocechat-events', 'vocechat-deliveries']) {
      const response = await handlers[`GET ${API_PREFIX}/${route}`](new Request(`http://localhost${API_PREFIX}/${route}`));
      const body = await response.json();
      assert.equal(body.ok, false, `${route} must refuse a non-owner`);
      assert.equal(body.error.code, 'denied');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
