// 只读核对：频道（群聊）这条链路的每一步在**真实平台数据**上都能跑通。
//
// 为什么需要它：单测用的是手写的行，真实平台会给出单测里想不到的东西（字段名、排序、
// 成员表形状、空频道、401）。这些差异恰好是"上下文永远是空的"这类故障的来源。
//
// 这个脚本**不驱动模型、不发消息**：只读 history、读频道详情、写一个临时目录里的
// rooms.json，然后把门控与渲染的结果打出来。它回答的是"链路能跑"，不是"她能聊得好"。
//
// 输出纪律：正文只打前 40 字；`at` 与 `mid` 照原样，因为排障要靠它们。
//
// 用法：
//   node scripts/verify-group-chain.mjs             # gid=1
//   node scripts/verify-group-chain.mjs 3           # 指定频道

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PLUGIN = path.resolve(HERE, '..');
const TRANSPORT = path.resolve(PLUGIN, '..', 'dsh-channel-vocechat');

const BASE = process.env.VOICECHAT_BASE_URL || 'http://127.0.0.1:3009';
const UID = Number(process.env.VOICECHAT_UID || 4) || 4;
const DEVICE = process.env.VOICECHAT_DEVICE || 'dsh-companion';
const DB = process.env.VOICECHAT_DB || 'D:/DSH/vocechat/vocechat-data/db/db.sqlite';

const gid = Number(process.argv[2] ?? 1) || 1;

const fail = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail.push(name);
}

async function main() {
  const { createAuth } = await import(`file:///${path.join(TRANSPORT, 'auth.mjs').replace(/\\/g, '/')}`);
  const { fetchContext, contextBlock } = await import(`file:///${path.join(PLUGIN, 'history.mjs').replace(/\\/g, '/')}`);
  const { createGate, idList, resolveGroup } = await import(`file:///${path.join(PLUGIN, 'gate.mjs').replace(/\\/g, '/')}`);
  const { createRoomState } = await import(`file:///${path.join(PLUGIN, 'room-state.mjs').replace(/\\/g, '/')}`);
  const { segmentationFor, channelPolicy, resolveSegmentation, inboundBatch } = await import(
    `file:///${path.join(PLUGIN, 'index.mjs').replace(/\\/g, '/')}`
  );

  const auth = createAuth({ baseUrl: BASE, uid: UID, deviceName: DEVICE, dbFile: DB });
  const token = await auth.token();
  if (!token) throw new Error('拿不到 access token');
  const call = async p => {
    const response = await fetch(`${BASE}${p}`, { headers: { 'x-api-key': token } });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 不是 JSON 也照样往下走，交给断言 */ }
    return { status: response.status, text, json };
  };

  // ── 1. 频道详情与成员表（门控这一档的事实来源）───────────────────────
  const detail = await call(`/api/group/${gid}`);
  check('频道详情 200', detail.status === 200, `status=${detail.status}`);
  const members = Array.isArray(detail.json?.members)
    ? detail.json.members.map(Number).filter(n => Number.isInteger(n) && n >= 1)
    : [];
  check('成员表是非空 id 数组', members.length > 0, `members=${JSON.stringify(members)}`);
  const port = {
    history: async (target, options) => {
      const p = target.channel !== undefined
        ? `/api/group/${target.channel}/history?limit=${options?.limit ?? 20}`
        : `/api/user/${target.user}/history?limit=${options?.limit ?? 20}`;
      const result = await call(p);
      if (result.status !== 200) throw Object.assign(new Error(`history ${result.status}`), { code: `http-${result.status}` });
      if (!Array.isArray(result.json)) throw Object.assign(new Error('not array'), { code: 'bad-response' });
      return result.json;
    },
    channel: async id => {
      const result = await call(`/api/group/${id}`);
      if (result.status !== 200) throw Object.assign(new Error(`channel ${result.status}`), { code: `http-${result.status}` });
      return result.json;
    },
    send: async () => { throw new Error('只读核对脚本不允许发送'); },
  };

  // ── 2. 上下文：映射 / 过滤 / 排序 / 渲染 ───────────────────────────────
  const limit = 20;
  const context = await fetchContext({ port, target: { channel: gid }, limit, selfUid: UID });
  check('历史能取到并映射成功', context.reason === 'ok' || context.reason === 'no-history', `reason=${context.reason} rows=${context.rows}`);
  check('渲染行数与取回行数一致', context.lines.length === context.rows);
  const mids = context.lines.map(line => Number(/^\[(\d+)\]/.exec(line)?.[1])).filter(Number.isInteger);
  check('渲染行按 mid 升序（不信任平台顺序）', mids.every((mid, i) => i === 0 || mid > mids[i - 1]), `mids=${mids.join(',')}`);
  check('渲染行都带 uid 标签', context.lines.every(line => /uid:\d+|uid:\?/.test(line)));
  check('自己发的标了「你自己」', context.lines.every(line => !line.includes(`uid:${UID}：`) || line.includes('你自己')));
  console.log('  上下文样例行：');
  for (const line of context.lines.slice(-3)) {
    console.log(`    ${line.length > 60 ? `${line.slice(0, 60)}…` : line}`);
  }

  const block = contextBlock(context.lines, null);
  check('上下文段有头有尾', block.length === 0 || (block.length >= 3 && block.at(-1) === '——'));

  // ── 3. 水位：rooms.json 读写与"只增不减" ───────────────────────────────
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-chain-'));
  const rooms = createRoomState({ dataRoot: tmpRoot });
  const room = `vc-chan-${gid}`;
  check('没有水位时返回 null', rooms.watermarkOf(room) === null);
  const topMid = mids.at(-1) ?? 0;
  check('noteSent 推进水位', rooms.noteSent(room, topMid) === true, `mid=${topMid}`);
  check('重投旧 mid 不让水位倒退', rooms.noteSent(room, Math.max(1, topMid - 1)) === false);
  check('水位持久化到 rooms.json', fs.existsSync(path.join(tmpRoot, 'home', 'vocechat-adapter', 'rooms.json')));
  const reopened = createRoomState({ dataRoot: tmpRoot });
  check('重新打开后水位仍在（跨重启）', reopened.watermarkOf(room) === topMid);
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  // ── 4. 门控：真实成员表 + 概率 ─────────────────────────────────────────
  const gate = createGate({
    allowUsers: idList([1]),
    allowGroups: idList([gid]),
    selfUid: UID,
    group: resolveGroup({ talkProbability: 1 }),
  });
  const memberUid = members.find(id => id !== UID) ?? members[0];
  const event = uid => ({
    kind: 'chat', mid: 1, fromUid: uid, target: { channel: gid }, content: 'hi', contentType: 'text/plain',
  });
  check('成员能触发（不在 allowUsers 里也一样）', gate.decideChannel(event(memberUid), { isMember: true }).allow === true);
  check('调过工具的非成员被拒', gate.decideChannel(event(9999), { isMember: false }).reason === 'not-a-member:9999');
  check('成员表不可用时白名单外被拒', gate.decideChannel(event(9999), { isMember: null }).reason === 'members-unavailable:9999');
  check('自己发的回声被丢弃', gate.decideChannel(event(UID), { isMember: true }).reason === 'from-self');

  const half = createGate({ allowUsers: idList([1]), allowGroups: idList([gid]), selfUid: UID, group: resolveGroup({ talkProbability: 0.3 }) });
  const skipped = half.decideChannel(event(memberUid), { isMember: true, roll: () => 0.9 });
  check('概率跳过带可读原因', skipped.allow === false && skipped.reason === 'chance-skip:0.3', skipped.reason);

  // ── 5. 表达：分段档与提示词 ────────────────────────────────────────────
  const config = {
    sendMaxChars: 4000,
    segmentation: resolveSegmentation({}),
    group: resolveGroup({}),
  };
  check('频道 3 段 / 120 字', segmentationFor(config, room).maxSegments === 3 && segmentationFor(config, room).maxChars === 120);
  check('私聊 6 段 / 无字数上限', segmentationFor(config, `vc-dm-${memberUid}`).maxSegments === 6 && segmentationFor(config, `vc-dm-${memberUid}`).maxChars === undefined);
  const policy = channelPolicy(room, config);
  check('群聊提示词含"多人/短/可不说话"', /多人频道/.test(policy) && /最多 3 条/.test(policy) && /被触发不等于必须发言/.test(policy));
  check('私聊提示词不含群聊三句', !/多人频道/.test(channelPolicy(`vc-dm-${memberUid}`, config)));

  // ── 6. 入站包：真实行拼进去之后结构仍然正确 ───────────────────────────
  const inboundEvent = { ...event(memberUid), mid: topMid + 1, content: '这一句是这次要回的' };
  const packed = inboundBatch([inboundEvent], block);
  check('入站包含发言人标签', packed.includes(`uid:${memberUid}：这一句是这次要回的`));
  check('入站包里历史在正文之前', block.length === 0 || packed.indexOf('——') < packed.indexOf('这一句是这次要回的'));

  console.log('');
  if (fail.length === 0) {
    console.log('全部通过：链路每一步都在真实数据上跑通了。');
  } else {
    console.log(`失败 ${fail.length} 项：${fail.join(' / ')}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(String(error?.stack ?? error).slice(0, 800));
  process.exitCode = 1;
});
