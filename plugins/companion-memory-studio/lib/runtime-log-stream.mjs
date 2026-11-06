import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Tail only the suite's own console output. No browser-supplied filesystem paths.
export function createLogStream(root,{signal,sanitize,pollMs=250}={}) {
  let cleanup=()=>{};
  return new ReadableStream({
    start(controller) {
      let timer,keepalive,closed=false,source=null,identity='',offset=0,pending='',discard=false;
      let decoder=new StringDecoder('utf8');
      const encoder=new TextEncoder();
      const send=(event,data)=>{if(!closed)controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));};
      cleanup=()=>{if(closed)return;closed=true;clearInterval(timer);clearInterval(keepalive);signal?.removeEventListener('abort',abort);};
      const abort=()=>{cleanup();try{controller.close();}catch{}};
      const tick=()=>{
        if(closed||controller.desiredSize<=0)return;
        try {
          const dir=path.join(root,'logs');
          const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(file=>/^start-.*\.log$/.test(file)).sort():[];
          const latest=files.at(-1);
          if(!latest){if(source!==null){source=null;send('logs',{reset:true,source:null,lines:[]});}return;}
          const file=path.join(dir,latest);const stat=fs.statSync(file);
          const nextIdentity=`${latest}:${stat.ino}:${stat.birthtimeMs}`;
          const reset=identity!==nextIdentity||stat.size<offset;
          if(reset){source=latest;identity=nextIdentity;offset=Math.max(0,stat.size-65536);discard=offset>0;pending='';decoder=new StringDecoder('utf8');}
          if(stat.size===offset){if(reset)send('logs',{reset:true,source,lines:[]});return;}
          const count=Math.min(stat.size-offset,65536);const bytes=Buffer.alloc(count);const fd=fs.openSync(file,'r');
          let read;try{read=fs.readSync(fd,bytes,0,count,offset);}finally{fs.closeSync(fd);}
          offset+=read;pending+=decoder.write(bytes.subarray(0,read));
          const complete=pending.split('\n');pending=complete.pop();
          if(discard&&complete.length){complete.shift();discard=false;}
          if(pending.length>65536){pending='';discard=true;}
          const lines=complete.map(line=>sanitize(line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'')).slice(0,8192)).filter(Boolean);
          if(lines.length||reset)send('logs',{reset,source,lines:reset?lines.slice(-250):lines,at:Date.now()});
        }catch{send('log-error',{message:'日志暂时无法读取，正在重试'});}
      };
      send('ready',{at:Date.now()});tick();
      timer=setInterval(tick,pollMs);timer.unref?.();
      keepalive=setInterval(()=>{if(!closed&&controller.desiredSize>0)controller.enqueue(encoder.encode(': keepalive\n\n'));},10000);keepalive.unref?.();
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    },
    cancel(){cleanup();},
  });
}
