/** P2.5 round16 §2.3a：账本写入的原子性——**改动与落盘同生共死，读盘的自愈面不许丢**。
 *
 * 缺陷原样（`store.write()`）：先把内存换成盘上那份、再就地改、最后才 `persist()`。
 * 于是 `persist()` 一抛，进程里的账本已经是脏的：配额、冷却、`deliveredDedupeKeys`
 * 会读到一个从未落盘的状态，直到下一次成功写盘（重读盘才自愈）。现场几乎复现不了，
 * 所以这两条用例的判据是"结构"而不是"某次输出"：
 *
 *   1. `mutate` 真的改了、但落盘失败 ⇒ 内存保持旧值、盘保持旧值；
 *   2. `mutate` 返回 false ⇒ **一个字节都不写盘**，但内存仍然采纳盘上的真相
 *      （round18 裁决：旧实现那条"读一次就跟着盘走"的自愈面不许因为原子性改造而丢掉；
 *      丢掉它，"内存相对盘落后"的窗口会出现在正常路径上，而不只是落盘失败路径）。
 *
 * 造"落盘失败"用一次注定失败的 `rename`：`ENOSPC` 不在 `ledger-io` 的可重试码表里，
 * 立刻抛、不需要推进假时钟，所以这条用例是确定性的（不赌退避与机器负载）。
 * 盘上的内容另起一次 `readLedgerFile`（或逐字节比对文件）核对，不信任被测对象自己的说法。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { readLedgerFile } from '../src/features/contact/ledger-io.js'
import { ContactStore, type ContactStoreOptions } from '../src/features/contact/store.js'
import type { ContactLedger } from '../src/features/contact/ledger.js'
import { contactCandidate, FakeClock, tempHome, type TempHome } from './fakes/contact.js'

const T0 = Date.UTC(2026, 9, 30, 1, 0, 0)
const DAY = '2026-10-30'

/** 一套"同一个文件上的两个实例"的公共参数（pid 不同，模拟两个进程）。 */
function options(home: TempHome, clock: FakeClock, pid: number, renameOnce?: ContactStoreOptions['renameOnce']): ContactStoreOptions {
  return {
    file: `${home.dir}/contact.json`,
    lockFile: `${home.dir}/contact.lock`,
    hostId: 'atomic-host',
    pid,
    log: () => {},
    clock,
    dayKey: () => DAY,
    ...(renameOnce === undefined ? {} : { renameOnce }),
  }
}

/** 从盘上现读一份（**独立于被测对象的内存**：它说什么才算数）。 */
async function readDisk(home: TempHome, clock: FakeClock): Promise<ContactLedger> {
  const read = await readLedgerFile({ file: `${home.dir}/contact.json`, clock, log: () => {}, dayKey: () => DAY }, false)
  return read.ledger
}

test('round16 §2.3a 落盘失败：内存与盘都保持旧值（不再"先换内存"）', async () => {
  const home = tempHome('atomic-fail-')
  const clock = new FakeClock(new Date(T0))
  let diskFull = false
  const store = new ContactStore(options(home, clock, process.pid, async (from, to) => {
    if (diskFull) {
      const error: NodeJS.ErrnoException = new Error('ENOSPC: 磁盘已满（伪造）')
      error.code = 'ENOSPC'
      throw error
    }
    await rename(from, to)
  }))
  try {
    await store.load()
    const candidate = contactCandidate({ id: 'c-atomic' })
    assert.equal(await store.putCandidate(candidate), true)
    assert.equal(store.state.candidates['c-atomic']?.attempts, 0)
    assert.equal((await readDisk(home, clock)).candidates['c-atomic']?.attempts, 0)

    diskFull = true
    // 写盘失败必须**抛出来**（调用方要知道"这次没落盘"），而不是假装成功。
    await assert.rejects(store.patchCandidate(candidate.id, { attempts: 7 }, T0 + 1), /ENOSPC/)
    // 内存：还是旧值。旧实现这里已经是 attempts=7 / version=2 —— 脏账本活到了下一次写盘。
    assert.equal(store.state.candidates['c-atomic']?.attempts, 0, '内存账本被一次失败的写改掉了')
    assert.equal(store.state.candidates['c-atomic']?.version, 1)
    // 盘：当然也没变。
    assert.equal((await readDisk(home, clock)).candidates['c-atomic']?.attempts, 0)

    diskFull = false
    assert.notEqual(await store.patchCandidate(candidate.id, { attempts: 7 }, T0 + 2), null)
    assert.equal(store.state.candidates['c-atomic']?.attempts, 7)
    assert.equal((await readDisk(home, clock)).candidates['c-atomic']?.attempts, 7)
  } finally {
    home.cleanup()
  }
})

test('round18/§2.3a mutate 返回 false：一个字节都不写盘，但内存采纳盘上的真相（只读 adopt）', async () => {
  const home = tempHome('atomic-noop-')
  const clock = new FakeClock(new Date(T0))
  let renames = 0
  const mine = new ContactStore(options(home, clock, process.pid, async (from, to) => {
    renames += 1
    await rename(from, to)
  }))
  // 第二个实例：模拟"另一个进程合法地写了这本账"（`propose()` 不需要租约就能入池）。
  const other = new ContactStore(options(home, clock, process.pid + 1))
  const file = `${home.dir}/contact.json`
  try {
    await mine.putCandidate(contactCandidate({ id: 'c-mine', dedupeKey: 'k-mine' }))
    await other.putCandidate(contactCandidate({ id: 'c-other', dedupeKey: 'k-other' }))
    assert.deepEqual(Object.keys((await readDisk(home, clock)).candidates).sort(), ['c-mine', 'c-other'])
    const diskBefore = readFileSync(file, 'utf-8')
    const renamesBefore = renames

    // 一次"业务上什么都不改"的写。
    assert.equal(await mine.write(() => false), false)

    // ① 不落盘：一次 rename（原子写的最后一步）都不该发生，盘上逐字节不变。
    assert.equal(renames, renamesBefore, 'mutate 说没改，就不许写盘')
    assert.equal(readFileSync(file, 'utf-8'), diskBefore, '盘上内容必须逐字节不变')

    // ② 但内存要跟着盘走（round18 裁决：旧实现的自愈面不许丢）。
    assert.deepEqual(Object.keys(mine.state.candidates).sort(), ['c-mine', 'c-other'])

    // ③ 下一次真的写：仍然从盘上重读，落盘成功后才整体换内存。
    assert.equal(await mine.putCandidate(contactCandidate({ id: 'c-later', dedupeKey: 'k-later' })), true)
    assert.deepEqual(Object.keys(mine.state.candidates).sort(), ['c-later', 'c-mine', 'c-other'])
    assert.deepEqual(Object.keys((await readDisk(home, clock)).candidates).sort(), ['c-later', 'c-mine', 'c-other'])
  } finally {
    home.cleanup()
  }
})
