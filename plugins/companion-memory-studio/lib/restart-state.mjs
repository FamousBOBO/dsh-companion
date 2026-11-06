import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeFileAtomic } from '../../companion-media/src/config-store.mjs';
const bootId=`${process.pid}:${performance.timeOrigin}`;
const fileFor=root=>path.join(root,'tmp','pending-restart.json');
export function restartState(root){
  try{
    const value=JSON.parse(fs.readFileSync(fileFor(root),'utf8'));
    if(value.bootId!==bootId){fs.unlinkSync(fileFor(root));return {pending:false,changes:[]};}
    return {pending:true,since:value.since,changes:value.changes};
  }catch{return {pending:false,changes:[]};}
}
export function markRestart(root,label){
  const previous=restartState(root);
  const changes=[...new Set([...(previous.changes||[]),label])];
  writeFileAtomic(fileFor(root),JSON.stringify({bootId,since:previous.since||Date.now(),changes}));
}
export function requiresRestart(data){
  return data?.restartRequired===true||(Array.isArray(data?.restartRequired)&&data.restartRequired.length>0);
}
