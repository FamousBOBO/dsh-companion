import * as path from 'node:path'
import type { AdminServer } from '../../admin.js'
import type { SubHost } from '../plugin-kit.js'
import { globalRegistryOf } from '../../adapters/dsh-host/global-registry.js'

const key=Symbol.for('dsh-companion:qq-settings')
interface Bridge {
  snapshot(): { config: SubHost['config']; version: number }
  apply(patch: Record<string,unknown>,version:number): ReturnType<AdminServer['applyConfigPatch']>
}
// 转型（`as unknown as`）搬进 adapters/dsh-host/global-registry.ts：分层检查 R7 要求
// "绕过类型系统的知识只住在一个地方"，这里只拿一张按 dshHome 索引的表。
const shared=globalRegistryOf<Bridge>(key)
export function publishStudioBridge(host:SubHost,server:AdminServer):()=>void {
  const home=path.resolve(host.dshHome)
  const bridge:Bridge={snapshot:()=>({config:host.config,version:server.configVersion}),
    apply:(patch,version)=>server.applyConfigPatch(patch,{baseVersion:version,requireVersion:true,source:'companion-studio'})}
  shared.set(home,bridge)
  return ()=>{if(shared.get(home)===bridge)shared.delete(home)}
}
