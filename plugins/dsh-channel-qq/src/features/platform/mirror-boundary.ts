import fs from 'node:fs'
import path from 'node:path'
import type { QQChannelConfig } from '../../config.js'

/** Explicit source root is required: guessing isolation from a directory name is unsafe. */
export function assertMirrorBoundary(config: QQChannelConfig, dshHome: string, productionRoot = process.env.DSH_MIRROR_PRODUCTION_ROOT): void {
  if (config.connection.mode !== 'mirror-observe') return
  if (!productionRoot || !fs.existsSync(productionRoot)) throw new Error('mirror-observe requires DSH_MIRROR_PRODUCTION_ROOT')
  if (config.presence.mode !== 'shadow') throw new Error('mirror-observe requires presence.mode=shadow')
  const url = new URL(config.connection.url)
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('mirror-observe requires literal loopback ws URL')
  const canonical = (value: string): string => fs.realpathSync(value).toLowerCase()
  const source = canonical(productionRoot)
  for (const value of [dshHome, config.workspacePath]) {
    if (!value || !fs.existsSync(value)) throw new Error('mirror-observe requires existing isolated home and workspace')
    const target = canonical(value)
    if (target === source || target.startsWith(source + path.sep) || source.startsWith(target + path.sep)) {
      throw new Error('mirror-observe home/workspace overlaps production root')
    }
  }
}
