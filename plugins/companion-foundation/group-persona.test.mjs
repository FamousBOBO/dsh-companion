// group-persona.mjs：群聊可见人格快照端口。
//
// 这些用例固定四条「不许退化」的性质：
//   1. 没有人格文件时 get() 是 null，**不抛** —— 群聊路径上不能因为一次 fs 异常就不说话；
//   2. 抽取按标题白名单走，字段长度与总量都有上限，抽不到就留空，不编造；
//   3. 改一个字 version 就变（热更新的判据）；
//   4. 私聊/记忆类小节的内容**不会**进快照（边界取舍见 group-persona.mjs 文件头）：
//      靠的是「来源 + 标题级白名单/否决」，不是正文关键词过滤。本文件同时钉住两个方向：
//      标题标明私事的小节里出现「主人」「密码」⇒ 快照里没有；被抽取的小节正文里出现同一个词
//      ⇒ 原样保留（那正是「不做正文过滤」这个取舍的可见证据，谁想改成过滤，得先改这里并说明）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GROUP_PERSONA_LIMITS,
  GROUP_PERSONA_PORT_SYMBOL,
  GROUP_PERSONA_SERVICE_NAME,
  buildGroupPersonaSnapshot,
  createGroupPersonaPort,
  groupPersonaRegistryKeys,
  personaSourceLabel,
  publishGroupPersonaPort,
  publishGroupPersonaService,
  resolveGroupPersonaPort,
} from './group-persona.mjs';
import { createServiceBridge } from './service-bridge.mjs';
import { publishHealthService } from './health-service-ref.mjs';

const charLen = text => Array.from(String(text ?? '')).length;

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-persona-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 一份「像真的」的人格文件：既有可公开的小节，也有只属于私聊的小节。 */
const PERSONA_MD = [
  '# 人格',
  '',
  '## 身份',
  '',
  '- 名字：**小满**',
  '- 你是什么：用户自建的 AI 陪伴助手。',
  '- 你和用户的关系：用户设定为朋友。',
  '',
  '## 性格',
  '',
  '- 说话自然、口语化。',
  '- 有自己的偏好，不刻意讨好。',
  '',
  '## 说话风格',
  '',
  '- 语言：中文为主。',
  '- 长度：一到三句。',
  '',
  '## 兴趣',
  '',
  '- 逛旧书店',
  '- 收集老唱片',
  '',
  '## 边界',
  '',
  '- 不假装自己是真人。',
  '- 不替用户做决定。',
  '',
  '## 私聊里才可以说的事',
  '',
  '- 主人的称呼是「阿岚」，QQ 是 10001。',
  '- 主人的家里WiFi密码是 hunter2。',
  '',
  '## 记忆里希望保留什么',
  '',
  '- 主人的作息、正在做的事。',
  '- 主人说过的私聊内容。',
  '',
].join('\n');

test('人格文件缺失：get() 返回 null，且绝不抛', t => {
  const root = tempRoot(t);
  // 裸挂载（没有 suitePaths）时的兜底路径是 <root>/workspace/PERSONA.md，它不存在。
  const port = createGroupPersonaPort({ root });
  assert.equal(port.get(), null);
  // suitePaths 明确说「没有找到人格文件」时也是 null，而不是空串对象。
  const viaSuite = createGroupPersonaPort({ root, suitePaths: { personaFile: null, personaSource: 'missing', personaId: 'bot' } });
  assert.equal(viaSuite.get(), null);
  // 文件存在但读不了（这里用一个目录冒充文件）同样只回 null。
  fs.mkdirSync(path.join(root, 'workspace', 'PERSONA.md'), { recursive: true });
  assert.equal(port.get(), null);
  // personaFile 指向不存在的绝对路径：null，不抛。
  assert.equal(createGroupPersonaPort({ root, personaFile: path.join(root, 'nope.md') }).get(), null);
});

test('正常 markdown：按标题抽出各字段，且都受长度上限约束', t => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace', 'PERSONA.md'), PERSONA_MD, 'utf8');

  const snapshot = createGroupPersonaPort({ root, personaId: 'bot' }).get();
  assert.ok(snapshot, '有人格文件就必须有快照');
  assert.equal(snapshot.personaId, 'bot');
  assert.equal(snapshot.publicOnly, true);
  assert.equal(snapshot.source, 'workspace/PERSONA.md');
  assert.match(snapshot.version, /^[0-9a-f]{8}$/, 'version 是 8 位短哈希，与 autonomy-materials 的格式一致');

  assert.match(snapshot.identity, /小满/);
  assert.match(snapshot.identity, /AI 陪伴助手/);
  assert.match(snapshot.personality, /口语化/);
  assert.match(snapshot.speakingStyle, /中文为主/);
  assert.deepEqual([...snapshot.interests], ['逛旧书店', '收集老唱片']);
  assert.deepEqual([...snapshot.interactionBoundaries], ['不假装自己是真人。', '不替用户做决定。']);
  // 没有对应小节 ⇒ 空数组，而不是编出来的内容。
  assert.deepEqual([...snapshot.knownExperiences], []);
  assert.deepEqual([...snapshot.publicFacts], []);
  // emotionalState 是可选字段：没有就不带这个键。
  assert.equal('emotionalState' in snapshot, false);

  // 上限：单条 ≤80、条数 ≤8、整份 ≤1600。
  for (const list of [snapshot.interests, snapshot.knownExperiences, snapshot.publicFacts, snapshot.interactionBoundaries]) {
    assert.ok(list.length <= GROUP_PERSONA_LIMITS.listItems, '条数受限');
    for (const item of list) assert.ok(charLen(item) <= GROUP_PERSONA_LIMITS.listItem, '单条长度受限');
  }
  assert.ok(charLen(snapshot.identity) <= GROUP_PERSONA_LIMITS.identity);
  assert.ok(charLen(snapshot.personality) <= GROUP_PERSONA_LIMITS.personality);
  assert.ok(charLen(snapshot.speakingStyle) <= GROUP_PERSONA_LIMITS.speakingStyle);
});

test('超长人格：每个字段被截断，整份快照不超过 1600 字', () => {
  const long = '长'.repeat(3000);
  const markdown = [
    '# 人格',
    '## 身份', long,
    '## 性格', long,
    '## 说话风格', long,
    '## 兴趣', ...Array.from({ length: 20 }, (_, i) => `- 兴趣第 ${i + 1} 条`),
    '## 经历', ...Array.from({ length: 20 }, (_, i) => `- 经历第 ${i + 1} 条`),
    '## 可公开的事实', ...Array.from({ length: 20 }, (_, i) => `- 事实第 ${i + 1} 条`),
    '## 边界', ...Array.from({ length: 20 }, (_, i) => `- 边界第 ${i + 1} 条`),
  ].join('\n');

  const snapshot = buildGroupPersonaSnapshot(markdown, { personaId: 'bot', source: 'config/persona.md' });
  assert.ok(charLen(snapshot.identity) <= GROUP_PERSONA_LIMITS.identity);
  assert.ok(charLen(snapshot.personality) <= GROUP_PERSONA_LIMITS.personality);
  assert.ok(charLen(snapshot.speakingStyle) <= GROUP_PERSONA_LIMITS.speakingStyle);
  assert.ok(snapshot.interests.length <= GROUP_PERSONA_LIMITS.listItems);
  const structured = [
    snapshot.identity, snapshot.personality, snapshot.speakingStyle,
    snapshot.emotionalState ?? '',
    ...snapshot.interests, ...snapshot.knownExperiences,
    ...snapshot.publicFacts, ...snapshot.interactionBoundaries,
  ];
  const total = structured.reduce((sum, item) => sum + charLen(item), 0);
  assert.ok(total <= GROUP_PERSONA_LIMITS.total, `整份快照 ${total} 字，超出上限`);
});

test('改一个字，version 就变；没改，version 就一样', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'persona.md');
  fs.writeFileSync(file, PERSONA_MD, 'utf8');
  const port = createGroupPersonaPort({ root, personaFile: file, source: 'config' });
  const first = port.get();

  // 每次 get() 都重新读文件：同一份内容两次得到同一个 version。
  assert.equal(port.get().version, first.version);

  // 改一个**在长度上限之外**的字也要变：否则排查时会以为「文件没保存」。
  fs.writeFileSync(file, PERSONA_MD.replace('收集老唱片', '收集老唱'), 'utf8');
  const second = port.get();
  assert.notEqual(second.version, first.version, '改一个字 version 必须变');
  assert.notEqual(second.interests.join('|'), first.interests.join('|'));

  // 再改回来，version 回到最初的哈希（内容寻址，而不是递增计数器）。
  fs.writeFileSync(file, PERSONA_MD, 'utf8');
  assert.equal(port.get().version, first.version);
});

test('私聊/记忆小节不进快照：来源是人格文件 + 标题白名单，不是关键词过滤', () => {
  const snapshot = buildGroupPersonaSnapshot(PERSONA_MD, { personaId: 'bot', source: 'config/persona.md' });
  const structured = JSON.stringify({
    identity: snapshot.identity,
    personality: snapshot.personality,
    speakingStyle: snapshot.speakingStyle,
    interests: snapshot.interests,
    knownExperiences: snapshot.knownExperiences,
    publicFacts: snapshot.publicFacts,
    interactionBoundaries: snapshot.interactionBoundaries,
    ...(snapshot.emotionalState ? { emotionalState: snapshot.emotionalState } : {}),
  });
  // 「## 私聊里才可以说的事」「## 记忆里希望保留什么」两节的内容一条都不许进来。
  assert.doesNotMatch(structured, /主人/);
  assert.doesNotMatch(structured, /私聊/);
  assert.doesNotMatch(structured, /密码/);
  assert.doesNotMatch(structured, /阿岚/);
  assert.doesNotMatch(structured, /hunter2/);
  assert.doesNotMatch(structured, /10001/);
  // 快照里也没有整份 markdown 的痕迹（没有标题符号、没有未被抽取的小节）。
  assert.doesNotMatch(structured, /##/);
  assert.doesNotMatch(structured, /记忆里希望保留什么/);
});

test('边界取舍的另一半：被抽取小节里的同一个词原样保留（不做关键词过滤）', () => {
  // 这条用例是**故意的**：把「主人」写进「身份」小节，快照里就会有这个词。
  // 理由写在 group-persona.mjs 文件头：正文关键词过滤拦不住（换个说法照样泄露），却会误伤
  // 人格小节的正常用词；我们能保证的是「不来自记忆库/私聊会话/标题标明私事的小节」，
  // 不是「文本里没有某些词」。
  const markdown = ['## 身份', '- 主人设定的 AI 陪伴助手。', '', '## 边界', '- 不提及密码类话题。'].join('\n');
  const snapshot = buildGroupPersonaSnapshot(markdown, { personaId: 'bot' });
  assert.match(snapshot.identity, /主人/);
  assert.match(snapshot.interactionBoundaries.join('\n'), /密码/);
});

test('标题级否决：标题写着「私聊/主人/记忆」的小节，别名命中也不抽', () => {
  // 白名单别名 `事实` `经历` `边界` 很常见，光靠「包含匹配」会把下面这些标题也吸进来：
  // 「## 和主人的共同经历」既包含「经历」又整节都是私事。所以标题本身先过一次否决。
  const markdown = [
    '# 人格',
    '## 主人不愿公开的事实', '- 主人的公司叫某某。',
    '## 和主人的共同经历', '- 那天主人失恋了。',
    '## 私聊里的身份', '- 私聊时自称「老公」。',
    '## 记忆里希望保留什么', '- 主人的作息。',
    '## 边界', '- 不替用户做决定。',
  ].join('\n');
  const snapshot = buildGroupPersonaSnapshot(markdown, { personaId: 'bot' });
  const structured = JSON.stringify({
    identity: snapshot.identity,
    interests: snapshot.interests,
    knownExperiences: snapshot.knownExperiences,
    publicFacts: snapshot.publicFacts,
    interactionBoundaries: snapshot.interactionBoundaries,
  });
  assert.doesNotMatch(structured, /某某/);
  assert.doesNotMatch(structured, /失恋/);
  assert.doesNotMatch(structured, /老公/);
  assert.doesNotMatch(structured, /作息/);
  // 合法小节照常抽：否决只看标题，不连坐。
  assert.deepEqual([...snapshot.interactionBoundaries], ['不替用户做决定。']);
});

test('模板占位与空小节不会变成事实', () => {
  const markdown = ['## 身份', '- 你和用户的关系：用户设定为 ______。', '- 你是什么：bot。', '', '## 性格', '', '## 兴趣', '- ______'].join('\n');
  const snapshot = buildGroupPersonaSnapshot(markdown, { personaId: 'bot' });
  // 半角/全角下划线都算「没填」：模板里那一行不能变成快照里的设定。
  assert.equal(snapshot.identity.includes('______'), false, '未填的模板行被丢弃');
  assert.equal(snapshot.identity.includes('＿＿＿'), false);
  assert.match(snapshot.identity, /bot/);
  assert.deepEqual([...snapshot.interests], []);
  assert.equal(snapshot.personality, '');
});

test('字段名严格等于跨插件契约的那 13 个（消费端按名字做结构归一化）', () => {
  // QQ 侧 `normalizePersonaSnapshot()` 按**字段名**取值，缺一个就回落成空。所以名字一旦改动，
  // 表现是「群里人格少一段」，而且两边测试各自都绿。这里把名字固定住。
  const markdown = [
    '## 身份', '- 小满。',
    '## 性格', '- 温和。',
    '## 说话风格', '- 短句。',
    '## 兴趣', '- 旧书店。',
    '## 经历', '- 搬过三次家。',
    '## 心情', '- 今天有点困。',
    '## 公开事实', '- 住在城里。',
    '## 边界', '- 不聊钱。',
  ].join('\n');
  const snapshot = buildGroupPersonaSnapshot(markdown, { personaId: 'bot', source: 'config/persona.md' });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'emotionalState', 'identity', 'interests', 'interactionBoundaries', 'knownExperiences',
    'personaId', 'personality', 'publicFacts', 'publicOnly', 'source', 'speakingStyle', 'version',
  ].sort());
  assert.equal(snapshot.publicOnly, true, 'publicOnly 必须是字面 true：消费端据此确认这不是私聊上下文');
  assert.equal(typeof snapshot.version, 'string');
  assert.equal(typeof snapshot.personaId, 'string');
  for (const key of ['identity', 'personality', 'speakingStyle', 'source']) assert.equal(typeof snapshot[key], 'string', key);
  for (const key of ['interests', 'knownExperiences', 'publicFacts', 'interactionBoundaries']) {
    assert.ok(Array.isArray(snapshot[key]), key);
  }
  assert.equal(typeof snapshot.emotionalState, 'string', '有「心情」小节时才出现这个键');
});
test('空文件与纯空白：快照是 null，不是空壳', () => {
  assert.equal(buildGroupPersonaSnapshot(''), null);
  assert.equal(buildGroupPersonaSnapshot('   \n\n'), null);
});

test('来源标签只写相对拼写，绝不带绝对路径（群聊是公开场合）', t => {
  const root = tempRoot(t);
  assert.equal(personaSourceLabel('config'), 'config/persona.md');
  assert.equal(personaSourceLabel('legacy'), 'workspace/PERSONA.md');
  assert.equal(personaSourceLabel('whatever'), 'persona.md');
  const file = path.join(root, 'persona.md');
  fs.writeFileSync(file, PERSONA_MD, 'utf8');
  // 即使调用方把绝对路径当 personaFile 传进来，source 字段仍然是标签而不是路径。
  const snapshot = createGroupPersonaPort({ root, personaFile: file, source: 'config' }).get();
  assert.equal(snapshot.source, 'config/persona.md');
  assert.doesNotMatch(JSON.stringify(snapshot), /[A-Za-z]:\\\\/, '快照里不许出现盘符路径');
});

test('端口可以被兄弟插件行解析到：注册表 + bridge + ctx 三条路', t => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace', 'PERSONA.md'), PERSONA_MD, 'utf8');
  const port = createGroupPersonaPort({ root, personaId: 'bot' });

  assert.equal(resolveGroupPersonaPort(null, root), null, '还没发布时是 null，不是错对象');
  const release = publishGroupPersonaPort(null, port, { root });
  t.after(release);

  // bridge 的 allow-list 是这个端口可达的前提。
  assert.equal(createServiceBridge(root).resolve(GROUP_PERSONA_SERVICE_NAME), port);
  assert.equal(resolveGroupPersonaPort(null, root), port);
  assert.match(resolveGroupPersonaPort(null, root).get().identity, /小满/);

  // 消费者自己的 context 优先于注册表。
  const fromCtx = { get: () => null };
  const ctx = { get: name => (name === GROUP_PERSONA_SERVICE_NAME ? fromCtx : undefined) };
  assert.equal(resolveGroupPersonaPort(ctx, root), fromCtx);
  // 一个会抛的 ctx 不能把解析搞崩，要落到注册表。
  assert.equal(resolveGroupPersonaPort({ get: () => { throw new Error('no realm'); } }, root), port);

  release();
  assert.equal(resolveGroupPersonaPort(null, root), null);
  release(); // 重复释放无害
});

test('注册表用裸 dataRoot 作键（与消费端契约一致），值是 { service, ready }', () => {
  const root = 'registry-bare-key-root';
  const registry = process[GROUP_PERSONA_PORT_SYMBOL] ?? (process[GROUP_PERSONA_PORT_SYMBOL] = new Map());
  const service = { get: () => null };
  const release = publishGroupPersonaService(root, service);
  try {
    const entry = registry.get(root);
    assert.ok(entry, '裸 root 上必须有一条记录，消费端就是这么读的');
    assert.equal(entry.service, service);
    assert.equal(entry.ready(), true);
    // 消费端看到的是同一个对象，不是副本。
    assert.equal(registry.get(root)?.service, service);
  } finally {
    release();
    registry.delete(root);
  }
  assert.equal(registry.get(root), undefined, '释放之后裸键上不留残影');
});

test('裸键被别的服务（例如 companion-health）占着时不覆盖，改走复合键', () => {
  // health-service-ref.mjs 也用裸 dataRoot 发布 { service, ready }，两者形状完全一样。
  // 覆盖是**静默**的：心率读数、pulse、care 会一起失效，而日志里什么都没有。
  const root = 'registry-collision-root';
  const registry = process[GROUP_PERSONA_PORT_SYMBOL] ?? (process[GROUP_PERSONA_PORT_SYMBOL] = new Map());
  const health = { pulsePrompt: async () => ({ text: '' }) };
  registry.set(root, { service: health, ready: () => true });
  const port = { get: () => null };
  const release = publishGroupPersonaPort(null, port, { root });
  try {
    assert.equal(registry.get(root)?.service, health, '健康服务的记录必须还在');
    assert.equal(resolveGroupPersonaPort(null, root), port, '靠复合键仍然找得到人格端口');
  } finally {
    release();
    registry.delete(root);
  }
});

test('publishGroupPersonaService 与 publishHealthService 共用同一个 Symbol 与值形状', () => {
  // 消费端写的是 Reflect.get(process, Symbol.for('dsh.companion.ports.v1'))；
  // 这里把它当成字面契约再断言一次，防止有人「优化」成模块级 Map。
  assert.equal(process[Symbol.for('dsh.companion.ports.v1')], process[GROUP_PERSONA_PORT_SYMBOL]);
  const root = 'registry-shape-root';
  const release = publishGroupPersonaService(root, { get: () => null });
  try {
    const registry = Reflect.get(process, Symbol.for('dsh.companion.ports.v1'));
    const entry = registry.get(root);
    assert.equal(typeof entry.ready, 'function');
    assert.equal(typeof entry.service.get, 'function');
  } finally {
    release();
  }
});

test('describe() 只回元信息，不带正文（排查用）', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'persona.md');
  fs.writeFileSync(file, PERSONA_MD, 'utf8');
  const port = createGroupPersonaPort({ root, personaFile: file, personaId: 'bot', source: 'config' });
  const info = port.describe();
  assert.equal(info.version, port.get().version);
  assert.equal(info.source, 'config/persona.md');
  assert.equal(info.personaId, 'bot');
  assert.ok(info.chars > 0 && info.chars <= GROUP_PERSONA_LIMITS.total, 'chars 是结构化字段的总字数');
  assert.doesNotMatch(JSON.stringify(info), /小满/, '诊断里不放正文');
  // 没有人格文件时也必须有值，且是「零」而不是 undefined：调用方要能直接判断。
  const empty = createGroupPersonaPort({ root, personaFile: path.join(root, 'nope.md') }).describe();
  assert.deepEqual(empty, { version: '', source: '', chars: 0, personaId: '' });
});

test('键的拼写容错：发布用 path.resolve 的写法，消费端用等价拼写也能命中', () => {
  // 消费端在 Windows 上算出来的 key 可能是小写或 realpath 版本；这里模拟「另一种拼写」。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-persona-key-'));
  try {
    const root = path.join(dir, 'data');
    fs.mkdirSync(root, { recursive: true });
    const port = { get: () => null };
    const release = publishGroupPersonaService(root, port);
    const consumerKey = process.platform === 'win32' ? root.toLowerCase() : root;
    const registry = process[GROUP_PERSONA_PORT_SYMBOL];
    assert.equal(registry.get(consumerKey)?.service, port, '同一目录的另一种拼写必须命中同一条记录');
    release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('给消费端的键清单：复合键排在最前，裸 dataRoot 兜底', () => {
  // companion-health 也用裸 dataRoot 发布（`publishHealthService(root, …)`），注册表是一键一记录；
  // 谁后挂载谁占住。所以消费端必须**先试复合键**，否则人格会不会被读到取决于挂载顺序。
  const root = path.join(os.tmpdir(), 'group-persona-keys');
  const keys = groupPersonaRegistryKeys(root);
  assert.ok(keys.length >= 2);
  assert.ok(keys[0].startsWith(`${GROUP_PERSONA_SERVICE_NAME}\u0000`), '复合键在最前');
  assert.ok(keys.includes(root), '裸 dataRoot 仍然在清单里（兼容既有约定）');
  assert.ok(keys.indexOf(root) > 0, '裸键排在复合键之后');
});
test('与真实的 companion-health 争同一个裸键：人格端口必须仍然可解析', () => {
  // 这不是假想：`publishHealthService(root, …)` 也把裸 dataRoot 当键，而合成里
  // foundation 先挂（第 2 节）、health 后挂（第 8 节），后挂的会**覆盖**先挂的。
  // 后果：只读裸键的消费端拿到的 service 没有 get()，人格静默消失。本用例把这件事钉住：
  // 无论谁先谁后，人格端口都必须能从复合键上被解析到。
  const root = path.join(os.tmpdir(), 'group-persona-health-collision');
  const registry = process[GROUP_PERSONA_PORT_SYMBOL] ?? (process[GROUP_PERSONA_PORT_SYMBOL] = new Map());
  const persona = { get: () => ({ version: 'deadbeef', identity: 'x' }), describe: () => ({}) };
  const health = { pulsePrompt: async () => ({ text: '' }) };
  const releasePersona = publishGroupPersonaService(root, persona);
  const releaseHealth = publishHealthService(root, health);
  try {
    // 健康服务覆盖了裸键（这是它现在的行为，不归本任务改）。
    assert.equal(registry.get(root)?.service, health, '裸键被后挂载的健康服务占住');
    assert.equal(typeof registry.get(root)?.service?.get, 'undefined', '拿裸键当人格端口会拿到错对象');
    // 本模块自己的解析（复合键优先）不受影响。
    assert.equal(resolveGroupPersonaPort(null, root), persona);
    assert.equal(registry.get(groupPersonaRegistryKeys(root)[0])?.service, persona);
  } finally {
    releasePersona();
    releaseHealth();
    registry.delete(root);
  }
});
test('服务名与既有命名一致，且已进 service-bridge 白名单', () => {
  assert.equal(GROUP_PERSONA_SERVICE_NAME, 'companionGroupPersona');
  const root = 'allow-list-root';
  // 白名单之外的旧名字永远解析不到：这是 bridge 的设计，不是本模块的私事。
  assert.equal(createServiceBridge(root).resolve('companionGroupPersonaV2'), null);
});
