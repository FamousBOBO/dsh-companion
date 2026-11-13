/** 宿主凭据接缝（`ctx.credentials`）。
 *
 * 为什么要有这一层：DeepSeek 平台 Key 存在 DSH 凭据库里（`<dshHome>/.credentials.yaml`
 * 的 `refs` 段），不在插件配置里、也不在进程环境里。插件直接把值读出来写进配置，
 * 就等于把它复制到了会入库、会进后台快照、会出现在日志里的地方。
 *
 * 所以这里只暴露"**按引用名现取一次**"，且**每次转写都重新取**：凭据改了，
 * 下一次转写就生效，不需要重挂插件（与宿主 `CredentialProvider` 的约定一致：
 * 消费方不得跨操作缓存）。
 *
 * 形状只声明我们用到的两个成员，不 import `@deepseek-ai/dsh-credentials`：
 * 那个包是宿主的 peer，QQ 插件不该为一行类型声明多一条依赖。
 */

/** 宿主凭据服务里我们真正调用到的那一面。 */
export interface CredentialsSeam {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
}

/**
 * 从任意宿主对象上取凭据服务。
 *
 * `ctx.get` 是可选查询：宿主没装这个服务时返回 `undefined` 而不是抛
 * "cannot get property without inject"（2026-10-18 上线时踩过这条）。
 * @param host - cordis ctx，或任何带 `get` 的宿主对象。
 * @returns 可用的凭据接缝，或 `null`。
 */
export function credentialsOf(host: unknown): CredentialsSeam | null {
  const getter = (host as { get?: (name: string) => unknown } | null)?.get
  if (typeof getter !== 'function') return null
  let service: unknown
  try {
    service = getter.call(host, 'credentials')
  } catch {
    return null
  }
  if (service === null || typeof service !== 'object') return null
  const resolve = (service as { resolve?: unknown }).resolve
  return typeof resolve === 'function' ? (service as CredentialsSeam) : null
}

/**
 * 建一个"按引用名现取密钥"的回调，供 STT 适配器使用。
 *
 * 取不到（服务缺失、引用未配置、值不是字符串）一律当作"没配置"返回 `null`：
 * STT 是可选能力，凭据读不到应当退化成"不转写"，不该让一条语音把回合打挂。
 *
 * @param host - cordis ctx。
 * @param ref - 引用名，例如 `DEEPSEEK_API_KEY`。
 * @returns 每次调用都会重新解析的回调。
 */
export function credentialResolver(host: unknown, ref: string): () => Promise<string | null> {
  return async () => {
    const seam = credentialsOf(host)
    if (seam === null) return null
    try {
      const found = await seam.resolve(ref)
      const value = typeof found?.value === 'string' ? found.value.trim() : ''
      return value === '' ? null : value
    } catch {
      return null
    }
  }
}
