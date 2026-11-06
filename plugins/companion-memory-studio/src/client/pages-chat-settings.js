(function(P){
  const {h,ui}=P;
  P.css(`
    .cpx-system-restart{position:sticky;top:0;z-index:90;flex:none;padding:14px 24px;background:var(--dsw-alias-bg-layer-2);border-bottom:2px solid #d8a653;box-shadow:0 4px 18px #0002;color:var(--dsw-alias-label-primary);font-size:14px;}
    .cpx-system-restart strong{display:block;margin-bottom:3px;}.cpx-system-restart p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;}
    .cpx-chat-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;}.cpx-chat-settings>*{min-width:0;}.cpx-chat-wide{grid-column:1/-1;}.cpx-chat-settings .cpx-field-label{min-height:23px;}.cpx-chat-summary{display:flex;align-items:center;gap:12px;margin-bottom:24px;color:var(--dsw-alias-label-secondary);font-size:13px;}
    .cpx-quiet-row{display:flex;gap:12px;align-items:center;margin-bottom:10px;}.cpx-quiet-row input{min-width:0;flex:1;max-width:160px;}.cpx-quiet-row .cmx-btn{flex:none;}
    @media(max-width:900px){.cpx-chat-settings{grid-template-columns:1fr;}.cpx-system-restart{padding:12px 16px;}}
  `);
  function RestartNotice(){
    const state=P.useApi(()=>P.api.get('restart-status'),[]);
    P.useEffect(()=>{const reload=()=>state.reload();window.addEventListener('companion:restart-required',reload);const timer=setInterval(reload,5000);return()=>{clearInterval(timer);window.removeEventListener('companion:restart-required',reload);};},[]);
    if(!state.data?.pending)return null;
    return h('div',{className:'cpx-system-restart',role:'alert','aria-label':'设置待重启'},h('strong',null,'设置已保存，尚未重启，部分设置未生效'),h('p',null,(state.data.changes||[]).join('、')+' · 重启套件后生效'));
  }
  P.ui.RestartNotice=RestartNotice;
  const cache={revision:'',draft:{}};
  function ChatSettings(){
    const state=P.useApi(()=>P.api.get('chat-settings'),[]);
    const [draft,setDraft]=P.useState({}),[tab,setTab]=P.useState('reply'),[busy,setBusy]=P.useState(false),[error,setError]=P.useState(null),[notice,setNotice]=P.useState('');
    P.useEffect(()=>{if(!state.data)return;const initial=Object.fromEntries(state.data.fields.map(field=>[field.path,field.value]));if(cache.revision!==state.data.revision){cache.revision=state.data.revision;cache.draft=initial;}setDraft({...cache.draft});},[state.data]);
    const change=(path,value)=>setDraft(previous=>{const next={...previous,[path]:value};cache.draft=next;return next;});
    const fields=state.data?.fields||[];
    const changed=fields.filter(field=>JSON.stringify(draft[field.path])!==JSON.stringify(field.value));
    const save=async()=>{
      setBusy(true);setError(null);
      try{
        const patch={};for(const field of changed){let value=draft[field.path];if(field.kind==='json'&&typeof value==='string')value=JSON.parse(value);patch[field.path]=value;}
        const result=await P.api.post('chat-settings',{patch,revision:state.data.revision});
        setNotice(result.restartRequired?.length?'已保存，待重启后加载':'已保存并应用');cache.revision='';state.reload();
      }catch(error){setError(error instanceof SyntaxError?new Error('结构化设置需要填写有效 JSON'):error);}finally{setBusy(false);}
    };
    const isReply=field=>field.page==='messages';
    const isGroup=field=>field.page==='groups';
    const isContact=field=>field.page==='proactive';
    const visible=fields.filter(field=>tab==='all'||(tab==='reply'?isReply(field):tab==='groups'?isGroup(field):tab==='contact'?isContact(field):!isReply(field)&&!isGroup(field)&&!isContact(field)));
    const groups=[...new Set(visible.map(field=>field.group))];
    const renderField=field=>{
      const value=draft[field.path],onChange=value=>change(field.path,value);
      const info=(field.help||'').replace(/\*\*|`/g,'');
      let control;
      if(field.kind==='boolean')control=h('button',{type:'button',className:'cpxp-enable',role:'switch','aria-label':field.label,'aria-checked':value===true,disabled:busy,onClick:()=>onChange(value!==true)},h('span',{className:'cpxp-switch-track'}),'启用');
      else if(field.kind==='enum')control=h(ui.Select,{value,ariaLabel:field.label,disabled:busy,options:field.options||[],onChange});
      else if(field.path==='contact.quietHours'){
        const rows=Array.isArray(value)?value:[];
        control=h('div',null,rows.map((row,index)=>h('div',{key:index,className:'cpx-quiet-row'},h('input',{type:'time',className:'cmx-input','aria-label':'免打扰开始 '+(index+1),value:row.from,onChange:event=>onChange(rows.map((r,i)=>i===index?{...r,from:event.target.value}:r))}),h('span',null,'至'),h('input',{type:'time',className:'cmx-input','aria-label':'免打扰结束 '+(index+1),value:row.to,onChange:event=>onChange(rows.map((r,i)=>i===index?{...r,to:event.target.value}:r))}),h(ui.Button,{disabled:busy,onClick:()=>onChange(rows.filter((_,i)=>i!==index))},'移除'))),h(ui.Button,{disabled:busy,onClick:()=>onChange(rows.concat({from:'23:00',to:'08:00'}))},'添加免打扰时段'));
      }else if(field.kind==='json')control=h(ui.TextArea,{ariaLabel:field.label,value:typeof value==='string'?value:JSON.stringify(value,null,2),onChange,disabled:busy});
      else if(field.kind==='list')control=h(ui.Input,{ariaLabel:field.label,value:Array.isArray(value)?value.join(', '):'',disabled:busy,onChange:text=>onChange(text.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean).map(x=>field.itemsKind==='number'?Number(x):x))});
      else control=h(ui.Input,{type:field.kind==='number'?'number':'text',ariaLabel:field.label,value:value??'',disabled:busy,onChange:text=>onChange(field.kind==='number'?(text===''?null:Number(text)):text)});
      return h('div',{key:field.path,className:field.kind==='json'?'cpx-chat-wide':''},h(ui.Field,{label:field.label,info},control));
    };
    return h(ui.Page,{title:'聊天设置',lead:'调整回复节奏、群聊行为和免打扰。',actions:[h(ui.Button,{key:'save',variant:'primary',loading:busy,disabled:busy||!changed.length,onClick:save},'保存'),h(ui.Button,{key:'reload',disabled:busy||!!changed.length,onClick:state.reload},'重新读取')]},
      state.error?h(ui.ErrorBox,{error:state.error,onRetry:state.reload}):null,error?h(ui.ErrorBox,{error}):null,
      notice?h(ui.Callout,{tone:'info',title:notice}):null,
      !state.data?h(ui.Skeleton,{rows:6}):[
        h('div',{key:'summary',className:'cpx-chat-summary'},h(ui.Badge,{tone:state.data.live?'ok':'neutral'},state.data.live?'通道运行中':'通道未加载'),h('span',null,state.data.live?'支持热更新的设置保存即应用':'保存的设置将在通道启用并重启后加载')),
        h(ui.Segmented,{key:'tabs',label:'聊天设置分类',value:tab,onChange:setTab,options:[{id:'reply',label:'回复设置'},{id:'groups',label:'群聊行为'},{id:'contact',label:'主动与免打扰'},{id:'advanced',label:'会话设置'},{id:'all',label:'全部'}]}),
        ...groups.map(group=>h(ui.Band,{key:group,title:visible.find(f=>f.group===group).groupLabel},h('div',{className:'cpx-chat-settings'},visible.filter(field=>field.group===group).map(renderField)))),
      ]);
  }
  P.registerPage({id:'chat',label:'聊天',order:11,component:ChatSettings});
})(P);
