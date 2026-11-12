import {test} from "node:test"
import assert from "node:assert/strict"
import {DmDeliveryGuard} from "../src/adapters/dsh-host/delivery-guard.js"
import {installDmDeliveryGuard} from "../src/adapters/dsh-host/agents.js"
function answer(g: DmDeliveryGuard, turn=1): void {
 g.observe({type:"start",turn})
 g.observe({type:"chunk",chunk:{type:"text-delta",text:"hello"}})
 g.observe({type:"end",outcome:{kind:"committed",eventType:"assistant/message"}})
}
test("committed plain text can request delivery only once in a turn",()=>{
 const g=new DmDeliveryGuard(); answer(g)
 assert.equal(g.correction(true),true)
 answer(g); assert.equal(g.correction(true),false)
 answer(g,2); assert.equal(g.correction(true),true)
})
test("any attempted tool call prevents duplicate or uncertain delivery",()=>{
 const g=new DmDeliveryGuard(); answer(g)
 g.observe({type:"chunk",chunk:{type:"block-start",blockType:"tool-call"}})
 assert.equal(g.correction(true),false)
})
test("no visible send tool, reasoning-only, abandoned and failed attempts do not nudge",()=>{
 const g=new DmDeliveryGuard(); answer(g)
 assert.equal(g.correction(false),false)
 g.observe({type:"end",outcome:{kind:"abandoned"}})
 assert.equal(g.correction(true),false)
 const empty=new DmDeliveryGuard();empty.observe({type:"start",turn:1})
 empty.observe({type:"end",outcome:{kind:"committed",eventType:"assistant/message"}})
 assert.equal(empty.correction(true),false)
})
test("host stopping hook injects one next-step correction into the same DM",()=>{
 const handlers=new Map<string,(payload: unknown)=>void>()
 const ctx={on:(name:string,fn:(payload:unknown)=>void)=>handlers.set(name,fn),tools:{get:()=>({})}}
 const messages: unknown[]=[]
 const agent={inject:(message:unknown)=>messages.push(message)}
 installDmDeliveryGuard(ctx as never,{sessionId:"qq-dm-42",log:()=>{}} as never)
 const emit=(frame:unknown)=>handlers.get("agent/assistant-stream")!({frame})
 emit({type:"start",turn:1})
 emit({type:"chunk",chunk:{type:"text-delta",text:"hello"}})
 emit({type:"end",outcome:{kind:"committed",eventType:"assistant/message"}})
 const stop=()=>handlers.get("agent/turn-stopping")!({agent,signal:new AbortController().signal})
 stop();stop()
 assert.equal(messages.length,1)
 assert.match(JSON.stringify(messages),/target=42/)
})
