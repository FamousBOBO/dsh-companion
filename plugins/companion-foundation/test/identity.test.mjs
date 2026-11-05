/**
 * identity.test.mjs — companion-foundation 身份层的专项套件（P1 补验 V0 缺口 1）。
 *
 * 覆盖四件事，全部由 `plugins/companion-foundation/identity.mjs` 的真实实现判定，
 * 不使用 stub / mock：
 *   1. 合成与主人绑定：identity.json → owner()/context() 一致，绑定文本自带身份声明；
 *   2. 会话解析：未知会话首次解析时绑定到主人并原子落盘（channel/boundAt/.previous）；
 *   3. 跨用户隔离：不同 root 的主人互不可见；一个会话的归属冲突不影响其他会话；
 *   4. 未知会话不冒充主人：非法/非本人 identity 一律 fail closed，
 *      已经把会话判给别人的记录不会被改判成主人。
 *
 * 临时 root 一律建在系统临时目录（`<tmp>/dsh-companion-identity-tests/identity-*`），
 * 每个用例结束即删；不触碰真实 `home/`，也不在仓库里留文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(os.tmpdir(), 'dsh-companion-identity-tests');
fs.mkdirSync(testRoot, { recursive: true });

const { createIdentity } = await import('../identity.mjs');

const OWNER = Object.freeze({ id: 'owner-10001', displayName: '槑', platform: 'qq' });

/** 合成一份合法的 identity.json（磁盘上的真实文件，不是内存对象）。 */
function writeIdentity(root, overrides = {}) {
  const value = {
    schemaVersion: 1,
    persona: 'bot',
    owner: { ...OWNER },
    desktop: { mode: 'local-owner', userId: OWNER.id },
    sessions: {},
    ...overrides,
  };
  const file = path.join(root, 'home/companion/identity.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return { file, value };
}

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(testRoot, 'identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const written = writeIdentity(root, overrides);
  return { root, ...written };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('合成 + 主人绑定：owner() 与 context() 描述同一个本地主人，绑定 JSON 与 resolve() 完全一致', t => {
  const { root, value } = fixture(t);
  const identity = createIdentity(root);

  assert.deepEqual(identity.owner(), value.owner);

  const bound = identity.resolve('sess-owner-1');
  assert.equal(bound.userId, OWNER.id);
  assert.equal(bound.displayName, OWNER.displayName);
  assert.equal(bound.sourcePlatform, 'qq');
  assert.equal(bound.persona, 'bot');
  assert.equal(bound.mode, 'local-owner');
  assert.equal(bound.sessionId, 'sess-owner-1');

  const context = identity.context('sess-owner-1');
  // 文本声明：当前桌面聊天者就是旧 QQ 私聊里的同一个人，不是陌生人。
  assert.match(context, /当前用户身份绑定/);
  assert.match(context, /不是新认识的陌生用户/);
  assert.ok(context.endsWith(JSON.stringify(bound)), 'context() 的 JSON 尾巴必须与 resolve() 的返回值逐字一致');
  assert.ok(context.includes(OWNER.id));
});

test('会话解析：未知会话首次解析即绑定到主人并原子落盘（channel=desktop、boundAt 合法、保留 .previous）', t => {
  const { root, file } = fixture(t);
  const before = Date.now();
  const identity = createIdentity(root);

  assert.deepEqual(readJson(file).sessions, {}, '前置条件：还没有任何会话绑定');

  const bound = identity.resolve('dm-10001');
  const onDisk = readJson(file);
  const entry = onDisk.sessions['dm-10001'];
  assert.equal(entry.userId, OWNER.id);
  assert.equal(entry.persona, 'bot');
  assert.equal(entry.channel, 'desktop');
  const boundAt = Date.parse(entry.boundAt);
  assert.ok(Number.isFinite(boundAt), `boundAt 必须是可解析时间戳，实际 ${entry.boundAt}`);
  assert.ok(boundAt >= before - 1_000 && boundAt <= Date.now() + 1_000, `boundAt 必须落在本次解析附近，实际 ${entry.boundAt}`);
  assert.equal(bound.userId, entry.userId);

  // 原子写：先用 tmp 再 rename，并留下 .previous 备份（备份里 sessions 还是空的）。
  assert.deepEqual(readJson(`${file}.previous`).sessions, {});
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')), []);

  // 重复解析不重复绑定、不重写文件。
  const snapshot = fs.readFileSync(file, 'utf8');
  const again = identity.resolve('dm-10001');
  assert.deepEqual(again, bound);
  assert.equal(fs.readFileSync(file, 'utf8'), snapshot, '已绑定的会话再次解析不得改写 identity.json');

  // 没有会话就不解析：不允许“不知道是谁”时顺手绑主人。
  assert.throws(() => identity.resolve(), /A runtime session is required/);
  assert.throws(() => identity.resolve(''), /A runtime session is required/);
  assert.throws(() => identity.resolve(42), /A runtime session is required/);
  assert.deepEqual(Object.keys(readJson(file).sessions), ['dm-10001'], '被拒绝的解析不能留下绑定');
});

test('会话级隔离：一个会话被外部用户占用时如实报冲突，其他会话照常解析，且不改写别人的归属', t => {
  const { root, file } = fixture(t);
  const identity = createIdentity(root);
  identity.resolve('sess-a');
  identity.resolve('sess-b');

  const tampered = readJson(file);
  tampered.sessions['sess-a'].userId = 'someone-else';
  fs.writeFileSync(file, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

  assert.throws(() => identity.resolve('sess-a'), /Session user binding conflicts with the local owner/);
  // 冲突只影响那一个会话；另一个会话不受牵连。
  assert.equal(identity.resolve('sess-b').userId, OWNER.id);
  // 也不会把别人的会话“顺手改判”成主人。
  assert.equal(readJson(file).sessions['sess-a'].userId, 'someone-else');
  assert.equal(identity.owner().id, OWNER.id);
});

test('跨用户隔离：两个 root 各自主人各管各的，同名会话不会互相串号', t => {
  const a = fixture(t);
  const b = fixture(t, {
    owner: { id: 'owner-b', displayName: '另一个人', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: 'owner-b' },
  });
  const identityA = createIdentity(a.root);
  const identityB = createIdentity(b.root);

  assert.equal(identityA.resolve('dm-1').userId, OWNER.id);
  assert.equal(identityB.resolve('dm-1').userId, 'owner-b');
  assert.deepEqual(Object.keys(readJson(a.file).sessions), ['dm-1']);
  assert.deepEqual(Object.keys(readJson(b.file).sessions), ['dm-1']);

  // 交叉核对：A 的上下文里不能出现 B 的主人，反之亦然。
  assert.equal(identityA.context('dm-1').includes('owner-b'), false);
  assert.equal(identityB.context('dm-1').includes(OWNER.id), false);
  // 同一个会话 id 在两个 root 里各绑各的主人：B 那边绑给 B 主人，A 这边仍然是 A 的主人。
  assert.equal(identityA.resolve('dm-1').userId, OWNER.id);
  assert.equal(readJson(b.file).sessions['dm-1'].userId, 'owner-b');
});

test('未知会话不冒充主人：身份不合法 / 桌面用户不是主人 / 已被判给别人的会话，一律 fail closed', async t => {
  const cases = [
    ['schemaVersion 不是 1', { schemaVersion: 2 }, /not configured/],
    ['缺 owner.id', { owner: { displayName: '槑', platform: 'qq' } }, /not configured/],
    ['缺 owner.displayName', { owner: { id: OWNER.id, platform: 'qq' } }, /not configured/],
    ['persona 不是 bot', { persona: 'someone' }, /not configured/],
    ['桌面模式不是 local-owner', { desktop: { mode: 'shared', userId: OWNER.id } }, /not configured/],
    ['桌面用户不是主人', { desktop: { mode: 'local-owner', userId: 'someone-else' } }, /not configured/],
    ['sessions 段缺失', { sessions: undefined }, /not configured/],
  ];
  for (const [label, overrides, expected] of cases) {
    const root = fs.mkdtempSync(path.join(testRoot, 'identity-bad-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const value = { schemaVersion: 1, persona: 'bot', owner: { ...OWNER }, desktop: { mode: 'local-owner', userId: OWNER.id }, sessions: {}, ...overrides };
    if (overrides.sessions === undefined) delete value.sessions;
    const file = path.join(root, 'home/companion/identity.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await t.test(label, () => {
      assert.throws(() => createIdentity(root), expected);
      // 失败必须发生在读盘时，不能先落一个绑定再报错。
      assert.equal(fs.existsSync(`${file}.previous`), false, `${label}：被拒绝的构造不得写盘`);
    });
  }

  // 构造之后主人被换掉：不再冒充新主人，也不继续按旧主人放行。
  const { root, file } = fixture(t);
  const identity = createIdentity(root);
  assert.equal(identity.owner().id, OWNER.id);
  const changed = readJson(file);
  changed.owner = { id: 'owner-hijacked', displayName: '冒名者', platform: 'qq' };
  changed.desktop = { mode: 'local-owner', userId: 'owner-hijacked' };
  fs.writeFileSync(file, `${JSON.stringify(changed, null, 2)}\n`, 'utf8');
  assert.throws(() => identity.owner(), /Local owner changed/);
  assert.throws(() => identity.resolve('dm-1'), /Local owner changed/);
});

test('首次运行：没有 identity.json 时按默认本地主人建档，不把「没配置」当错误', t => {
  const root = fs.mkdtempSync(path.join(testRoot, 'identity-first-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'home/companion/identity.json');
  assert.equal(fs.existsSync(file), false, '前置条件：目录里确实没有 identity.json');

  // 构造阶段就必须活下来：profile 可能先挂 Studio，再有人写身份文件。
  const identity = createIdentity(root, { onProvision: () => {} });
  const owner = identity.owner();
  assert.equal(fs.existsSync(file), true, '首次读取后文件必须存在');
  const written = readJson(file);
  assert.equal(written.schemaVersion, 1);
  assert.equal(written.persona, 'bot');
  assert.equal(written.owner.id, owner.id);
  assert.equal(written.desktop.mode, 'local-owner');
  assert.equal(written.desktop.userId, owner.id);
  assert.deepEqual(written.sessions, {});
  assert.equal(written.provisionedBy, 'companion-foundation/identity');
  assert.ok(Number.isFinite(Date.parse(written.provisionedAt)));

  // 幂等：用户改过之后，再构造一次不得覆盖。
  written.owner.displayName = '我自己改的名字';
  fs.writeFileSync(file, `${JSON.stringify(written, null, 2)}\n`, 'utf8');
  const again = createIdentity(root, { onProvision: () => {} });
  assert.equal(again.owner().displayName, '我自己改的名字');
  assert.equal(again.owner().id, owner.id);
});

test('首次运行：可用显式 owner 建档；关掉自动建档时仍然 fail closed 且不写盘', t => {
  const root = fs.mkdtempSync(path.join(testRoot, 'identity-first-run-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = createIdentity(root, {
    owner: { id: 'owner-from-setup', displayName: '设置页主人', platform: 'qq' },
    onProvision: () => {},
  });
  assert.equal(identity.owner().id, 'owner-from-setup');
  assert.equal(identity.resolve('dm-1').userId, 'owner-from-setup');

  const bare = fs.mkdtempSync(path.join(testRoot, 'identity-no-provision-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  assert.throws(() => createIdentity(bare, { provision: false }), /not configured/);
  assert.equal(fs.existsSync(path.join(bare, 'home/companion/identity.json')), false, '关掉建档就不许写盘');
});