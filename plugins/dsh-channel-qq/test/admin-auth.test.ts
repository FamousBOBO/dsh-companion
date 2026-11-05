/** 认证链（`src/admin/auth.ts`）：scrypt、来源优先级、会话滑动续期、限速、CSRF、Cookie。
 *
 * P5.7 的安全底线：口令来源从高到低逐档回退、坏哈希 fail-closed、全空时生成
 * 一次性口令（而不是留一个固定默认口令）；会话 12 小时滑动；写请求必须带
 * 自定义头。全部在这里用单测钉住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  AuthManager, HASH_ENV, LoginGuard, MIN_PASSWORD_LENGTH, PASSWORD_ENV, SessionStore,
  SESSION_TTL_MS, checkCsrf, clearCookieHeader, cookieHeader, generatePassword,
  hashPassword, readCookie, verifyPassword,
} from '../src/admin/auth.js'

async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const before = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(vars)) {
    before.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    await run()
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function tempHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'admin-auth-'))
}

test('scrypt：哈希往返；错误口令与格式不对的哈希都拒绝（fail-closed）', () => {
  const stored = hashPassword('correct horse battery')
  assert.ok(stored.startsWith('scrypt$'))
  assert.equal(verifyPassword('correct horse battery', stored), true)
  assert.equal(verifyPassword('wrong', stored), false)
  assert.equal(verifyPassword('anything', 'garbage'), false)
  assert.equal(verifyPassword('anything', 'scrypt$1$2$3$x$y'), false)
})

test('生成口令：长度足够、无易混字符、每次都不同', () => {
  const pw = generatePassword()
  assert.ok(pw.length >= MIN_PASSWORD_LENGTH)
  assert.ok(!/[0O1lI]/.test(pw), `生成口令混进了易混字符：${pw}`)
  assert.notEqual(generatePassword(), generatePassword())
})

test('来源链：env 哈希优先于明文 env；坏哈希 fail-closed 不降级', async () => {
  await withEnv({ [HASH_ENV]: hashPassword('hash-password-123'), [PASSWORD_ENV]: 'plain-password-456' }, async () => {
    const home = tempHome()
    try {
      const auth = new AuthManager({ dshHome: home, configPassword: () => '', log: () => {} })
      await auth.load()
      assert.equal(auth.info.kind, 'env-hash')
      assert.equal(auth.info.canChange, false)
      assert.equal(auth.verify('hash-password-123'), true)
      assert.equal(auth.verify('plain-password-456'), false, '有哈希时明文 env 不该再有效')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  await withEnv({ [HASH_ENV]: 'not-a-hash', [PASSWORD_ENV]: 'plain-password-456' }, async () => {
    const home = tempHome()
    try {
      const logs: string[] = []
      const auth = new AuthManager({ dshHome: home, configPassword: () => '', log: (l) => logs.push(l) })
      await auth.load()
      assert.equal(auth.configured, false)
      assert.equal(auth.verify('plain-password-456'), false, '坏哈希不能降级到明文 env')
      assert.ok(logs.some((l) => l.includes('登录一律拒绝')))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

test('全空：生成一次性口令（只打印一次）；改密写入面板文件并被下一次启动优先采用', async () => {
  await withEnv({ [HASH_ENV]: undefined, [PASSWORD_ENV]: undefined }, async () => {
    const home = tempHome()
    try {
      const logs: string[] = []
      const auth = new AuthManager({ dshHome: home, configPassword: () => '', log: (l) => logs.push(l) })
      await auth.load()
      assert.equal(auth.info.kind, 'generated')
      assert.equal(auth.info.canChange, true)
      const line = logs.find((l) => l.includes('已生成一次性口令'))
      assert.ok(line !== undefined, '必须打印生成口令的那一行')
      const generated = line.split('：').pop()?.trim() ?? ''
      assert.ok(generated.length >= MIN_PASSWORD_LENGTH)
      assert.equal(auth.verify(generated), true)

      const tooShort = await auth.change('short')
      assert.equal(tooShort.ok, false)
      const changed = await auth.change('a-much-longer-password')
      assert.equal(changed.ok, true)
      assert.equal(auth.info.kind, 'panel')
      assert.equal(auth.verify('a-much-longer-password'), true)
      assert.equal(auth.verify(generated), false, '改密后旧口令立即失效')

      const again = new AuthManager({ dshHome: home, configPassword: () => '', log: () => {} })
      await again.load()
      assert.equal(again.info.kind, 'panel', '重启后面板口令文件优先于生成')
      assert.equal(again.verify('a-much-longer-password'), true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

test('会话：12 小时滑动续期、过期失效、revoke / revokeAll', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const store = new SessionStore()
  const token = store.create()
  assert.equal(store.touch(token), 'valid')
  t.mock.timers.tick(6 * 60 * 1000)
  assert.equal(store.touch(token), 'renewed')
  t.mock.timers.tick(1 * 60 * 1000)
  assert.equal(store.touch(token), 'valid', '距上次续期不足阈值时不应重复续期')
  t.mock.timers.tick(SESSION_TTL_MS + 1000)
  assert.equal(store.touch(token), 'invalid')
  const a = store.create()
  const b = store.create()
  assert.equal(store.size, 2)
  store.revoke(a)
  assert.equal(store.touch(a), 'invalid')
  assert.equal(store.touch(b), 'valid')
  store.revokeAll()
  assert.equal(store.touch(b), 'invalid')
})

test('登录限速：连续失败 10 次后封锁 5 分钟，按 IP 隔离', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 })
  const guard = new LoginGuard()
  for (let i = 0; i < 10; i += 1) guard.record('1.2.3.4')
  assert.equal(guard.blocked('1.2.3.4'), true)
  assert.equal(guard.blocked('5.6.7.8'), false)
  t.mock.timers.tick(5 * 60 * 1000 + 1)
  assert.equal(guard.blocked('1.2.3.4'), false)
})

test('CSRF：非 GET 必带自定义头；Origin 存在时必须与 Host 同源', () => {
  assert.equal(checkCsrf('GET', {}), null)
  assert.match(String(checkCsrf('POST', {})), /X-Requested-With/)
  assert.equal(checkCsrf('POST', { 'x-requested-with': 'dsh-admin' }), null)
  assert.equal(checkCsrf('POST', {
    'x-requested-with': 'dsh-admin', host: '127.0.0.1:8791', origin: 'http://127.0.0.1:8791',
  }), null)
  assert.match(String(checkCsrf('POST', {
    'x-requested-with': 'dsh-admin', host: '127.0.0.1:8791', origin: 'http://evil.example',
  })), /跨站/)
})

test('Cookie：HttpOnly / SameSite=Strict / Max-Age=43200；readCookie 解析多段', () => {
  const header = cookieHeader('tok123')
  assert.match(header, /^dsh_admin=tok123/)
  assert.match(header, /HttpOnly/)
  assert.match(header, /SameSite=Strict/)
  assert.match(header, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}\\b`))
  assert.match(clearCookieHeader(), /Max-Age=0/)
  assert.equal(readCookie('a=1; dsh_admin=tok123; b=2', 'dsh_admin'), 'tok123')
  assert.equal(readCookie(undefined, 'dsh_admin'), null)
  assert.equal(readCookie('x=y', 'dsh_admin'), null)
})
