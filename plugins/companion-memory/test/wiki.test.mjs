import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_ENTRIES_PER_PAGE,
  DEFAULT_MAX_PAGE_BYTES,
  MAX_ENTRIES_PER_PAGE,
  MAX_PAGE_BYTES,
  WIKI_INDEX_MAX_CHARS,
  WIKI_SORT_VERSION,
  WIKI_TOPICS,
  compileWiki,
  readPage,
  renderIndex,
  renderPage,
} from '../lib/wiki.mjs';

// Every test owns a throwaway directory below the OS temp dir and removes it in
// t.after, so a failed assertion never leaves wiki pages behind.
const FIXED_NOW = '2026-03-07T00:00:00.000Z';
const LATER_NOW = '2026-04-01T09:30:00.000Z';
const VIEWER = Object.freeze({ userId: 'user_1', personaId: 'bot', worldId: '' });

function tempDir(t, prefix = 'dsh-wiki-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function record(overrides = {}) {
  const id = overrides.id ?? `mem_${String(Object.keys(overrides).length)}${Math.abs(hash(JSON.stringify(overrides))).toString(16)}`;
  return {
    id,
    scope: 'user_global',
    kind: 'fact',
    subject: 'user',
    predicate: '',
    value: '占位事实',
    content: '',
    confidence: 0.9,
    importance: 0.7,
    mentionPolicy: 'direct',
    status: 'confirmed',
    realityLevel: 'explicit_user_statement',
    userId: 'user_1',
    personaId: 'bot',
    worldId: '',
    sourceKind: 'desktop_fact',
    sourceId: '',
    dedupeKey: '',
    validFrom: null,
    validTo: null,
    occurredAt: '2026-03-01T08:00:00.000Z',
    createdAt: '2026-03-01T08:00:00.000Z',
    updatedAt: '2026-03-01T08:00:00.000Z',
    revision: 1,
    supersedesId: '',
    tags: [],
    searchText: '',
    ...overrides,
  };
}

function hash(text) {
  let value = 0;
  for (const char of String(text)) value = (value * 31 + char.codePointAt(0)) | 0;
  return value;
}

function makeDb(records, options = {}) {
  const pages = new Map();
  const db = {
    listMemories(filter = {}) {
      const rows = records.filter(row =>
        (!filter.userId || row.userId === filter.userId) &&
        (!filter.personaId || row.personaId === filter.personaId) &&
        (!filter.status || row.status === filter.status) &&
        (!filter.kind || row.kind === filter.kind));
      const offset = Number.isInteger(filter.offset) ? filter.offset : 0;
      const limit = Number.isInteger(filter.limit) ? filter.limit : rows.length;
      return rows.slice(offset, offset + limit);
    },
    upsertWikiPage(page) {
      pages.set(page.pageId, page);
      return page;
    },
    evidenceFor(id) {
      return options.evidence?.[id] ?? [];
    },
  };
  return { db, pages };
}

function pageFile(dir, relative) {
  return path.join(dir, ...relative.split('/'));
}

function readAll(dir) {
  const files = new Map();
  for (const topic of WIKI_TOPICS) files.set(topic.path, fs.readFileSync(pageFile(dir, topic.path), 'utf8'));
  files.set('index.md', fs.readFileSync(pageFile(dir, 'index.md'), 'utf8'));
  return files;
}

function generatedRegionOf(markdown) {
  const begin = markdown.indexOf('<!-- generated:begin');
  const end = markdown.indexOf('<!-- generated:end -->', begin);
  assert.ok(begin >= 0 && end > begin, '页面必须包含完整的生成区标记');
  return markdown.slice(begin, end + '<!-- generated:end -->'.length);
}

function manualRegionOf(markdown) {
  const begin = markdown.indexOf('<!-- manual:begin -->');
  const end = markdown.indexOf('<!-- manual:end -->', begin);
  assert.ok(begin >= 0 && end > begin, '页面必须包含完整的人工区标记');
  return markdown.slice(begin, end + '<!-- manual:end -->'.length);
}

function entryLines(markdown) {
  return markdown.split('\n').filter(line => line.startsWith('- [mem:'));
}

function assertNoTraversal(dir) {
  const attempts = [
    '../outside.md',
    'user/../../outside.md',
    '..',
    '.',
    'users/..',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'C:/Windows/win.ini',
    '\\\\server\\share\\page.md',
    'user/profile.md:hidden',
    '',
    '   ',
  ];
  for (const attempt of attempts) {
    assert.throws(() => readPage({ dir, topicId: attempt }), `越界标识应被拒绝：${attempt}`);
  }
  assert.throws(() => readPage({ dir, topicId: path.resolve(dir, '../escape.md') }));
  assert.throws(() => readPage({ dir, topicId: 42 }));
}

// ---------------------------------------------------------------------------
// Rendering and structure
// ---------------------------------------------------------------------------

test('compiles the four topic pages plus an index with traceable entries', async t => {
  const dir = tempDir(t);
  const records = [
    record({ id: 'mem_profile', kind: 'profile', value: '用户是独立开发者', occurredAt: '2026-02-01T02:00:00.000Z' }),
    record({ id: 'mem_pref', kind: 'preference', value: '用户喜欢温热的乌龙茶' }),
    record({ id: 'mem_rel', kind: 'relationship', scope: 'user_persona', value: '用户习惯用吐槽表达关心' }),
    record({ id: 'mem_event', kind: 'event', scope: 'user_persona', value: '一起熬夜看完了整季番剧' }),
    record({ id: 'mem_promise', kind: 'commitment', scope: 'user_persona', value: '答应下次一起去看海' }),
  ];
  const { db, pages } = makeDb(records);

  const result = await compileWiki({ dir, db, viewer: VIEWER, now: FIXED_NOW });

  assert.deepEqual(result.pages.map(page => page.pageId), WIKI_TOPICS.map(topic => topic.id));
  for (const topic of WIKI_TOPICS) {
    const file = pageFile(dir, topic.path);
    assert.ok(fs.existsSync(file), `缺少页面 ${topic.path}`);
    const markdown = fs.readFileSync(file, 'utf8');
    assert.match(markdown, /<!-- generated:begin .* rev-[0-9a-f]+ -->/);
    assert.match(markdown, /<!-- generated:end -->/);
    assert.match(markdown, /<!-- manual:begin -->\n<!-- manual:end -->/);
    assert.match(markdown, /<!-- compiled: 2026-03-07T00:00:00\.000Z .* -->/);
  }

  const profile = fs.readFileSync(pageFile(dir, 'user/profile.md'), 'utf8');
  assert.match(profile, /^# 用户画像与稳定偏好$/m);
  assert.ok(profile.includes('用户是独立开发者'));
  assert.match(profile, /- \[mem:mem_profile\] 来源 desktop_fact · 用户明确说过 · 2026-02-01T02:00:00\.000Z — 用户是独立开发者/);
  assert.match(profile, /数据版本 \d+/);

  const preferences = fs.readFileSync(pageFile(dir, 'user/preferences.md'), 'utf8');
  assert.ok(preferences.includes('用户喜欢温热的乌龙茶'));
  assert.ok(!preferences.includes('用户是独立开发者'));

  const relationship = fs.readFileSync(pageFile(dir, 'relationships/bot-user.md'), 'utf8');
  assert.ok(relationship.includes('用户习惯用吐槽表达关心'));

  const events = fs.readFileSync(pageFile(dir, 'events/important-events.md'), 'utf8');
  assert.ok(events.includes('一起熬夜看完了整季番剧'));
  assert.ok(events.includes('答应下次一起去看海'));
  assert.match(events, /### 承诺（1 条）/);

  const index = fs.readFileSync(pageFile(dir, 'index.md'), 'utf8');
  for (const topic of WIKI_TOPICS) {
    assert.ok(index.includes(topic.id), '索引应包含页面标识');
    assert.ok(index.includes(topic.path), '索引应包含页面路径');
  }
  assert.ok(index.includes('现实'));
  assert.ok(index.includes('关系'));

  assert.equal(pages.size, WIKI_TOPICS.length + 1);
  const registered = pages.get('user-profile');
  assert.equal(registered.scope, 'user_global');
  assert.equal(registered.path, 'user/profile.md');
  assert.equal(registered.status, 'compiled');
  assert.equal(registered.contentHash.length, 64);
  assert.ok(Number.isInteger(registered.sourceRevision));
  assert.equal(result.index.pageId, 'index');
  assert.equal(result.index.path, 'index.md');
  assert.deepEqual(result.warnings, []);

  const page = readPage({ dir, topicId: 'user-profile' });
  assert.equal(page.exists, true);
  assert.equal(page.topicId, 'user-profile');
  assert.equal(page.path, 'user/profile.md');
  assert.equal(page.markdown, profile);
  assert.equal(readPage({ dir, topicId: 'user/profile.md' }).markdown, profile);
  assert.equal(readPage({ dir, topicId: 'index' }).topicId, 'index');
  assert.equal(readPage({ dir, topicId: 'index' }).markdown, index);
});

test('renders one generated entry line per input record', async t => {
  const dir = tempDir(t);
  const records = [
    record({ id: 'mem_a1', value: '事实一' }),
    record({ id: 'mem_a2', value: '事实二' }),
    record({ id: 'mem_a3', value: '事实三' }),
    record({ id: 'mem_other', kind: 'preference', value: '偏好一' }),
  ];
  const { db } = makeDb(records);

  const first = await compileWiki({ dir, db, viewer: VIEWER, now: FIXED_NOW });
  const profileResult = first.pages.find(page => page.pageId === 'user-profile');
  assert.equal(profileResult.entryCount, 3);
  const profile = fs.readFileSync(pageFile(dir, 'user/profile.md'), 'utf8');
  assert.equal(entryLines(profile).length, 3);
  assert.equal(entryLines(generatedRegionOf(profile)).length, 3);

  const rendered = renderPage({
    topic: WIKI_TOPICS[0],
    records,
    viewer: VIEWER,
    now: FIXED_NOW,
  });
  assert.equal(rendered.entryCount, 3);
  assert.equal(entryLines(rendered.markdown).length, 3);
  assert.ok(!rendered.markdown.includes('<!-- manual:begin -->'), 'renderPage 只产出生成区');
  assert.ok(!rendered.markdown.includes('偏好一'), '主题归并：偏好不进画像页');
});

test('index and page content stay inside the character budget', async t => {
  const dir = tempDir(t);
  const { db } = makeDb([
    record({ id: 'mem_long', kind: 'profile', value: '很长的值'.repeat(80) }),
  ]);
  await compileWiki({ dir, db, viewer: VIEWER, now: FIXED_NOW });

  const index = readPage({ dir, topicId: 'index' }).markdown;
  assert.ok(index.length <= WIKI_INDEX_MAX_CHARS, `index.md 长度 ${index.length} 超出预算`);
  const renderedIndex = renderIndex({ pages: WIKI_TOPICS });
  assert.ok(renderedIndex.length <= 360, `renderIndex 长度 ${renderedIndex.length} 超出预算`);
  for (const topic of WIKI_TOPICS) {
    assert.ok(renderedIndex.includes(topic.id));
    assert.ok(renderedIndex.includes(topic.path));
    assert.ok(renderedIndex.includes(topic.description));
  }
  assert.ok(!index.includes('很长的值'), '索引只有主题信息，不含正文');
});

// ---------------------------------------------------------------------------
// Generated / manual separation
// ---------------------------------------------------------------------------

test('keeps the manual region byte for byte across recompiles', async t => {
  const dir = tempDir(t);
  const { db } = makeDb([record({ id: 'mem_first', value: '最初的事实' })]);
  await compileWiki({ dir, db, viewer: VIEWER, now: FIXED_NOW });

  const file = pageFile(dir, 'user/profile.md');
  const before = fs.readFileSync(file, 'utf8');
  const manual = [
    '<!-- manual:begin -->',
    '# 我自己的笔记',
    '',
    '- 保留末尾空格  ',
    '- 含 `代码` 与 *强调*',
    '  缩进也要原样保留',
    '<!-- manual:end -->',
  ].join('\n');
  fs.writeFileSync(file, before.replace(manualRegionOf(before), manual), 'utf8');

  const changedDb = makeDb([record({ id: 'mem_first', value: '最初的事实' }), record({ id: 'mem_second', kind: 'profile', value: '后来的事实' })]);
  await compileWiki({ dir, db: changedDb.db, viewer: VIEWER, now: LATER_NOW });

  const after = fs.readFileSync(file, 'utf8');
  assert.equal(manualRegionOf(after), manual, '人工区必须逐字节保留');
  assert.ok(after.includes('后来的事实'));
  assert.ok(after.includes('最初的事实'));

  // A third compile must not drift either.
  await compileWiki({ dir, db: changedDb.db, viewer: VIEWER, now: '2026-05-05T05:05:05.000Z' });
  assert.equal(manualRegionOf(fs.readFileSync(file, 'utf8')), manual);
});

test('adds an empty manual region instead of overwriting a page written by hand', async t => {
  const dir = tempDir(t);
  const legacy = '# 我手写的画像\n\n- 用户只喝无糖茶\n- 不要提生日\n';
  fs.mkdirSync(path.join(dir, 'user'), { recursive: true });
  fs.writeFileSync(pageFile(dir, 'user/profile.md'), legacy, 'utf8');

  const { db } = makeDb([record({ id: 'mem_legacy', value: '编译出来的事实' })]);
  await compileWiki({ dir, db, viewer: VIEWER, now: FIXED_NOW });

  const markdown = fs.readFileSync(pageFile(dir, 'user/profile.md'), 'utf8');
  assert.match(markdown, /<!-- manual:begin -->/);
  assert.match(markdown, /<!-- manual:end -->/);
  assert.ok(markdown.includes('用户只喝无糖茶'), '手写内容不能丢');
  assert.ok(markdown.includes('不要提生日'));
  assert.ok(markdown.includes('编译出来的事实'));

  const manual = manualRegionOf(markdown);
  await compileWiki({ dir, db, viewer: VIEWER, now: LATER_NOW });
  assert.equal(manualRegionOf(fs.readFileSync(pageFile(dir, 'user/profile.md'), 'utf8')), manual);
});

test('is idempotent: identical data yields identical bytes', async t => {
  const dir = tempDir(t);
  const records = [
    record({ id: 'mem_x1', kind: 'profile', value: '稳定事实' }),
    record({ id: 'mem_x2', kind: 'preference', value: '喜欢下雨天' }),
    record({ id: 'mem_x3', kind: 'event', scope: 'user_persona', value: '一起修好了台灯' }),
  ];
  const first = await compileWiki({ dir, db: makeDb(records).db, viewer: VIEWER, now: FIXED_NOW });
  const firstFiles = readAll(dir);

  const second = await compileWiki({ dir, db: makeDb(records).db, viewer: VIEWER, now: FIXED_NOW });
  const secondFiles = readAll(dir);
  for (const [relative, content] of firstFiles) {
    assert.equal(secondFiles.get(relative), content, `${relative} 重复编译应完全一致`);
  }
  assert.ok(second.pages.every(page => page.changed === false), '内容未变化时不应重写文件');
  assert.deepEqual(first.pages.map(page => page.sourceRevision), second.pages.map(page => page.sourceRevision));

  // A different compile timestamp may only move the stamp outside the generated region.
  await compileWiki({ dir, db: makeDb(records).db, viewer: VIEWER, now: LATER_NOW });
  const thirdFiles = readAll(dir);
  for (const [relative, content] of firstFiles) {
    assert.equal(generatedRegionOf(thirdFiles.get(relative)), generatedRegionOf(content), `${relative} 生成区应稳定`);
  }
  assert.notEqual(thirdFiles.get('user/profile.md'), firstFiles.get('user/profile.md'));

  // New data must change the recorded source revision.
  const grown = [...records, record({ id: 'mem_x4', kind: 'profile', value: '新增事实' })];
  const fourth = await compileWiki({ dir, db: makeDb(grown).db, viewer: VIEWER, now: FIXED_NOW });
  const before = new Map(first.pages.map(page => [page.pageId, page.sourceRevision]));
  assert.notEqual(fourth.pages.find(page => page.pageId === 'user-profile').sourceRevision, before.get('user-profile'));
  assert.equal(fourth.pages.find(page => page.pageId === 'user-preferences').sourceRevision, before.get('user-preferences'));
});

// ---------------------------------------------------------------------------
// Filtering and policy
// ---------------------------------------------------------------------------

test('keeps only confirmed active records and hides avoid_unless_asked bodies', async t => {
  const dir = tempDir(t);
  const records = [
    record({ id: 'mem_ok', value: '正常的确认事实' }),
    record({ id: 'mem_pending', value: '待确认事实', status: 'pending' }),
    record({ id: 'mem_superseded', value: '被替代事实', status: 'superseded' }),
    record({ id: 'mem_retracted', value: '已撤回事实', status: 'retracted' }),
    record({ id: 'mem_archived', value: '归档事实', status: 'archived' }),
    record({ id: 'mem_expired', value: '过期事实', validTo: '2026-01-01T00:00:00.000Z' }),
    record({ id: 'mem_future', value: '未来事实', validFrom: '2027-01-01T00:00:00.000Z' }),
    record({ id: 'mem_secret', value: '不愿被提起的私事', mentionPolicy: 'avoid_unless_asked', sourceKind: 'manual' }),
    record({ id: 'mem_wrong_user', value: '别人的事实', userId: 'user_2' }),
    record({ id: 'mem_wrong_persona', value: '别的人设事实', personaId: 'other' }),
    record({ id: 'mem_bot', kind: 'bot_action', scope: 'persona_self', value: '主动发了一条消息', realityLevel: 'bot_action' }),
    record({ id: 'mem_artifact', kind: 'artifact', scope: 'persona_self', value: '生成了一张图' }),
  ];
  const { db } = makeDb(records);
  await compileWiki({ dir, db, viewer: VIEWER, now: FIXED_NOW });
  const files = [...readAll(dir).values()].join('\n');

  assert.ok(files.includes('正常的确认事实'));
  for (const hiddenId of ['mem_pending', 'mem_superseded', 'mem_retracted', 'mem_archived', 'mem_expired', 'mem_future', 'mem_wrong_user', 'mem_wrong_persona', 'mem_bot', 'mem_artifact']) {
    assert.ok(!files.includes(hiddenId), `${hiddenId} 不应出现在 Wiki 中`);
  }
  assert.ok(!files.includes('待确认事实'));
  assert.ok(!files.includes('归档事实'));
  assert.ok(!files.includes('过期事实'));
  assert.ok(!files.includes('别人的事实'));

  assert.ok(files.includes('[mem:mem_secret]'), '被隐藏的记录仍需保留来源标记');
  assert.ok(!files.includes('不愿被提起的私事'), 'avoid_unless_asked 的正文不得写入页面');
  assert.ok(files.includes('（存在一条用户不愿主动提及的记录，已隐藏正文）'), '需要显式的隐藏占位');
  assert.match(
    files,
    /- \[mem:mem_secret\] 来源 manual · 用户明确说过 · 2026-03-01T08:00:00\.000Z — （存在一条用户不愿主动提及的记录，已隐藏正文）/,
    '占位条目仍需带来源类型、现实级别与时间',
  );

  const profile = fs.readFileSync(pageFile(dir, 'user/profile.md'), 'utf8');
  const generated = generatedRegionOf(profile);
  assert.ok(generated.includes('其中 1 条只保留占位'), '生成区应说明有占位条目');
  assert.equal(entryLines(generated).length, 2);
});

test('never mixes another world or the fiction layer into the reality sections', async t => {
  const worldA = tempDir(t, 'dsh-wiki-world-a-');
  const records = [
    record({ id: 'mem_reality_rel', kind: 'relationship', scope: 'user_persona', value: '现实里我们互相吐槽' }),
    record({
      id: 'mem_world_a',
      kind: 'relationship',
      scope: 'roleplay_world',
      worldId: 'world_a',
      realityLevel: 'roleplay_fiction',
      sourceKind: 'extracted',
      value: '在雪原剧情里我们是搭档',
    }),
    record({
      id: 'mem_world_b',
      kind: 'relationship',
      scope: 'roleplay_world',
      worldId: 'world_b',
      realityLevel: 'roleplay_fiction',
      sourceKind: 'extracted',
      value: '另一个世界的秘密剧情',
    }),
  ];
  const viewerA = { ...VIEWER, worldId: 'world_a' };
  await compileWiki({ dir: worldA, db: makeDb(records).db, viewer: viewerA, now: FIXED_NOW });

  const relationshipA = fs.readFileSync(pageFile(worldA, 'relationships/bot-user.md'), 'utf8');
  assert.ok(relationshipA.includes('mem_reality_rel'));
  assert.ok(relationshipA.includes('mem_world_a'));
  assert.ok(relationshipA.includes('仅在该剧情内有效'));
  assert.ok(relationshipA.includes('world:world_a'));
  assert.ok(![...readAll(worldA).values()].join('\n').includes('mem_world_b'), '其他世界的剧情不得出现在本页');
  assert.ok(![...readAll(worldA).values()].join('\n').includes('另一个世界的秘密剧情'));

  const fictionIndex = relationshipA.indexOf('## 剧情世界');
  const realitySection = relationshipA.slice(0, fictionIndex);
  assert.ok(fictionIndex > 0, '混排时必须显式分区');
  assert.ok(!realitySection.includes('mem_world_a'), '剧情条目不得出现在现实分区');
  assert.ok(realitySection.includes('mem_reality_rel'));

  // Reality viewer: the fiction layer must disappear entirely.
  const realityDir = tempDir(t, 'dsh-wiki-reality-');
  await compileWiki({ dir: realityDir, db: makeDb(records).db, viewer: VIEWER, now: FIXED_NOW });
  const realityFiles = [...readAll(realityDir).values()].join('\n');
  assert.ok(realityFiles.includes('mem_reality_rel'));
  assert.ok(!realityFiles.includes('mem_world_a'));
  assert.ok(!realityFiles.includes('mem_world_b'));
  assert.ok(!realityFiles.includes('## 剧情世界'));

  // Profile pages never accept fiction even for a matching world viewer.
  const profileA = fs.readFileSync(pageFile(worldA, 'user/profile.md'), 'utf8');
  assert.ok(!profileA.includes('mem_world_a'));
});

// ---------------------------------------------------------------------------
// Degradation and empty input
// ---------------------------------------------------------------------------

test('compiles an empty database into valid pages', async t => {
  const dir = tempDir(t);
  const result = await compileWiki({ dir, db: makeDb([]).db, viewer: VIEWER, now: FIXED_NOW });

  assert.equal(result.pages.every(page => page.entryCount === 0), true);
  for (const topic of WIKI_TOPICS) {
    const markdown = fs.readFileSync(pageFile(dir, topic.path), 'utf8');
    assert.match(markdown, /^# /m);
    assert.ok(markdown.includes('_（暂无已确认的记录）_'));
    assert.equal(entryLines(markdown).length, 0);
    assert.ok(manualRegionOf(markdown).length > 0);
  }
  assert.ok(fs.existsSync(pageFile(dir, 'index.md')));
  assert.ok(readPage({ dir, topicId: 'user-preferences' }).exists);
});

test('degrades to file-only output when the database API is missing', async t => {
  const dir = tempDir(t);
  const empty = await compileWiki({ dir, db: null, viewer: VIEWER, now: FIXED_NOW });
  assert.ok(empty.warnings.some(warning => warning.includes('db.listMemories')));
  assert.ok(empty.warnings.some(warning => warning.includes('db.upsertWikiPage')));
  assert.equal(fs.readFileSync(pageFile(dir, 'user/profile.md'), 'utf8').startsWith('<!-- generated:begin'), true);

  const partialDir = tempDir(t);
  const partial = await compileWiki({
    dir: partialDir,
    db: { listMemories: () => [record({ id: 'mem_partial', value: '只有读取接口' })] },
    viewer: VIEWER,
    now: FIXED_NOW,
  });
  assert.ok(partial.warnings.every(warning => warning.includes('upsertWikiPage')));
  assert.ok(fs.readFileSync(pageFile(partialDir, 'user/profile.md'), 'utf8').includes('只有读取接口'));

  const broken = await compileWiki({
    dir: tempDir(t),
    db: {
      listMemories: () => { throw new Error('database is locked'); },
      upsertWikiPage: () => { throw new Error('database is locked'); },
    },
    viewer: VIEWER,
    now: FIXED_NOW,
  });
  assert.ok(broken.warnings.some(warning => warning.includes('database is locked')));
  assert.equal(broken.pages.length, WIKI_TOPICS.length);
});

test('rejects a missing output directory instead of inventing a default', async () => {
  await assert.rejects(() => compileWiki({ viewer: VIEWER, now: FIXED_NOW }), TypeError);
  await assert.rejects(() => compileWiki({ dir: '   ', viewer: VIEWER, now: FIXED_NOW }), TypeError);
  assert.throws(() => readPage({ topicId: 'user-profile' }), TypeError);
  assert.throws(() => readPage({ dir: '', topicId: 'user-profile' }), TypeError);
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

test('readPage rejects traversal, absolute paths and symlinked escapes', async t => {
  const dir = tempDir(t);
  await compileWiki({ dir, db: makeDb([record({ id: 'mem_safe', value: '正常事实' })]).db, viewer: VIEWER, now: FIXED_NOW });
  assertNoTraversal(dir);

  // Unknown but safe relative pages are readable (not yet existing).
  const missing = readPage({ dir, topicId: 'worlds/roleplay-world' });
  assert.equal(missing.exists, false);
  assert.equal(missing.path, 'worlds/roleplay-world.md');
  assert.equal(missing.markdown, '');

  const outside = tempDir(t, 'dsh-wiki-outside-');
  fs.writeFileSync(path.join(outside, 'secret.md'), '# 外部机密\n', 'utf8');
  let linked = false;
  try {
    fs.symlinkSync(outside, path.join(dir, 'linked'), 'junction');
    linked = true;
  } catch {
    linked = false;
  }
  if (linked) {
    assert.throws(() => readPage({ dir, topicId: 'linked/secret.md' }), /越界/);
    assert.throws(() => readPage({ dir, topicId: 'linked/../secret.md' }));
  }
});

// ---------------------------------------------------------------------------
// Digest caps: a topic page must stay readable
// ---------------------------------------------------------------------------

const TRUNCATION_NOTE = '完整历史请用 companion_recall 检索，或查看数据库原始记录。';

function summaries(count, { importance = 0.8, kind = 'summary', scope = 'user_persona' } = {}) {
  return Array.from({ length: count }, (_, index) => record({
    id: `mem_sum${String(index).padStart(3, '0')}`,
    kind,
    scope,
    value: `第 ${index + 1} 条摘要`,
    importance,
  }));
}

test('caps the event page at MAX_ENTRIES_PER_PAGE and says so', async t => {
  const dir = tempDir(t);
  const records = summaries(50);
  const result = await compileWiki({ dir, db: makeDb(records).db, viewer: VIEWER, now: FIXED_NOW });

  const events = result.pages.find(page => page.pageId === 'important-events');
  assert.equal(MAX_ENTRIES_PER_PAGE, 40);
  assert.equal(events.entryCount, 40);
  assert.equal(events.totalCount, 50);
  assert.equal(events.truncated, true);

  const markdown = fs.readFileSync(pageFile(dir, 'events/important-events.md'), 'utf8');
  assert.equal(entryLines(markdown).length, 40);
  assert.ok(markdown.includes(`> 仅展示最重要的 40 条（共 50 条）。${TRUNCATION_NOTE}`), '必须有明确的截断说明');
  assert.ok(markdown.includes('已确认条目 50 条'));
  assert.ok(markdown.length < 20 * 1024, `页面不应再无限膨胀（当前 ${markdown.length} 字节）`);

  // Other pages are unaffected by the event page's volume.
  const profile = result.pages.find(page => page.pageId === 'user-profile');
  assert.equal(profile.totalCount, 0);
  assert.equal(profile.truncated, false);
});

test('ranks structured events ahead of summaries regardless of importance', async t => {
  const dir = tempDir(t);
  const records = [
    // Derived summaries claim the highest importance, exactly like the imported
    // AstrBot data (summary 0.9 vs event 0.25). Rule B must still show the events.
    ...summaries(45, { importance: 0.9 }),
    record({ id: 'mem_event_top', kind: 'event', scope: 'user_persona', value: '一起看完了整季番剧', importance: 0.25 }),
    record({ id: 'mem_commitment_top', kind: 'commitment', scope: 'user_persona', value: '答应一起去看海', importance: 0.2 }),
  ];
  const result = await compileWiki({ dir, db: makeDb(records).db, viewer: VIEWER, now: FIXED_NOW });

  const markdown = fs.readFileSync(pageFile(dir, 'events/important-events.md'), 'utf8');
  const events = result.pages.find(page => page.pageId === 'important-events');
  assert.equal(entryLines(markdown).length, MAX_ENTRIES_PER_PAGE);
  assert.equal(events.entryCount, MAX_ENTRIES_PER_PAGE);
  assert.ok(markdown.includes('[mem:mem_event_top]'), '低重要度的结构化事件也必须保留');
  assert.ok(markdown.includes('[mem:mem_commitment_top]'), '低重要度的承诺也必须保留');
  assert.ok(!markdown.includes('[mem:mem_sum044]'), '尾部摘要按截断规则被舍弃');

  // Every event/commitment line precedes every summary line.
  const lines = entryLines(generatedRegionOf(markdown));
  const ranked = lines.map(line => (line.includes('来源') && /- \[mem:mem_(event|commitment)_/.test(line) ? 'structured' : 'summary'));
  const lastStructured = ranked.lastIndexOf('structured');
  const firstSummary = ranked.indexOf('summary');
  assert.ok(lastStructured >= 0 && firstSummary >= 0);
  assert.ok(lastStructured < firstSummary, '结构化事件必须整体排在摘要之前');
  assert.equal(ranked.filter(kind => kind === 'structured').length, 2);
});

test('real-library shape: 262 high-importance summaries plus 5 events keep all events', async t => {
  const dir = tempDir(t);
  const records = [
    ...summaries(262, { importance: 0.9 }),
    ...Array.from({ length: 5 }, (_, index) => record({
      id: `mem_evt${index}`,
      kind: 'event',
      scope: 'user_persona',
      value: `真实事件 ${index + 1}`,
      importance: 0.25,
    })),
  ];
  const result = await compileWiki({ dir, db: makeDb(records).db, viewer: VIEWER, now: FIXED_NOW });
  const events = result.pages.find(page => page.pageId === 'important-events');
  assert.equal(events.totalCount, 267);
  assert.equal(events.entryCount, MAX_ENTRIES_PER_PAGE);

  const markdown = fs.readFileSync(pageFile(dir, 'events/important-events.md'), 'utf8');
  const generated = generatedRegionOf(markdown);
  const summaryShown = entryLines(generated).filter(line => line.startsWith('- [mem:mem_sum')).length;
  assert.equal(entryLines(generated).length, MAX_ENTRIES_PER_PAGE);
  assert.equal(5, entryLines(generated).filter(line => /\[mem:mem_evt\d\]/.test(line)).length, '5 条事件全部在页');
  assert.equal(summaryShown, MAX_ENTRIES_PER_PAGE - 5, '其余名额由摘要填满');
  assert.match(generated, /^### 事件（5 条）$/m);
  assert.match(generated, /^### 摘要（35 条）$/m);
  assert.ok(generated.includes(`> 仅展示最重要的 ${MAX_ENTRIES_PER_PAGE} 条（共 267 条）。${TRUNCATION_NOTE}`));
});

test('changing the ranking rule version changes sourceRevision', async t => {
  const dir = tempDir(t);
  const records = [
    record({ id: 'mem_rule_a', kind: 'event', scope: 'user_persona', value: '一起爬山' }),
    record({ id: 'mem_rule_b', kind: 'summary', scope: 'user_persona', value: '一段对话摘要', importance: 0.9 }),
  ];
  const { db } = makeDb(records);
  const current = await compileWiki({ dir, db, viewer: VIEWER, now: FIXED_NOW });
  const bumped = await compileWiki({ dir, db, viewer: VIEWER, now: FIXED_NOW, sortVersion: WIKI_SORT_VERSION + 1 });

  const currentRevisions = new Map(current.pages.map(page => [page.pageId, page.sourceRevision]));
  const bumpedRevisions = new Map(bumped.pages.map(page => [page.pageId, page.sourceRevision]));
  assert.notEqual(bumpedRevisions.get('important-events'), currentRevisions.get('important-events'));
  assert.notEqual(bumpedRevisions.get('user-profile'), currentRevisions.get('user-profile'));

  // The rule version is part of the revision only; the entries are unchanged.
  assert.deepEqual(
    bumped.pages.map(page => page.entryCount),
    current.pages.map(page => page.entryCount),
  );

  // Default caps stay exported for the config wiring.
  assert.equal(DEFAULT_MAX_ENTRIES_PER_PAGE, MAX_ENTRIES_PER_PAGE);
  assert.equal(DEFAULT_MAX_PAGE_BYTES, MAX_PAGE_BYTES);
  assert.equal(WIKI_SORT_VERSION, 2);
});

test('honours maxEntriesPerTopic and changes sourceRevision with it', async t => {
  const dir = tempDir(t);
  const small = tempDir(t);
  const records = summaries(12, { kind: 'event', scope: 'user_persona' });
  const db = makeDb(records).db;

  const wide = await compileWiki({ dir, db, viewer: VIEWER, now: FIXED_NOW });
  const narrow = await compileWiki({ dir: small, db, viewer: VIEWER, now: FIXED_NOW, maxEntriesPerTopic: 5 });

  assert.equal(wide.pages.find(page => page.pageId === 'important-events').entryCount, 12);
  const narrowEvents = narrow.pages.find(page => page.pageId === 'important-events');
  assert.equal(narrowEvents.entryCount, 5);
  assert.equal(narrowEvents.totalCount, 12);
  assert.ok(fs.readFileSync(pageFile(small, 'events/important-events.md'), 'utf8')
    .includes(`> 仅展示最重要的 5 条（共 12 条）。${TRUNCATION_NOTE}`));
  assert.equal(entryLines(fs.readFileSync(pageFile(small, 'events/important-events.md'), 'utf8')).length, 5);

  // Same data, different cap -> different revision, for every page.
  const wideRevisions = new Map(wide.pages.map(page => [page.pageId, page.sourceRevision]));
  const narrowRevisions = new Map(narrow.pages.map(page => [page.pageId, page.sourceRevision]));
  assert.notEqual(narrowRevisions.get('important-events'), wideRevisions.get('important-events'));
  assert.notEqual(narrowRevisions.get('user-profile'), wideRevisions.get('user-profile'));

  // Same data + same cap -> identical bytes and revision.
  const repeat = await compileWiki({ dir: small, db, viewer: VIEWER, now: FIXED_NOW, maxEntriesPerTopic: 5 });
  assert.deepEqual(
    repeat.pages.map(page => [page.pageId, page.sourceRevision, page.entryCount]),
    narrow.pages.map(page => [page.pageId, page.sourceRevision, page.entryCount]),
  );
  assert.ok(repeat.pages.every(page => page.changed === false), '同数据同配置重复编译不应重写文件');
});

test('stops growing a giant page at MAX_PAGE_BYTES', async t => {
  const dir = tempDir(t);
  const records = Array.from({ length: 200 }, (_, index) => record({
    id: `mem_huge${String(index).padStart(3, '0')}`,
    kind: 'event',
    scope: 'user_persona',
    value: '很长的共同经历正文'.repeat(80),
    importance: 0.8,
  }));
  const result = await compileWiki({
    dir,
    db: makeDb(records).db,
    viewer: VIEWER,
    now: FIXED_NOW,
    maxEntriesPerTopic: 200,
  });

  const events = result.pages.find(page => page.pageId === 'important-events');
  const markdown = fs.readFileSync(pageFile(dir, 'events/important-events.md'), 'utf8');
  const generated = generatedRegionOf(markdown);
  assert.ok(Buffer.byteLength(generated, 'utf8') <= MAX_PAGE_BYTES,
    `生成区 ${Buffer.byteLength(generated, 'utf8')} 字节超过上限 ${MAX_PAGE_BYTES}`);
  assert.ok(events.entryCount < 200, '超字节上限时必须截断');
  assert.equal(entryLines(markdown).length, events.entryCount);
  assert.ok(markdown.includes(`> 仅展示最重要的 ${events.entryCount} 条（共 200 条）。${TRUNCATION_NOTE}`));
  assert.equal(events.totalCount, 200);

  // A tiny byte budget still produces a valid page with the note.
  const tight = tempDir(t);
  const tightResult = await compileWiki({ dir: tight, db: makeDb(records).db, viewer: VIEWER, now: FIXED_NOW, maxPageBytes: 2000, maxEntriesPerTopic: 200 });
  const tightEvents = tightResult.pages.find(page => page.pageId === 'important-events');
  const tightGenerated = generatedRegionOf(fs.readFileSync(pageFile(tight, 'events/important-events.md'), 'utf8'));
  assert.ok(Buffer.byteLength(tightGenerated, 'utf8') <= 2000);
  assert.ok(tightEvents.entryCount < events.entryCount);
  assert.ok(tightEvents.entryCount > 0);
  assert.ok(tightGenerated.includes('仅展示最重要的'));
});

// ---------------------------------------------------------------------------
// Control-marker injection (P1 regression: notes must never be captured)
// ---------------------------------------------------------------------------

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

test('escapes control markers in memory text so notes are never captured', async t => {
  const dir = tempDir(t);
  const file = pageFile(dir, 'user/profile.md');
  const manual = [
    '<!-- manual:begin -->',
    '# 我的笔记',
    '',
    '- NOTE-LINE-A 这行必须一直在',
    '- 含 `代码` 与尾随空格  ',
    '<!-- manual:end -->',
  ].join('\n');

  await compileWiki({ dir, db: makeDb([record({ id: 'mem_calm', value: '普通事实' })]).db, viewer: VIEWER, now: FIXED_NOW });
  const first = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, first.replace(manualRegionOf(first), manual), 'utf8');

  // Memory values that try to become page structure.
  const injected = [
    record({ id: 'mem_inject_a', value: 'MARKER-A <!-- manual:begin --> 与 <!-- manual:end --> 都塞进正文' }),
    record({ id: 'mem_inject_b', kind: 'profile', value: 'MARKER-B <!-- generated:end --> 想提前结束生成区' }),
    record({ id: 'mem_inject_c', kind: 'fact', value: 'MARKER-C <!-- generated:begin user-profile rev-deadbeef --> 伪造起点' }),
  ];
  const injection = await compileWiki({ dir, db: makeDb(injected).db, viewer: VIEWER, now: FIXED_NOW });
  assert.deepEqual(injection.warnings, [], '转义后的页面结构必须仍然合法');

  const after = fs.readFileSync(file, 'utf8');
  assert.equal(manualRegionOf(after), manual, '人工笔记必须逐字节保留');
  assert.equal(countOf(after, '<!-- manual:begin -->'), 1);
  assert.equal(countOf(after, '<!-- manual:end -->'), 1);
  assert.equal(countOf(after, '<!-- generated:end -->'), 1);
  assert.equal(countOf(after, '<!-- generated:begin'), 1);
  assert.ok(after.includes('<\\!-- manual:begin -->'), '标记应以转义形式保留可读性');
  assert.ok(after.includes('<\\!-- generated:end -->'));
  const generated = generatedRegionOf(after);
  const interior = generated
    .replace(/^<!-- generated:begin[^>]*-->/, '')
    .replace(/<!-- generated:end -->$/, '');
  assert.ok(!/<!--\s*(?:manual|generated):/.test(interior), '生成区内不得出现未转义的控制标记');

  // Recompile with the same data: still stable and still escaping.
  await compileWiki({ dir, db: makeDb(injected).db, viewer: VIEWER, now: LATER_NOW });
  assert.equal(manualRegionOf(fs.readFileSync(file, 'utf8')), manual);

  // Withdraw the facts: nothing from them may survive anywhere on the page.
  const withdrawn = await compileWiki({ dir, db: makeDb([record({ id: 'mem_calm', value: '普通事实' })]).db, viewer: VIEWER, now: LATER_NOW });
  assert.deepEqual(withdrawn.warnings, []);
  const cleaned = fs.readFileSync(file, 'utf8');
  assert.equal(manualRegionOf(cleaned), manual, '撤回事实后人工笔记仍然完好');
  assert.ok(!cleaned.includes('MARKER-A'), '已撤回事实的正文不得残留');
  assert.ok(!cleaned.includes('MARKER-B'));
  assert.ok(!cleaned.includes('MARKER-C'));
  assert.ok(!cleaned.includes('<\\!-- manual:begin -->'), '已撤回事实的转义标记也不得残留');
  assert.ok(cleaned.includes('NOTE-LINE-A'));
  assert.equal(countOf(cleaned, '<!-- manual:begin -->'), 1);
  assert.equal(cleaned, fs.readFileSync(file, 'utf8'), '同一 now 下产物稳定');
});

test('refuses to rewrite a page with ambiguous control markers', async t => {
  const dir = tempDir(t);
  const file = pageFile(dir, 'user/profile.md');
  await compileWiki({ dir, db: makeDb([record({ id: 'mem_before', value: '改动前的普通事实' })]).db, viewer: VIEWER, now: FIXED_NOW });

  const manual = '<!-- manual:begin -->\n# 不能丢的笔记\n- NOTE-KEEP\n<!-- manual:end -->';
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, before.replace(manualRegionOf(before), manual), 'utf8');
  assert.equal(manualRegionOf(fs.readFileSync(file, 'utf8')), manual);

  // A duplicated manual begin is an anomaly: freeze the whole page.
  const broken = `${fs.readFileSync(file, 'utf8')}\n<!-- manual:begin -->\n多出来的标记\n`;
  fs.writeFileSync(file, broken, 'utf8');

  const second = makeDb([record({ id: 'mem_after', value: '改动后的普通事实' })]);
  const result = await compileWiki({ dir, db: second.db, viewer: VIEWER, now: LATER_NOW });
  const page = result.pages.find(entry => entry.pageId === 'user-profile');

  assert.equal(fs.readFileSync(file, 'utf8'), broken, '异常页面的整页字节必须原样保留');
  assert.ok(result.warnings.some(warning => warning.startsWith('manual-region-invalid')), '必须给出 manual-region-invalid 警告');
  assert.equal(page.invalid, true);
  assert.equal(page.changed, false);
  assert.equal(second.pages.has('user-profile'), false, '结构异常时不得登记数据库');
  assert.ok(fs.readFileSync(file, 'utf8').includes('NOTE-KEEP'), '人工笔记不能被覆盖');

  // Other pages keep compiling, and a repeated compile stays frozen as well.
  assert.equal(result.pages.find(entry => entry.pageId === 'user-preferences').invalid, false);
  assert.ok(second.pages.has('user-preferences'));
  assert.equal(result.index.invalid, false);
  const again = await compileWiki({ dir, db: second.db, viewer: VIEWER, now: '2026-06-06T06:06:06.000Z' });
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
  assert.ok(again.warnings.some(warning => warning.startsWith('manual-region-invalid')));
});


