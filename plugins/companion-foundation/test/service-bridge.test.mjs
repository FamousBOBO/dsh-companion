import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServiceBridge } from '../service-bridge.mjs';
const runtime=JSON.parse(fs.readFileSync(new URL('../../../runtime.local.json',import.meta.url))).moduleRoot;
const {Context}=await import(pathToFileURL(path.join(runtime,'@deepseek-ai/cordis/lib/index.js')).href);
function home(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-real-'));fs.mkdirSync(path.join(p,'home'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
test('real Cordis: isolated agenda is unavailable during mount, bridge exposes active owner across realms only',async t=>{
  const root=home(t),ctx=new Context(),bridge=createServiceBridge(root),port={casOccurrence:()=>({ok:true})};
  let local,stop,mountRead,mountBridgeRead;
  const fiber=ctx.isolate('companionAgenda').plugin(c=>{local=c;c.provide('companionAgenda',port);mountRead=c.get('companionAgenda');stop=bridge.publish('companionAgenda',port,{ready:()=>c.fiber.state===2});mountBridgeRead=bridge.resolve('companionAgenda');c.on('dispose',stop);});
  await fiber;
  assert.equal(mountBridgeRead,null,'bridge must also respect inactive owning fiber');
  assert.equal(mountRead,undefined,'strict get during mount must really miss');
  assert.ok(local.get('companionAgenda'));
  assert.equal(ctx.get('companionAgenda'),undefined,'root remains isolated');
  assert.equal(bridge.resolve('companionAgenda'),port);
  assert.equal(createServiceBridge(home(t)).resolve('companionAgenda'),null,'other home must never see it');
  await fiber.dispose();
  assert.equal(bridge.resolve('companionAgenda'),null,'disposed provider must disappear');
});
test('bridge refuses equal owners, selects writer, and resumes remaining owner without stale references',t=>{
  const bridge=createServiceBridge(home(t)),a={},b={};let ready=false;
  const stopA=bridge.publish('companionAgenda',a,{priority:()=>1});
  const stopB=bridge.publish('companionAgenda',b,{ready:()=>ready,priority:()=>2});
  assert.equal(bridge.resolve('companionAgenda'),a);ready=true;assert.equal(bridge.resolve('companionAgenda'),b);
  stopB();assert.equal(bridge.resolve('companionAgenda'),a);
  const stopC=bridge.publish('companionAgenda',{} ,{priority:()=>1});assert.equal(bridge.resolve('companionAgenda'),null);
  stopC();stopA();assert.equal(bridge.resolve('companionAgenda'),null);
});
test('sharing bridge never caches an unloaded sender',async t=>{
  const bridge=createServiceBridge(home(t));let calls=0;
  const stop=bridge.publish('companionContactShare',{submitShareCandidate:async()=>{calls++;return {ok:false,code:'share-disabled'}}});
  assert.deepEqual(await bridge.resolve('companionContactShare').submitShareCandidate({}),{ok:false,code:'share-disabled'});
  stop();assert.equal(bridge.resolve('companionContactShare'),null);assert.equal(calls,1);
});
