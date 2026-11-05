import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { companionDashboard } from '../lib/companion-dashboard.mjs';

test('dashboard reads only trusted scope and never creates a missing database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-ui-'));
  const file = path.join(root,'home/companion/companion-runtime.db');
  const kernel = { root, internal:async()=>({}), viewer:()=>({userId:'owner',personaId:'bot'}), ok:x=>x };
  try {
    assert.equal((await companionDashboard(null,kernel)).runtime.available,false);
    assert.equal(fs.existsSync(file),false);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE goals (scope TEXT,goal_id TEXT,title TEXT,status TEXT,deadline_at INTEGER,next_step TEXT,waiting_on TEXT,updated_at INTEGER)');
    const insert=db.prepare('INSERT INTO goals VALUES (?,?,?,?,?,?,?,?)');
    insert.run('u:owner|p:bot|w:world:default','own','visible','active',null,'','',1);
    insert.run('u:other|p:bot|w:world:default','other','private','active',null,'','',1);
    db.close();
    const result=await companionDashboard(new Request('http://localhost/?userId=other'),kernel);
    assert.deepEqual(result.sections.goals.map(row=>row.title),['visible']);
    assert.ok(result.unavailable.includes('state'));
    assert.equal(result.runtime.available,true);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
