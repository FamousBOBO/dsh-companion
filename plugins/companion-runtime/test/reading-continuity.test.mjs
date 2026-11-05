import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';

const bound={userId:'owner',persona:'march7'};
const target='https://example.com/article';
const start=Date.UTC(2026,10,1,1);
function fixture(t) {
  const root=fs.mkdtempSync(path.join(process.cwd(),'continuous-reading-'));
  let at=start, fetches=0;
  fs.mkdirSync(path.join(root,'home/companion'),{recursive:true});
  fs.writeFileSync(path.join(root,'home/companion/runtime.config.json'),JSON.stringify({schemaVersion:1,leaseTtlMs:172800000,enabled:true,mode:'active',timeZone:'Asia/Shanghai',p2:{planning:{enabled:true},activities:{enabled:true,readFullSource:true,artifactRoot:'home/companion/works',chunkUnits:100,maxUnitsPerStep:100},autonomy:{allowedSources:['*']}}}));
  const options={now:()=>at,identity:{resolve:sessionId=>({...bound,sessionId})},materials:()=>({entryPoints:[target]}),
    callModel:async args=>({text:args.purpose==='p2-planning'?JSON.stringify({summary:'continue reading',slots:[{kind:'activity',activity:'explore',title:'read article',detail:'continue at checkpoint',startAt:at,endAt:at+300000,flexibility:'soft',targetRef:target}]}):'reading notes',provider:'test',model:'test',inputTokens:10,outputTokens:10}),
    p2Ports:{fetchPage:async()=>{fetches++;return {ok:true,status:200,text:'long text. '.repeat(600),contentType:'text/plain'};}}};
  let runtime=mountRuntime(null,root,options);
  t.after(()=>{runtime.dispose();fs.rmSync(root,{recursive:true,force:true});});
  return {get runtime(){return runtime;},setAt:value=>{at=value;},reopen:()=>{runtime.dispose();runtime=mountRuntime(null,root,options);},fetches:()=>fetches};
}
test('automatic window pause continues the same source and prefix across day and restart',async t=>{
  const f=fixture(t), r=f.runtime;
  r.proposeGoal({bound,title:'reading'});
  const plan=await r.pumpPlanning({reason:'timer'});
  assert.equal(plan.ok,true,JSON.stringify(plan));
  await r.pumpActivities({now:start});
  f.setAt(start+300001);
  const step=await r.pumpActivityExecution({now:start+300001,maxStepsPerCycle:1});
  let activity=r.listActivities({bound}).activities[0];
  assert.equal(activity.status,'paused',JSON.stringify({step,activity,status:r.status({bound})})); assert.ok(activity.consumed>0);
  const id=activity.activityId,prefix=activity.consumed;
  f.setAt(start+86400000); f.reopen();
  await f.runtime.pumpPlanning({reason:'timer'});
  await f.runtime.pumpActivities({now:start+86400000});
  const rows=f.runtime.listActivities({bound}).activities;
  assert.equal(rows.length,1); assert.equal(rows[0].activityId,id); assert.equal(rows[0].consumed,prefix); assert.equal(rows[0].status,'running');
  await f.runtime.pumpActivityExecution({now:start+86400000,maxStepsPerCycle:1});
  activity=f.runtime.listActivities({bound}).activities[0];
  assert.ok(activity.consumed>prefix); assert.equal(f.fetches(),1);
});
test('a manual pause cannot be silently resumed or restarted by a new plan',async t=>{
  const f=fixture(t),r=f.runtime;
  r.proposeGoal({bound,title:'reading'}); await r.pumpPlanning({reason:'timer'}); await r.pumpActivities({now:start});
  const original=r.listActivities({bound}).activities[0];
  await r.pauseActivity({bound,activityId:original.activityId});
  f.setAt(start+86400000); await r.pumpPlanning({reason:'timer'}); await r.pumpActivities({now:start+86400000});
  const rows=r.listActivities({bound}).activities;
  assert.equal(rows.length,1); assert.equal(rows[0].status,'paused'); assert.equal(f.fetches(),1);
});
