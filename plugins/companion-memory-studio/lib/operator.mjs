import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../../companion-media/src/config-store.mjs';
import { redactText } from '../../companion-media/src/secrets.mjs';
import { loadConfig } from '../../companion-runtime/lib/config.mjs';
import { ApiError } from './api-kernel.mjs';
import { readPanelConfig, panelConfigFile, panelStatus, controlPanel } from './web-panel-process.mjs';
import { createLogStream } from './runtime-log-stream.mjs';
import { restartState } from './restart-state.mjs';

export async function pendingRestart(request,kernel){kernel.viewer(await kernel.internal());return kernel.ok(restartState(kernel.root));}

const runtimeFields = {enabled:['enabled'],planning:['p2','planning','enabled'],heartbeat:['heartbeat','enabled'],share:['p2','share','enabled']};
const readJson = file => {try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return {};}};
const at=(value,parts)=>parts.reduce((node,key)=>node?.[key],value);
const set=(value,parts,next)=>{let node=value;for(const key of parts.slice(0,-1))node=node[key]??=( {} );node[parts.at(-1)]=next;};

export async function runtimeSettings(request,kernel,deps={}) {
  kernel.viewer(await kernel.internal());
  const {config,file,error}=loadConfig(kernel.root,{env:{}});
  if(error&&request.method==='POST')throw new ApiError('bad-request','运行库配置文件无法读取，请先修复配置',400);
  if(request.method==='POST') {
    const {patch}=await kernel.body(request);
    if(!patch||Array.isArray(patch)||typeof patch!=='object'||!Object.keys(patch).length)throw new ApiError('bad-request','请选择要修改的开关',400);
    const next=readJson(file);
    for(const [key,value]of Object.entries(patch)) {
      if(!runtimeFields[key]||typeof value!=='boolean')throw new ApiError('bad-request','不支持的运行库设置',400);
      set(next,runtimeFields[key],value);
      if(key==='enabled'&&value&&(!next.mode||next.mode==='off'))next.mode='active';
    }
    writeFileAtomic(file,JSON.stringify(next,null,2)+'\n');
    // Disable the live runtime immediately when available. Enabling and subfeature changes
    // use the persisted configuration on restart; never claim that a file write started work.
    const runtime=typeof deps.runtime==='function'?deps.runtime():deps.runtime;
    if(patch.enabled===false&&typeof runtime?.stop==='function')runtime.stop({reason:'operator-settings'});
    return kernel.ok({saved:true,restartRequired:true,values:Object.fromEntries(Object.entries(runtimeFields).map(([key,parts])=>[key,at(loadConfig(kernel.root,{env:{}}).config,parts)===true]))});
  }
  return kernel.ok({values:Object.fromEntries(Object.entries(runtimeFields).map(([key,parts])=>[key,at(config,parts)===true])),mode:config.mode,restartRequired:false});
}

export async function webPanel(request,kernel) {
  kernel.viewer(await kernel.internal());
  const file=panelConfigFile(kernel.root);
  let config=readPanelConfig(kernel.root);
  if(request.method==='POST') {
    const body=await kernel.body(request);
    let url;try{url=new URL(String(body.url));}catch{throw new ApiError('bad-request','请输入有效网页地址',400);}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new ApiError('bad-request','只支持不含账号密码的 HTTP/HTTPS 地址',400);
    if(!['napcat','snowluma','luna'].includes(body.provider))throw new ApiError('bad-request','请选择 NapCat 或 SnowLuma',400);
    const sameOrigin=config.url&&new URL(config.url).origin===url.origin&&config.provider===body.provider;
    config={...(sameOrigin?config:{}),provider:body.provider==='luna'?'snowluma':body.provider,url:url.href};
    writeFileAtomic(file,JSON.stringify(config,null,2)+'\n');
  }
  return kernel.ok(await panelStatus(kernel.root));
}

export async function webPanelControl(request,kernel) {
  kernel.viewer(await kernel.internal());
  const body=await kernel.body(request);
  return kernel.ok(await controlPanel(kernel.root,body.action));
}

export function sanitizeLog(text) {
  return redactText(String(text)).replace(/([?&](?:token|key|password|auth)\s*=)[^\s&"']+/gi,'$1[redacted]')
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|cookie|password)["']?\s*[:=]\s*["']?)[^\r\n,"']+/gi,'$1[redacted]');
}

export async function runtimeLogs(request,kernel) {
  kernel.viewer(await kernel.internal());
  const dir=path.join(kernel.root,'logs');
  const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>/^start-.*\.log$/.test(f)).sort():[];
  const file=files.at(-1);
  if(!file)return kernel.ok({lines:[],source:null,observedAt:new Date().toISOString()});
  const fd=fs.openSync(path.join(dir,file),'r');
  let text;
  try{const size=fs.fstatSync(fd).size;const start=Math.max(0,size-65536);const bytes=Buffer.alloc(size-start);fs.readSync(fd,bytes,0,bytes.length,start);text=bytes.toString('utf8');if(start>0)text=text.slice(text.indexOf('\n')+1);}finally{fs.closeSync(fd);}
  return kernel.ok({lines:sanitizeLog(text).split(/\r?\n/).filter(Boolean).slice(-160),source:file,observedAt:new Date().toISOString()});
}

export async function runtimeLogsStream(request,kernel) {
  kernel.viewer(await kernel.internal());
  return new Response(createLogStream(kernel.root,{signal:request.signal,sanitize:sanitizeLog}),{headers:{
    'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no',
  }});
}
