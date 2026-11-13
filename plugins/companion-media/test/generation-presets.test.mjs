import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaService } from '../src/service.mjs';
import { normalizeConfig } from '../src/schema.mjs';
import { autoResolution } from '../src/resolution.mjs';
import { validateGenerationLibrary } from '../src/generation-presets.mjs';
import { tempDataDir, mockFetch, makePng, makeZip, writeConfig } from './helpers.mjs';

test('named presets survive disk reload without including connection settings', () => {
  const {dir,cleanup}=tempDataDir();
  try {
    const first=createMediaService({dataDir:dir,env:{}});
    const generationPresets=[
      {id:'portrait',name:'竖图',settings:{model:'nai-diffusion-5-full',steps:24,autoResolution:true,aspect:'portrait'},presets:{'5':{positive:'v5',negative:'n5',applyDefaults:true}}},
      {id:'square',name:'方图',settings:{model:'nai-diffusion-4-5-full',steps:28,autoResolution:false,aspect:'square'},presets:{'4.5':{positive:'v45',negative:'n45',applyDefaults:false}}},
    ];
    assert.equal(first.saveConfig({image:{provider:'nai',nai:{generationPresets,activePresetId:'portrait'}}}).ok,true);
    const second=createMediaService({dataDir:dir,env:{}});
    assert.deepEqual(second.readConfig().config.image.nai.generationPresets,generationPresets);
    assert.equal(second.readConfig().config.image.nai.activePresetId,'portrait');
    assert.equal(second.readConfig().config.image.enabled,false);
  } finally {cleanup();}
});

test('preset library refuses credential fields, duplicate IDs and dangling selection',()=>{
  const base=normalizeConfig().image.nai;
  assert.ok(validateGenerationLibrary({...base,generationPresets:[{id:'a',name:'x',settings:{apiKey:'never-store-this'}}]}).length);
  assert.ok(validateGenerationLibrary({...base,activePresetId:'missing'}).length);
  assert.ok(validateGenerationLibrary({...base,generationPresets:[{id:'a',name:'x',settings:{}},{id:'a',name:'y',settings:{}}]}).length);
});

for(const aspect of ['portrait','landscape','square'])test(`auto resolution ${aspect}: dry-run and actual outgoing request agree`,async()=>{
  const {dir,cleanup}=tempDataDir();
  try {
    writeConfig(dir,{schemaVersion:2,image:{enabled:true,provider:'nai',nai:{apiKey:'local-test-key',autoResolution:true,aspect,width:512,height:512}}});
    const expected=autoResolution({aspect});
    const {fetchImpl,calls}=mockFetch([{match:'https://image.novelai.net/ai/generate-image',response:{status:200,bytes:makeZip([{name:'0.png',bytes:makePng(expected)}]),headers:{'content-type':'application/zip'},mime:'application/zip'}}]);
    const service=createMediaService({dataDir:dir,env:{},fetchImpl});
    const dry=await service.generateImage({prompt:'test',dryRun:true});
    assert.equal(dry.ok,true,JSON.stringify(dry));
    assert.equal(dry.resolution.width,expected.width);
    assert.equal(calls.length,0);
    const result=await service.generateImage({prompt:'test'});
    assert.equal(result.ok,true,JSON.stringify(result.error));
    assert.equal(calls.length,1);
    const parameters=JSON.parse(calls[0].body).parameters;
    assert.equal(parameters.width,expected.width);
    assert.equal(parameters.height,expected.height);
    assert.equal(result.artifact.width,expected.width);
  } finally {cleanup();}
});

test('automatic sizing disabled preserves the existing custom dimensions',async()=>{
  const {dir,cleanup}=tempDataDir();
  try {
    writeConfig(dir,{schemaVersion:2,image:{enabled:true,provider:'nai',nai:{apiKey:'local-test-key',autoResolution:false,aspect:'square',width:768,height:1152}}});
    const result=await createMediaService({dataDir:dir,env:{}}).generateImage({prompt:'x',dryRun:true});
    assert.equal(result.resolution.size,'768x1152');
  } finally {cleanup();}
});

for (const aspect of ['portrait', 'landscape', 'square']) test(`per-call LLM aspect ${aspect} overrides auto configuration without saving it`, async () => {
  const {dir, cleanup} = tempDataDir();
  try {
    writeConfig(dir, {schemaVersion:2,image:{enabled:true,provider:'nai',nai:{apiKey:'local-test-key',autoResolution:true,aspect:'portrait',width:512,height:512}}});
    const expected = autoResolution({aspect});
    const {fetchImpl,calls} = mockFetch([{match:'https://image.novelai.net/ai/generate-image',response:{status:200,bytes:makeZip([{name:'0.png',bytes:makePng(expected)}]),headers:{'content-type':'application/zip'},mime:'application/zip'}}]);
    const service = createMediaService({dataDir:dir,env:{},fetchImpl});
    const dry = await service.generateImage({prompt:'test',aspect,dryRun:true});
    assert.equal(dry.resolution.size, `${expected.width}x${expected.height}`);
    const real = await service.generateImage({prompt:'test',aspect});
    assert.equal(real.ok,true,JSON.stringify(real.error));
    const params = JSON.parse(calls[0].body).parameters;
    assert.equal(params.width,expected.width);
    assert.equal(params.height,expected.height);
    const fallback = await service.generateImage({prompt:'test',dryRun:true});
    assert.equal(fallback.resolution.size,'832x1216');
  } finally {cleanup();}
});

test('invalid LLM aspect refuses before network; fixed dimensions remain authoritative',async()=>{
  const {dir,cleanup}=tempDataDir();
  try {
    writeConfig(dir,{schemaVersion:2,image:{enabled:true,provider:'nai',nai:{apiKey:'local-test-key',autoResolution:false,width:768,height:1152}}});
    const service=createMediaService({dataDir:dir,env:{},fetchImpl:()=>{throw Error('unexpected network');}});
    const bad=await service.generateImage({prompt:'test',aspect:'invalid'});
    assert.equal(bad.error.code,'MEDIA_BAD_INPUT');
    const fixed=await service.generateImage({prompt:'test',aspect:'landscape',dryRun:true});
    assert.equal(fixed.resolution.size,'768x1152');
  } finally {cleanup();}
});
