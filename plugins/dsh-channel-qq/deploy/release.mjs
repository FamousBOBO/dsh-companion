/**
 * 原子发布 / 回滚 —— 在**服务器上**跑。
 *
 * 为什么要换掉"解包覆盖 + 重启"：现有部署是整树替换，坏掉的窗口是"从 rm -rf 到
 * 解包完"，中途任何一步失败（磁盘满、tar 截断、ssh 断线）都会留下一个**半新的**
 * 插件目录，而机器人就起不来了——回滚只能靠人手上有备份。这条链路上有 1KB 级
 * MTU 黑洞，传输中断不是假设。
 *
 * 现在改成：新版本解到**新目录**，验签通过才切换，切换本身是一次 `rename`（原子）。
 * 旧版本原地不动，回滚就是把软链接换回去 + 重启。
 *
 * 目录布局（**深度必须一致**，见下）：
 *
 *   /srv/dsh/dsh-channel-qq                     → 软链接，dsh 加载的就是这个路径
 *   /srv/dsh/dsh-channel-qq-rel-<版本>/          真实发布目录（同深度！）
 *   /srv/dsh/dsh-channel-qq-rel-<版本>/.release.json  来源、时间、文件数
 *   /srv/dsh/releases.json                      发布索引（活跃版本 + 历史）
 *
 * ⚠️ **为什么发布目录必须与主目录同深度**：`node_modules/@deepseek-ai/cordis` 是指向
 * `../../../dsh/vendor/cordis` 的**相对**软链接（宿主 monorepo 的 vendor 目录）。
 * 换成 `/srv/dsh/releases/<版本>/` 会多一层，那三条相对链接就全指到
 * `/srv/dsh/releases/dsh/vendor/cordis`——构建能过、启动必炸。同深度的
 * `/srv/dsh/dsh-channel-qq-rel-<版本>` 才是安全的。
 *
 * 用法（服务器本机）：
 *   node deploy/release.mjs install /root/release.tar.gz    # 验签 + 发布 + 重启
 *   node deploy/release.mjs install /root/x.tar.gz --no-restart
 *   node deploy/release.mjs list                            # 有哪些版本
 *   node deploy/release.mjs rollback                        # 回上一版 + 重启
 *   node deploy/release.mjs rollback --to <版本>
 *   node deploy/release.mjs diff <版本A> <版本B>             # 两个版本差了什么
 *   node deploy/release.mjs prune                           # 只保留最近 5 版
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, renameSync, lstatSync } from 'node:fs'
import * as path from 'node:path'

const ENTRY = '/srv/dsh/dsh-channel-qq'
const PREFIX = 'dsh-channel-qq-rel-'
const INDEX = '/srv/dsh/releases.json'
const KEEP = 5

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'list'
const positional = argv.slice(1).filter(a => !a.startsWith('--'))
const noRestart = argv.includes('--no-restart')
const toFlag = argv.indexOf('--to')

function sh(cmdline, opts = {}) {
  const out = execFileSync('bash', ['-lc', cmdline], { encoding: 'utf8', ...opts })
  // `stdio: 'inherit'` 时 execFileSync **返回 null**（输出直接进了终端，没有被捕获），
  // 直接 `.trim()` 会炸成 "Cannot read properties of null"——真踩过一次。
  return typeof out === 'string' ? out.trim() : ''
}

function readIndex() {
  try {
    return JSON.parse(readFileSync(INDEX, 'utf8'))
  } catch {
    return { active: null, history: [] }
  }
}

function writeIndex(index) {
  writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n', 'utf8')
}

/** 所有已发布的版本目录名（按名字排序即按时间排序）。 */
function versions() {
  return readdirSync('/srv/dsh')
    .filter(n => n.startsWith(PREFIX))
    .map(n => n.slice(PREFIX.length))
    .sort()
}

/** 当前软链接指向哪个版本（主目录还不是软链接时返回 null）。 */
function activeVersion() {
  try {
    if (!lstatSync(ENTRY).isSymbolicLink()) return null
    return path.basename(sh(`readlink -f ${ENTRY}`)).slice(PREFIX.length)
  } catch {
    return null
  }
}

/**
 * 切到某个版本：把软链接**原子**换掉。
 *
 * `ln -sfn` 对已存在的软链接是"先删后建"，不是原子；`mv -T` 覆盖是原子的
 * （同一个文件系统内 rename）。所以先建临时链接，再 rename 到位。
 */
function switchTo(version) {
  const target = path.join('/srv/dsh', `${PREFIX}${version}`)
  if (!existsSync(path.join(target, 'package.json'))) {
    throw new Error(`版本 ${version} 不完整：${target}/package.json 不存在`)
  }
  const tmp = `${ENTRY}.new`
  rmSync(tmp, { force: true, recursive: true })
  symlinkSync(target, tmp)
  // 首次切换时主目录还是个真目录：先把它挪开（保留内容），再 rename。
  if (existsSync(ENTRY) && lstatSync(ENTRY).isDirectory()) {
    const parked = `${ENTRY}.pre-symlink`
    rmSync(parked, { force: true, recursive: true })
    renameSync(ENTRY, parked)
    console.log(`  主目录是实体目录，已挪到 ${parked}（确认无误后可删）`)
  }
  renameSync(tmp, ENTRY)
  console.log(`  已切换：${ENTRY} → ${target}`)
}

function restart() {
  sh('systemctl restart dsh')
  const active = sh('systemctl is-active dsh')
  if (active !== 'active') throw new Error(`重启后 dsh 状态是 ${active}`)
  console.log('  dsh 已重启且 active')
}

/** 验签：解包之后先对着清单逐个 sha256，对不上就不切换。 */
function verify(dir) {
  const manifest = path.join(dir, 'MANIFEST.sha256')
  if (!existsSync(manifest)) throw new Error('产物里没有 MANIFEST.sha256，拒绝发布')
  const out = sh(`cd ${dir} && sha256sum -c MANIFEST.sha256 --quiet 2>&1 || true`)
  const bad = out.split('\n').filter(l => l.trim() !== '')
  if (bad.length > 0) {
    // 校验失败的**具体差异**要打出来：这是唯一能说明"传坏了哪一块"的材料。
    throw new Error(`清单校验失败（${bad.length} 条）：\n${bad.slice(0, 10).join('\n')}`)
  }
  const count = readFileSync(manifest, 'utf8').split('\n').filter(l => l.trim() !== '').length
  return count
}

function install(tarball) {
  if (!existsSync(tarball)) throw new Error(`找不到产物 ${tarball}`)
  const base = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  let version = base
  for (let i = 1; existsSync(path.join('/srv/dsh', `${PREFIX}${version}`)); i++) {
    version = `${base}-${i}`   // 同一秒里连发两次也别撞目录
  }
  const dir = path.join('/srv/dsh', `${PREFIX}${version}`)
  mkdirSync(dir, { recursive: true })
  console.log(`=== 解包到 ${dir} ===`)
  sh(`tar -xzf ${tarball} -C ${dir}`)

  console.log('=== 验签 ===')
  const count = verify(dir)
  console.log(`  ${count} 个文件 sha256 全部一致`)

  // node_modules 不随产物走（体积大且与宿主 monorepo 的相对链接绑定）。
  // 从当前活跃版本**硬链接复制**：省空间，且相对链接的结构一模一样。
  // 首次发布时主目录还是实体目录（没有 active 版本），那时就从它复制。
  const donor = activeVersion() !== null
    ? path.join('/srv/dsh', `${PREFIX}${activeVersion()}`)
    : (existsSync(path.join(ENTRY, 'node_modules')) ? ENTRY : null)
  if (donor !== null && existsSync(path.join(donor, 'node_modules'))) {
    console.log(`=== 复用 ${donor} 的 node_modules（硬链接）===`)
    sh(`cp -al ${donor}/node_modules ${dir}/node_modules`)
  } else if (!existsSync(path.join(dir, 'node_modules'))) {
    console.log('  ⚠️ 没有可复用的 node_modules，稍后需要手工确保依赖可用')
  }

  const meta = existsSync(path.join(dir, 'RELEASE.json'))
    ? JSON.parse(readFileSync(path.join(dir, 'RELEASE.json'), 'utf8'))
    : {}
  const source = sh(`sha256sum ${tarball} | cut -c1-64`)

  console.log('=== 冒烟：这一版至少能被解释器读进来 ===')
  // 兼容两种产物布局：新版本把产物收在 build/ 下，旧版本直接在根（lib/）。
  // 服务器上跑的可能是旧版脚本，第一次切换到新布局时靠这个判断。
  const libDir = existsSync(path.join(dir, 'build', 'lib')) ? 'build/lib' : 'lib'
  const testDir = existsSync(path.join(dir, 'build', 'lib-test', 'test'))
    ? 'build/lib-test/test'
    : 'lib-test/test'
  sh(`cd ${dir} && /opt/node22/bin/node -e "import('${dir}/${libDir}/index.js').then(()=>console.log('LOAD-OK'))"`)

  // 在**新目录里**跑一遍测试，跑不过就不切换。这一步才是"校验通过后切换"的实处：
  // 清单只能证明"文件传对了"，测试才能证明"这份代码在这个宿主上还能用"。
  // 失败时什么都不动——新版本留在磁盘上供排查，活跃版本还是旧的。
  if (existsSync(path.join(dir, testDir))) {
    console.log('=== 在新版本目录里跑测试（跑不过就不切换）===')
    // ⚠️ 退出码必须**显式取**。写成 `node --test … | tail -12` 时 `$?` 是 `tail` 的，
    // 管道会把失败整个吞掉——第一版就是这么写的，服务器上 5 个测试失败它照样切换了。
    // （那次失败本身是另一个 bug：打包清单漏了 `eval/`，评测器自己的用例找不到
    //  `eval/run.mjs`。两个 bug 叠在一起才让"闸门失效"暴露出来。）
    const log = '/tmp/release-selftest.log'
    // TZ=Asia/Shanghai：宿主（dsh.service 走 /etc/dsh/env）的运行时区就是它，"今天是
    // 哪天"的测试必须与生产同一口径。手动 shell 默认 TZ=UTC，会在北京过午夜后让
    // localDayKey 差一天——2026-10-17 深夜就是这样挂了两条记忆测试、发布被拦下。
    const out = sh(`cd ${dir} && TZ=Asia/Shanghai /opt/node22/bin/node --test '${testDir}/*.test.js' > ${log} 2>&1; echo "EXIT=$?"`)
    const exit = Number(/EXIT=(\d+)/.exec(out)?.[1] ?? '1')
    sh(`tail -14 ${log}`, { stdio: 'inherit' })
    if (exit !== 0) {
      throw new Error(`新版本的测试没通过（exit ${exit}），已放弃切换（活跃版本未变）。完整日志：${log}`)
    }
  } else {
    console.log('  ⚠️ 产物里没有测试目录，跳过测试闸门')
  }

  console.log('=== 切换 ===')
  const index = readIndex()
  const previous = activeVersion()
  switchTo(version)
  index.active = version
  index.history = [...(index.history ?? []), {
    version,
    commit: meta.commit ?? null,
    builtAt: meta.builtAt ?? null,
    sourceSha256: source,
    fileCount: count,
    installedAt: new Date().toISOString(),
  }].slice(-50)
  writeIndex(index)
  if (!noRestart) restart()
  console.log(`\n发布完成：${version}${previous === null ? '' : `（上一版 ${previous} 仍在磁盘上）`}`)
}

function rollback() {
  const index = readIndex()
  const all = versions()
  const current = activeVersion()
  const previous = toFlag !== -1 ? argv[toFlag + 1] : all.filter(v => v !== current).pop()
  if (previous === undefined || !all.includes(previous)) {
    throw new Error(`没有可回滚的版本（现有：${all.join(', ')}）`)
  }
  console.log(`=== 回滚 ${current} → ${previous} ===`)
  switchTo(previous)
  index.active = previous
  index.history = [...(index.history ?? []), { version: previous, rolledBack: true, at: new Date().toISOString() }]
  writeIndex(index)
  restart()
}

function list() {
  const index = readIndex()
  const current = activeVersion()
  console.log(`活跃：${current ?? '(主目录还是实体目录，没有软链接)'}`)
  for (const v of versions()) {
    const dir = path.join('/srv/dsh', `${PREFIX}${v}`)
    const meta = existsSync(path.join(dir, 'RELEASE.json'))
      ? JSON.parse(readFileSync(path.join(dir, 'RELEASE.json'), 'utf8'))
      : {}
    const mark = v === current ? '*' : ' '
    console.log(`${mark} ${v}  ${(meta.commit ?? '?').slice(0, 8)}  ${meta.builtAt ?? '?'}`)
  }
  if ((index.history ?? []).length > 0) {
    console.log('\n最近五次操作：')
    for (const h of index.history.slice(-5)) {
      console.log(`  ${h.installedAt ?? h.at}  ${h.version}${h.rolledBack === true ? '  (回滚)' : ''}`)
    }
  }
}

function prune() {
  const current = activeVersion()
  const all = versions()
  const drop = all.slice(0, Math.max(0, all.length - KEEP)).filter(v => v !== current)
  for (const v of drop) {
    console.log(`  删除 ${PREFIX}${v}`)
    rmSync(path.join('/srv/dsh', `${PREFIX}${v}`), { recursive: true, force: true })
  }
  console.log(`保留 ${KEEP} 版（含当前 ${current}）`)
}

/**
 * 两个版本之间的差异 —— **发布记录可追溯**（P7.1）靠的就是这个 + 每版带着的
 * `RELEASE.json`（本地 git commit）。服务器上不留 `.git`（产物里没有）。所以
 * "哪次发布改了什么"由两步回答：这里看**部署了什么**，本地按 commit 看**为什么改**。
 */
function diff(a, b) {
  const dirA = a === undefined ? null : path.join('/srv/dsh', `${PREFIX}${a}`)
  const dirB = b === undefined ? path.join('/srv/dsh', `${PREFIX}${activeVersion()}`) : path.join('/srv/dsh', `${PREFIX}${b}`)
  if (dirA === null || !existsSync(dirA)) throw new Error(`版本 ${a} 不存在`)
  if (!existsSync(dirB)) throw new Error(`版本 ${b} 不存在`)
  // `diff -rq` 直接比两个目录（不需要仓库），排除依赖与产物目录。
  const out = sh(`diff -rq -x node_modules -x lib -x lib-test ${dirA} ${dirB} 2>&1 || true`)
  if (out === '') { console.log('(没有差异)'); return }
  const lines = out.split('\n')
  console.log(lines.slice(0, 60).join('\n'))
  if (lines.length > 60) console.log(`…还有 ${lines.length - 60} 行（源目录：${dirA} / ${dirB}）`)
}

const COMMANDS = { install, rollback, prune, list, diff }
const action = COMMANDS[cmd]
if (action === undefined) {
  console.error(`未知子命令：${cmd}（可用：install / rollback / list / diff / prune）`)
  process.exit(2)
}
try {
  action(...positional)
} catch (error) {
  // 运维在最紧张的时候跑这条命令，所以错误只打一行有用的，不打栈。
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
