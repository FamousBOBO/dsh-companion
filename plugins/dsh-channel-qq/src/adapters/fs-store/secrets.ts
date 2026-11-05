/** 密钥文件：放 `/etc/dsh/secrets/`（600），不再混在 `dshHome` 的数据目录里。
 *
 * 为什么值得单开一个模块：`<dshHome>/channel-qq/` 下面既有**状态**（sent-log、
 * scheduler-state、backups）也有**密钥**（网易云 cookie、酷狗 dfid）。状态要备份、
 * 要能被后台读到、运维要能随手 `cat`；密钥不该。两类东西放同一个目录，权限只能
 * 取宽的那个——于是密钥继承了状态文件的 644。
 *
 * 目录按三级回退选：
 *   1. `CHANNEL_QQ_SECRETS_DIR` 环境变量（测试与开发机用）；
 *   2. 非 Windows 且 `/etc/dsh/secrets` 存在或能建 → 用它（线上就是这个）；
 *   3. 退回 `<dshHome>/channel-qq/`（Windows 开发机、写不了 /etc 的环境）。
 *
 * 换目录**不能让人重新登录**：`readSecret` 在新位置没有时回读旧位置，读到了就
 * 顺手写一份到新位置（600）。旧文件留着不删——搬迁期内它是唯一的那份记录。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { resolveDshHome } from '../../paths.js'

/** 线上位置。600，只有 root 能读。 */
const SYSTEM_DIR = '/etc/dsh/secrets'

/** 密钥进来之前的位置（`<dshHome>/channel-qq/`），只用于一次性搬迁。 */
function legacyDir(): string {
  return path.join(resolveDshHome(), 'channel-qq')
}

let cachedDir: string | null = null

/** 选一个能用的目录（结果缓存：每次读密钥都 stat 一遍没必要）。 */
export function secretsDir(): string {
  if (cachedDir !== null) return cachedDir
  const fromEnv = process.env.CHANNEL_QQ_SECRETS_DIR
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    cachedDir = path.resolve(fromEnv.trim())
    return cachedDir
  }
  // Windows 上没有 /etc；开发机上也不必迁。判平台而不是"试着写一下"，
  // 是因为后者在只读挂载上会留半截状态。
  cachedDir = process.platform === 'win32' ? legacyDir() : SYSTEM_DIR
  return cachedDir
}

/** 仅测试用：清掉目录缓存（换了环境变量之后要让它重新选）。 */
export function resetSecretsDirForTest(): void {
  cachedDir = null
}

export function secretPath(name: string): string {
  return path.join(secretsDir(), name)
}

async function readIfPresent(file: string): Promise<string> {
  try {
    return (await fs.readFile(file, 'utf8')).trim()
  } catch {
    return ''
  }
}

/**
 * 读一个密钥。
 *
 * 新位置优先；空则回读旧位置。旧位置读到东西时会**尽力**写一份到新位置——
 * 写失败不算错（只读挂载、权限不足都不该让"读密钥"这件事失败），下次再说。
 */
export async function readSecret(name: string): Promise<string> {
  const current = secretPath(name)
  const fresh = await readIfPresent(current)
  if (fresh !== '') return fresh
  const legacy = await readIfPresent(path.join(legacyDir(), name))
  if (legacy === '') return ''
  try {
    await writeSecret(name, legacy)
  } catch { /* 搬迁失败不影响本次读取 */ }
  return legacy
}

/** 写一个密钥（原子替换 + 600）。 */
export async function writeSecret(name: string, value: string): Promise<void> {
  const file = secretPath(name)
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, value.trim(), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tmp, file)
  // rename 保留 tmp 的 mode，但目录里可能有 umask 留下的旧文件；显式再来一次。
  await fs.chmod(file, 0o600).catch(() => { /* 某些文件系统不支持 chmod */ })
}

/** 删一个密钥（新位置删掉，旧位置也删——否则下一次读会把旧值搬回来）。 */
export async function removeSecret(name: string): Promise<void> {
  await fs.rm(secretPath(name), { force: true })
  await fs.rm(path.join(legacyDir(), name), { force: true })
}
