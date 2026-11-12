import catalog from './official-nai-presets.json' with {type:'json'};
import { resolvePreset } from './presets.mjs';

export function modelPresetKey(model) {
  const family=String(model).startsWith('nai-diffusion-5')?'5':'4.5';
  return family+'-'+(String(model).endsWith('-curated')?'curated':'full');
}
export function officialOptions(model) {
  const key=modelPresetKey(model);
  return {
    quality:[{value:'none',label:'None',tags:''},{value:'standard',label:'Standard',tags:catalog.quality[key.startsWith('5-')?'5-standard':key]},...(key.startsWith('5-')?[{value:'light',label:'Light',tags:catalog.quality['5-light']}]:[]),{value:'legacy',label:'Legacy',tags:null}],
    negative:[{value:'none',label:'None',tags:''},...Object.entries(catalog.negative[key]||{}).map(([value,tags])=>({value,label:({heavy:'Heavy',light:'Light',human:'Human Focus',furry:'Furry Focus'})[value],tags})),{value:'legacy',label:'Legacy',tags:null}],
  };
}
export function resolveNaiPrompt(section,request={}) {
  const legacy=resolvePreset({model:section.model,presets:section.presets,negativePrompt:section.negativePrompt,artistString:section.artistString,request});
  const key=modelPresetKey(section.model);
  const quality=section.qualityPreset??'legacy';
  const negative=section.negativePreset??'legacy';
  const suffix=quality==='none'||quality==='legacy'?'':catalog.quality[key.startsWith('5-')?'5-'+quality:key];

  return {...legacy,
    positive:[legacy.positive,suffix].map(x=>String(x??'').trim()).filter(Boolean).join(', '),
    negative:negative==='legacy'?legacy.negative:[negative==='none'?'':catalog.negative[key]?.[negative],section.negativePrompt,request.negative].map(x=>String(x??'').trim()).filter(Boolean).join(', '),
  };
}
