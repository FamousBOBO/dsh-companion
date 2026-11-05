/** `ssrf-guard` 的规则表：私网拦截、协议限制、体积上限。
 *
 * 这些是 P0 安全止血的核心断言，所以逐条钉住——尤其是「IPv4-mapped IPv6」
 * 与「重定向逐跳检查」这两处，它们是绕过拦截最常见的两条路。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertUrlAllowed,
  blockedAddressReason,
  blockedHostReason,
  parseIpv4,
  parseIpv6,
  readCapped,
  type AddressInfo,
} from '../src/adapters/http/ssrf-guard.js'

/** 固定解析器：把任意主机名解析成给定地址，测试不碰真 DNS。 */
const resolver = (addresses: readonly string[]) =>
  async (_host: string): Promise<readonly AddressInfo[]> =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

test('IPv4 解析', () => {
  assert.equal(parseIpv4('0.0.0.0'), 0)
  assert.equal(parseIpv4('127.0.0.1'), 0x7f000001)
  assert.equal(parseIpv4('255.255.255.255'), 0xffffffff)
  assert.equal(parseIpv4('1.2.3'), null)
  assert.equal(parseIpv4('1.2.3.256'), null)
  assert.equal(parseIpv4('a.b.c.d'), null)
})

test('IPv6 解析（含 :: 压缩与内嵌 IPv4）', () => {
  assert.equal(parseIpv6('::1')?.length, 16)
  assert.deepEqual([...parseIpv6('::1')!].slice(15), [1])
  assert.deepEqual([...parseIpv6('::ffff:127.0.0.1')!].slice(12), [127, 0, 0, 1])
  assert.deepEqual([...parseIpv6('fe80::1%eth0')!].slice(0, 2), [0xfe, 0x80])
  assert.equal(parseIpv6('1:2:3:4:5:6:7'), null, '组数不足且没有 ::')
  assert.equal(parseIpv6('hello'), null)
})

test('内网 / 保留地址一律拦下', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1',
  ]
  for (const address of blocked) {
    assert.notEqual(blockedAddressReason(address), null, `${address} 应该被拦`)
  }
})

test('公网地址放行', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '223.5.5.5', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(blockedAddressReason(address), null, `${address} 不该被拦`)
  }
})

test('主机名规则：本机别名 / 无点主机名 / 后缀', async () => {
  assert.notEqual(await blockedHostReason('localhost'), null)
  assert.notEqual(await blockedHostReason('napcat'), null, '没有点的名字一律拒绝')
  assert.notEqual(await blockedHostReason('foo.local'), null)
  assert.notEqual(await blockedHostReason('metadata.google.internal'), null)
  assert.equal(await blockedHostReason('example.com', resolver(['93.184.216.34'])), null)
})

test('DNS 解析到内网地址，即使域名是公网域名也拦下', async () => {
  const reason = await blockedHostReason('evil.example.com', resolver(['127.0.0.1']))
  assert.notEqual(reason, null)
  const mixed = await blockedHostReason('mixed.example.com', resolver(['93.184.216.34', '10.0.0.5']))
  assert.notEqual(mixed, null, '只要有一个地址是内网就拒绝')
  assert.notEqual(await blockedHostReason('dead.example.com', async () => { throw new Error('NXDOMAIN') }), null)
  assert.notEqual(await blockedHostReason('empty.example.com', resolver([])), null)
})

test('URL 闸门：协议与地址', async () => {
  await assert.rejects(() => assertUrlAllowed('file:///etc/passwd'), /http\/https/)
  await assert.rejects(() => assertUrlAllowed('gopher://x/1'), /http\/https/)
  await assert.rejects(() => assertUrlAllowed('http://127.0.0.1:8790/'), /内网|本机/)
  await assert.rejects(() => assertUrlAllowed('http://169.254.169.254/latest/meta-data/'), /内网/)
  await assert.rejects(() => assertUrlAllowed('not a url'), /不像一个链接/)
  const ok = await assertUrlAllowed('https://example.com/a', resolver(['93.184.216.34']))
  assert.equal(ok.hostname, 'example.com')
})

test('readCapped：按上限截断，不整份读进内存', async () => {
  const big = new Response('x'.repeat(5000), { headers: { 'content-type': 'text/plain' } })
  const { bytes, truncated } = await readCapped(big, 1024)
  assert.equal(bytes.length, 1024)
  assert.equal(truncated, true)

  const small = new Response('hello')
  const exact = await readCapped(small, 1024)
  assert.equal(exact.bytes.toString('utf8'), 'hello')
  assert.equal(exact.truncated, false)

  const declared = new Response('x', { headers: { 'content-length': '99999999' } })
  await assert.rejects(() => readCapped(declared, 1024), /超过上限/)
})

test('readCapped：正好等于上限时不算截断', async () => {
  const body = new Response('x'.repeat(512))
  const { bytes, truncated } = await readCapped(body, 512)
  assert.equal(bytes.length, 512)
  assert.equal(truncated, false)
})
