import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMemoryEngine} from '../index.mjs';
test('P2 activity memory belongs to the character; missed/routine and legacy unclassified activities do not become user facts',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'p2-actor-'));fs.mkdirSync(path.join(root,'home/companion'),{recursive:true});fs.writeFileSync(path.join(root,'home/companion/memory.config.json'),JSON.stringify({backend:'sqlite',wiki:{enabled:false},extraction:{enabled:false},retrieval:{semanticEnabled:false}}));
 const identity={owner:()=>({id:'owner',displayName:'owner'}),resolve:()=>({userId:'owner',personaId:'bot',worldId:''})};
 const engine=createMemoryEngine({root,identity,env:{}});t.after(async()=>{await engine.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});await engine.initialize();const {db}=await engine.internal();
 const base={subject:{userId:'owner',personaId:'bot',worldId:''},namespace:'p2/activity',transformVersion:'v1',rootEvidenceIds:[],realityStatus:'actual_tool_activity',evidenceStatus:'inferred',occurredAt:Date.now()};
 const routine=await engine.ingestDomainEvent({...base,eventId:'missed',significance:'routine',content:'计划中的探索没有开始（窗口已过）'});assert.equal(routine.status,'rejected');
 const legacy=await engine.ingestDomainEvent({...base,eventId:'legacy-missed',content:'计划中的探索没有开始（窗口已过）'});assert.equal(legacy.status,'rejected');assert.equal(legacy.reason,'activity-significance-required');
 const result=await engine.ingestDomainEvent({...base,eventId:'explored',significance:'notable',content:'自主探索结束，覆盖 1234 字。'});assert.equal(result.status,'pending');const row=db.getMemory(result.recordId);assert.equal(row.scope,'persona_self');assert.equal(row.kind,'event');assert.equal(row.subject,'bot');assert.equal(row.realityLevel,'bot_action');
 const user=await engine.ingestDomainEvent({...base,namespace:'companion.event',eventId:'user',evidenceStatus:'confirmed',content:'用户喜欢猫'});const fact=db.getMemory(user.recordId);assert.equal(fact.scope,'user_global');assert.equal(fact.kind,'fact');assert.equal(fact.subject,'user');
});
