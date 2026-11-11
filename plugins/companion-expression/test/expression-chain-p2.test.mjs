/**
 * docs/11「P2 离线测试」里与**发送纪律**相关的四条（第 7–10 条）：
 *
 *   7. 无候选不随机挑图；
 *   8. `expression_reply` 必须使用候选 `assetId`；
 *   9. 同轮最多一张；
 *  10. 无 `message_id` 不记为已发送、不重试。
 *
 * 这些纪律分散在三个模块里（工具参数校验 / 计划器 / 投递层），单独一条都不难，
 * 难的是**被绕过去**：所以这里从「模型能调到的那个入口」开始，一路查到落库的那一行。
 * 全程假库 + 假发送器 + `:memory:` 数据库，零网络、零 QQ。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { openExpressionDb } from '../src/db.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { plan } from '../src/planner.mjs';
import { deliver } from '../src/delivery.mjs';
import { quotaBucketFor } from '../src/decision.mjs';
import { privateScope } from '../src/scopes.mjs';
import { createToolHandlers } from '../src/tools.mjs';

const NOW = 1_700_000_000_000;
const SALT = 'p2-salt-0123456789abcdef';
const OWNER_SCOPE = privateScope({ kind: 'owner_private', chatId: 10001, salt: SALT });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 3)]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** 一个只会说「没有候选」的图库：调用 reply 的路径必须一次都不发生。 */
function emptyLibrary() {
  const calls = [];
  return {
    calls,
    getFileForDelivery({ assetId }) {
      calls.push(assetId);
      return { ok: false, reasonCode: 'asset-missing', message: '没有这张图。' };
    },
  };
}

/**
 * 一个能给出文件、但发送器永远不回 message_id 的环境。
 *
 * 回调必须 **await**：投递是异步的，不等回调就 `db.close()`，后续查询会撞「数据库已关闭」。
 */
async function harness(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-p2-'));
  const assetsDir = path.join(dir, 'home', 'expression', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const db = openExpressionDb({ file: ':memory:' });
  const config = { ...DEFAULT_CONFIG, delivery: { ...DEFAULT_CONFIG.delivery, enabled: true } };
  try {
    return await run({ db, dir, dataRoot: dir, assetsDir, config });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 7. 无候选不随机挑图 ─────────────────────────────────────────────────────

test('无候选时：工具层不会凭空造 assetId，服务层一次也不会被调用', async () => {
  const seen = [];
  const handlers = createToolHandlers({
    service: {
      candidates: async () => ({ ok: true, candidates: [], send: false, reasonCode: 'text-only-no-candidate' }),
      reply: async (args) => { seen.push(args); return { ok: true, delivered: 1 } },
    },
  });
  const candidates = await handlers.expression_candidates({ query: '开心' }, {})
  assert.equal(candidates.ok, true)
  assert.deepEqual(candidates.candidates, [], '没有候选就是空列表——这是正常结果，不是错误')
  assert.equal(candidates.send, false)
  assert.equal(candidates.reasonCode, 'text-only-no-candidate')

  // 模型拿不到 assetId 就调不了 reply：没有 assetId 的 reply 在参数校验就被拦下。
  const reply = await handlers.expression_reply({ action: 'send' }, {})
  assert.equal(reply.ok, false)
  assert.equal(reply.reasonCode, 'asset-id-missing')
  assert.equal(seen.length, 0, '没有候选时不许"随便挑一张"：service 一次都不该被问')
})

test('图库返回空候选时，投递层不做兜底挑图（没有 assetId 就没有图 part）', () => {
  const planned = plan({ turnId: 't-empty', target: { kind: 'dm', id: 10001 }, draft: '好耶', assetId: null, mode: 'text_then_sticker', now: NOW })
  // 计划器不允许"想发图但没有 assetId"退化成随便一张：它退化成纯文字。
  assert.equal(planned.mode, 'text_only')
  assert.equal(planned.parts.filter(part => part.kind === 'sticker').length, 0)
})

// ── 8. expression_reply 只认候选 assetId ────────────────────────────────────

test('expression_reply 只接受候选 assetId（ast_… 形状），路径/URL 一律在参数层被拒不穿透', async () => {
  const seen = [];
  const handlers = createToolHandlers({
    service: { reply: async (args) => { seen.push(args); return { ok: true, delivered: 1 } } },
  })
  for (const bad of [
    { assetId: '/etc/passwd' },
    { assetId: 'https://cdn.example.com/a.png' },
    { assetId: 'C:\\\\tmp\\\\a.png' },
    { assetId: 'ast_abc123456', file: '/etc/passwd' },
    { assetId: 'ast_abc123456', url: 'https://x/y.png' },
  ]) {
    const result = await handlers.expression_reply(bad, {})
    assert.equal(result.ok, false, `${JSON.stringify(bad)} 必须被拒`)
    assert.ok(
      ['asset-id-invalid', 'path-argument-forbidden'].includes(result.reasonCode),
      `实际原因码：${result.reasonCode}`,
    )
  }
  assert.equal(seen.length, 0, '被拒绝的调用一次都不到达服务层')

  // 正确形状能穿透，并且服务层收到的就是那个 assetId（不是路径）。
  const ok = await handlers.expression_reply({ assetId: 'ast_abc123456', action: 'send' }, {})
  assert.equal(ok.ok, true)
  assert.equal(seen[0].assetId, 'ast_abc123456')
})

// ── 9. 同轮最多一张 ────────────────────────────────────────────────────────

test('同轮最多一张：计划器只接受一个 assetId，两张图构不出来', () => {
  // 正常路径：一个 assetId → 恰好一个 sticker part。
  const one = plan({ turnId: 't-1', target: { kind: 'dm', id: 10001 }, draft: '好耶', assetId: 'ast_abc123456', mode: 'text_then_sticker', now: NOW })
  assert.equal(one.parts.filter(part => part.kind === 'sticker').length, 1)
  // 第二张图没有参数能表达：连"传两个 assetId"的入口都不存在（只有一个 assetId 位）。
  assert.equal(Object.keys(one).includes('assetIds'), false)
})

// ── 10. 无 message_id 不记为已发送、不重试 ──────────────────────────────────

test('发送器不回 message_id：状态记 unknown（不是 confirmed），且后续 part 停止、不重试', async () => {
  await harness(async ({ db, dataRoot, assetsDir, config }) => {
    const file = path.join(assetsDir, 'ast_abc123456.png')
    fs.writeFileSync(file, PNG)
    const bytes = sha(PNG)
    const library = {
      getFileForDelivery: () => ({ ok: true, path: file, sha256: bytes, kind: 'png', mime: 'image/png', scope: OWNER_SCOPE }),
    }
    let calls = 0
    const sender = {
      async sendText() { calls += 1; return { ok: true, messageId: 7 } },
      // 没有 messageId，也没有 ok:true 之外的任何成功证据。
      async sendSticker() { calls += 1; return { ok: true } },
    }
    const planned = plan({ turnId: 't-no-receipt', target: { kind: 'dm', id: 10001 }, draft: '好耶', assetId: 'ast_abc123456', mode: 'sticker_only', now: NOW })
    const scope = OWNER_SCOPE
    const result = await deliver({
      plan: { ...planned, scope, bucketKey: quotaBucketFor({ kind: 'dm', id: 10001, scope }) },
      library, db, config, dataRoot, qqSender: sender, scope, usable: [scope],
      kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW,
    })
    assert.equal(result.ok, false, '没有回执不能算成功')
    assert.equal(calls, 1, '没有回执也不许重试')

    const rows = db.all('SELECT status, provider_message_id, reason_code FROM deliveries')
    assert.equal(rows.length, 1)
    assert.equal(String(rows[0].status), 'unknown', 'unknown 单独成态：它既不是 sent 也不是 confirmed')
    assert.equal(rows[0].provider_message_id, null, '没有回执就记 null，不许编一个')

    // 再投一次同一份计划：已落终态（unknown）的 part 全部跳过，绝不重投。
    const replay = await deliver({
      plan: { ...planned, scope, bucketKey: quotaBucketFor({ kind: 'dm', id: 10001, scope }) },
      library, db, config, dataRoot, qqSender: sender, scope, usable: [scope],
      kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW + 1000,
    })
    assert.equal(calls, 1, '重放同一计划不会再发一次')
    assert.equal(replay.status, 'skipped')
  })
})

test('有 message_id 才算 confirmed（与上一条形成对照：不能把测试写成"永远不成功"）', async () => {
  await harness(async ({ db, dataRoot, assetsDir, config }) => {
    const file = path.join(assetsDir, 'ast_abc123456.png')
    fs.writeFileSync(file, PNG)
    const bytes = sha(PNG)
    const library = {
      getFileForDelivery: () => ({ ok: true, path: file, sha256: bytes, kind: 'png', mime: 'image/png', scope: OWNER_SCOPE }),
    }
    const sender = {
      async sendText() { return { ok: true, messageId: 7 } },
      async sendSticker() { return { ok: true, messageId: 424242 } },
    }
    const planned = plan({ turnId: 't-receipt', target: { kind: 'dm', id: 10001 }, draft: '好耶', assetId: 'ast_abc123456', mode: 'sticker_only', now: NOW })
    const scope = OWNER_SCOPE
    const result = await deliver({
      plan: { ...planned, scope, bucketKey: quotaBucketFor({ kind: 'dm', id: 10001, scope }) },
      library, db, config, dataRoot, qqSender: sender, scope, usable: [scope],
      kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW,
    })
    assert.equal(result.ok, true)
    const row = db.get('SELECT status, provider_message_id FROM deliveries')
    assert.equal(String(row.status), 'confirmed')
    assert.equal(String(row.provider_message_id), '424242', '回执要落库，否则"发过没有"永远说不清')
  })
})
