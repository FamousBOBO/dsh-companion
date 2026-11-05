/** 审批网关的核心测试：归一化、分级、令牌三元组。
 *
 * 这些用例的价值在于**把"什么样的命令算危险"钉成可 diff 的清单**——以后要放宽
 * 某条规则，必须同时改测试并在提交信息里说明理由。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const {
  normalizeCommand, classify, createRequest, approveRequest, consumeRequest, denyRequest,
} = await import('../src/core/approval/gateway.js')

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

test('归一化：引号拼接、${IFS}、续行、sudo 前缀都还原成真正会执行的命令', () => {
  assert.equal(normalizeCommand("rm -r''f /"), 'rm -rf /')
  assert.equal(normalizeCommand('rm${IFS}-rf${IFS}/'), 'rm -rf /')
  assert.equal(normalizeCommand('rm -r\\\nf /'), 'rm -rf /')
  assert.equal(normalizeCommand('sudo rm -rf /'), 'rm -rf /')
  assert.equal(normalizeCommand('FOO=1 BAR=2 rm -rf /'), 'rm -rf /')
  assert.equal(normalizeCommand('  echo   "a b"  '), 'echo a b')
})

test('L3：不可恢复的动作，永不执行（连申请都建不出来）', () => {
  const cases = [
    'rm -rf /',
    "rm -r''f /",
    'rm -rf /etc',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    'shutdown -h now',
    'systemctl stop sshd',
    'docker system prune -a',
    'docker volume prune',
    'iptables -F',
    'userdel -r someone',
    'chmod 777 /',
    ':(){ :|:& };:',
  ]
  for (const command of cases) {
    const verdict = classify(command)
    assert.equal(verdict.level, 'L3', `${command} 应为 L3（实际 ${verdict.level}: ${verdict.reason}）`)
  }
  assert.throws(() => createRequest('rm -rf /', { id: 'a', now: 1, digest }), /L3 永不执行/)
})

test('L2：需要一次性令牌（重启、装包、发布、删除、改系统文件）', () => {
  const cases = [
    'systemctl restart dsh',
    'docker restart napcat',
    'apt-get install -y nginx',
    'npm install -g pnpm',
    'git push origin main',
    'node deploy/release.mjs install /root/x.tar.gz',
    'rm -rf /tmp/build',
    'cp x.conf /etc/dsh/env',
    'crontab -e',
    'sysctl -w net.ipv4.tcp_mtu_probing=1',
  ]
  for (const command of cases) {
    assert.equal(classify(command).level, 'L2', `${command} 应为 L2`)
  }
})

test('L1：工作区内的副作用动作（提交、打包、跑脚本）', () => {
  for (const command of ['git commit -m "x"', 'tar czf a.tgz src', 'cp a b', 'npm run verify', 'node scripts/build-admin-html.mjs']) {
    assert.equal(classify(command).level, 'L1', `${command} 应为 L1`)
  }
})

test('L0：只读动作直接放行', () => {
  for (const command of ['ls -la', 'cat /etc/dsh/env', 'grep -r foo src', 'docker ps', 'systemctl status dsh', 'curl https://example.com']) {
    assert.equal(classify(command).level, 'L0', `${command} 应为 L0`)
  }
})

test('令牌：批准后核验通过、一次性、过期失效、改命令即作废', () => {
  const req = createRequest('systemctl restart dsh', { id: 'appr-1', now: 1000, digest })
  assert.equal(req.level, 'L2')
  assert.equal(req.status, 'pending')

  const approved = approveRequest(req, 'tok-1', 1000)
  assert.equal(approved.status, 'approved')

  const good = consumeRequest(approved, 'tok-1', 'systemctl restart dsh', 1001, digest)
  assert.equal(good.ok, true)
  if (good.ok) assert.equal(good.request.status, 'consumed')

  // 已消费：再核验一次必须失败（一次性）。状态是**返回值**里的新对象——
  // 调用方必须把它落盘，旧对象不会自动变（纯函数的约定）。
  const consumed = good.ok ? good.request : approved
  const again = consumeRequest(consumed, 'tok-1', 'systemctl restart dsh', 1002, digest)
  assert.deepEqual(again, { ok: false, reason: 'consumed' })

  // 令牌错 / 命令被改 / 过期。
  const bad = consumeRequest(approved, 'tok-2', 'systemctl restart dsh', 1001, digest)
  assert.deepEqual(bad, { ok: false, reason: 'bad-token' })
  const changed = consumeRequest(approved, 'tok-1', 'systemctl restart napcat', 1001, digest)
  assert.equal(changed.ok, false)
  if (!changed.ok) assert.equal(changed.reason, 'hash-mismatch')
  const expired = consumeRequest(approved, 'tok-1', 'systemctl restart dsh', 1000 + 11 * 60_000, digest)
  assert.equal(expired.ok, false)
  if (!expired.ok) assert.equal(expired.reason, 'token-expired')
})

test('令牌：未批准的请求不能执行；拒绝后也不能再批准', () => {
  const req = createRequest('rm -rf /tmp/x', { id: 'appr-2', now: 1000, digest })
  assert.deepEqual(consumeRequest(req, 'tok', 'rm -rf /tmp/x', 1001, digest), { ok: false, reason: 'not-approved' })
  const denied = denyRequest(req)
  assert.equal(denied.status, 'denied')
  assert.throws(() => approveRequest(denied, 'tok', 1001), /不能再批准/)
})

test('命令归一化后相同即同一条：空白差异不影响授权', () => {
  const req = createRequest('systemctl   restart   dsh', { id: 'appr-3', now: 1000, digest })
  const approved = approveRequest(req, 'tok', 1000)
  const result = consumeRequest(approved, 'tok', 'systemctl restart dsh', 1001, digest)
  assert.equal(result.ok, true)
})

test('分级：等价变形不能绕过 L3（长选项、命令前转义）', () => {
  // 2026-10-19 排查：这两种写法当时被判成 L0（直接执行），而 `rm -r -f /` 是 L3。
  assert.equal(classify('rm --recursive --force /').level, 'L3')
  assert.equal(classify(String.fromCharCode(92) + 'rm -rf /').level, 'L3')
  // 普通命令不受影响
  assert.equal(classify('ls -la').level, 'L0')
})

test('审计：批准/拒绝会记下是谁做的', () => {
  const req = createRequest('systemctl restart dsh', { id: 'appr-audit', now: 1000, digest })
  const approved = approveRequest(req, 'tok', 1000, undefined, 'dm-42')
  assert.equal(approved.approvedBy, 'dm-42')
  const denied = denyRequest(createRequest('systemctl restart dsh', { id: 'appr-audit2', now: 1000, digest }), 'dm-43')
  assert.equal(denied.deniedBy, 'dm-43')
})

test('审计：申请人写进请求', () => {
  const req = createRequest('ls', { id: 'appr-req', now: 1000, digest, requestedBy: 'dm-7' })
  assert.equal(req.requestedBy, 'dm-7')
})
