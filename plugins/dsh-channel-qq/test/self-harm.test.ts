/** 自断命令的识别：会重启/停止自己的命令必须改走审批。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { selfHarmReason, selfHarmHint } = await import('../src/core/approval/self-harm.js')

test('会把自己弄断的命令：命中并给出原因', () => {
  const cases = [
    'systemctl restart dsh',
    'sudo systemctl stop dsh',
    'systemctl restart docker',
    'systemctl daemon-reload',
    'node deploy/release.mjs install /root/x.tar.gz',
    'node deploy/release.mjs rollback',
    'pkill -f dsh',
    'killall node',
    'shutdown -h now',
    'reboot',
    'docker restart napcat',
    'docker compose down',
  ]
  for (const command of cases) {
    assert.ok(selfHarmReason(command) !== null, `${command} 应该被判为自断命令`)
  }
})

test('普通命令不误拦（它们交给 L2 审批，不是这里一刀切）', () => {
  const cases = [
    'ls -la',
    'npm run verify',
    'git status',
    'rm -rf /tmp/build',
    'systemctl status dsh',
    'docker ps',
    'cat /etc/dsh/env',
  ]
  for (const command of cases) {
    assert.equal(selfHarmReason(command), null, `${command} 不该被拦`)
  }
})

test('提示词把"别做"换成"怎么做"：给出申请指令与预期断开', () => {
  const hint = selfHarmHint('systemctl restart dsh', '会杀掉自己')
  assert.match(hint, /申请 systemctl restart dsh/)
  assert.match(hint, /批准/)
  assert.match(hint, /断开/)
})
