/** 密钥目录：三级回退、一次性搬迁、权限。
 *
 * 为什么值得测：这条路径一旦错，症状是"登录过的账号突然没了"（cookie 读不到）或
 * "密钥被当成状态文件备份出去"（权限没落到 600）。两种都不是一眼能看出来的
 * 崩溃，而是安静地坏掉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { readSecret, writeSecret, removeSecret, secretPath, secretsDir, resetSecretsDirForTest } =
  await import('../src/adapters/fs-store/secrets.js')

/** 每一次都换一对临时目录：home（旧位置）与 secrets（新位置）。 */
function scratch(): { home: string; secrets: string; cleanup: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), 'secret-home-'))
  const secrets = mkdtempSync(path.join(tmpdir(), 'secret-new-'))
  const previousHome = process.env.DSH_HOME
  const previousDir = process.env.CHANNEL_QQ_SECRETS_DIR
  process.env.DSH_HOME = home
  process.env.CHANNEL_QQ_SECRETS_DIR = secrets
  resetSecretsDirForTest()
  return {
    home,
    secrets,
    cleanup: () => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (previousDir === undefined) delete process.env.CHANNEL_QQ_SECRETS_DIR
      else process.env.CHANNEL_QQ_SECRETS_DIR = previousDir
      resetSecretsDirForTest()
      rmSync(home, { recursive: true, force: true })
      rmSync(secrets, { recursive: true, force: true })
    },
  }
}

test('secrets：环境变量指定的目录优先，写进去的值去掉首尾空白', async () => {
  const s = scratch()
  try {
    assert.equal(secretsDir(), s.secrets, 'CHANNEL_QQ_SECRETS_DIR 应当胜出')
    assert.equal(secretPath('netease-cookie').startsWith(s.secrets), true)
    await writeSecret('netease-cookie', '  MUSIC_U=abc; __csrf=1  \n')
    assert.equal(await readSecret('netease-cookie'), 'MUSIC_U=abc; __csrf=1')
  } finally { s.cleanup() }
})

test('secrets：文件权限是 600（Windows 上跳过）', async () => {
  const s = scratch()
  try {
    await writeSecret('kugou-cookie', 'token=xyz')
    if (process.platform === 'win32') return
    const mode = statSync(secretPath('kugou-cookie')).mode & 0o777
    assert.equal(mode, 0o600, `期望 600，实际 ${mode.toString(8)}`)
  } finally { s.cleanup() }
})

test('secrets：新位置为空时从旧位置搬一次（登录状态不因换目录而丢）', async () => {
  const s = scratch()
  try {
    const legacy = path.join(s.home, 'channel-qq')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(path.join(legacy, 'netease-cookie'), 'MUSIC_U=legacy-token', 'utf8')

    assert.equal(await readSecret('netease-cookie'), 'MUSIC_U=legacy-token')
    // 读完顺手写了一份到新位置
    assert.equal(existsSync(secretPath('netease-cookie')), true)
    assert.equal(readFileSync(secretPath('netease-cookie'), 'utf8'), 'MUSIC_U=legacy-token')
    // 旧文件留着：搬迁期内它是唯一的那份记录
    assert.equal(existsSync(path.join(legacy, 'netease-cookie')), true)
  } finally { s.cleanup() }
})

test('secrets：新位置有值时不再看旧位置（新值优先）', async () => {
  const s = scratch()
  try {
    const legacy = path.join(s.home, 'channel-qq')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(path.join(legacy, 'kugou-cookie'), 'token=old', 'utf8')
    await writeSecret('kugou-cookie', 'token=new')
    assert.equal(await readSecret('kugou-cookie'), 'token=new')
  } finally { s.cleanup() }
})

test('secrets：两份都不存在时返回空串（而不是抛错）', async () => {
  const s = scratch()
  try {
    assert.equal(await readSecret('never-written'), '')
  } finally { s.cleanup() }
})

test('secrets：removeSecret 把两份都删掉，否则下次读会把旧值搬回来', async () => {
  const s = scratch()
  try {
    const legacy = path.join(s.home, 'channel-qq')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(path.join(legacy, 'netease-cookie'), 'MUSIC_U=old', 'utf8')
    await writeSecret('netease-cookie', 'MUSIC_U=new')

    await removeSecret('netease-cookie')
    assert.equal(existsSync(secretPath('netease-cookie')), false)
    assert.equal(existsSync(path.join(legacy, 'netease-cookie')), false)
    assert.equal(await readSecret('netease-cookie'), '', '删过之后不许复活')
  } finally { s.cleanup() }
})
