import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { panelConfigFile, panelEmbedUrl, panelStatus, controlPanel,matchingDarwinProcess,darwinProcessIdentity } from '../lib/web-panel-process.mjs';

test('macOS verifies spaced arguments and stable start time without /proc',async()=>{
  const launch={executable:process.execPath,args:['/tmp/panel with spaces.mjs','--port','12345']};
  const fields={comm:launch.executable,args:[launch.executable,...launch.args].join(' '),lstart:'Fri Nov  6 08:00:00 2026'};
  const execute=async(command,args,options)=>{
    assert.equal(command,'/bin/ps');assert.deepEqual(args.slice(0,4),['-ww','-p','123','-o']);assert.equal(options.env.LC_ALL,'C');
    return {stdout:fields[args.at(-1).replace(/=$/,'')]+'\n'};
  };
  const createdAt='darwin:'+fields.lstart;
  assert.equal(await matchingDarwinProcess(123,launch,createdAt,execute),true);
  assert.equal(await matchingDarwinProcess(123,{...launch,args:['/tmp/other.mjs']},createdAt,execute),false);
  assert.equal(await matchingDarwinProcess(123,launch,'darwin:another process',execute),false);
  let reads=0;
  const recycled=async(command,args,options)=>args.at(-1)==='lstart='?{stdout:++reads===1?fields.lstart:'changed'}:execute(command,args,options);
  assert.equal(await darwinProcessIdentity(123,recycled),null);
  assert.equal(await darwinProcessIdentity(123,async()=>{throw new Error('process exited');}),null);
});

test('NapCat token is used only for its configured local iframe, never returned as launch configuration', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'panel-token-'));
  try {
    const tokenFile=path.join(root,'webui.json');fs.writeFileSync(tokenFile,JSON.stringify({token:'private+token'}));
    const config={provider:'napcat',url:'http://127.0.0.1:1/',launch:{tokenFile}};
    fs.mkdirSync(path.dirname(panelConfigFile(root)),{recursive:true});fs.writeFileSync(panelConfigFile(root),JSON.stringify(config));
    assert.equal(new URL(panelEmbedUrl(config)).searchParams.get('token'),'private+token');
    assert.equal(new URL(panelEmbedUrl({...config,url:'https://example.test/'})).searchParams.has('token'),false);
    const status=await panelStatus(root);
    assert.equal(status.launch,undefined);assert.equal(status.url,config.url);assert.equal(status.canControl,false);
    await assert.rejects(controlPanel(root,'restart'),/请先配置/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('persistent local launcher starts once, survives requests, and restarts only its matching process', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'panel-launch-'));
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const script=path.join(root,'panel.mjs');fs.writeFileSync(script,"import http from 'node:http';http.createServer((req,res)=>res.end('ready')).listen("+port+",'127.0.0.1');");
  fs.mkdirSync(path.dirname(panelConfigFile(root)),{recursive:true});
  fs.writeFileSync(panelConfigFile(root),JSON.stringify({provider:'napcat',url:`http://127.0.0.1:${port}/`,launch:{executable:process.execPath,args:[script],cwd:root}}));
  const receipt=()=>JSON.parse(fs.readFileSync(path.join(root,'tmp/qq-panel-process.json')));
  let pid;
  try {
    const first=await controlPanel(root,'start');assert.equal(first.running,true);pid=receipt().pid;
    assert.equal((await controlPanel(root,'start')).started,false);assert.equal(receipt().pid,pid);
    const second=await controlPanel(root,'restart');assert.equal(second.running,true);assert.notEqual(receipt().pid,pid);pid=receipt().pid;
    fs.writeFileSync(path.join(root,'tmp/qq-panel-process.json'),JSON.stringify({pid:process.pid}));
    await assert.rejects(controlPanel(root,'restart'),/无法安全重启/);
  } finally {
    if(pid) { try { if(process.platform==='win32')execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else process.kill(pid); } catch {} }
    fs.rmSync(root,{recursive:true,force:true});
  }
});
