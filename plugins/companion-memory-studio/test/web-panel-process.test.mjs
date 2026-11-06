import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { panelConfigFile, panelEmbedUrl, panelStatus, controlPanel } from '../lib/web-panel-process.mjs';

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
