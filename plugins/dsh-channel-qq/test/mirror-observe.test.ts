import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OneBotClient } from '../src/onebot.js'
import { resolveConfig } from '../src/config.js'
import { assertMirrorBoundary } from '../src/features/platform/mirror-boundary.js'
import { WebSocketServer } from 'ws'
import { once } from 'node:events'

test('connected mirror receives events but sends zero action frames', async () => {
  const server=new WebSocketServer({host:'127.0.0.1',port:0})
  await once(server,'listening')
  const address=server.address()
  assert.ok(typeof address==='object' && address!==null)
  const client=new OneBotClient({mode:'mirror-observe',url:`ws://127.0.0.1:${address.port}`},'synthetic',()=>{})
  let frames=0
  try {
    const accepted=once(server,'connection')
    client.start()
    const [socket]=await accepted
    socket.on('message',()=>{frames++})
    const received=once(client,'event')
    socket.send(JSON.stringify({post_type:'message',message_type:'group',group_id:123,user_id:456,message_id:789,message:[]}))
    assert.equal((await received)[0].message_id,789)
    for(const action of ['get_status','send_group_msg','unknown'])await assert.rejects(client.call(action),/blocked/)
    await new Promise(resolve=>setTimeout(resolve,20))
    assert.equal(frames,0)
  } finally {
    client.stop()
    for(const socket of server.clients)socket.terminate()
    await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})

test('mirror transport refuses every action before touching a socket', async () => {
  const client = new OneBotClient({mode:'mirror-observe',url:'ws://127.0.0.1:3101'},'synthetic',()=>{})
  for(const action of ['send_group_msg','send_private_msg','get_login_info','get_status','unknown']) {
    await assert.rejects(client.call(action), /mirror-observe blocked/)
  }
  assert.throws(()=>client.reconnect({mode:'forward',url:'ws://127.0.0.1:3001'},''), /requires a restart/)
  client.stop()
})

test('mirror refuses remote addresses and reverse/live transport transitions', () => {
  const client = new OneBotClient({mode:'mirror-observe',url:'ws://example.invalid:3101'},'',()=>{})
  assert.throws(()=>client.start(), /literal loopback/)
  const live = new OneBotClient({mode:'forward',url:''},'',()=>{})
  assert.throws(()=>live.reconnect({mode:'mirror-observe',url:'ws://127.0.0.1:3101'},''), /requires a restart/)
})

test('mirror boundary requires shadow and canonical paths outside production', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mirror-boundary-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const production=path.join(root,'production'),home=path.join(root,'test','home'),workspace=path.join(root,'test','workspace')
  for(const dir of [production,home,workspace])fs.mkdirSync(dir,{recursive:true})
  const config=resolveConfig({connection:{mode:'mirror-observe',url:'ws://127.0.0.1:3101'},workspacePath:workspace})
  config.presence.mode='shadow'
  assert.doesNotThrow(()=>assertMirrorBoundary(config,home,production))
  assert.throws(()=>assertMirrorBoundary(config,production,production), /overlaps/)
  assert.throws(()=>assertMirrorBoundary(config,home,''), /PRODUCTION_ROOT/)
  config.presence.mode='live'
  assert.throws(()=>assertMirrorBoundary(config,home,production), /shadow/)
})
