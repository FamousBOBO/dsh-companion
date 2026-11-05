/** 群文件：8 个工具。
 *
 * 群文件的列、传、下、改名、移动、删除。
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

/** `qq_list_group_files` — 列出群文件系统（文件、文件夹、大小、上传者），用于整理群文件。… */
function qqListGroupFiles(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_list_group_files',
        description: '列出群文件系统（文件、文件夹、大小、上传者），用于整理群文件。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            folderId: { type: 'string', description: '文件夹ID，不填=根目录' },
          },
          required: ['groupId'],
        },
        run: async (args) => args.folderId !== undefined
          ? api.getGroupFilesByFolder(Number(args.groupId), String(args.folderId))
          : api.getGroupRootFiles(Number(args.groupId)),
      }
}

/** `qq_upload_group_file` — 上传本地文件到群文件系统（可以从咱的工作区里挑文件发）。file 是本地绝对路径。… */
function qqUploadGroupFile(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_upload_group_file',
        description: '上传本地文件到群文件系统（可以从咱的工作区里挑文件发）。file 是本地绝对路径。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            file: { type: 'string', description: '本地文件绝对路径' },
            name: { type: 'string', description: '显示的文件名' },
            folderId: { type: 'string', description: '目标文件夹ID，不填=根目录' },
          },
          required: ['groupId', 'file'],
        },
        run: async (args) => {
          const local = localPathOf(String(args.file))
          return api.uploadGroupFile(Number(args.groupId), 
            await napcatFileArg(local), 
            String(args.name ?? local.replace(/^.*[\\/]/, '')), 
            args.folderId !== undefined ? String(args.folderId) : undefined, 
          )
        },
      }
}

/** `qq_download_group_file` — 下载群文件到咱的工作区（先拿链接再存盘），存好返回本地路径。… */
function qqDownloadGroupFile(deps: QQToolDeps): ToolSpec {
  const { api, config } = deps
  return {
        name: 'qq_download_group_file',
        description: '下载群文件到咱的工作区（先拿链接再存盘），存好返回本地路径。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            fileId: { type: 'string', description: '群文件ID（来自文件列表）' },
            saveAs: { type: 'string', description: '保存的文件名，存到工作区 downloads/ 下' },
          },
          required: ['groupId', 'fileId'],
        },
        run: async (args) => {
          const urlData = await api.getGroupFileUrl(Number(args.groupId), String(args.fileId)) as { url?: string }
          if (typeof urlData?.url !== 'string' || urlData.url === '') throw new Error('拿不到群文件下载链接')
          // NapCat 文件服务给的下载链接，本机部署时就是 127.0.0.1。
          const res = await systemHttp.request(urlData.url, { limit: MAX_DOWNLOAD_BYTES, allowPrivateHosts: true })
          if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
          const bytes = Buffer.from(res.bytes)
          const fs = await import('node:fs/promises')
          const path = await import('node:path')
          const wsRoot = config.workspacePath ?? process.cwd()
          const dir = path.join(wsRoot, 'downloads')
          await fs.mkdir(dir, { recursive: true })
          // 反斜杠也要清洗：Windows 宿主上 `..\..\x` 是路径逃逸；这里与 files 的同名实现保持一致。
          const safeName = String(args.saveAs ?? `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`).replace(/[\\/:*?"<>|]/g, '_')
          const target = path.join(dir, safeName)
          await atomicWriteFile(target, bytes)
          return { saved: target, size: bytes.length }
        },
      }
}

/** `qq_create_file_folder` — 在群文件系统里新建文件夹（整理群文件用）。… */
function qqCreateFileFolder(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_create_file_folder',
        description: '在群文件系统里新建文件夹（整理群文件用）。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            folderName: { type: 'string', description: '文件夹名' },
            parentId: { type: 'string', description: '父文件夹ID，不填=根目录' },
          },
          required: ['groupId', 'folderName'],
        },
        run: async (args) => api.createGroupFileFolder(Number(args.groupId),  String(args.folderName),  String(args.parentId ?? '/')),
      }
}

/** `qq_move_group_file` — 移动群文件（拖动到别的文件夹）。目录ID来自文件列表。… */
function qqMoveGroupFile(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_move_group_file',
        description: '移动群文件（拖动到别的文件夹）。目录ID来自文件列表。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            fileId: { type: 'string', description: '文件ID' },
            currentParentDirectory: { type: 'string', description: '当前父目录ID' },
            targetParentDirectory: { type: 'string', description: '目标父目录ID' },
          },
          required: ['groupId', 'fileId', 'currentParentDirectory', 'targetParentDirectory'],
        },
        run: async (args) => api.moveGroupFile(Number(args.groupId),  String(args.fileId),  String(args.currentParentDirectory),  String(args.targetParentDirectory)),
      }
}

/** `qq_rename_group_file` — 重命名群文件。… */
function qqRenameGroupFile(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_rename_group_file',
        description: '重命名群文件。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            fileId: { type: 'string' },
            currentParentDirectory: { type: 'string', description: '当前父目录ID' },
            newName: { type: 'string', description: '新文件名' },
          },
          required: ['groupId', 'fileId', 'currentParentDirectory', 'newName'],
        },
        run: async (args) => api.renameGroupFile(Number(args.groupId),  String(args.fileId),  String(args.currentParentDirectory),  String(args.newName)),
      }
}

/** `qq_delete_group_file` — 删除群文件。慎重使用。… */
function qqDeleteGroupFile(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_delete_group_file',
        description: '删除群文件。慎重使用。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            fileId: { type: 'string' },
          },
          required: ['groupId', 'fileId'],
        },
        run: async (args) => api.deleteGroupFile(Number(args.groupId), String(args.fileId)),
      }
}

/** `qq_get_file_url` — 拿私聊/群文件的下载链接（fileId 来自文件消息或群文件列表）。… */
function qqGetFileUrl(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_get_file_url',
        description: '拿私聊/群文件的下载链接（fileId 来自文件消息或群文件列表）。',
        parameters: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: '文件ID' },
          },
          required: ['fileId'],
        },
        run: async (args) => api.getPrivateFileUrl(String(args.fileId)),
      }
}

/** 组装这一组工具。 */
export function groupFilesTools(deps: QQToolDeps): ToolSpec[] {
  return [
    qqListGroupFiles(deps),
    qqUploadGroupFile(deps),
    qqDownloadGroupFile(deps),
    qqCreateFileFolder(deps),
    qqMoveGroupFile(deps),
    qqRenameGroupFile(deps),
    qqDeleteGroupFile(deps),
    qqGetFileUrl(deps),
  ]
}
