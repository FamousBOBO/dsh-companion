import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { suite } from './paths.mjs';
export { suite };
export async function connectHost({root=suite,fetchImpl=fetch}={}){
 const text=fs.readFileSync(path.join(root,'data/logs/production-host.log'),'utf8');
 const current=text.slice(text.lastIndexOf('Production Node host started'));
 const match=[...current.matchAll(/dsh web:\s*(http:\/\/127\.0\.0\.1:3100\/\?token=\S+)/g)].at(-1);
 if(!match)throw Error('Current host URL not published');
 const url=new URL(match[1]);
 const connect=new URL('/connect',url);connect.search=url.search;connect.searchParams.set('interactions','none');
 const auth=await fetchImpl(connect,{redirect:'manual',signal:AbortSignal.timeout(10000)});
 const cookie=auth.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 if(!cookie)throw Error('Host authentication failed');
 return async function call(method,args={}){
  const response=await fetchImpl(new URL('/api/'+method,url),{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args}}),signal:AbortSignal.timeout(30000)});
  const envelope=await response.json();
  if(!envelope.result?.ok)throw Error(JSON.stringify(envelope.result?.error??{status:response.status}));
  return envelope.result.value;
 };
}
