import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServiceBridge} from '../service-bridge.mjs';
import {contactSharePort} from '../contact-share-port.mjs';
test('actual foundation share port: late publication, switch-off, unload and replacement do not use stale senders',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'share-lifecycle-'));fs.mkdirSync(path.join(root,'home/companion'),{recursive:true});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const config=path.join(root,'home/companion/runtime.config.json');const set=on=>fs.writeFileSync(config,JSON.stringify({p2:{share:{enabled:on}}}));set(false);
 const bridge=createServiceBridge(root),port=contactSharePort({get:()=>undefined},root);assert.equal(port.sink,'jsonl-queue');let first=0,second=0;
 const stop=bridge.publish('companionContactShare',{submitShareCandidate:async()=>{first++;return {ok:true,code:'queued'}}});t.after(stop);
 assert.equal(port.sink,'contact-service');assert.equal((await port.submit({})).code,'share-disabled');assert.equal(first,0);
 set(true);assert.equal((await port.submit({})).code,'queued');assert.equal(first,1);stop();assert.equal(port.sink,'unavailable');assert.equal((await port.submit({})).code,'share-port-unavailable');assert.equal(first,1);
 const stop2=bridge.publish('companionContactShare',{submitShareCandidate:async()=>{second++;return {ok:true,code:'queued'}}});t.after(stop2);assert.equal((await port.submit({})).code,'queued');assert.equal(second,1);assert.equal(first,1);
});
