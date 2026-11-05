/** 切换日说明（D3）与 AGENTS.md 工具区（tools.v2）。
 *
 * 两件事、一个来源：
 *   1. **工具区**：把"17 个工具 + 旧名对照"写进工作区 AGENTS.md 的第二个受管区
 *      （`<!-- channel-qq:tools:begin -->`），与 context.v2 的指令区各自独立、
 *      互不覆盖。开则同步、关则移除，挂载时幂等重写——切换日后**新开的会话**
 *      靠它认识新工具面（它们没有收到过切换日说明）。
 *   2. **切换日说明**：工具面换掉的那天，给每个已挂回的历史会话投一次 `inject`
 *      （不重建会话、不唤醒）；投过就落账（`<dshHome>/channel-qq/tools-surface.json`），
 *      之后每次启动不再打扰（那是噪音）。投递失败只记日志，绝不挡启动。
 * 文案都在人格包里（`instruction/tools-v2` / `notice/tools-renamed`），这里只负责时机。
 */

import { promises as fs, type Dirent } from 'node:fs'
import * as path from 'node:path'
import {
  atomicWriteFile, atomicWriteJson, readJsonFileOrNull, readTextFileOrNull,
} from '../../adapters/fs-store/atomic.js'
import {
  TOOLS_REGION_BEGIN, TOOLS_REGION_END, regionBlock, stripManagedRegion, upsertManagedRegion,
  type RegionMarkers,
} from '../../core/instruction/managed-region.js'
import { SESSION_PREFIX } from '../../core/room.js'
import { resolveSessionsRoot } from '../../paths.js'
import { renderFaceList, renderMapping } from './mapping.js'
import { toolsV2Enabled } from './surface.js'
import type { ConversationRegistry } from '../../app/conversation/registry.js'
import type { SubHost } from '../plugin-kit.js'

const TOOLS_MARKERS: RegionMarkers = [TOOLS_REGION_BEGIN, TOOLS_REGION_END]

/** 当前工具面的版本；切换日说明按它落账，只投一次。 */
export const TOOLS_SURFACE_VERSION = 'v2'

export type ToolsRegionStatus = 'created' | 'updated' | 'removed' | 'unchanged' | 'malformed'

/** 写/移除工具区（`body === null` = 移除）；只碰工具区标记之间的内容。 */
export async function writeToolsRegion(workspacePath: string, body: string | null): Promise<ToolsRegionStatus> {
  const file = path.join(workspacePath, 'AGENTS.md')
  const current = await readTextFileOrNull(file)
  if (body === null) {
    if (current === null) return 'unchanged'
    const stripped = stripManagedRegion(current, TOOLS_MARKERS)
    if (stripped.status === 'malformed') return 'malformed'
    if (stripped.status === 'absent') return 'unchanged'
    await atomicWriteFile(file, stripped.text)
    return 'removed'
  }
  const result = upsertManagedRegion(current ?? '', regionBlock(body, TOOLS_MARKERS), TOOLS_MARKERS)
  if (result.status === 'malformed') return 'malformed'
  if (result.status === 'unchanged') return 'unchanged'
  await atomicWriteFile(file, result.text)
  return current === null ? 'created' : 'updated'
}

/** 挂载时同步工具区；任何失败都只汇报、不抛出（不能挡住启动与热更新）。 */
export async function syncToolsRegion(host: SubHost): Promise<string> {
  const workspace = host.config.workspacePath
  if (workspace === null || workspace === '') return '未配置工作区，跳过'
  let body: string | null = null
  if (toolsV2Enabled(host.config)) {
    try {
      body = host.need('persona').pack.render('instruction/tools-v2', {
        tools: renderFaceList(),
        mapping: renderMapping(),
      })
    } catch (error) {
      return `渲染 instruction/tools-v2 失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
  try {
    const status = await writeToolsRegion(workspace, body)
    return status === 'malformed' ? 'AGENTS.md 工具区标记不成对，未改动（需人工检查）' : status
  } catch (error) {
    return `写入失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 切换日说明的落账文件（记录已宣告过的工具面版本）。 */
export function toolsSurfaceStatePath(dshHome: string): string {
  return path.join(dshHome, 'channel-qq', 'tools-surface.json')
}

/** 落盘的 qq 会话 id（与启动自愈同一套扫描：会话根下每个项目目录里的 qq-* 子目录）。 */
export async function listPersistedQqSessions(): Promise<string[]> {
  const ids = new Set<string>()
  const root = resolveSessionsRoot()
  let projects: Dirent[]
  try {
    projects = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue
    let sessions: Dirent[]
    try {
      sessions = await fs.readdir(path.join(root, entry.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (session.isDirectory() && session.name.startsWith(SESSION_PREFIX)) ids.add(session.name)
    }
  }
  return [...ids].sort()
}

/**
 * 切换日说明：`tools.v2` 打开且这台机器还没宣告过时，给每个已挂回的历史会话投
 * 一次 `inject`（只进上下文、不唤醒），然后落账；之后每次启动不再打扰。
 */
export async function announceToolsV2Switch(host: SubHost, registry: ConversationRegistry): Promise<void> {
  if (!toolsV2Enabled(host.config)) return
  try {
    const file = toolsSurfaceStatePath(host.dshHome)
    const state = await readJsonFileOrNull(file, isSurfaceState)
    if (state?.announced === TOOLS_SURFACE_VERSION) return
    const notice = host.need('persona').pack.render('notice/tools-renamed', { mapping: renderMapping() })
    const ids = await listPersistedQqSessions()
    let delivered = 0
    const failures: string[] = []
    for (const id of ids) {
      try {
        const key = id.slice(SESSION_PREFIX.length)
        const record = registry.bootstrap(key)
        if (record === undefined) { failures.push(`${id}：房间键解析失败`); continue }
        await registry.ensure(key, record.lastEvent)
        if (record.session?.deliver([{ type: 'text', text: notice }], 'inject') === true) delivered += 1
        else failures.push(`${id}：inject 通道不可用`)
      } catch (error) {
        failures.push(`${id}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    host.log(`tools.v2: 切换日说明已投给 ${delivered}/${ids.length} 个已挂回会话`)
    if (failures.length > 0) {
      host.log(`tools.v2: 未投达 ${failures.length} 个会话：${failures.slice(0, 5).join('；')}${failures.length > 5 ? ' …' : ''}`)
      // **有失败就不记账**：旧实现无论成败都写 announced，失败者永久收不到。
      // 但也不能无限重试（坏房间会每次都失败），所以记次数，三次后放弃。
      const attempts = (state?.attempts ?? 0) + 1
      await atomicWriteJson(file, attempts >= 3
        ? { announced: TOOLS_SURFACE_VERSION, attempts }
        : { attempts })
      return
    }
    await atomicWriteJson(file, { announced: TOOLS_SURFACE_VERSION })
  } catch (error) {
    host.log(`tools.v2: 切换日说明投递失败（不影响启动）：${error instanceof Error ? error.message : String(error)}`)
  }
}

function isSurfaceState(value: unknown): value is { announced?: string; attempts?: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const announced = (value as { announced?: unknown }).announced
  return announced === undefined || typeof announced === 'string'
}
