/** 凭据接缝的**类型**（实现见 `adapters/dsh-host/credentials.ts`）。
 *
 * 为什么单独一个文件而不是塞进 `plugin-kit.ts`：后者是子插件的装载契约，已经贴着
 * 400 行硬上限；凭据是一个独立的能力面，与"怎么装载子插件"无关。
 *
 * 为什么是**函数**而不是字符串：Key 存在 DSH 凭据库里，改了要下一次操作就生效，
 * 不能等插件重挂；而且它的值不该被复制进任何配置快照、后台响应或日志。
 */

/** 按引用名现取凭据；宿主没装 credentials 服务时返回 `null`。 */
export interface CredentialLookup {
  /**
   * 按引用名取一次密钥。
   * @param ref - 引用名，例如 `DEEPSEEK_API_KEY`。
   * @returns 非空值，或 `null`（未配置 / 服务缺失 / 值为空）。
   */
  credential?(ref: string): Promise<string | null>
}
