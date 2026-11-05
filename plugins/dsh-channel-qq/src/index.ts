/** dsh-channel-qq 入口：只导出 cordis 根服务（装配在 `plugin.ts`）。
 *
 * `package.json` 的 `main` 指到这里；具名导出与默认导出都和旧版一致，
 * 装载器（bundle patch / deploy 的 LOAD 探针）不用改。
 */

export { ChannelQQ } from './plugin.js'
export { ChannelQQ as default } from './plugin.js'
