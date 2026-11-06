import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStudioHandlers, API_PREFIX } from '../server.mjs';
import { restartState, markRestart } from '../lib/restart-state.mjs';

function fixture(owner=true){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-chat-'));
  const file=path.join(root,'home/channel-qq/admin-config.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({connection:{accessToken:'private-credential'},segmentation:{maxSegments:3}}));
  const options={root,chatBase:{},engine:{internal:()=>({viewer:()=>owner?{userId:'owner',personaId:'bot'}:null})}};
  let handlers=createStudioHandlers(options);
  return {root,file,reload:()=>{handlers=createStudioHandlers(options);},async call(method,route='chat-settings',body){const response=await handlers[`${method} ${API_PREFIX}/${route}`](new Request('http://localhost'+API_PREFIX+'/'+route,{method,...(body?{body:JSON.stringify(body)}:{})}));return {status:response.status,...await response.json()};},cleanup(){globalThis[Symbol.for('dsh-companion:qq-settings')]?.delete(path.resolve(root,'home'));fs.rmSync(root,{recursive:true,force:true});}};
}

test('chat saves whitelisted native parameters, preserves secrets, rejects stale revisions and invalid quiet hours',async()=>{
  const f=fixture();try{
    const first=await f.call('GET');assert.equal(first.ok,true);
    assert.equal(JSON.stringify(first).includes('private-credential'),false);
    for(const key of ['segmentation.maxSegments','segmentation.delayMinMs','contact.quietHours'])assert.ok(first.data.fields.some(field=>field.path===key),key);
    const post=patch=>f.call('POST','chat-settings',{revision:first.data.revision,patch});
    assert.equal((await post({'connection.accessToken':'leak'})).status,400);
    assert.equal((await post({'segmentation.maxSegments':-1})).status,400);
    assert.equal((await post({'contact.quietHours':[{from:'25:00',to:'08:00'}]})).status,400);
    assert.equal((await post({'segmentation.maxSegments':4,'contact.quietHours':[{from:'23:00',to:'08:00'}]})).ok,true);
    const saved=JSON.parse(fs.readFileSync(f.file,'utf8'));assert.equal(saved.connection.accessToken,'private-credential');assert.equal(saved.segmentation.maxSegments,4);
    assert.equal((await post({'segmentation.maxSegments':5})).status,400);
    f.reload();assert.equal((await f.call('GET','restart-status')).data.pending,true);
    assert.equal((await f.call('GET')).data.fields.find(field=>field.path==='segmentation.maxSegments').value,4);
  }finally{f.cleanup();}
});

test('live chat uses versioned native apply and distinguishes hot changes from restart requirements',async()=>{
  const f=fixture();let received;try{
    globalThis[Symbol.for('dsh-companion:qq-settings')]??=new Map();
    const {resolveConfig}=await import('../../dsh-channel-qq/build/lib/config.js');
    const bridge={snapshot:()=>({config:resolveConfig({}),version:17}),apply:async(patch,version)=>{received={patch,version};return {restartRequired:[],effects:[]};}};
    globalThis[Symbol.for('dsh-companion:qq-settings')].set(path.resolve(f.root,'home'),bridge);
    const first=await f.call('GET');const save=()=>f.call('POST','chat-settings',{revision:first.data.revision,patch:{'segmentation.maxSegments':4}});
    assert.equal((await save()).data.live,true);assert.deepEqual(received,{patch:{segmentation:{maxSegments:4}},version:17});assert.equal(restartState(f.root).pending,false);
    bridge.apply=async()=>({restartRequired:['context.enabled'],effects:[]});await save();assert.equal(restartState(f.root).pending,true);
  }finally{f.cleanup();}
});

test('restart reminder survives handler recreation and clears on actual process restart',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-restart-'));try{
    markRestart(root,'人格设定');markRestart(root,'人格设定');assert.equal(restartState(root).changes.length,1);
    const moduleUrl=new URL('../lib/restart-state.mjs',import.meta.url).href;
    const result=spawnSync(process.execPath,['--input-type=module','-e',`import {restartState} from ${JSON.stringify(moduleUrl)};process.stdout.write(JSON.stringify(restartState(process.argv[1])))`,root],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).pending,false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('chat settings require a bound owner',async()=>{const f=fixture(false);try{assert.equal((await f.call('GET')).ok,false);}finally{f.cleanup();}});
