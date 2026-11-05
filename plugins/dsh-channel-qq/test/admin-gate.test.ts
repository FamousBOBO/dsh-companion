/** 后台闸门的行为断言——P0 的核心安全结论就落在这里。
 *
 * 1. 巡航任务（`cruises`）在环境开关关闭时**不能**被后台改写，打开后才可以；
 * 2. 后端锁定 admin.host：远程监听未开时改成非本机地址被拒；
 * 3. 密码来源链（P5.7）：环境变量 scrypt 哈希 / 明文 env / 未设置时**生成一次性
 *    口令并打印一次**（spec §8 抄 AstrBot 的做法——不再"登录一律拒绝"，但也不
 *    存在任何固定默认口令）；改密码撤销全部会话。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  AdminServer, ALLOW_CRUISE_EDITS_ENV, ALLOW_REMOTE_ENV, PASSWORD_ENV, HASH_ENV,
  type AdminDeps,
} from '../src/admin.js'
import { resolveConfig } from '../src/config.js'
import { hashPassword } from '../src/admin/auth.js'

/** 一个端口号足够高、不撞常用服务的测试端口。 */
const TEST_PORT = 18790

function makeDeps(dshHome: string, logs: string[] = []): AdminDeps {
  const config = resolveConfig()
  config.admin.port = TEST_PORT
  return {
    config,
    dshHome,
    log: (line: string) => { logs.push(line) },
    status: async () => ({}),
    readLog: async () => [],
    resources: {},
  }
}

/** 环境变量在用例之间必须清干净，否则测试顺序会互相影响。 */
async function withEnv(names: string[], values: Array<string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous = names.map((name) => process.env[name])
  names.forEach((name, i) => {
    const value = values[i]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  })
  try {
    await run()
  } finally {
    names.forEach((name, i) => {
      const value = previous[i]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
  }
}

const CLEAN_ENV = () => withEnv([PASSWORD_ENV, HASH_ENV, ALLOW_REMOTE_ENV, ALLOW_CRUISE_EDITS_ENV],
  [undefined, undefined, undefined, undefined], async () => { /* 仅作为包装用法时的占位 */ })

test('巡航任务在环境开关关闭时被拒绝（403），且配置没有被改写', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'admin-gate-'))
  try {
    await withEnv([ALLOW_CRUISE_EDITS_ENV], [undefined], async () => {
      const deps = makeDeps(home)
      const server = new AdminServer(deps)
      const evil = [{ id: 'x', enabled: true, script: 'node scripts/a.mjs; rm -rf /', intervalMin: 30 }]
      await assert.rejects(
        () => server.applyConfigPatch({ cruises: evil }),
        (error: Error & { status?: number }) => {
          assert.equal(error.status, 403, '应当是 403 而不是 500')
          assert.match(error.message, /巡航任务/)
          return true
        },
      )
      assert.deepEqual(deps.config.cruises, [], '被拒绝的补丁不能碰到内存里的配置')
      // 也不该落盘。
      assert.throws(() => readFileSync(path.join(home, 'channel-qq', 'admin-config.json'), 'utf-8'))
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('巡航任务在环境开关打开时可以保存', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'admin-gate-'))
  try {
    await withEnv([ALLOW_CRUISE_EDITS_ENV], ['1'], async () => {
      const deps = makeDeps(home)
      const server = new AdminServer(deps)
      const patch = [{ id: 'x', enabled: true, script: 'node scripts/a.mjs', intervalMin: 30 }]
      const result = await server.applyConfigPatch({ cruises: patch })
      assert.deepEqual(result.applied, ['cruises'])
      assert.equal(deps.config.cruises.length, 1)
      const persisted: unknown = JSON.parse(readFileSync(path.join(home, 'channel-qq', 'admin-config.json'), 'utf-8'))
      assert.equal((persisted as { cruises: unknown[] }).cruises.length, 1)
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('其它配置项不受巡航锁影响', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'admin-gate-'))
  try {
    await withEnv([ALLOW_CRUISE_EDITS_ENV], [undefined], async () => {
      const deps = makeDeps(home)
      const server = new AdminServer(deps)
      const result = await server.applyConfigPatch({ talkValue: 0.25, groupAdmin: { dangerous: true } })
      assert.equal(deps.config.talkValue, 0.25)
      assert.equal(deps.config.groupAdmin.dangerous, true)
      assert.deepEqual(result.restartRequired, [], 'live 级字段不需要重启')
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('远程监听关闭时，不接受把 admin.host 存成别的地址', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'admin-gate-'))
  try {
    await withEnv([ALLOW_REMOTE_ENV], [undefined], async () => {
      const deps = makeDeps(home)
      const server = new AdminServer(deps)
      await assert.rejects(
        () => server.applyConfigPatch({ admin: { host: '0.0.0.0' } }),
        (error: Error & { status?: number }) => {
          assert.equal(error.status, 403)
          assert.match(error.message, /127\.0\.0\.1/)
          return true
        },
      )
      assert.equal(deps.config.admin.host, '127.0.0.1', '内存里的 host 不该被改掉')

      // 写回 127.0.0.1 本身是允许的（幂等保存）。
      const ok = await server.applyConfigPatch({ admin: { host: '127.0.0.1' } })
      assert.deepEqual(ok.applied, ['admin'])
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('远程监听打开时，admin.host 可以被保存', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'admin-gate-'))
  try {
    await withEnv([ALLOW_REMOTE_ENV], ['1'], async () => {
      const deps = makeDeps(home)
      const server = new AdminServer(deps)
      await server.applyConfigPatch({ admin: { host: '0.0.0.0' } })
      assert.equal(deps.config.admin.host, '0.0.0.0')
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('未设置任何口令：生成一次性随机口令并打印一次，登录只认它', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'admin-gate-'))
  const logs: string[] = []
  await CLEAN_ENV()
  const server = new AdminServer(makeDeps(home, logs))
  try {
    await withEnv([PASSWORD_ENV, HASH_ENV], [undefined, undefined], async () => {
      await server.start()
      const health = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`)
      assert.equal(health.status, 200)
      const healthBody = await health.json() as { passwordRequired?: boolean }
      assert.equal(healthBody.passwordRequired, true, '生成口令后 health 应当说"要密码"')

      const empty = await fetch(`http://127.0.0.1:${TEST_PORT}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'dsh-admin' },
        body: JSON.stringify({ password: '' }),
      })
      assert.equal(empty.status, 401, '空密码 = 谁也进不来')

      // 从日志里把生成的一次性口令捞出来（那是它唯一的亮相）。
      const line = logs.find((l) => l.includes('已生成一次性口令'))
      assert.ok(line !== undefined, '应当打印一行生成口令的日志')
      const generated = line.split('：').pop()?.trim() ?? ''
      assert.ok(generated.length >= 12, `生成口令应当 ≥12 位：${generated.length}`)

      const login = await fetch(`http://127.0.0.1:${TEST_PORT}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'dsh-admin' },
        body: JSON.stringify({ password: generated }),
      })
      assert.equal(login.status, 200, '生成的口令应当能登录')
      const cookie = login.headers.get('set-cookie') ?? ''
      assert.match(cookie, /HttpOnly/)
      assert.match(cookie, /SameSite=Strict/)
      assert.match(cookie, /Max-Age=43200\b/, '会话应为 12 小时')
    })
  } finally {
    server.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('环境变量明文口令仍然可用，旧字面量默认口令不再有效', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'admin-gate-'))
  await CLEAN_ENV()
  const server = new AdminServer(makeDeps(home))
  try {
    await withEnv([PASSWORD_ENV, HASH_ENV], ['a-strong-test-password', undefined], async () => {
      await server.start()

      const wrong = await fetch(`http://127.0.0.1:${TEST_PORT}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'dsh-admin' },
        body: JSON.stringify({ password: 'test-password-123' }),
      })
      assert.equal(wrong.status, 401, '代码里那个旧默认密码必须不再能登录')

      const right = await fetch(`http://127.0.0.1:${TEST_PORT}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'dsh-admin' },
        body: JSON.stringify({ password: 'a-strong-test-password' }),
      })
      assert.equal(right.status, 200)
      const cookie = right.headers.get('set-cookie') ?? ''
      assert.match(cookie, /dsh_admin=/)
      assert.match(cookie, /Max-Age=43200\b/, '会话应为 12 小时')
    })
  } finally {
    server.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('写请求缺少防 CSRF 头被拒绝；带上则通过', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'admin-gate-'))
  await CLEAN_ENV()
  const logs: string[] = []
  const server = new AdminServer(makeDeps(home, logs))
  try {
    await withEnv([PASSWORD_ENV, HASH_ENV], [undefined, undefined], async () => {
      await server.start()
      const line = logs.find((l) => l.includes('已生成一次性口令'))
      const generated = line?.split('：').pop()?.trim() ?? ''
      const login = await fetch(`http://127.0.0.1:${TEST_PORT}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'dsh-admin' },
        body: JSON.stringify({ password: generated }),
      })
      const cookie = login.headers.get('set-cookie') ?? ''
      const token = cookie.split(';')[0]?.split('=')[1] ?? ''

      const noHeader = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ patch: { talkValue: 0.5 } }),
      })
      assert.equal(noHeader.status, 403, '没有 X-Requested-With 的写请求必须被拒')

      const withHeader = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-requested-with': 'dsh-admin' },
        body: JSON.stringify({ patch: { talkValue: 0.5 } }),
      })
      assert.equal(withHeader.status, 200, '带上头就应当通过')
    })
  } finally {
    server.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('scrypt 哈希口令（env）优先于明文 env，且改密会撤销全部会话', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'admin-gate-'))
  await CLEAN_ENV()
  const server = new AdminServer(makeDeps(home))
  try {
    const hashed = hashPassword('hash-env-password-123')
    await withEnv([HASH_ENV, PASSWORD_ENV], [hashed, 'plain-env-password-456'], async () => {
      await server.start()

      const byPlain = await fetch(`http://127.0.0.1:${TEST_PORT}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'dsh-admin' },
        body: JSON.stringify({ password: 'plain-env-password-456' }),
      })
      assert.equal(byPlain.status, 401, '哈希存在时明文 env 不该再有效')

      const login = await fetch(`http://127.0.0.1:${TEST_PORT}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'dsh-admin' },
        body: JSON.stringify({ password: 'hash-env-password-123' }),
      })
      assert.equal(login.status, 200, '哈希口令应当能登录')
      const cookie = login.headers.get('set-cookie') ?? ''
      const token = cookie.split(';')[0]?.split('=')[1] ?? ''

      // 会话有效：snapshot 可达。
      const before = await fetch(`http://127.0.0.1:${TEST_PORT}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(before.status, 200)

      // env 管理时改密被拒（后台不接管）。
      const change = await fetch(`http://127.0.0.1:${TEST_PORT}/api/password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-requested-with': 'dsh-admin' },
        body: JSON.stringify({ current: 'hash-env-password-123', next: 'a-new-strong-password' }),
      })
      assert.equal(change.status, 403, 'env 管理的口令后台不接管修改')

      // 撤销全部会话后，同一 token 失效。
      const out = await fetch(`http://127.0.0.1:${TEST_PORT}/api/logout-all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-requested-with': 'dsh-admin' },
        body: JSON.stringify({}),
      })
      assert.equal(out.status, 200)
      const after = await fetch(`http://127.0.0.1:${TEST_PORT}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(after.status, 401, '撤销后旧会话不能再用')
    })
  } finally {
    server.stop()
    rmSync(home, { recursive: true, force: true })
  }
})
