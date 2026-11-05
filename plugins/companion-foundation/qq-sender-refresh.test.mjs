import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProgressPhase, upgradeLiveQqSender } from './qq-conversation.mjs';
test('hot-reloaded channel replaces a scoped adapter that still references the closed client', async () => {
  let closedCalls=0, currentCalls=0;
  const old={ parameters:{properties:{}}, execute:async()=>{closedCalls++;throw Error('QQ not connected');} };
  let global={parameters:{properties:{}}, execute:async()=>{currentCalls++;return {message_id:42};}};
  let scoped=withProgressPhase(old);
  const local={register(def){scoped=def;}};
  const agent={id:'qq-dm-123',session:{id:'qq-dm-123'},ctx:{tools:local}};
  const root={get:()=>({get:(_name,a)=>a?scoped:global})};
  assert.equal(upgradeLiveQqSender(root,agent),true);
  assert.equal((await scoped.execute({action:'send',phase:'final'},{})).message_id,42);
  assert.equal(closedCalls,0);assert.equal(currentCalls,1);
  assert.equal(upgradeLiveQqSender(root,agent),false);
  global={parameters:{properties:{}},execute:async()=>({message_id:43})};
  assert.equal(upgradeLiveQqSender(root,agent),true);
  assert.equal((await scoped.execute({action:'send',phase:'final'},{})).message_id,43);
});
test('fresh adapter binds current sender once and preserves progress continuation', async()=>{
  const global={parameters:{properties:{}},execute:async()=>({message_id:44})};
  let scoped=global,registrations=0;
  const agent={session:{id:'qq-dm-123'},ctx:{tools:{register(def){scoped=def;registrations++;}}}};
  const root={get:()=>({get:(_name,a)=>a?scoped:global})};
  assert.equal(upgradeLiveQqSender(root,agent),true);
  assert.equal(upgradeLiveQqSender(root,agent),false);
  assert.equal(registrations,1);
  assert.equal((await scoped.execute({action:'send',phase:'progress'},{})).progress_message_id,44);
});
