/** 私聊文件：2 个工具。
 *
 * 私聊收发文件（收进工作区，交给 agent 用文件工具处理）。
 *
 * 这些 spec **逐字节**来自原来的 `registerQQTools`——P4 的判据是工具名与
 * 参数 schema 一条都不许变（`test/golden/tools/qq-tools.txt` 钉着这一点）。
 * 一个工具一个函数：单看一个工具时不必在 1200 行里找它的边界。
 */

import { systemHttp } from '../../adapters/http/client.js'
import { napcatFileArg, localPathOf } from '../../local-file.js'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import { MAX_DOWNLOAD_BYTES } from '../download-limit.js'
import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQToolDeps } from '../tool-deps.js'

/** `qq_send_private_file` — 私聊给好友发本地文件（从咱的工作区里挑）。file 是本地绝对路径；不填 name 就用原文件名。… */
function qqSendPrivateFile(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_send_private_file',
        description: '私聊给好友发本地文件（从咱的工作区里挑）。file 是本地绝对路径；不填 name 就用原文件名。',
        parameters: {
          type: 'object',
          properties: {
            userId: { type: 'number', description: '好友QQ号' },
            file: { type: 'string', description: '本地文件绝对路径' },
            name: { type: 'string', description: '显示的文件名' },
          },
          required: ['userId', 'file'],
        },
        run: async (args) => {
          // `localPathOf` first so a `file:///…` argument from the model resolves
          // instead of making fs.access fail with a bogus ENOENT on the URL.
          const local = localPathOf(String(args.file))
          const fsMod = await import('node:fs/promises')
          await fsMod.access(local)
          return api.uploadPrivateFile(Number(args.userId), await napcatFileArg(local), String(args.name ?? local.replace(/^.*[\\/]/, '')))
        },
      }
}

/** `qq_save_private_file` — 把私聊收到的文件存到咱的工作区 downloads/ 下（fileId 来自文件消息），返回本地路径。… */
function qqSavePrivateFile(deps: QQToolDeps): ToolSpec {
  const { api, config } = deps
  return {
        name: 'qq_save_private_file',
        description: '把私聊收到的文件存到咱的工作区 downloads/ 下（fileId 来自文件消息），返回本地路径。',
        parameters: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: '私聊文件ID' },
            saveAs: { type: 'string', description: '保存的文件名，存到工作区 downloads/ 下' },
          },
          required: ['fileId'],
        },
        run: async (args) => {
          const urlData = await api.getPrivateFileUrl(String(args.fileId)) as { url?: string }
          if (typeof urlData?.url !== 'string' || urlData.url === '') throw new Error('拿不到私聊文件下载链接')
          // 同上：NapCat 的私聊文件链接可能指向本机。
          const res = await systemHttp.request(urlData.url, { limit: MAX_DOWNLOAD_BYTES, allowPrivateHosts: true })
          if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
          const bytes = Buffer.from(res.bytes)
          const fsMod = await import('node:fs/promises')
          const pathMod = await import('node:path')
          const wsRoot = config.workspacePath ?? process.cwd()
          const dir = pathMod.join(wsRoot, 'downloads')
          await fsMod.mkdir(dir, { recursive: true })
          const safeName = String(args.saveAs ?? `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`).replace(/[\\/:*?"<>|]/g, '_')
          const target = pathMod.join(dir, safeName)
          await atomicWriteFile(target, bytes)
          return { saved: target, size: bytes.length }
        },
      }
}

/** 组装这一组工具。 */
export function filesTools(deps: QQToolDeps): ToolSpec[] {
  return [
    qqSendPrivateFile(deps),
    qqSavePrivateFile(deps),
  ]
}
