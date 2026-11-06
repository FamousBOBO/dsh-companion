import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { connectHost,suite } from './host-rpc.mjs';
if(process.argv.includes('--help')){console.log('node dsh-ops/probe-opencode.mjs [--smoke] — smoke makes one model request; otherwise read catalog only.');process.exit(0);}
const call=await connectHost();
const catalog=await call('session/modelCatalog');
const report={at:new Date().toISOString(),default:catalog.default,providers:catalog.groups.map(g=>({id:g.id,models:g.models.map(m=>m.id)})).filter(g=>g.id.includes('opencode')),failures:catalog.failures};
if(!process.argv.includes('--smoke')){console.log(JSON.stringify(report,null,2));}else{
let sessionId;
try{
 sessionId=(await call('session/create',{request:{cwd:path.join(suite,'data/workspace'),agentPreset:'companion'}})).sessionId;
 report.sessionId=sessionId;
 await call('session/rename',{request:{sessionId,title:'OpenCode Go 连接验收'}});
 await call('session/selectModel',{request:{sessionId,provider:'opencode-go',model:'deepseek-v4.1-flash',reasoningEffort:'low'}});
 report.selected=true;
 await call('session/prompt',{request:{sessionId,requestId:randomUUID(),mode:'queue',clientTimeZone:'Asia/Shanghai',content:[{type:'text',text:'这是模型连接测试，不是个人事实。只回复 OK。不要调用任何工具，不要写入记忆，不要发送消息到任何外部平台。'}]}});
 const deadline=Date.now()+120000;
 while(Date.now()<deadline){
  await setTimeout(2000);
  const projection=await call('session/projections',{request:{sessionId}});
  const page=await call('session/page',{request:{address:{kind:'session',sessionId},throughSeq:projection.asOfSeq,maxMessages:30}});
  const events=page.records.map(r=>r.event);
  const errors=events.filter(e=>/error|fail/.test(e.type));
  const replies=events.filter(e=>e.type==='assistant/message');
  if(replies.length){const reply=replies.at(-1);report.modelSource=reply.data.message?.source??reply.data.source;report.replyPresent=true;report.replyText=(reply.data.message?.content??reply.data.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('');report.ok=true;break;}
  if(errors.length){report.errors=errors.map(e=>({type:e.type,data:e.data}));report.ok=false;break;}
 }
 if(!report.ok&&!report.errors)report.error='No assistant response within 120 seconds';
}catch(error){report.error=error.message;report.ok=false;}
finally{
 if(sessionId&&report.selected){try{await call('session/selectModel',{request:{sessionId,...catalog.default}});report.defaultRestored=true;}catch(error){report.restoreError=error.message;}}
 fs.writeFileSync(path.join(suite,'data/logs/opencode-connection-probe.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
 if(!report.ok)process.exitCode=1;
}
}
