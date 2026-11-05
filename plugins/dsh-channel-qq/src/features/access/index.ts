/** 访问门控子插件（安全）：配对审批 / 白名单 / 全放行。 */

import * as path from 'node:path'
import { AccessService } from './service.js'
import { AccessStore } from './store.js'
import type { SubPlugin } from '../plugin-kit.js'

export const accessPlugin: SubPlugin = {
  name: 'access',
  watches: ['access'],
  requires: ['platform', 'persona'],
  async apply(host) {
    const store = new AccessStore(path.join(host.dshHome, 'channel-qq', 'access.json'), host.log)
    await store.load()
    const service = new AccessService({
      api: () => host.get('platform')?.api ?? null,
      out: () => host.get('platform')?.out ?? null,
      persona: () => host.get('persona')?.pack ?? null,
      config: () => host.config.access,
      rootConfig: () => host.config,
      admins: () => host.config.admins,
      store,
      now: () => Date.now(),
      log: host.log,
    })
    host.provide('access', service)
    host.registerResource('access', {
      label: '访问请求',
      list: () => service.list(),
      actions: {
        approve: async (body) => await service.approve(kindOf(body), idOf(body)),
        reject: async (body) => await service.reject(kindOf(body), idOf(body)),
      },
    })
  },
}

function bodyOf(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
}

function kindOf(body: unknown): 'user' | 'group' {
  return bodyOf(body).kind === 'group' ? 'group' : 'user'
}

function idOf(body: unknown): number {
  const id = Number(bodyOf(body).id)
  if (!Number.isFinite(id) || id <= 0) throw new Error('缺少合法的 id')
  return id
}
