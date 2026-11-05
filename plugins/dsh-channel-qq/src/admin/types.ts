/** `AdminServer` 的公共类型：依赖面（`AdminDeps`）与保存管线（补丁/结果）的声明。
 *
 * 从 `admin.ts` 拆出（体量棘轮）。这里保持**没有行为**——纯类型，任何拿到
 * `AdminServer` 的类型使用者（组合根、子插件、测试）都从这里读，admin.ts 只做
 * 再导出，导出面与拆分前逐字不变。
 */

import type { QQChannelConfig } from '../config.js'
import type { WorkspaceFiles } from '../workspace-files.js'
import type { ProvidersSurface } from '../adapters/dsh-host/providers.js'
import type { ChangeEntry, Json } from './config-engine.js'

/** One CRUD surface the panel exposes as a table. */
export interface AdminResource {
  label?: string
  list?: (query: URLSearchParams) => Promise<unknown> | unknown
  create?: (body: Json) => Promise<unknown> | unknown
  remove?: (id: string) => Promise<unknown> | unknown
  actions?: Record<string, (body: Json) => Promise<unknown> | unknown>
}

export interface AdminDeps {
  config: QQChannelConfig
  dshHome: string
  log: (line: string) => void
  /** Runtime status for the overview tab (connection, groups, scheduler…). */
  status: () => Promise<Record<string, unknown>>
  /** Tail of `channel-qq.log`. */
  readLog: (lines: number) => Promise<string[]>
  /** Inject a prompt into the agent as the master would. */
  prompt?: (text: string) => Promise<unknown>
  /** Resource tables contributed by feature modules. */
  resources: Record<string, AdminResource>
  /**
   * React to a live config change (relisten a port, re-dial the transport,
   * re-read a directory). Returns human-readable notes for the response; kept
   * as a callback so this file never needs to know the channel's internals.
   */
  applyEffects?: (patch: Json) => Promise<string[]>
  /** Workspace file access; absent → those routes answer 503 with a reason. */
  files?: WorkspaceFiles
  /** Agent preset roster + document reading, for the persona tab. */
  presets?: {
    current: () => string
    list: () => Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>>
    doc: (id: string) => Promise<{ id: string; content: string; name?: string; description?: string }>
    select: (id: string) => Promise<string>
  }
  /** Persisted agent sessions: list them, or wipe one so it restarts clean. */
  sessions?: {
    list: () => Promise<Array<{ room: string; sessionId: string; files: number; bytes: number; mtime: number }>>
    rebuild: (room: string) => Promise<{ room: string; moved: boolean; files: number; note: string }>
  }
  /** 模型供应商管理（宿主 settings / agentDefaultModel / credentials 的接入面）。 */
  providers?: ProvidersSurface
  /**
   * 发送侧健康探测（`/api/healthz`）。**不产生消息**：内部是一次 `get_status`
   * 往返。给运维脚本（state.sh）用，所以这条路由不走登录门禁——只接受本机请求。
   */
  health?: () => Promise<unknown>
}

/** Options for {@link AdminServer.applyConfigPatch}. */
export interface ConfigPatchOptions {
  /** History entry source: `save` | `rollback` | `internal` (default `save`). */
  source?: string
  /** Client's last-seen version; mismatch → 409 (only with `requireVersion`). */
  baseVersion?: number
  requireVersion?: boolean
  ip?: string
  method?: string
  path?: string
}

/** One change list entry as sent to the UI (no raw values → no secret leakage). */
export type PublicChange = Pick<ChangeEntry, 'path' | 'label' | 'hot' | 'secret' | 'old' | 'new'>

export interface ConfigPatchResult {
  applied: string[]
  changes: PublicChange[]
  restartRequired: string[]
  effects: string[]
  note: string
  version: number
}
