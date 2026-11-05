import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHostWebPort } from './autonomy-host-web.mjs';
import { createAutonomyPorts } from './autonomy.mjs';
import { createMaterialsPort } from './autonomy-materials.mjs';
import { adapterContext, ADAPTERS, sourceAllowed } from '../companion-runtime/lib/activity-adapters.mjs';
import { buildPlanningPrompt } from '../companion-runtime/lib/planner.mjs';

const at = Date.UTC(2026,10,1,4);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'host-reading-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls = [];
  const web = {
    search: async request => { calls.push(['search',request]); return { sources:[{url:'https://example.com/article',title:'Photography'},{url:'http://127.0.0.1/private'}] }; },
    fetch: async request => { calls.push(['fetch',request]); return {url:request.url,statusCode:200,body:{kind:'html',content:'<title>Photography</title><article>'+ 'interesting sentence. '.repeat(500)+'</article>'},truncated:false}; },
  };
  const ctx = {get:name=>name==='web'?web:name==='agents'?{list:()=>[]}:undefined};
  const options = {ctx,root,allowedSources:['*'],topics:['摄影'],now:()=>at};
  return {root,calls,web,ctx,options};
}
test('DSH native Search/Fetch are reused, bounded and cached across recreation',async t=>{
  const f=fixture(t), port=createHostWebPort(f.options);
  const [a,b]=await Promise.all([port.search({query:'星空'}),port.search({query:'星空'})]);
  assert.equal(a.results.length,1); assert.deepEqual(a,b);
  assert.deepEqual(f.calls[0],['search',{query:'星空',maxResults:6}]);
  const page=await port.fetchPage({url:a.results[0].url});
  assert.ok(page.text.length>4000);
  const reopened=createHostWebPort(f.options);
  await reopened.search({query:'星空'}); await reopened.fetchPage({url:a.results[0].url});
  assert.equal(f.calls.length,2);
  assert.equal((await port.fetchPage({url:'http://127.0.0.1/private'})).ok,false);
  assert.equal(sourceAllowed('127.0.0.1',['*']),false);
  assert.equal(sourceAllowed('example.com',['*']),true);
});
test('native failures, provider truncation and failed search quota are honest',async t=>{
  const f=fixture(t); f.web.search=async()=>{throw Error('offline');};
  const port=createHostWebPort({...f.options,maxSearchesPerDay:1});
  assert.equal((await port.search({query:'one'})).ok,false);
  assert.equal((await createHostWebPort({...f.options,maxSearchesPerDay:1}).search({query:'two'})).code,'search-daily-limit');
  f.web.fetch=async()=>({url:'https://example.com/partial',statusCode:200,body:{kind:'text',content:'partial'},truncated:true});
  assert.equal((await port.fetchPage({url:'https://example.com/partial'})).code,'source-truncated');
  const missing=createHostWebPort({...f.options,ctx:{get:()=>undefined}});
  assert.equal((await missing.search({query:'new',scopeKey:'other'})).code,'host-search-unavailable');
});
test('background native search reuses the signed-in account without storing tokens or changing endpoints',async t=>{
  const f=fixture(t);
  const endpoint='https://api.deepseek.com/anthropic/v1';
  const seen=[];
  class NativeProvider {
    constructor(resolveOptions){this.resolveOptions=resolveOptions;}
    async search(request){const options=this.resolveOptions();seen.push([options.baseURL,request.query]);assert.equal(await options.resolveAccountToken(options.baseURL+'/messages'),'ephemeral-test-token');return {sources:[{url:'https://example.com/article'}]};}
  }
  const original=new NativeProvider(()=>({baseURL:endpoint,maxTokens:3000,resolveAccountToken:async()=>undefined}));
  f.web.search=async()=>{throw Object.assign(Error('missing'),{code:'WEB_PROVIDER_CREDENTIAL_MISSING'});};
  f.web.searchProviders=new Map([['deepseek-official',original]]);
  const ctx={get:name=>name==='web'?f.web:name==='deepseekAccount'?{resolveToken:async destination=>{assert.ok(destination.startsWith(endpoint));return 'ephemeral-test-token';}}:undefined};
  const result=await createHostWebPort({...f.options,ctx}).search({query:'background'});
  assert.equal(result.ok,true);assert.deepEqual(seen,[[endpoint,'background']]);
  const persisted=fs.readFileSync(path.join(f.root,'home/companion/reading-web-cache.json'),'utf8');
  assert.equal(persisted.includes('ephemeral-test-token'),false);
});
test('full-source explore retains and processes the tail beyond legacy 4000-char excerpt',async t=>{
  const f=fixture(t), port=createHostWebPort(f.options);
  const ctx=adapterContext({ports:port,config:{p2:{activities:{readFullSource:true,chunkUnits:1200,maxTotalUnits:200000},autonomy:{allowedSources:['*']}}}});
  const prepared=await ADAPTERS.explore.prepare(ctx,{target:'https://example.com/article',now:at});
  assert.ok(prepared.totalUnits>4000);
  assert.equal(prepared.checkpoint.fullSource,true);
  const segment=ADAPTERS.explore.consume(ctx,{checkpoint:prepared.checkpoint,consumedPrefix:5000,sourceHash:prepared.sourceHash},{units:1200});
  assert.equal(segment.from,5000); assert.ok(segment.text.length>0);
});
test('production wiring selects DSH, interests drive search, completed URLs are excluded',async t=>{
  const f=fixture(t);
  const wired=createAutonomyPorts({root:f.root,ctx:f.ctx,options:{searchProvider:'dsh',allowedSources:['*'],topics:['fallback']}});
  assert.equal(wired.describe().web.port,'dsh-web');
  await wired.ports.search({query:'photography'});
  assert.equal(f.calls[0][0],'search');
  const web=createHostWebPort(f.options);
  const materials=createMaterialsPort({root:f.root,web,options:{artifactRoot:'home/companion/works',seedLimit:8,seedVerify:1}});
  fs.mkdirSync(path.join(f.root,'home/companion/works/library'),{recursive:true});
  fs.writeFileSync(path.join(f.root,'home/companion/works/library/book.md'),'a real book');
  const m=await materials.materials({scopeKey:'owner',now:at,runtime:{interests:[{title:'感兴趣的摄影'}],budget:{requests:{remaining:10}},runningActivities:[{kind:'explore',target:'https://example.com/continued',status:'paused',consumed_prefix:1200,total_units:9000}],planningPreferences:{targetActivities:4,maxSlots:12}}});
  assert.ok(f.calls.some(([type,args])=>type==='search'&&args.query==='感兴趣的摄影'));
  assert.ok(m.entryPoints.includes('library/book.md'));
  const p=buildPlanningPrompt({material:m,day:'2026-11-01',timeZone:'Asia/Shanghai',now:at,windowStart:at,windowEnd:at+3600000});
  assert.ok(p.input.includes('约 4 项')); assert.ok(p.input.includes('https://example.com/continued')); assert.ok(p.input.includes('library/book.md'));
  const noBudget=await web.seeds({topic:'blocked',budget:{remaining:0}});
  assert.equal(noBudget.code,'budget-blocked');
  const seeds=await web.seeds({topic:'photography',excludeUrls:['https://example.com/article']});
  assert.equal(seeds.seeds.length,0);
});

test('explore preserves HTTP failures and treats transport errors as unknown', async t => {
  const { options, web } = fixture(t);
  const port = createHostWebPort(options);
  const ctx = adapterContext({ ports: port, config: { p2: { autonomy: { allowedSources: ['*'] } } } });
  const target = 'https://example.com/article';
  web.fetch = async () => ({ url: target, statusCode: 403 });
  await assert.rejects(async () => ADAPTERS.explore.prepare(ctx, { target }), error =>
    error.code === 'source-invalid' && /HTTP 403/.test(error.message) && !error.noAnswer);
  web.fetch = async () => { throw Object.assign(Error('request details'), { code: 'ETIMEDOUT' }); };
  await assert.rejects(async () => ADAPTERS.explore.prepare(ctx, { target }), error =>
    error.code === 'source-invalid' && /ETIMEDOUT/.test(error.message) &&
    !error.message.includes('request details') && error.noAnswer === true);
});
