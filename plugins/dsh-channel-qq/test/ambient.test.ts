/** 旁听缓冲（`core/ambient.ts`）+ 按群装配层（`app/inbound/ambient-store.ts`）的单测。
 *
 * 这一层是"她记得刚才大家在聊什么"的唯一来源，所以被钉的是它的**边界**：
 *   条数 / 时间 / 字数三重上限、`messageId` 去重、空正文拒绝、
 *   `take` 的游标语义（取走就不再出现）、`peekAfter` 只看不动、
 *   多群隔离、以及热改上限时立即裁剪。
 *
 * 时间全部由入参驱动（`add` 的 `atMs` / `size` / `take` / `peekAfter` 的 `nowMs`）：
 * 这里**没有任何 sleep**，每一条过期与窗口行为都是可重放的。
 *
 * 断言只描述"现在按合同应该怎样"：如果哪天真坏了，坏在具体哪一行要一眼看得出来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { AmbientRing } = await import('../src/core/ambient.js')
const { AmbientStore, ambientLimitsOf, presenceAppliesTo, presenceGroupsOf, presenceSettingsOf } =
  await import('../src/app/inbound/ambient-store.js')

type AmbientLimits = import('../src/core/ambient.js').AmbientLimits
type AmbientInput = import('../src/core/ambient.js').AmbientInput

/** 一套够用的上限；单个用例只覆盖它关心的那个字段。 */
function limits(over: Partial<AmbientLimits> = {}): AmbientLimits {
  return { maxEntries: 10, ttlMs: 1_000, maxChars: 10_000, ...over }
}

/** 一条旁听；`at` 是它的时间，`id` 是 QQ 消息号。 */
function entry(at: number, text: string, over: Partial<AmbientInput> = {}): AmbientInput {
  return {
    messageId: null,
    userId: 200,
    name: '甲',
    text,
    atMs: at,
    self: false,
    ...over,
  }
}

// ── 1. 条数上限 ────────────────────────────────────────────────────────────

test('条数上限：超了就丢最老的，留下的永远是最新的那几条', () => {
  const ring = new AmbientRing(limits({ maxEntries: 3 }))
  for (let i = 1; i <= 5; i += 1) ring.add(entry(0, `第${String(i)}条`))

  assert.equal(ring.size(0), 3, 'maxEntries=3 只能留 3 条')
  assert.deepEqual(ring.peekAfter(0, 0).map((e) => e.text), ['第3条', '第4条', '第5条'], '丢的是最老的，不是最新的')
})

test('条数上限：seq 是单调递增的，被淘汰的条号不会被复用', () => {
  const ring = new AmbientRing(limits({ maxEntries: 2 }))
  ring.add(entry(0, 'a'))
  ring.add(entry(0, 'b'))
  ring.add(entry(0, 'c'))

  assert.equal(ring.lastSeq(), 3, 'seq 只跟"加过几条"有关，与淘汰无关')
  assert.deepEqual(ring.peekAfter(0, 0).map((e) => e.seq), [2, 3], '剩下的两条仍带着原来的序号')
})

// ── 2. TTL 过期（时间由入参驱动，不 sleep）────────────────────────────────

test('TTL：到期的条目不再计入 size，也取不出来', () => {
  const ring = new AmbientRing(limits({ ttlMs: 1_000 }))
  ring.add(entry(0, '十分钟前的话'))

  assert.equal(ring.size(999), 1, '差 1ms 没过期还算活着（atMs + ttl > now）')
  assert.equal(ring.size(1_000), 0, '正好到期就没了')
  assert.deepEqual(ring.take(1_000), [], '过期的条目不能被交付给回合')
})

test('TTL：新消息入列时顺带清掉过期的，过期条目不占条数额度', () => {
  const ring = new AmbientRing(limits({ ttlMs: 1_000, maxEntries: 2 }))
  ring.add(entry(0, 'old-1'))
  ring.add(entry(0, 'old-2'))
  // 时间跨过 TTL 之后再记一条：前两条在 add 里就被 prune 了。
  ring.add(entry(5_000, 'new'))

  assert.equal(ring.size(5_000), 1, '过期的两条都不在了')
  assert.deepEqual(ring.peekAfter(0, 5_000).map((e) => e.text), ['new'])
})

test('TTL：每条各自计时，不是"最后一条的时钟"', () => {
  const ring = new AmbientRing(limits({ ttlMs: 1_000 }))
  ring.add(entry(0, '0ms'))
  ring.add(entry(600, '600ms'))

  assert.deepEqual(ring.peekAfter(0, 1_100).map((e) => e.text), ['600ms'], '先来的先过期，后来的还在')
})

// ── 3. 字数上限 ───────────────────────────────────────────────────────────

test('字数上限：总量越界就按最老的开始丢，直到不超', () => {
  const ring = new AmbientRing(limits({ maxChars: 8 }))
  ring.add(entry(0, 'aaaa')) // 4
  ring.add(entry(0, 'bbbb')) // 4
  ring.add(entry(0, 'cccc')) // 4 → 共 12，必须丢到 ≤ 8

  assert.deepEqual(ring.peekAfter(0, 0).map((e) => e.text), ['bbbb', 'cccc'], '只留最近的两条（8 字）')
  assert.equal(ring.size(0), 2)
})

test('字数上限按码点算：一个 emoji 算一个字，不是两个', () => {
  // 两条各 2 个码点（UTF-16 长度是 4）。按码点算总量 4 ≤ 4，两条都留；
  // 若按 UTF-16 长度算就是 8 > 4，会误丢一条。
  const ring = new AmbientRing(limits({ maxChars: 4 }))
  ring.add(entry(0, '😀😀'))
  ring.add(entry(0, '😀😀'))

  assert.equal(ring.size(0), 2, 'emoji 不能被算成两个字符')
})

test('字数上限：单条超长时 take 仍然给出一条（窗口不会空手而归）', () => {
  const ring = new AmbientRing(limits({ maxChars: 1_000 }))
  ring.add(entry(0, 'x'.repeat(50)))

  const taken = ring.take(0, { maxChars: 10 })
  assert.equal(taken.length, 1, '最新的那条即使超过窗口字数也保留：否则被 @ 时背景整个是空的')
})

// ── 4. messageId 去重 ─────────────────────────────────────────────────────

test('去重：同一个 message_id 再 add 返回 duplicate，且不增加条目', () => {
  const ring = new AmbientRing(limits())
  assert.equal(ring.add(entry(0, '同一条', { messageId: 7 })), 'added')
  assert.equal(ring.add(entry(0, '同一条', { messageId: 7 })), 'duplicate', 'NapCat 重试/窗口回显不能重复入列')
  assert.equal(ring.size(0), 1)
  assert.equal(ring.lastSeq(), 1, 'duplicate 不占序号')
})

test('去重：messageId 为 null 的合成消息不参与去重（没有号就没法判重）', () => {
  const ring = new AmbientRing(limits())
  assert.equal(ring.add(entry(0, '无号-1', { messageId: null })), 'added')
  assert.equal(ring.add(entry(0, '无号-2', { messageId: null })), 'added', '两个 null 不是"同一条"')
  assert.equal(ring.size(0), 2)
})

test('去重：正文相同但 message_id 不同，是两条', () => {
  const ring = new AmbientRing(limits())
  ring.add(entry(0, '哈哈哈', { messageId: 1 }))
  ring.add(entry(0, '哈哈哈', { messageId: 2 }))
  assert.equal(ring.size(0), 2, '复读不是重复投递')
})

// ── 5. 空正文 ─────────────────────────────────────────────────────────────

test('空正文：纯空白视为 rejected，不占序号也不占条数', () => {
  const ring = new AmbientRing(limits())
  assert.equal(ring.add(entry(0, '')), 'rejected')
  assert.equal(ring.add(entry(0, '   \n\t ')), 'rejected', '只有空格换行也算空')
  assert.equal(ring.size(0), 0)
  assert.equal(ring.lastSeq(), 0, 'rejected 不推游标')
})

// ── 6. take 推进游标 ──────────────────────────────────────────────────────

test('take：取走之后游标推进，第二次 take 不会拿到同一批', () => {
  const ring = new AmbientRing(limits())
  ring.add(entry(0, '一'))
  ring.add(entry(0, '二'))

  assert.deepEqual(ring.take(0).map((e) => e.text), ['一', '二'], '第一次全取走（时间正序）')
  assert.deepEqual(ring.take(0), [], '第二次是空的——同一批背景不能交付两遍')

  ring.add(entry(0, '三'))
  assert.deepEqual(ring.take(0).map((e) => e.text), ['三'], '新来的照常交付')
})

test('take：被窗口跳过的老条目也算交付过（不会在下一次被 @ 时又冒出来）', () => {
  const ring = new AmbientRing(limits({ maxEntries: 10 }))
  for (const text of ['老1', '老2', '老3']) ring.add(entry(0, text))

  const taken = ring.take(0, { maxEntries: 1 })
  assert.deepEqual(taken.map((e) => e.text), ['老3'], '条数窗口只取最近 1 条')
  assert.deepEqual(ring.take(0), [], '被跳过的老1/老2 已经算交付过，不再重复给')
})

// ── 7. take 的 excludeMessageId ───────────────────────────────────────────

test('take：excludeMessageId 把"当前这条消息"排除在背景之外', () => {
  const ring = new AmbientRing(limits())
  ring.add(entry(0, '背景-1', { messageId: 11 }))
  ring.add(entry(0, '背景-2', { messageId: 12 }))
  // 当前这条（被 @ 的那条）自己也已经进了旁听：它在待回块里，不该再当背景重复一遍。
  ring.add(entry(0, '@三月七 你怎么看', { messageId: 13 }))

  const taken = ring.take(0, { excludeMessageId: 13 })
  assert.deepEqual(taken.map((e) => e.text), ['背景-1', '背景-2'], '当前这条不在背景里')
  assert.ok(!taken.some((e) => e.messageId === 13), '再确认一次：背景块里没有当前消息')
})

test('take：excludeMessageId 传 null 等于不排除', () => {
  const ring = new AmbientRing(limits())
  ring.add(entry(0, 'a', { messageId: 5 }))
  assert.equal(ring.take(0, { excludeMessageId: null }).length, 1)
})

// ── 8. peekAfter 不推进游标 ───────────────────────────────────────────────

test('peekAfter：只看不取，游标不动（兴趣判断用同一份条目）', () => {
  const ring = new AmbientRing(limits())
  ring.add(entry(0, '一'))
  ring.add(entry(0, '二'))

  const peeked = ring.peekAfter(0, 0)
  assert.deepEqual(peeked.map((e) => e.text), ['一', '二'])
  assert.deepEqual(ring.peekAfter(0, 0).map((e) => e.text), ['一', '二'], '看几次都一样')
  assert.deepEqual(ring.take(0).map((e) => e.text), ['一', '二'], 'peek 之后再 take 仍然拿得到')
})

test('peekAfter：只返回给定 seq 之后的（判断到哪了不会被重复判）', () => {
  const ring = new AmbientRing(limits())
  ring.add(entry(0, '一')) // seq 1
  ring.add(entry(0, '二')) // seq 2
  ring.add(entry(0, '三')) // seq 3

  assert.deepEqual(ring.peekAfter(2, 0).map((e) => e.text), ['三'])
  assert.deepEqual(ring.peekAfter(3, 0), [], '都判过了')
})

// ── 9. self 标记 ──────────────────────────────────────────────────────────

test('self：她自己发的那条照样进旁听，但带着 self=true 交给下游区分', () => {
  const ring = new AmbientRing(limits())
  ring.add(entry(0, '别人说的'))
  ring.add(entry(0, '她自己说的', { self: true, userId: 100 }))

  const taken = ring.take(0)
  assert.equal(taken.length, 2, '自己的回显也是"群里刚发生的事"，不该凭空消失')
  assert.equal(taken[0]?.self, false)
  assert.equal(taken[1]?.self, true, 'self 标记必须保留：判断与背景都要能区分谁说的')
})

// ── 10. 多群隔离（AmbientStore）───────────────────────────────────────────

test('多群互不影响：两个群号各有各的缓冲', () => {
  const logs: string[] = []
  const store = new AmbientStore({ log: (line) => logs.push(line) })
  const a = store.ring(111, limits())
  const b = store.ring(222, limits())

  a.add(entry(0, '群里 A 的话', { messageId: 1 }))
  a.add(entry(0, 'A 的第二句', { messageId: 2 }))

  assert.equal(a.size(0), 2)
  assert.equal(b.size(0), 0, '另一个群看不到这里的旁听')
  assert.deepEqual(b.take(0), [], '另一个群也没有可交付的背景')
  assert.deepEqual(a.take(0).map((e) => e.text), ['群里 A 的话', 'A 的第二句'], 'A 的游标只影响 A')

  assert.deepEqual(store.groups().sort((x, y) => x - y), [111, 222])
  assert.equal(logs.length, 2, '首次建缓冲各记一行日志')
})

test('多群互不影响：同一个群反复取到的是同一个环（游标与序号连续）', () => {
  const store = new AmbientStore({ log: () => {} })
  const first = store.ring(111, limits())
  first.add(entry(0, '一'))

  const again = store.ring(111, limits())
  assert.equal(again, first, '上限没变就复用同一个环')
  assert.equal(again.lastSeq(), 1, '序号接着走，不会被重置')
  assert.deepEqual(again.take(0).map((e) => e.text), ['一'])
})

test('forget：群被移出白名单后旁听直接抹掉，不会留一份看不见的状态', () => {
  const store = new AmbientStore({ log: () => {} })
  const ring = store.ring(111, limits())
  ring.add(entry(0, '旧背景'))

  store.forget(111)
  assert.deepEqual(store.groups(), [], 'group 列表里没有它了')

  const fresh = store.ring(111, limits())
  assert.notEqual(fresh, ring)
  assert.equal(fresh.size(0), 0, '重新进白名单是干净的，不继承旧旁听')
})

// ── 11. configure 换上限立即裁剪 ──────────────────────────────────────────

test('configure：换小条数上限立即裁剪，不迁移历史', () => {
  const ring = new AmbientRing(limits({ maxEntries: 5 }))
  for (let i = 1; i <= 5; i += 1) ring.add(entry(0, `第${String(i)}条`))
  assert.equal(ring.size(0), 5)

  ring.configure(limits({ maxEntries: 2 }))
  assert.equal(ring.size(0), 2, '换上限当场生效（后台改完不用等下一次 add）')
  assert.deepEqual(ring.peekAfter(0, 0).map((e) => e.text), ['第4条', '第5条'], '留最新的')
})

test('configure：换小字数上限也立即裁剪', () => {
  const ring = new AmbientRing(limits({ maxChars: 100 }))
  ring.add(entry(0, 'aaaa'))
  ring.add(entry(0, 'bbbb'))

  ring.configure(limits({ maxChars: 4 }))
  assert.deepEqual(ring.peekAfter(0, 0).map((e) => e.text), ['bbbb'], '4 字只够留最新一条')
})

test('AmbientStore：配置热改上限时环就地裁剪（同一个实例，不重建）', () => {
  const store = new AmbientStore({ log: () => {} })
  const wide = store.ring(111, limits({ maxEntries: 5, ttlMs: 1_000, maxChars: 100 }))
  for (let i = 1; i <= 4; i += 1) wide.add(entry(0, `第${String(i)}条`))
  assert.equal(wide.size(0), 4)

  const narrowed = store.ring(111, limits({ maxEntries: 1, ttlMs: 1_000, maxChars: 100 }))
  assert.equal(narrowed, wide, '复用同一个环（上下文不该因为改上限全丢）')
  assert.equal(narrowed.size(0), 1)
  assert.deepEqual(narrowed.peekAfter(0, 0).map((e) => e.text), ['第4条'])
})

// ── 12. 装配层的配置归一 ──────────────────────────────────────────────────

test('presenceSettingsOf：没有 presence 段 → null（旧配置 = 关）', () => {
  assert.equal(presenceSettingsOf({}), null, '老配置构造里没有这一段，必须当成"没开"')
  const settings = { enabled: true, groups: [1], ambientMaxEntries: 40, ambientTtlMs: 600_000, ambientMaxChars: 6_000 }
  assert.equal(presenceSettingsOf({ presence: settings }), settings)
})

test('presenceGroupsOf：字符串群号归一成数字，认不出的丢掉', () => {
  const base = { enabled: true, ambientMaxEntries: 40, ambientTtlMs: 600_000, ambientMaxChars: 6_000 }
  assert.deepEqual(
    presenceGroupsOf({ ...base, groups: ['145326153', 145326154, ' 145326155 ', 'abc', -1, 0, 1.5, null] }),
    [145326153, 145326154, 145326155],
    '手改 JSON 存成字符串是老事故（primaryGroup 就这样失效过）：这里认得出就转成数字，认不出就丢',
  )
  // 手改坏的配置里 groups 可能根本不是数组：不抛异常、不当成"全部群"。
  assert.deepEqual(presenceGroupsOf({ ...base, groups: 'not-an-array' as never }), [], '不是数组就当空')
})

test('presenceAppliesTo：总开关关着 / 群不在白名单 / 没有群号 → 都不适用', () => {
  const settings = {
    enabled: true,
    groups: ['145326153'],
    ambientMaxEntries: 40,
    ambientTtlMs: 600_000,
    ambientMaxChars: 6_000,
  }
  assert.equal(presenceAppliesTo(settings, 145326153), true)
  assert.equal(presenceAppliesTo({ ...settings, enabled: false }, 145326153), false, '总开关关着时永远不适用')
  assert.equal(presenceAppliesTo(settings, 999), false, '白名单外的群不旁听')
  assert.equal(presenceAppliesTo(settings, null), false, '私聊没有群号')
  assert.equal(presenceAppliesTo(null, 145326153), false, '没有配置就是关')
})

test('ambientLimitsOf：三个上限原样传下去（夹安全值是环自己的事）', () => {
  const settings = {
    enabled: true,
    groups: [],
    ambientMaxEntries: 7,
    ambientTtlMs: 8,
    ambientMaxChars: 9,
  }
  assert.deepEqual(ambientLimitsOf(settings), { maxEntries: 7, ttlMs: 8, maxChars: 9 })
})

test('非法上限被夹成安全值：0 / 负数 / NaN 不会把缓冲撑爆或立刻清空', () => {
  const ring = new AmbientRing({ maxEntries: 0, ttlMs: Number.NaN, maxChars: -5 })
  for (let i = 1; i <= 45; i += 1) ring.add(entry(0, `第${String(i)}条`))

  // maxEntries 非正 → 回落到 40（默认值），所以 45 条只剩 40 条。
  assert.equal(ring.size(0), 40, '非法条数上限回落到默认 40')
  assert.equal(ring.take(0).length > 0, true, 'ttl 非法时不该把所有东西都判成过期')
})
