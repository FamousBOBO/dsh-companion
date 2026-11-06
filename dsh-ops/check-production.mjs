import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './paths.mjs';
const log=fs.readFileSync(path.join(suite,'data/logs/production-host.log'),'utf8');
const currentStartup=log.slice(log.lastIndexOf('Production Node host started'));
const matches=[...currentStartup.matchAll(/dsh web:\s*(http:\/\/127\.0\.0\.1:3100\/\?token=\S+)/g)];
if(!matches.length)throw Error('No production URL');
const url=new URL(matches.at(-1)[1]);
function request(target,cookie='') {return new Promise((resolve,reject)=>{
  const req=http.get(target,{headers:cookie?{cookie}:{}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});
  req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('HTTP timeout')));
});}
const connect=new URL('/connect',url);connect.search=url.search;connect.searchParams.set('interactions','none');
const auth=await request(connect);
const cookie=(auth.headers['set-cookie']||[]).map(v=>v.split(';')[0]).join('; ');
if(!cookie)throw Error(`Authentication did not issue a cookie (${auth.status})`);
const results=[];
let browserCookie=cookie;
for(const pathname of ['/','/api/companion-memory/summary','/api/companion-memory/companion']){
 let target=pathname==='/'?url:new URL(pathname,url);
 let r;
 for(let attempt=0;attempt<5;attempt++){
   r=await request(target,browserCookie);
   const jar=new Map(browserCookie.split('; ').filter(Boolean).map(c=>[c.split('=')[0],c]));
   for(const value of r.headers['set-cookie']||[]){const c=value.split(';')[0];jar.set(c.split('=')[0],c);}
   browserCookie=[...jar.values()].join('; ');
   if(![301,302,303,307,308].includes(r.status)||!r.headers.location)break;
   target=new URL(r.headers.location,target);
   if(target.origin!==url.origin)throw Error('Unexpected cross-origin redirect');
 }
 let ok=r.status===200;
 if(pathname.startsWith('/api/')){try{const parsed=JSON.parse(r.body);if(parsed.ok===false||parsed.error)ok=false;}catch{ok=false;}}
 results.push({path:pathname,status:r.status,ok});
}
const report={at:new Date().toISOString(),authenticated:true,results,ok:results.every(r=>r.ok)};
const latest=log.slice(log.lastIndexOf('Production Node host started'));
report.pluginActivationClean=!/entries? did not activate|failed to import|pending \(waiting for service/.test(latest);
report.ok=report.ok&&report.pluginActivationClean;
fs.writeFileSync(path.join(suite,'data/logs/production-health.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(!report.ok)process.exitCode=1;
