import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {connectHost} from './host-rpc.mjs';

test('RPC authenticates with this startup only and sends the host request envelope',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'production-rpc-'));
 try{
  fs.mkdirSync(path.join(root,'data/logs'),{recursive:true});
  fs.writeFileSync(path.join(root,'data/logs/production-host.log'),'Production Node host started old\ndsh web: http://127.0.0.1:3100/?token=old\nProduction Node host started current\ndsh web: http://127.0.0.1:3100/?token=current\n');
  const calls=[];
  const fetchImpl=async(url,options)=>{
   calls.push(url);
   if(url.pathname==='/connect'){
    assert.equal(url.searchParams.get('token'),'current');assert.equal(url.searchParams.get('interactions'),'none');
    return new Response(null,{status:302,headers:{'set-cookie':'test-session=ok; HttpOnly; Path=/'}});
   }
   assert.equal(options.headers.cookie,'test-session=ok');const body=JSON.parse(options.body);
   assert.equal(body.type,'client-request');assert.equal(body.method,'session/modelCatalog');assert.deepEqual(body.payload.args,{});
   return Response.json({result:{ok:true,value:{connected:true}}});
  };
  const call=await connectHost({root,fetchImpl});assert.deepEqual(await call('session/modelCatalog'),{connected:true});assert.equal(calls.length,2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
