(function(P){
  const {h,ui}=P;
  P.css(`
    .cpx-runtime-controls { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px; }
    .cpx-runtime-control { display:flex;align-items:center;justify-content:space-between;gap:14px;padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1); }
    .cpx-runtime-control h3 { margin:0;font-size:14px; }
    .cpx-runtime-control p { margin:3px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary); }
    .cpx-log-toolbar { display:flex;gap:12px;align-items:center;flex-wrap:wrap; }
    .cpx-live-log { font:12px/1.7 var(--cpx-mono);white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:18px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);max-height:360px;overflow:auto; }
    .cpx-web-frame { width:100%;height:calc(100vh - 190px);min-height:500px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1); }
    .cpx-web-settings { display:grid;grid-template-columns:180px minmax(0,1fr) auto;gap:16px;align-items:end;margin:16px 0; }
    @media(max-width:760px) { .cpx-runtime-controls,.cpx-web-settings {grid-template-columns:1fr;} }
  `);
  function RuntimeSettings(){
    const state=P.useApi(()=>P.api.get('runtime-settings'),[]);
    const [busy,setBusy]=P.useState('');
    const [notice,setNotice]=P.useState('');
    const [error,setError]=P.useState(null);
    const toggle=key=>{
      setBusy(key);setError(null);
      P.api.post('runtime-settings',{patch:{[key]:!state.data.values[key]}}).then(()=>{state.reload();setNotice('已保存，重启套件后生效');},e=>setError(e)).finally(()=>setBusy(''));
    };
    return h(ui.Band,{title:'生活与运行库'},
      state.error?h(ui.ErrorBox,{error:state.error,onRetry:state.reload}):null,
      error?h(ui.ErrorBox,{error}):null,
      notice?h('p',{className:'cpx-muted'},notice):null,
      h('div',{className:'cpx-runtime-controls'},[
        ['enabled','运行库','认知、日程与状态管理'],['planning','自主规划','自动安排日程'],['heartbeat','心跳','定时推进已启用的任务'],['share','分享候选','整理待分享的内容'],
      ].map(([key,label,hint])=>h('div',{className:'cpx-runtime-control',key},
        h('div',null,h('h3',null,label),h('p',null,hint)),
        h('button',{type:'button',className:'cpxp-enable cpx-stable-switch',role:'switch','aria-label':label,'aria-checked':!!state.data?.values?.[key],disabled:!!busy||!state.data,onClick:()=>toggle(key)},h('span',{className:'cpxp-switch-track'}),'启用')))));
  }
  P.css(`
    .cpx-log-console{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;overflow:hidden;background:#101319;color:#dae0eb;}
    .cpx-log-console-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;background:#191e27;border-bottom:1px solid #2b313c;font-size:12px;}
    .cpx-log-connection{display:flex;align-items:center;gap:8px;color:#9ca8bb;}.cpx-log-dot{width:7px;height:7px;border-radius:50%;background:#e5b868;}.cpx-log-dot[data-live=true]{background:#62c99b;box-shadow:0 0 9px #62c99b55;}
    .cpx-log-source{font-family:var(--cpx-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#929eb0;}
    .cpx-log-output{height:420px;min-height:260px;max-height:65vh;overflow:auto;overscroll-behavior:contain;padding:12px 0;font:13px/1.8 var(--cpx-mono);tab-size:2;}
    .cpx-log-row{display:flex;gap:14px;padding:1px 18px 1px 12px;}.cpx-log-row:hover{background:#ffffff06;}.cpx-log-number{flex:none;width:36px;color:#69758a;text-align:right;user-select:none;}.cpx-log-message{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;}.cpx-log-row[data-level=error]{color:#f49b9b;}.cpx-log-row[data-level=warn]{color:#e4c183;}
    .cpx-log-empty{padding:32px 24px;color:#909aab;}.cpx-log-count{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;}.cpx-log-toolbar{margin-bottom:14px;}.cpx-log-toolbar .cmx-input{max-width:280px;}
    .cpx-persona-editor .cmx-textarea{height:320px;min-height:200px;max-height:320px;font-size:14px;line-height:1.8;}.cpx-persona-footer{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:18px;color:var(--dsw-alias-label-secondary);font-size:13px;}
  `);
  function RuntimeLog(){
    const [rows,setRows]=P.useState([]),[source,setSource]=P.useState(''),[status,setStatus]=P.useState('connecting');
    const [paused,setPaused]=P.useState(false),[follow,setFollow]=P.useState(true),[filter,setFilter]=P.useState(''),[refresh,setRefresh]=P.useState(0);
    const output=P.useRef(null),sequence=P.useRef(0);
    P.useEffect(()=>{
      if(paused){setStatus('paused');return;}
      let active=true;
      setStatus('connecting');
      const stream=new EventSource(new URL('api/companion-memory/runtime-logs/stream',document.baseURI));
      stream.addEventListener('ready',()=>{if(active)setStatus('live');});
      stream.addEventListener('logs',event=>{if(!active)return;try{const data=JSON.parse(event.data);setSource(data.source||'');setStatus('live');const next=data.lines.map(text=>({id:++sequence.current,text}));setRows(previous=>(data.reset?next:previous.concat(next)).slice(-2000));}catch{setStatus('error');}});
      stream.addEventListener('log-error',()=>{if(active)setStatus('error');});
      stream.onerror=()=>{if(active)setStatus('reconnecting');};
      return()=>{active=false;stream.close();};
    },[paused,refresh]);
    const visible=rows.filter(row=>!filter||row.text.toLowerCase().includes(filter.toLowerCase()));
    P.useEffect(()=>{if(follow&&output.current)output.current.scrollTop=output.current.scrollHeight;},[rows,filter,follow]);
    const labels={connecting:'正在连接',live:'实时连接',paused:'已暂停',reconnecting:'正在重连',error:'读取异常，正在重试'};
    return h(ui.Band,{title:'后台日志',actions:[h(ui.Button,{key:'refresh',disabled:paused,onClick:()=>setRefresh(value=>value+1)},'重新连接'),h(ui.Button,{key:'pause',onClick:()=>setPaused(!paused)},paused?'继续':'暂停')]},
      h('div',{className:'cpx-log-toolbar'},h(ui.Input,{value:filter,ariaLabel:'筛选日志',placeholder:'筛选日志',onChange:setFilter}),h(ui.Button,{pressed:follow,onClick:()=>setFollow(!follow)},follow?'跟随最新：开':'跟随最新：关'),h(ui.Button,{onClick:()=>setRows([])},'清屏'),h('span',{className:'cpx-log-count'},visible.length+' 行')),
      h('div',{className:'cpx-log-console'},h('div',{className:'cpx-log-console-head'},h('span',{className:'cpx-log-connection',role:'status'},h('span',{className:'cpx-log-dot','data-live':status==='live'}),labels[status]),h('span',{className:'cpx-log-source'},source||'等待运行日志')),
        h('div',{ref:output,className:'cpx-log-output',role:'log','aria-label':'实时后台日志','aria-live':'off',tabIndex:0,onScroll:event=>{const node=event.currentTarget;if(node.scrollHeight-node.scrollTop-node.clientHeight>48&&follow)setFollow(false);}},visible.length?visible.map(row=>h('div',{className:'cpx-log-row',key:row.id,'data-level':/\b(error|exception|failed)\b/i.test(row.text)?'error':/\b(warn|warning)\b/i.test(row.text)?'warn':'info'},h('span',{className:'cpx-log-number','aria-hidden':true},row.id),h('span',{className:'cpx-log-message'},row.text))):h('div',{className:'cpx-log-empty'},filter?'没有匹配的日志':paused?'日志已暂停':'等待新的日志输出…'))));
  }
  function PersonaPage(){
    const state=P.useApi(()=>P.api.get('persona'),[]);
    const [draft,setDraft]=P.useState(''),[revision,setRevision]=P.useState(''),[busy,setBusy]=P.useState(false),[error,setError]=P.useState(null),[notice,setNotice]=P.useState('');
    P.useEffect(()=>{if(state.data){setDraft(state.data.content);setRevision(state.data.revision);}},[state.data]);
    const dirty=!!state.data&&draft!==state.data.content;
    const save=()=>{setBusy(true);setError(null);P.api.post('persona',{content:draft,revision}).then(()=>{setNotice('已保存，重启套件后应用到对话');state.reload();},setError).finally(()=>setBusy(false));};
    return h(ui.Page,{title:'人格',lead:'设定性格、语气与相处方式。',actions:[h(ui.Button,{key:'save',variant:'primary',loading:busy,disabled:!dirty||busy,onClick:save},'保存')]},
      state.error?h(ui.ErrorBox,{error:state.error,onRetry:state.reload}):null,error?h(ui.ErrorBox,{error}):null,notice?h(ui.Callout,{tone:'info',title:notice}):null,
      !state.data?h(ui.Skeleton,{rows:6}):h(ui.Band,{title:'人格设定'},h('div',{className:'cpx-persona-editor'},h(ui.TextArea,{value:draft,onChange:setDraft,ariaLabel:'人格设定',disabled:busy,placeholder:'写下角色的性格、说话方式，以及你们如何相处…'})),h('div',{className:'cpx-persona-footer'},h('span',null,dirty?'有未保存的修改':'已保存'),h('span',null,draft.length+' 字'))));
  }
  function QQWeb(){
    const state=P.useApi(()=>P.api.get('web-panel'),[]);
    const [url,setUrl]=P.useState('');const [provider,setProvider]=P.useState('napcat');const [busy,setBusy]=P.useState('');const [error,setError]=P.useState(null);const [notice,setNotice]=P.useState('');const [frameKey,setFrameKey]=P.useState(0);
    P.useEffect(()=>{if(state.data){setUrl(state.data.url||'');setProvider(state.data.provider||'napcat');}},[state.data]);
    const save=()=>{setBusy('save');setError(null);P.api.post('web-panel',{url,provider}).then(()=>state.reload(),setError).finally(()=>setBusy(''));};
    const control=action=>{setBusy(action);setError(null);setNotice('');P.api.post('web-panel-control',{action}).then(result=>{setNotice(result.running?'服务已就绪':result.pending?'进程已启动，服务正在准备':'启动未完成');setFrameKey(key=>key+1);state.reload();},setError).finally(()=>setBusy(''));};
    const label=state.data?.provider==='snowluma'?'SnowLuma':'NapCat';
    const form=h('div',{className:'cpx-web-settings'},h(ui.Field,{label:'网页面板'},h(ui.Select,{ariaLabel:'网页面板',value:provider,onChange:setProvider,options:[{value:'napcat',label:'NapCat'},{value:'snowluma',label:'SnowLuma'}]})),h(ui.Field,{label:'网页地址'},h(ui.Input,{ariaLabel:'网页地址',value:url,onChange:setUrl,placeholder:'填写已部署的网页地址'})),h(ui.Button,{variant:'primary',loading:busy==='save',disabled:!!busy,onClick:save},'保存'));
    return h(ui.Page,{title:state.data?.configured?label:'QQ 连接',actions:state.data?.configured?[
      h(ui.Badge,{key:'status',tone:state.data.running?'ok':'neutral'},state.data.running?'运行中':state.data.running===false?'未启动':'远端面板'),
      h(ui.Button,{key:'start',variant:'primary',loading:busy==='start',disabled:!!busy||!state.data.canControl,onClick:()=>control('start')},'启动'),
      h(ui.Button,{key:'restart',loading:busy==='restart',disabled:!!busy||!state.data.canControl,onClick:()=>control('restart')},'重启')]:[]},
      state.error?h(ui.ErrorBox,{error:state.error,onRetry:state.reload}):null,error?h(ui.ErrorBox,{error}):null,
      notice?h('p',{className:'cpx-muted',role:'status'},notice):null,
      state.data?.configured?h('details',null,h('summary',null,'面板设置'),form):h(ui.Band,{title:'连接 NapCat 或 SnowLuma'},h('p',{className:'cpx-muted'},'选择面板并填写网页地址。配置仅保存在本机。'),form),
      state.data?.configured?h('iframe',{key:frameKey,className:'cpx-web-frame',title:label+' 网页面板',src:state.data.embedUrl||state.data.url,referrerPolicy:'no-referrer',sandbox:'allow-scripts allow-forms allow-same-origin allow-popups'}):null);
  }
  P.registerPage({id:'persona',label:'人格',order:12,component:PersonaPage});
  P.ui.RuntimeSettings=RuntimeSettings;
  P.ui.RuntimeLog=RuntimeLog;
  P.registerPage({id:'qq-web',label:'QQ 连接',order:15,component:QQWeb});
})(P);
