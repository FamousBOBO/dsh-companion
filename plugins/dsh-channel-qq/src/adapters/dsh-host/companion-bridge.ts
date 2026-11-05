import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

export interface CompanionBridge {
  publish(name: string, value: unknown, options?: { ready?: () => boolean; priority?: () => number }): () => void
  resolve(name: string): unknown
}

/** Optional companion deployment seam; no shared module means ordinary Cordis resolution. */
export async function loadCompanionBridge(home: string, log: (line: string) => void): Promise<CompanionBridge | null> {
  const file = path.resolve(home, '../plugins/companion-foundation/service-bridge.mjs')
  try {
    const module = await import(pathToFileURL(file).href)
    if (typeof module.createServiceBridge !== 'function') throw new Error('bridge factory unavailable')
    return module.createServiceBridge(path.dirname(home)) as CompanionBridge
  } catch (error) {
    log('companion bridge unavailable: ' + (error instanceof Error ? error.message : String(error)))
    return null
  }
}
