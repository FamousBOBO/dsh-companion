import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveNaiPrompt,officialOptions } from '../src/official-prompts.mjs';
import { createMediaService } from '../src/service.mjs';
import { createMediaHandlers,API_PREFIX } from '../src/http-api.mjs';
import { tempDataDir,makeWav,mockFetch,writeConfig } from './helpers.mjs';

test('explicit Light quality preset applies without injecting identity or clothing',()=>{
  const options=officialOptions('nai-diffusion-5-full');
  assert.equal(options.quality.find(x=>x.value==='standard').label,'Standard');
  assert.match(options.quality.find(x=>x.value==='standard').tags,/masterpiece/);
  assert.equal(options.negative.find(x=>x.value==='human').label,'Human Focus');
  assert.match(options.negative.find(x=>x.value==='human').tags,/bad anatomy/);
  const section={model:'nai-diffusion-5-full',qualityPreset:'light',negativePreset:'light',artistString:'artist',negativePrompt:'custom negative'};
  const value=resolveNaiPrompt(section,{prompt:'subject',negative:'request negative'});
  assert.match(value.positive,/^artist, subject, /);
  assert.match(value.positive,/amazing quality/);
  assert.match(value.negative,/custom negative, request negative$/);
  assert.equal(officialOptions('nai-diffusion-4-5-curated').negative.some(x=>x.value==='furry'),false);
  const off=resolveNaiPrompt({...section,qualityPreset:'none',negativePreset:'none'},{prompt:'subject'});
  assert.equal(off.positive,'artist, subject');
  assert.equal(off.negative,'custom negative');
});
test('legacy negative presets remain effective; positive presets are not injected',()=>{
  const value=resolveNaiPrompt({model:'nai-diffusion-5-full',qualityPreset:'legacy',negativePreset:'legacy',presets:{'5':{applyDefaults:true,positive:'custom old positive',negative:'custom old negative'}}},{prompt:'subject'});
  assert.equal(value.positive,'subject');
  assert.equal(value.negative,'custom old negative');
});
test('Breeze reference upload stores validated bytes and does not call the service',async()=>{
  const {dir,cleanup}=tempDataDir();
  try {
    const {fetchImpl,calls}=mockFetch([]);
    const service=createMediaService({dataDir:dir,env:{},fetchImpl});
    const bytes=makeWav();
    const result=await service.uploadReference({id:'breeze-tts2',bytes});
    assert.equal(result.location,'local');assert.deepEqual(fs.readFileSync(result.path),bytes);assert.equal(calls.length,0);
    await assert.rejects(()=>service.uploadReference({id:'breeze-tts2',bytes:Buffer.from('not audio')}),/有效/);
  }finally{cleanup();}
});
test('GPT-SoVITS upload uses the remote receipt path, including through a local tunnel',async()=>{
  const {dir,cleanup}=tempDataDir();
  try {
    writeConfig(dir,{schemaVersion:2,tts:{providers:{'gpt-sovits':{baseUrl:'http://127.0.0.1:9881'}}}});
    const {fetchImpl,calls}=mockFetch([{match:'http://127.0.0.1:9881/reference-audio',response:{status:200,json:{path:'/server/audio/reference.wav'}}}]);
    const service=createMediaService({dataDir:dir,env:{},fetchImpl});
    const result=await service.uploadReference({id:'gpt-sovits',bytes:makeWav()});
    assert.equal(result.location,'remote');assert.equal(result.path,'/server/audio/reference.wav');assert.equal(calls.length,1);
    assert.ok(Buffer.isBuffer(calls[0].body));
  }finally{cleanup();}
});
test('upload route rejects foreign origins, unsupported providers and non-audio',async()=>{
  const {dir,cleanup}=tempDataDir();
  try {
    const handlers=createMediaHandlers(createMediaService({dataDir:dir,env:{}}));
    const handler=handlers[`POST ${API_PREFIX}/reference-audio`];
    const foreign=await handler(new Request('http://localhost/api/companion-media/reference-audio?provider=breeze-tts2',{method:'POST',body:makeWav(),headers:{origin:'https://foreign.example'}}));
    assert.equal(foreign.status,403);
    const bad=await handler(new Request('http://localhost/api/companion-media/reference-audio?provider=breeze-tts2',{method:'POST',body:'not an audio file'}));
    assert.equal(bad.status,415);
  }finally{cleanup();}
});
