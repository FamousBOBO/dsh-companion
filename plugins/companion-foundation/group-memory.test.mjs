// group-memory.mjs：群记忆 / 成员记忆 / 话题状态的存储与端口。
//
// 这些用例固定六条“不许退化”的硬规则（group-memory.mjs 文件头逐条写了理由）：
//   1. 跨群不可见 —— A 群写的东西，B 群查不到；缺 groupId 什么都查不到，也什么都删不掉；
//   2. guess 不是事实 —— 推测带显式标记，且**排在最后**，但不丢弃；
//   3. 写入门槛 —— 没有来源消息号就没有记忆；正文超长按码点截断并如实回报；
//   4. 去重 —— 同群同一句话只占一行，来源合并、置信度取 max、kind 取更强的，**异群绝不合并**；
//   5. 话题 TTL —— 过期就当没有（返回 null），但行还在（诊断要看得见）；
//   6. 绝不抛 —— 库文件打不开时每个入口都降级成空结果 / { ok:false }，群聊路径不会因此不回话。
//
// 另外钉住两件结构上的事：每张表都有 group_id NOT NULL（隔离由列约束保证），
// 以及本模块只碰 SQLite 文件，没有网络、没有模型调用、不 import 别的插件。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GROUP_MEMORY_KINDS,
  GROUP_MEMORY_LIMITS,
  GROUP_MEMORY_RELATIVE_FILE,
  GROUP_MEMORY_SCHEMA_SQL,
  createGroupMemoryStore,
  groupMemoryFile,
} from './group-memory.mjs';

const charLen = text => Array.from(String(text ?? '')).length;

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-memory-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 建一个用临时目录的 store。
 *
 * 为什么关库和删目录必须在**同一个** after 钩子里：Windows 上库（以及 -wal/-shm）还开着的时候
 * 删目录会 EPERM。两个独立的 after 钩子按注册顺序跑，先删目录就必红——所以这里自己收尾，
 * 不再用 tempRoot 的那一份清理。
 */
function storeAt(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-memory-test-'));
  const store = createGroupMemoryStore({ root: dir, ...options });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { root: dir, store };
}

test('库落在 <root>/home/group-memory/group-memory.db，目录不存在会自己建', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-memory-test-'));
  const store = createGroupMemoryStore({ root });
  // 先关库再删目录：库（含 -wal/-shm）还开着时删目录在 Windows 上是 EPERM。
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = groupMemoryFile(root);
  assert.equal(file, path.join(path.resolve(root), GROUP_MEMORY_RELATIVE_FILE));
  assert.equal(path.dirname(file).endsWith(path.join('home', 'group-memory')), true);
  // 数据根为空 ⇒ 空串：绝不退回当前目录（相对路径会随 cwd 漂，群记忆漂到哪都不该是隐式的）。
  assert.equal(groupMemoryFile(''), '');
  assert.equal(groupMemoryFile('   '), '');

  assert.equal(store.file, path.join(path.resolve(root), GROUP_MEMORY_RELATIVE_FILE));
  const written = store.writeGroupFact({ groupId: 'g1', content: '群里今天在聊搬家', sourceMessageIds: [501] });
  assert.equal(written.ok, true);
  assert.equal(fs.existsSync(store.file), true, '首次写入时目录与库文件才出现');
});

test('三张表都有 group_id NOT NULL：隔离由列约束保证', t => {
  const { store } = storeAt(t);
  store.writeGroupFact({ groupId: 'g1', content: '一句话', sourceMessageIds: [1] });
  // 直接读文件，确认 DDL 真的落到了盘上（而不是只存在于字符串常量里）。
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(store.file, { readOnly: true });
  try {
    for (const table of ['group_facts', 'member_facts', 'topic_state']) {
      const columns = db.prepare('PRAGMA table_info(' + table + ')').all();
      const groupId = columns.find(column => column.name === 'group_id');
      assert.ok(groupId, table + ' 必须有 group_id 列');
      assert.equal(Number(groupId.notnull), 1, table + '.group_id 必须 NOT NULL');
    }
    const groupColumns = db.prepare('PRAGMA table_info(group_facts)').all().map(column => column.name);
    for (const name of ['content', 'kind', 'confidence', 'topic', 'source_message_ids', 'created_at', 'updated_at', 'dedupe_key']) {
      assert.ok(groupColumns.includes(name), 'group_facts 缺列 ' + name);
    }
    const memberColumns = db.prepare('PRAGMA table_info(member_facts)').all().map(column => column.name);
    assert.ok(memberColumns.includes('member_id'), 'member_facts 必须有 member_id');
    // WAL：并发读（Studio 诊断）不被写入阻塞。
    assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
  } finally {
    db.close();
  }
  // 所有 DDL 都是 IF NOT EXISTS：重开同一个库不会重塑、不会丢行。
  assert.match(GROUP_MEMORY_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS group_facts/);
  assert.match(GROUP_MEMORY_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS member_facts/);
  assert.match(GROUP_MEMORY_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS topic_state/);
  assert.equal(/UNIQUE (s*dedupe_keys*)/.test(GROUP_MEMORY_SCHEMA_SQL), false, '唯一约束必须带 group_id，否则两个群互相顶掉');
});

test('规则 1：跨群不可见 —— A 群写入，B 群查为空（前缀相似的群号也不算同一群）', t => {
  const { store } = storeAt(t);
  store.writeGroupFact({ groupId: 'group-A', content: 'A 群的秘密计划', sourceMessageIds: [11] });
  store.writeMemberFact({ groupId: 'group-A', memberId: 'u1', content: '小王养了猫', sourceMessageIds: [12] });
  store.upsertTopic({ groupId: 'group-A', topic: '周末去哪', startedBy: 'u1' });

  const b = store.query({ groupId: 'group-B', memberIds: ['u1'] });
  assert.deepEqual([...b.group], []);
  assert.deepEqual([...b.member], []);
  assert.equal(b.topic, null);

  // 'group-A' 与 'group-A2' 只差一个字符，也必须是两个群：口径是**完全相等**，不是前缀/LIKE。
  const similar = store.query({ groupId: 'group-A2', memberIds: ['u1'] });
  assert.deepEqual([...similar.group], []);
  assert.deepEqual([...similar.member], []);

  // 缺群号 = 空结果 + 可读原因；**没有**“查全部”的分支。
  const none = store.query({});
  assert.deepEqual([...none.group], []);
  assert.deepEqual([...none.member], []);
  assert.equal(none.topic, null);
  assert.deepEqual([...none.dropped], ['no-group']);
  assert.equal(none.reason, 'no-group');
  assert.deepEqual([...store.query().group], [], '连参数都不传也不能炸');
});

test('规则 1：缺 groupId 时写入被拒、忘记群不删任何行', t => {
  const { store } = storeAt(t);
  assert.deepEqual(store.writeGroupFact({ content: '没有群号的事实', sourceMessageIds: [1] }), { ok: false, reason: 'no-group' });
  assert.deepEqual(store.writeMemberFact({ memberId: 'u1', content: '没有群号的事实', sourceMessageIds: [1] }), { ok: false, reason: 'no-group' });
  assert.equal(store.writeGroupFact({ groupId: '   ', content: 'x', sourceMessageIds: [1] }).reason, 'no-group');

  store.writeGroupFact({ groupId: 'g1', content: '有群号的事实', sourceMessageIds: [2] });
  store.upsertTopic({ groupId: 'g1', topic: '聊点什么' });
  // 把‘忘记传参’解释成‘清空所有群’是不可逆事故，所以这里是 ok:false 且零删除。
  const forgot = store.forgetGroup('');
  assert.equal(forgot.ok, false);
  assert.equal(forgot.reason, 'no-group');
  assert.equal(forgot.total, 0);
  assert.equal(store.status().facts, 1, '别的群的行必须还在');
  assert.equal(store.status().topics, 1);
  assert.equal(store.clearTopic('').ok, false);
});

test('成员维与群维分开：各自有自己的表和召回位置，成员号必须点名', t => {
  const { store } = storeAt(t);
  store.writeGroupFact({ groupId: 'g1', content: '这个群约了周六爬山', kind: 'explicit', sourceMessageIds: [101] });
  store.writeMemberFact({ groupId: 'g1', memberId: 'u1', content: '小王膝盖有伤', kind: 'explicit', sourceMessageIds: [102] });
  store.writeMemberFact({ groupId: 'g1', memberId: 'u2', content: '小李有车', kind: 'explicit', sourceMessageIds: [103] });

  const all = store.query({ groupId: 'g1', memberIds: ['u1', 'u2'] });
  assert.deepEqual(all.group.map(e => e.content), ['这个群约了周六爬山']);
  assert.equal(all.group[0].scope, 'group');
  assert.deepEqual(all.member.map(e => e.content).sort(), ['小李有车', '小王膝盖有伤'].sort());
  for (const evidence of all.member) {
    assert.equal(evidence.scope, 'member');
    assert.equal(evidence.groupId, 'g1');
    assert.equal(typeof evidence.memberId, 'string');
  }
  assert.equal('memberId' in all.group[0], false, '群维证据不带 memberId：那会让消费端以为它是某人的事');

  // 只点名 u1 时，u2 的成员事实不该出现（绝不隐式扩大成“这个群的所有成员”）。
  const onlyU1 = store.query({ groupId: 'g1', memberIds: ['u1'] });
  assert.deepEqual(onlyU1.member.map(e => e.content), ['小王膝盖有伤']);

  // 不点名成员：成员维必然为空，原因写进 dropped（诊断上看得出“不是我忘了这点”）。
  const noMembers = store.query({ groupId: 'g1' });
  assert.deepEqual([...noMembers.member], []);
  assert.ok(noMembers.dropped.includes('no-members'));

  // 成员事实没有成员号 ⇒ 拒绝，而不是退化成群事实。
  assert.deepEqual(
    store.writeMemberFact({ groupId: 'g1', content: '不知道是谁的事', sourceMessageIds: [104] }),
    { ok: false, reason: 'no-member' },
  );
  assert.equal(store.status().facts, 1, '被拒的写入不能变成群事实');
  assert.equal(store.status().memberFacts, 2);
});

test('规则 2：guess 带 speculative 标记，并排在最后（即使它更新）', t => {
  let clock = Date.parse('2026-11-08T10:00:00.000Z');
  const { store } = storeAt(t, { now: () => clock });

  // 故意先写事实、后写推测：如果排序只看时间，推测会排在最前。
  store.writeGroupFact({ groupId: 'g1', content: '她说过自己住在城里', kind: 'explicit', sourceMessageIds: [1] });
  clock += 60_000;
  store.writeGroupFact({ groupId: 'g1', content: '大家最近在聊露营', kind: 'observed', sourceMessageIds: [2] });
  clock += 60_000;
  store.writeGroupFact({ groupId: 'g1', content: '她可能喜欢露营', kind: 'guess', sourceMessageIds: [3] });

  const result = store.query({ groupId: 'g1' });
  const kinds = result.group.map(e => e.kind);
  assert.deepEqual(kinds, ['explicit', 'observed', 'guess'], '确定性等级在前，新近度在后');
  assert.deepEqual(result.group.map(e => e.speculative), [false, false, true]);
  // 不丢弃：推测要能被诊断看到（否则“她以为事情是这样的”永远查不出来）。
  assert.equal(result.group.length, 3);
  assert.match(result.group[2].content, /可能/);

  // limit 剪枝先剪推测：把上限压到 1 时留下的是最硬的那条。
  const top1 = store.query({ groupId: 'g1', limit: 1 });
  assert.deepEqual(top1.group.map(e => e.content), ['她说过自己住在城里']);
  assert.ok(top1.dropped.some(entry => entry.startsWith('over-limit:')), '被裁掉的条数要能看见');
});

test('规则 3：没有来源消息号就不写；正文超长按码点截断并回报 truncated', t => {
  const { store } = storeAt(t);
  assert.deepEqual(
    store.writeGroupFact({ groupId: 'g1', content: '没来源的一句话' }),
    { ok: false, reason: 'no-source' },
  );
  assert.deepEqual(
    store.writeGroupFact({ groupId: 'g1', content: '空数组也不算来源', sourceMessageIds: [] }),
    { ok: false, reason: 'no-source' },
  );
  assert.equal(
    store.writeGroupFact({ groupId: 'g1', content: '来源全是垃圾', sourceMessageIds: [null, '', '   ', NaN] }).reason,
    'no-source',
  );
  assert.equal(store.writeGroupFact({ groupId: 'g1', content: '   ', sourceMessageIds: [1] }).reason, 'empty-content');
  assert.equal(store.writeGroupFact({ groupId: 'g1', content: 'x', kind: 'definitely', sourceMessageIds: [1] }).reason, 'invalid-kind');
  assert.equal(store.status().facts, 0, '被拒的写入一行都不许留下');

  const long = '长'.repeat(GROUP_MEMORY_LIMITS.content + 50);
  const truncated = store.writeGroupFact({ groupId: 'g1', content: long, sourceMessageIds: [7] });
  assert.equal(truncated.ok, true);
  assert.equal(truncated.reason, 'truncated', '截断必须回报，不能静默');
  const saved = store.query({ groupId: 'g1' }).group[0];
  assert.equal(charLen(saved.content), GROUP_MEMORY_LIMITS.content);
  // 码点截断：emoji 不能被劈成半个代理对。
  const emoji = store.writeGroupFact({ groupId: 'g1', content: '🎈'.repeat(GROUP_MEMORY_LIMITS.content + 5), sourceMessageIds: [8] });
  assert.equal(emoji.ok, true);
  const emojiSaved = store.query({ groupId: 'g1' }).group.find(e => e.content.startsWith('🎈'));
  assert.equal(charLen(emojiSaved.content), GROUP_MEMORY_LIMITS.content);
  assert.equal(emojiSaved.content.includes('\uFFFD'), false);
});

test('规则 4：同群同一句话只占一行，来源合并、置信度取 max、kind 取更强的', t => {
  const { store } = storeAt(t);
  const first = store.writeGroupFact({
    groupId: 'g1', content: '小王周六搬家', kind: 'observed', confidence: 0.4, sourceMessageIds: [501],
  });
  assert.equal(first.ok, true);
  assert.equal(first.reason, undefined);

  // 标点、空白差异都算同一件事；新来源追加，置信度取高，kind 由 observed 升到 explicit。
  const second = store.writeGroupFact({
    groupId: 'g1', content: '小王 周六 搬家。', kind: 'explicit', confidence: 0.9, sourceMessageIds: [502, 501],
  });
  assert.equal(second.ok, true);
  assert.equal(second.reason, 'merged');
  assert.equal(second.id, first.id, '合并而不是新增行');

  const rows = store.query({ groupId: 'g1' }).group;
  assert.equal(rows.length, 1, '重复的一句话不许变成两行把 limit 挤满');
  assert.deepEqual(rows[0].sourceMessageIds, [501, 502], '来源合并、去重、保序');
  assert.equal(rows[0].confidence, 0.9);
  assert.equal(rows[0].kind, 'explicit');

  // 更强的 kind 不会被后来更弱的推测降级（同一句话被“猜”一次不该抹掉明确陈述）。
  store.writeGroupFact({ groupId: 'g1', content: '小王周六搬家', kind: 'guess', confidence: 0.1, sourceMessageIds: [503] });
  const after = store.query({ groupId: 'g1' }).group[0];
  assert.equal(after.kind, 'explicit');
  assert.equal(after.speculative, false);
  assert.deepEqual(after.sourceMessageIds, [501, 502, 503]);

  // 异群绝不合并：同一句话在另一个群必须是**另一行**（否则 A 群的事实会被写成 B 群的）。
  const other = store.writeGroupFact({ groupId: 'g2', content: '小王周六搬家', kind: 'explicit', sourceMessageIds: [901] });
  assert.equal(other.ok, true);
  assert.equal(other.reason, undefined);
  assert.notEqual(other.id, first.id);
  assert.deepEqual(store.query({ groupId: 'g2' }).group[0].sourceMessageIds, [901]);
  assert.equal(store.status().facts, 2);
});

test('规则 5：话题 TTL —— 过期返回 null（行还在），ttlMs 被夹进 [60s, 6h]', t => {
  let clock = Date.parse('2026-11-08T10:00:00.000Z');
  const { store } = storeAt(t, { now: () => clock });

  const started = store.upsertTopic({ groupId: 'g1', topic: '周末去哪玩', startedBy: 'u1', participants: ['u1'] });
  assert.equal(started.ok, true);
  assert.equal(started.topic.topic, '周末去哪玩');
  assert.equal(started.topic.expired, false);
  assert.equal(Date.parse(started.topic.expiresAt) - clock, GROUP_MEMORY_LIMITS.topicTtlMs, '默认 30 分钟');

  // 同一个话题继续推进：参与者并集、不换发起人、TTL 从“现在”重新算。
  clock += 10 * 60_000;
  const advanced = store.upsertTopic({ groupId: 'g1', topic: '周末 去哪玩', startedBy: 'u2', participants: ['u2'] });
  assert.deepEqual([...advanced.topic.participants], ['u1', 'u2']);
  assert.equal(advanced.topic.startedBy, 'u1', '发起人不随接口的人变');
  assert.equal(Date.parse(advanced.topic.expiresAt) - clock, GROUP_MEMORY_LIMITS.topicTtlMs);

  // 换话题：参与者与发起人一起换（留着上一轮的人会把“现在是谁在聊”记错）。
  const switched = store.upsertTopic({ groupId: 'g2', topic: '聊聊游戏', startedBy: 'u9' });
  assert.deepEqual([...switched.topic.participants], []);

  // TTL 夹取：0 与一天都被夹进 [60s, 6h]。
  const tiny = store.upsertTopic({ groupId: 'g3', topic: '短', ttlMs: 0 });
  assert.equal(Date.parse(tiny.topic.expiresAt) - clock, GROUP_MEMORY_LIMITS.topicTtlMs, '0 按默认处理');
  const oneMinute = store.upsertTopic({ groupId: 'g4', topic: '一分钟', ttlMs: 1000 });
  assert.equal(Date.parse(oneMinute.topic.expiresAt) - clock, GROUP_MEMORY_LIMITS.topicTtlMinMs);
  const oneDay = store.upsertTopic({ groupId: 'g5', topic: '一天', ttlMs: 24 * 60 * 60 * 1000 });
  assert.equal(Date.parse(oneDay.topic.expiresAt) - clock, GROUP_MEMORY_LIMITS.topicTtlMaxMs);
  assert.equal(store.upsertTopic({ groupId: 'g1', topic: '   ' }).reason, 'empty-topic');
  assert.equal(store.upsertTopic({ topic: '没有群号' }).reason, 'no-group');

  // 越过 expires_at：契约里的 topicState 返回 null，但行还在（诊断要看得见）。
  clock += GROUP_MEMORY_LIMITS.topicTtlMs + 1;
  assert.equal(store.topicState('g1'), null);
  assert.equal(store.query({ groupId: 'g1' }).topic, null);
  const diagnostic = store.topicState('g1', { includeExpired: true });
  // 推进时给的是「周末 去哪玩」，规范化后与原文「周末去哪玩」同一个话题，于是**保留首次的原文**
  // ——诊断里读到的是大家一开始说的那个话题，而不是某次接口时的空格差异。
  assert.equal(diagnostic.topic, '周末去哪玩');
  assert.equal(diagnostic.expired, true);
  assert.equal(store.status().topics, 5, '过期不清表：诊断需要“最后一个话题是什么、何时过期”');
  // 其他群的话题各算各的，不会被这个群的时间推进影响（g3 是默认 30 分钟，也一起过期了；
  // g5 是 6 小时，仍然活着）。
  assert.equal(store.topicState('g5')?.topic, '一天');
});

test('clearTopic 只清话题，不动任何事实', t => {
  const { store } = storeAt(t);
  store.upsertTopic({ groupId: 'g1', topic: '临时话题' });
  store.writeGroupFact({ groupId: 'g1', content: '一件事实', sourceMessageIds: [1] });
  const cleared = store.clearTopic('g1');
  assert.deepEqual(cleared, { ok: true, removed: 1 });
  assert.equal(store.topicState('g1'), null);
  assert.equal(store.status().facts, 1);
  assert.equal(store.clearTopic('g1').removed, 0, '再清一次是无害的空操作');
});

test('forgetGroup 把三张表里该群的行删干净，其他群一行不动', t => {
  const { store } = storeAt(t);
  store.writeGroupFact({ groupId: 'g1', content: 'A 事实', sourceMessageIds: [1] });
  store.writeGroupFact({ groupId: 'g1', content: 'B 事实', sourceMessageIds: [2] });
  store.writeMemberFact({ groupId: 'g1', memberId: 'u1', content: 'A 成员事实', sourceMessageIds: [3] });
  store.upsertTopic({ groupId: 'g1', topic: 'A 话题' });
  store.writeGroupFact({ groupId: 'g2', content: '另一个群的事实', sourceMessageIds: [4] });
  store.upsertTopic({ groupId: 'g2', topic: '另一个群的话题' });

  const removed = store.forgetGroup('g1');
  assert.equal(removed.ok, true);
  assert.deepEqual(
    { groupFacts: removed.groupFacts, memberFacts: removed.memberFacts, topics: removed.topics, total: removed.total },
    { groupFacts: 2, memberFacts: 1, topics: 1, total: 4 },
  );
  const gone = store.query({ groupId: 'g1', memberIds: ['u1'] });
  assert.deepEqual([...gone.group], []);
  assert.deepEqual([...gone.member], []);
  assert.equal(gone.topic, null);
  assert.equal(store.topicState('g1', { includeExpired: true }), null, '过期标记也不该留在这个群上');

  const kept = store.query({ groupId: 'g2' });
  assert.deepEqual(kept.group.map(e => e.content), ['另一个群的事实']);
  assert.equal(kept.topic.topic, '另一个群的话题');
  assert.deepEqual(store.status(), {
    groups: 1, facts: 1, memberFacts: 0, topics: 1, file: store.file, degraded: false, reason: '',
  });
});

test('库文件打不开：每个入口都降级、绝不抛', t => {
  const root = tempRoot(t);
  const blocker = path.join(root, 'blocked');
  fs.writeFileSync(blocker, 'this is a file, not a directory');
  // 这个路径的父目录是个文件，mkdir/打开都必然失败。
  const store = createGroupMemoryStore({ file: path.join(blocker, 'group-memory.db') });
  t.after(() => store.close());

  assert.deepEqual(store.writeGroupFact({ groupId: 'g1', content: 'x', sourceMessageIds: [1] }), { ok: false, reason: 'open-failed' });
  assert.deepEqual(store.writeMemberFact({ groupId: 'g1', memberId: 'u1', content: 'x', sourceMessageIds: [1] }), { ok: false, reason: 'open-failed' });
  const queried = store.query({ groupId: 'g1', memberIds: ['u1'] });
  assert.deepEqual([...queried.group], []);
  assert.deepEqual([...queried.member], []);
  assert.equal(queried.topic, null);
  assert.deepEqual([...queried.dropped], ['degraded']);
  assert.equal(queried.reason, 'open-failed');
  assert.equal(store.upsertTopic({ groupId: 'g1', topic: 'x' }).ok, false);
  assert.equal(store.topicState('g1'), null);
  assert.equal(store.clearTopic('g1').ok, false);
  assert.equal(store.forgetGroup('g1').ok, false);
  assert.equal(store.status().degraded, true);
  assert.equal(store.status().reason, 'open-failed');
  store.close();
  store.close(); // 幂等

  // 没配路径同理：空串 = 没配置 = 永久降级，绝不“写到当前目录”。
  const noFile = createGroupMemoryStore({});
  t.after(() => noFile.close());
  assert.equal(noFile.file, '');
  assert.equal(noFile.status().degraded, true);
  assert.equal(noFile.status().reason, 'no-file');
  assert.equal(noFile.query({ groupId: 'g1' }).reason, 'no-file');
});

test('一次偶发失败不把整个库永久关掉（只有“打不开”才永久降级）', t => {
  const { store } = storeAt(t);
  store.writeGroupFact({ groupId: 'g1', content: '这条要活过一次故障', sourceMessageIds: [1] });

  // 从**外部**连接把表删掉：这是一个真实的“偶发读失败”，不是注入的假异常。
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const outside = new DatabaseSync(store.file);
  outside.exec('DROP TABLE group_facts');
  outside.close();

  const failed = store.query({ groupId: 'g1' });
  assert.deepEqual([...failed.group], [], '失败时回空结果');
  assert.equal(failed.reason, 'read-failed');

  // 表回来了（真实场景：另一次写入重建、用户恢复备份），同一个 store 必须**自己恢复**。
  // 如果一次读失败就置位“永久降级”，群聊里没人会去重启插件，这个群的记忆就永久没了。
  const repair = new DatabaseSync(store.file);
  repair.exec(GROUP_MEMORY_SCHEMA_SQL);
  repair.close();

  store.writeGroupFact({ groupId: 'g1', content: '故障之后仍然能写', sourceMessageIds: [2] });
  const recovered = store.query({ groupId: 'g1' });
  // 旧那一行随表一起被外部 DROP 掉了（那是外部损坏，不该由本模块负责找回），
  // 要钉住的是**同一个 store 自己恢复可用**，而不是它凭空恢复数据。
  assert.deepEqual(recovered.group.map(e => e.content), ['故障之后仍然能写']);
  assert.equal(recovered.reason, '');
  assert.equal(store.status().degraded, false);
  assert.equal(store.writeGroupFact({ groupId: 'g1', content: '还是会去重', sourceMessageIds: [3] }).ok, true);
});

test('重开同一个库：数据还在，DDL 可重复执行', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-memory-test-'));
  const opened = [];
  // 两个句柄都要先关掉才能删目录（Windows 上开着的 -wal 会挡住 rm）。
  t.after(() => {
    for (const store of opened) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const first = createGroupMemoryStore({ root });
  opened.push(first);
  first.writeGroupFact({ groupId: 'g1', content: '重开以后还要在', kind: 'explicit', sourceMessageIds: [42] });
  first.writeMemberFact({ groupId: 'g1', memberId: 'u1', content: '成员事实也要在', sourceMessageIds: [43] });
  first.upsertTopic({ groupId: 'g1', topic: '还在聊', participants: ['u1'] });
  const beforeStatus = first.status();
  first.close();

  const second = createGroupMemoryStore({ root });
  opened.push(second);
  assert.equal(second.file, first.file);
  const rows = second.query({ groupId: 'g1', memberIds: ['u1'] });
  assert.deepEqual(rows.group.map(e => e.content), ['重开以后还要在']);
  assert.deepEqual(rows.group[0].sourceMessageIds, [42]);
  assert.deepEqual(rows.member.map(e => e.content), ['成员事实也要在']);
  assert.equal(rows.topic.topic, '还在聊');
  assert.deepEqual(second.status(), beforeStatus);

  // 重开之后再写，仍然按 dedupe_key 合并（唯一约束跨进程打开也成立）。
  const again = second.writeGroupFact({ groupId: 'g1', content: '重开以后还要在。', sourceMessageIds: [44] });
  assert.equal(again.reason, 'merged');
  assert.deepEqual(second.query({ groupId: 'g1' }).group[0].sourceMessageIds, [42, 44]);
});

test('query 的 query 参数做本地子串匹配（不把正文里的 % 与 _ 当通配符）', t => {
  const { store } = storeAt(t);
  store.writeGroupFact({ groupId: 'g1', content: '进度 100% 了', sourceMessageIds: [1] });
  store.writeGroupFact({ groupId: 'g1', content: '想买 a_b 型号', sourceMessageIds: [2] });
  store.writeGroupFact({ groupId: 'g1', content: '完全不相干的一句', sourceMessageIds: [3] });

  assert.deepEqual(store.query({ groupId: 'g1', query: '%' }).group.map(e => e.content), ['进度 100% 了']);
  assert.deepEqual(store.query({ groupId: 'g1', query: 'a_b' }).group.map(e => e.content), ['想买 a_b 型号']);
  // 下划线不该变成“任意一个字符”：'aXb' 不是命中。
  assert.deepEqual([...store.query({ groupId: 'g1', query: 'aXb' }).group], []);
  assert.equal(store.query({ groupId: 'g1' }).group.length, 3, '不给 query 时全给（仍受 limit 约束）');
});

test('kind 只有 explicit / observed / guess 三档，未知值直接拒（不猜）', t => {
  assert.deepEqual([...GROUP_MEMORY_KINDS], ['explicit', 'observed', 'guess']);
  const { store } = storeAt(t);
  for (const kind of GROUP_MEMORY_KINDS) {
    const written = store.writeGroupFact({ groupId: 'g1', content: '关于 ' + kind, kind, sourceMessageIds: [1] });
    assert.equal(written.ok, true, kind + ' 必须可写');
  }
  for (const kind of ['fact', 'EXPLICIT', '推测', 0, null]) {
    assert.equal(
      store.writeGroupFact({ groupId: 'g1', content: '关于 ' + String(kind), kind, sourceMessageIds: [2] }).reason,
      'invalid-kind',
      'kind=' + String(kind) + ' 必须被拒',
    );
  }
  // 缺省 kind 按 observed：写入口最保守的默认，而不是猜成 explicit。
  const defaultKind = store.writeGroupFact({ groupId: 'g1', content: '没说是什么类型', sourceMessageIds: [3] });
  assert.equal(defaultKind.ok, true);
  const row = store.query({ groupId: 'g1' }).group.find(e => e.content === '没说是什么类型');
  assert.equal(row.kind, 'observed');
  assert.equal(row.confidence, 0.6);
});

test('纯结构：只碰 SQLite 文件，没有网络、没有模型调用、不 import 别的插件', async () => {
  const raw = fs.readFileSync(new URL('./group-memory.mjs', import.meta.url), 'utf8');
  // 注释里当然会提到 companion-memory（文件头就在解释为什么不复用它），所以只扫**代码**：
  // 去掉行注释与块注释之后再断言，避免这条用例变成“不许解释自己”。
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /fetch\(|node:http|node:https|node:net|undici/);
  // 不 import 任何兄弟插件：群记忆坏了不能把聊天一起弄坏。
  const imports = [...code.matchAll(/^import .* from '([^']+)';/gm)].map(match => match[1]);
  assert.deepEqual([...new Set(imports)].sort(), ['node:crypto', 'node:fs', 'node:path']);
  assert.doesNotMatch(code, /companion-memory|dsh-channel-qq|companion-group/);
  assert.equal(typeof createGroupMemoryStore, 'function');
});
