import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudioHandlers,API_PREFIX } from '../server.mjs';

function fixture(viewer=true){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-operator-'));
  const engine={internal:()=>({viewer:()=>viewer?{userId:'owner',personaId:'companion'}:null})};
  return {root,handlers:createStudioHandlers({root,engine}),cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
async function call(f,method,route,body){
  const response=await f.handlers[`${method} ${API_PREFIX}/${route}`](new Request('http://localhost'+API_PREFIX+'/'+route,{method,...(body?{body:JSON.stringify(body),headers:{'content-type':'application/json'}}:{})}));
  return {response,json:await response.json()};
}
test('runtime switches persist only permitted keys and retain unrelated settings',async()=>{
  const f=fixture();try{
    const file=path.join(f.root,'home/companion/runtime.config.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({enabled:false,mode:'off',custom:'keep'}));
    const saved=await call(f,'POST','runtime-settings',{patch:{enabled:true,planning:false}});
    assert.equal(saved.response.status,200);
    const raw=JSON.parse(fs.readFileSync(file));assert.equal(raw.custom,'keep');assert.equal(raw.enabled,true);assert.equal(raw.mode,'active');
    const bad=await call(f,'POST','runtime-settings',{patch:{arbitrary:true}});assert.equal(bad.response.status,400);
    assert.equal(JSON.parse(fs.readFileSync(file)).custom,'keep');
  }finally{f.cleanup();}
});
test('web panel starts unconfigured and saves only after an explicit request',async()=>{
  const f=fixture();try{
    const first=await call(f,'GET','web-panel');assert.equal(JSON.stringify(first.json).includes('configured":false'),true);
    assert.equal(fs.existsSync(path.join(f.root,'home/companion/studio.webpanels.json')),false);
    assert.equal((await call(f,'POST','web-panel',{provider:'luna',url:'javascript:alert(1)'})).response.status,400);
    assert.equal((await call(f,'POST','web-panel',{provider:'luna',url:'https://panel.example/'})).response.status,200);
    const raw=JSON.parse(fs.readFileSync(path.join(f.root,'home/companion/studio.webpanels.json')));assert.equal(raw.url,'https://panel.example/');
  }finally{f.cleanup();}
});
test('log endpoint returns actual tail and redacts credentials',async()=>{
  const f=fixture();try{
    fs.mkdirSync(path.join(f.root,'logs'));fs.writeFileSync(path.join(f.root,'logs','start-test.log'),'worker started\nhttp://localhost/?token=secret-value\nAuthorization: Bearer secret-private-value\n');
    const result=await call(f,'GET','runtime-logs');const text=JSON.stringify(result.json);
    assert.match(text,/worker started/);assert.equal(text.includes('secret-value'),false);assert.equal(text.includes('secret-private-value'),false);
  }finally{f.cleanup();}
});
test('operator endpoints require a bound owner',async()=>{
  const f=fixture(false);try{
    for(const route of ['web-panel','runtime-settings','runtime-logs']){
      const result=await call(f,'GET',route);assert.equal(result.json.ok,false);
    }
  }finally{f.cleanup();}
});
