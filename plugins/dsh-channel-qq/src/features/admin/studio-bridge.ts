import * as path from 'node:path'
import type { AdminServer } from '../../admin.js'
import type { SubHost } from '../plugin-kit.js'

const key=Symbol.for('dsh-companion:qq-settings')
interface Bridge {
  snapshot(): { config: SubHost['config']; version: number }
  apply(patch: Record<string,unknown>,version:number): ReturnType<AdminServer['applyConfigPatch']>
}
const shared=globalThis as unknown as { [key: symbol]: Map<string,Bridge>|undefined }
export function publishStudioBridge(host:SubHost,server:AdminServer):()=>void {
  const registry=shared[key]??=new Map<string,Bridge>()
  const home=path.resolve(host.dshHome)
  const bridge:Bridge={snapshot:()=>({config:host.config,version:server.configVersion}),
    apply:(patch,version)=>server.applyConfigPatch(patch,{baseVersion:version,requireVersion:true,source:'companion-studio'})}
  registry.set(home,bridge)
  return ()=>{if(registry.get(home)===bridge)registry.delete(home)}
}
