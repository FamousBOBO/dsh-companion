import fs from 'node:fs';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { resolveSuitePaths } from '../../companion-foundation/suite-paths.mjs';
import { writeFileAtomic } from '../../companion-media/src/config-store.mjs';
import { ApiError } from './api-kernel.mjs';

const revision=text=>createHash('sha256').update(text).digest('hex');
export async function personaSettings(request,kernel,options={}) {
  kernel.viewer(await kernel.internal());
  const paths=options.personaPaths??resolveSuitePaths({moduleUrl:import.meta.url});
  const target=paths.suiteRoot?path.join(paths.suiteRoot,'config','persona.md'):path.join(kernel.root,'workspace','PERSONA.md');
  const source=fs.existsSync(target)?target:paths.personaFile;
  let content=source&&fs.existsSync(source)?fs.readFileSync(source,'utf8'):'';
  let saved=false;
  if(request.method==='POST') {
    const body=await kernel.body(request);
    if(typeof body.content!=='string'||!body.content.trim()||Buffer.byteLength(body.content)>131072)throw new ApiError('bad-request','人格设定不能为空，且不能超过 128 KB',400);
    if(body.revision!==revision(content))throw new ApiError('bad-request','人格设定已被修改，请重新读取后再保存',400);
    if(fs.existsSync(target)) {
      const backup=path.join(kernel.root,'backups',`persona-${Date.now()}-${randomUUID()}.md`);
      fs.mkdirSync(path.dirname(backup),{recursive:true});fs.copyFileSync(target,backup);
    }
    writeFileAtomic(target,body.content);content=body.content;saved=true;
  }
  return kernel.ok({content,revision:revision(content),personaId:paths.personaId||'bot',saved,restartRequired:saved});
}
