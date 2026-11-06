import fs from 'node:fs';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ApiError } from './api-kernel.mjs';
import { writeFileAtomic } from '../../companion-media/src/config-store.mjs';
import { resolveSuitePaths } from '../../companion-foundation/suite-paths.mjs';
const at=(value,key)=>key.split('.').reduce((node,part)=>node?.[part],value);
const set=(value,key,next)=>{const parts=key.split('.');let node=value;for(const part of parts.slice(0,-1))node=node[part]??={};node[parts.at(-1)]=next;};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
const removed=new Set(['cruises','primaryTalkValue','rooms','agentPreset','permissionPreset','groupAgentPreset','groupPermissionPreset']);
const displayHelp={
  keywordReactions:'关键词命中后，向模型提供对应的反应提示。',
  'presence.ambientTtlMs':'旁听消息保留多久，单位为分钟。过期后不再用于接话判断。',
  'presence.judgeIntervalMs':'两次判断至少间隔多少分钟，支持小数。缩短间隔会增加模型调用。',
  'presence.judgeTimeoutMs':'一次判断最多等待多少分钟。超时后本轮不重试。',
  'presence.speakMinIntervalMs':'同一个群两次自主发言之间至少间隔多少分钟。',
};
const allowed=ref=>!ref.spec.secret&&!ref.spec.dormant&&!removed.has(ref.path)&&!['groupModel','planner','context'].includes(ref.section)&&(
  ['messages','groups','proactive'].includes(ref.page)||['contact','presence','turn','contextBudget','sessionReset'].includes(ref.section));

export function normalizeKeywordReactions(value){
  if(!Array.isArray(value)||value.length>100)throw new ApiError('bad-request','关键词映射需要是列表，最多 100 组',400);
  const groups=new Map(),seen=new Set();
  for(const row of value){
    if(!row||typeof row.reaction!=='string'||!row.reaction.trim()||row.reaction.length>2000||!Array.isArray(row.keywords))throw new ApiError('bad-request','每组映射需要填写有效的反应提示与关键词列表',400);
    const reaction=row.reaction.trim(),keywords=groups.get(reaction)||[];
    for(const raw of row.keywords){
      if(typeof raw!=='string'||!raw.trim()||raw.length>100)throw new ApiError('bad-request','关键词不能为空或超过 100 字',400);
      const word=raw.trim();if(seen.has(word))throw new ApiError('bad-request','同一关键词只能连接一个反应',400);
      seen.add(word);keywords.push(word);
    }
    groups.set(reaction,keywords);
  }
  return [...groups].map(([reaction,keywords])=>({keywords,reaction}));
}

function profileConfig(suiteRoot,home){
  if(!suiteRoot)return {};
  const suite=read(path.join(suiteRoot,'config','suite.json'));
  let YAML;
  try{YAML=createRequire(import.meta.url)('yaml');}catch{
    if(process.env.DSH_COMPANION_MODULE_ROOT)YAML=createRequire(path.join(process.env.DSH_COMPANION_MODULE_ROOT,'_studio.cjs'))('yaml');
  }
  let base={};
  for(const file of [path.join(suiteRoot,'config/profile/companion.patch.yml'),path.join(home,'profiles',suite.dsh?.profile||'companion','cordis.patch.yml')]){
    if(!fs.existsSync(file))continue;
    if(!YAML)throw new ApiError('internal','无法读取聊天初始配置，请先完成宿主安装与构建',500);
    const rows=YAML.parse(fs.readFileSync(file,'utf8'),{logLevel:'silent'});
    for(const row of rows||[])if(row.id==='channel-qq'&&row.config)base={...base,...row.config};
  }
  return base;
}

export async function chatSettings(request,kernel,options={}){
  kernel.viewer(await kernel.internal());
  const [{SCHEMA,resolveConfig},{fieldRefs,validateValue},{applyPatch}]=await Promise.all([
    import('../../dsh-channel-qq/build/lib/config.js'),import('../../dsh-channel-qq/build/lib/config/meta.js'),import('../../dsh-channel-qq/build/lib/admin.js'),
  ]);
  const refs=fieldRefs().filter(allowed);
  const home=path.join(kernel.root,'home');const file=path.join(home,'channel-qq','admin-config.json');
  const bridge=globalThis[Symbol.for('dsh-companion:qq-settings')]?.get(path.resolve(home));
  const live=bridge?.snapshot();
  const override=read(file);
  const base=options.chatBase??profileConfig(resolveSuitePaths({moduleUrl:import.meta.url}).suiteRoot,home);
  const merged=structuredClone(base);applyPatch(merged,override);
  const config=live?.config??resolveConfig(merged);
  const values=Object.fromEntries(refs.map(ref=>[ref.path,at(config,ref.path)??null]));
  const revision=hash({values,version:live?.version,override});
  if(request.method==='POST'){
    const body=await kernel.body(request);
    if(body.revision!==revision)throw new ApiError('bad-request','配置已被其他页面修改，请重新读取',400);
    if(!body.patch||typeof body.patch!=='object'||Array.isArray(body.patch)||!Object.keys(body.patch).length)throw new ApiError('bad-request','没有待保存的设置',400);
    const patch={};
    for(const [key,raw]of Object.entries(body.patch)){
      const value=key==='keywordReactions'?normalizeKeywordReactions(raw):raw;
      const ref=refs.find(item=>item.path===key);if(!ref)throw new ApiError('bad-request','不支持的聊天设置',400);
      const error=validateValue(ref.spec,value);if(error)throw new ApiError('bad-request',`${ref.spec.label}：${error}`,400);
      if(key==='contact.quietHours'&&(!Array.isArray(value)||value.some(row=>!row||Object.keys(row).some(key=>!['from','to'].includes(key))||!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.from)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.to))))throw new ApiError('bad-request','免打扰时间需要填写为 HH:MM',400);
      set(patch,key,value);
    }
    if(bridge){
      try{const result=await bridge.apply(patch,live.version);const failed=result.effects?.some(effect=>/未能热应用/.test(effect));return kernel.ok({saved:true,restartRequired:failed?Object.keys(body.patch):result.restartRequired,live:true});}
      catch{throw new ApiError('bad-request','聊天设置未保存：请核对字段或重新读取后再试',400);}
    }
    const next=structuredClone(override);applyPatch(next,patch);
    if(fs.existsSync(file)){
      const backup=path.join(kernel.root,'backups',`chat-settings-${randomUUID()}.json`);fs.mkdirSync(path.dirname(backup),{recursive:true});fs.copyFileSync(file,backup);
    }
    writeFileAtomic(file,JSON.stringify(next,null,2)+'\n');
    return kernel.ok({saved:true,live:false,restartRequired:Object.keys(body.patch)});
  }
  const groups=new Map(SCHEMA.groups.map(group=>[group.id,group.label]));
  return kernel.ok({revision,live:!!bridge,fields:refs.map(ref=>({path:ref.path,group:ref.section||'general',groupLabel:ref.section==='batching'?'消息合并与等待':groups.get(ref.section)||'基本回复',page:ref.page,kind:ref.spec.kind,label:(({'segmentation.maxSegments':'私聊回复条数上限','segmentation.delayPerCharMs':'回复延时（毫秒/字）','segmentation.delayMinMs':'回复延时下限（毫秒）','segmentation.delayMaxMs':'回复延时上限（毫秒）','segmentation.enabled':'启用私聊分段回复'})[ref.path]||ref.spec.label)+(ref.section==='presence'&&ref.spec.unit==='ms'?'（min）':''),help:displayHelp[ref.path]||ref.spec.help||'',hot:ref.spec.hot||'restart',options:ref.spec.choices,min:ref.spec.min,max:ref.spec.max,step:ref.spec.step??'any',displayDivisor:ref.section==='presence'&&ref.spec.unit==='ms'?60000:1,itemsKind:ref.spec.itemsKind,value:values[ref.path]}))});
}
