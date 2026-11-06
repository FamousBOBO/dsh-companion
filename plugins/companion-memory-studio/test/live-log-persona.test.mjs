import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudioHandlers,API_PREFIX } from '../server.mjs';

function fixture(owner=true){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-live-'));
  const personaFile=path.join(root,'config/persona.md');fs.mkdirSync(path.dirname(personaFile),{recursive:true});fs.writeFileSync(personaFile,'原来的人格');
  const handlers=createStudioHandlers({root,engine:{internal:()=>({viewer:()=>owner?{userId:'owner',personaId:'bot'}:null})},personaPaths:{suiteRoot:root,personaFile,personaId:'bot'}});
  return {root,personaFile,handlers,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
async function call(f,method,route,body){return f.handlers[`${method} ${API_PREFIX}/${route}`](new Request('http://localhost'+API_PREFIX+'/'+route,{method,...(body?{body:JSON.stringify(body)}:{})}));}
async function until(reader,needle){
  let output='';const timeout=AbortSignal.timeout(2500);
  while(!output.includes(needle)){
    const result=await Promise.race([reader.read(),new Promise((_,reject)=>timeout.addEventListener('abort',()=>reject(new Error('stream timeout')),{once:true}))]);
    if(result.done)break;output+=new TextDecoder().decode(result.value);
  }return output;
}

test('SSE appends real lines, redacts split tokens, follows rotation, and cancels cleanly',async()=>{
  const f=fixture();let reader;
  try{
    const dir=path.join(f.root,'logs');fs.mkdirSync(dir);const file=path.join(dir,'start-1.log');fs.writeFileSync(file,'initial worker output\n');
    const response=await call(f,'GET','runtime-logs/stream');assert.match(response.headers.get('content-type'),/text\/event-stream/);reader=response.body.getReader();
    assert.match(await until(reader,'initial worker output'),/"reset":true/);
    fs.appendFileSync(file,'new real output\nurl ?token=private');
    assert.match(await until(reader,'new real output'),/"reset":false/);
    fs.appendFileSync(file,'-token-value\n');const next=await until(reader,'redacted');assert.equal(next.includes('private'),false);
    fs.writeFileSync(path.join(dir,'start-2.log'),'rotated output\n');const rotated=await until(reader,'rotated output');assert.match(rotated,/"reset":true/);
    await reader.cancel();assert.equal((await reader.read()).done,true);reader=null;
  }finally{await reader?.cancel();f.cleanup();}
});

test('persona save backs up original text and rejects stale edits without overwriting',async()=>{
  const f=fixture();try{
    const data=(await (await call(f,'GET','persona')).json()).data;
    assert.equal(data.content,'原来的人格');
    const saved=await (await call(f,'POST','persona',{content:'新的性格与语气',revision:data.revision})).json();assert.equal(saved.ok,true);assert.equal(saved.data.restartRequired,true);
    const backup=fs.readdirSync(path.join(f.root,'backups'))[0];assert.equal(fs.readFileSync(path.join(f.root,'backups',backup),'utf8'),'原来的人格');
    const stale=await call(f,'POST','persona',{content:'过期修改',revision:data.revision});assert.equal(stale.status,400);assert.equal(fs.readFileSync(f.personaFile,'utf8'),'新的性格与语气');
  }finally{f.cleanup();}
});

test('live stream and persona require a bound owner',async()=>{
  const f=fixture(false);try{for(const route of ['runtime-logs/stream','persona'])assert.equal((await (await call(f,'GET',route)).json()).ok,false);}finally{f.cleanup();}
});
