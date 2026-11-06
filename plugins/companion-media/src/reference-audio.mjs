import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sniffAudio } from './media-format.mjs';
import { Code,mediaError } from './errors.mjs';

export async function storeReference({dataDir,id,bytes,section,net,key=''}) {
  if(!['breeze-tts2','gpt-sovits'].includes(id))throw mediaError(Code.BAD_INPUT,'这个语音服务不使用参考音频文件');
  if(!bytes.length||bytes.length>16*1024*1024)throw mediaError(Code.TOO_LARGE,'参考音频需小于16MB');
  const audio=sniffAudio(bytes);
  if(!audio)throw mediaError(Code.UNSUPPORTED_TYPE,'请选择有效的 WAV、MP3、OGG 或 FLAC 音频');
  if(id==='gpt-sovits') {
    const url=String(section.baseUrl).replace(/\/+$/,'')+'/reference-audio';
    const response=await net.request(url,{method:'POST',headers:{'content-type':audio.mime,...(key?{Authorization:'Bearer '+key}:{})},body:bytes,maxBytes:8192,timeoutMs:30000});
    if(!response.ok)throw mediaError(Code.BAD_INPUT,'远程服务没有接收参考音频。请配置参考音频桥接服务，或填写远端已有文件的路径。');
    let reply;try{reply=JSON.parse(response.bytes.toString('utf8'));}catch{throw mediaError(Code.BAD_INPUT,'远程上传没有返回文件路径');}
    if(typeof reply.path!=='string'||!reply.path.trim()||reply.path.length>2048)throw mediaError(Code.BAD_INPUT,'远程上传没有返回有效文件路径');
    return {ok:true,path:reply.path,format:audio.format,location:'remote'};
  }
  const folder=path.join(dataDir,'media','references');fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,crypto.randomBytes(16).toString('hex')+'.'+audio.format);
  fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});
  return {ok:true,path:file,format:audio.format,location:'local'};
}
