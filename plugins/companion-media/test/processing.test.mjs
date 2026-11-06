import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createMediaService } from '../src/service.mjs';
import { normalizeConfig, validateConfig } from '../src/schema.mjs';
import { parseDirection, directSpeech } from '../src/director.mjs';
import { prepareImagePrompt } from '../src/image-pipeline.mjs';
import { createMediaHost } from '../src/host-llm.mjs';
import { tempDataDir, mockFetch, makeZip, makePng, makePcm, writeConfig } from './helpers.mjs';

function imageSetup(dir,enabled=true) {
  writeConfig(dir,{schemaVersion:2,image:{enabled:true,provider:'nai',pipeline:{enabled,mode:'compose'},nai:{apiKey:'synthetic-test-key',model:'nai-diffusion-4-5-full'}}});
}
function voiceSetup(dir) {
  writeConfig(dir,{schemaVersion:2,tts:{enabled:true,provider:'breeze-tts2',director:{enabled:true},providers:{'breeze-tts2':{enabled:true,baseUrl:'http://127.0.0.1:7860',instruction:'自然说'}}}});
}
const fakeHost=text=>({available:()=>true,completeText:async()=>({text})});

test('image pipeline composes before presets and reports use; dry run and disabled feature never call a model',async()=>{
  const f=tempDataDir();try{
    imageSetup(f.dir);let modelCalls=0;
    const host={available:()=>true,completeText:async options=>{modelCalls++;assert.equal(options.provider,undefined);assert.equal(options.model,undefined);assert.match(options.input,/窗边的猫/);return {text:'{"tag":"cat, windowsill","negative":"dog"}'};}};
    const net=mockFetch([{match:'https://image.novelai.net/ai/generate-image',response:{bytes:makeZip([{name:'image.png',bytes:makePng()}]),mime:'application/zip'}}]);
    const service=createMediaService({dataDir:f.dir,host,fetchImpl:net.fetchImpl});
    assert.equal((await service.generateImage({prompt:'窗边的猫',dryRun:true})).ok,true);assert.equal(modelCalls,0);assert.equal(net.calls.length,0);
    const result=await service.generateImage({prompt:'窗边的猫',negative:'blurry'});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(modelCalls,1);assert.equal(result.processing.used,true);
    const body=JSON.parse(net.calls[0].body);assert.match(body.input,/cat, windowsill/);assert.match(JSON.stringify(body.parameters),/blurry, dog/);assert.equal(result.handoff.delivered,false);
    service.store.save({image:{enabled:false}});await service.generateImage({prompt:'猫'});assert.equal(modelCalls,1);
  }finally{f.cleanup();}
});

test('pipeline fallback retains original prompt and user negative; translation skips English',async()=>{
  const config=normalizeConfig({image:{pipeline:{enabled:true}}});
  const failed=await prepareImagePrompt({host:fakeHost('not json'),prompt:'猫',negative:'blurry',config});assert.equal(failed.prompt,'猫');assert.equal(failed.negative,'blurry');assert.equal(failed.processing.used,false);
  config.image.pipeline.mode='translate';
  const done=await prepareImagePrompt({host:fakeHost('a cat at the window'),prompt:'窗边的猫',negative:'blurry',config});assert.equal(done.prompt,'a cat at the window');assert.equal(done.negative,'blurry');
  const unused=await prepareImagePrompt({host:{available(){throw Error('must not inspect host');}},prompt:'a cat',config});assert.equal(unused.processing.reason,'already-english');
});

test('director rejects dialogue changes, spacing changes and parameters; allows only supported sound events',()=>{
  assert.deepEqual(parseDirection('你好。','{"input":"[笑]你好。","instructions":"自然温柔"}'),{input:'[笑]你好。',instructions:'自然温柔'});
  for(const output of [{input:'别的话',instructions:'温柔'},{input:'你 好。',instructions:'温柔'},{input:'你好。',instructions:'温柔',model:'another'}])assert.throws(()=>parseDirection('你好。',JSON.stringify(output)),/voice direction/);
});

test('Breeze receives original dialogue on invalid director output and applies valid instructions without extra syntheses',async()=>{
  const f=tempDataDir();try{
    voiceSetup(f.dir);let calls=0;
    const host={available:()=>true,completeText:async()=>({text:++calls===1?'{"input":"改写了","instructions":"温柔"}':'{"input":"你好。","instructions":"轻柔地说"}'})};
    const net=mockFetch([{match:'http://127.0.0.1:7860/v1/audio/speech',response:{bytes:makePcm(),mime:'audio/pcm'}}]);
    const service=createMediaService({dataDir:f.dir,host,fetchImpl:net.fetchImpl});
    const first=await service.synthesize({text:'你好。'});assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.director.used,false);assert.ok(net.calls[0].body.includes(Buffer.from('你好。')));assert.equal(net.calls[0].body.includes(Buffer.from('改写了')),false);
    const second=await service.synthesize({text:'你好。'});assert.equal(second.director.used,true);assert.ok(net.calls[1].body.includes(Buffer.from('轻柔地说')));assert.equal(calls,2);assert.equal(net.calls.length,2);
    assert.equal(second.handoff.delivered,false);
  }finally{f.cleanup();}
});

test('cancellation after model work stops before paid provider invocation; disabled director is zero-call',async()=>{
  const f=tempDataDir();try{
    imageSetup(f.dir);const abort=new AbortController();let network=0;
    const service=createMediaService({dataDir:f.dir,host:{available:()=>true,completeText:async()=>{abort.abort();throw abort.signal.reason;}},fetchImpl:async()=>{network++;throw Error('must not send');}});
    assert.equal((await service.generateImage({prompt:'猫',signal:abort.signal})).ok,false);assert.equal(network,0);
    assert.equal((await directSpeech({host:{available(){throw Error('not called');}},text:'你好',config:normalizeConfig({})})).used,false);
  }finally{f.cleanup();}
});

test('host bridge resolves the current default each call and never retries failed generation',async()=>{
  const previous=process.env.DSH_COMPANION_MODULE_ROOT;
  process.env.DSH_COMPANION_MODULE_ROOT=fileURLToPath(new URL('../../companion-foundation/test-fixtures/module-root/',import.meta.url));
  try{
    let route={provider:'first',model:'one'},fail=false;const prepared=[];
    const llm={async prepareCall(selected){
      prepared.push(selected);
      return {config:{},async *stream(){if(fail)throw Error('no retry');yield {type:'text-delta',text:'valid'};}};
    }};
    const ctx={get(name){if(name==='agentDefaultModel')return {currentSelection:()=>route};if(name==='llm')return llm;}};
    const host=createMediaHost(ctx);assert.equal(host.available(),true);
    assert.equal((await host.completeText({system:'s',input:'i',maxTokens:20,timeoutMs:1000})).text,'valid');route={provider:'second',model:'two'};
    await host.completeText({system:'s',input:'i',maxTokens:20,timeoutMs:1000});assert.deepEqual(prepared.map(value=>[value.provider,value.model]),[['first','one'],['second','two']]);
    fail=true;await assert.rejects(host.completeText({system:'s',input:'i',maxTokens:20,timeoutMs:1000}),/no retry/);assert.equal(prepared.length,3);
  }finally{if(previous===undefined)delete process.env.DSH_COMPANION_MODULE_ROOT;else process.env.DSH_COMPANION_MODULE_ROOT=previous;}
});

test('processing configuration validates mode, timeouts and director bounds',()=>{
  for(const raw of [{image:{pipeline:{mode:'invalid'}}},{image:{pipeline:{timeoutMs:0}}},{tts:{director:{maxInstructionChars:0}}}])assert.equal(validateConfig(normalizeConfig(raw)).ok,false);
});
