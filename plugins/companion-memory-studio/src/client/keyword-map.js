(function(P){
  const {h,ui}=P;
  P.css(`
    .cpx-keymap{position:relative;min-width:0;}.cpx-keymap-help{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;margin:0 0 16px;}.cpx-keymap-head{display:grid;grid-template-columns:1fr 48px 1fr;font-size:12px;margin-bottom:10px;color:var(--dsw-alias-label-secondary);}.cpx-keymap-head span:last-child{grid-column:3;}
    .cpx-keymap-group{display:grid;grid-template-columns:minmax(0,1fr) 48px minmax(0,1fr);align-items:center;padding:16px 12px;margin-bottom:12px;border:1px solid var(--dsw-alias-border-primary,#73737a55);border-radius:12px;background:var(--dsw-alias-bg-layer-2);min-width:0;}
    .cpx-keymap-words{min-width:0;}.cpx-keymap-word{height:44px;margin-bottom:12px;display:flex;align-items:center;gap:6px;position:relative;}.cpx-keymap-word:last-child{margin-bottom:0;}.cpx-keymap-word input{width:100%;min-width:0;padding-right:4px;}.cpx-keymap-remove{flex:none;background:none;color:var(--dsw-alias-label-secondary);border:0;cursor:pointer;padding:4px;}
    .cpx-keymap-port{position:absolute;width:14px;height:14px;border-radius:50%;padding:0;border:2px solid var(--dsw-alias-bg-layer-1,#191c23);background:#b48da7;cursor:crosshair;z-index:2;}.cpx-keymap-word .cpx-keymap-port{right:-7px;}.cpx-keymap-port[aria-pressed=true]{outline:3px solid #dca2c5;}.cpx-keymap-port:focus-visible{outline:3px solid #64a9ed;}.cpx-keymap-lines{width:48px;overflow:visible;pointer-events:none;}.cpx-keymap-lines path{fill:none;stroke:#b48da7;stroke-width:2;opacity:.8;}
    .cpx-keymap-reaction{position:relative;min-width:0;}.cpx-keymap-reaction>.cpx-keymap-port{left:-7px;top:50%;transform:translateY(-50%);}.cpx-keymap-reaction textarea{width:100%;min-height:76px;max-height:180px;resize:vertical;box-sizing:border-box;}.cpx-keymap-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:8px;flex-wrap:wrap;}.cpx-keymap-actions .cmx-btn{font-size:12px;}.cpx-keymap-preview{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:200;}.cpx-keymap-preview line{stroke:#dca2c5;stroke-width:3;stroke-dasharray:6 4;}
    @media(max-width:650px){.cpx-keymap-group,.cpx-keymap-head{grid-template-columns:minmax(0,1fr) 32px minmax(0,1fr);}.cpx-keymap-lines{width:32px;}.cpx-keymap-group{padding:12px 8px;}}
  `);
  function merge(rows){
    const result=[];
    for(const row of rows){const found=row.reaction.trim()&&result.find(item=>item.reaction.trim()===row.reaction.trim());if(found)found.keywords.push(...row.keywords);else result.push({keywords:[...row.keywords],reaction:row.reaction});}
    return result;
  }
  function KeywordMap({value,onChange,disabled}){
    const rows=Array.isArray(value)?value:[];
    const [selected,setSelected]=P.useState(null),[wire,setWire]=P.useState(null);
    const update=fn=>{const next=rows.map(row=>({keywords:[...row.keywords],reaction:row.reaction}));fn(next);onChange(next);};
    const connect=(target,source=selected)=>{
      if(!source||!rows[source.group]?.keywords[source.word]&&rows[source.group]?.keywords[source.word]!=='')return;
      if(target!==source.group)update(next=>{const [word]=next[source.group].keywords.splice(source.word,1);next[target].keywords.push(word);});
      setSelected(null);setWire(null);
    };
    return h('div',{className:'cpx-keymap'},
      h('p',{className:'cpx-keymap-help'},'从关键词右侧圆点拖线到反应左侧圆点，也可以依次点击两个圆点。连接同一反应的关键词会自动归到一起。'),
      h('div',{className:'cpx-keymap-head'},h('span',null,'关键词'),h('span',null,'反应提示')),
      rows.map((row,group)=>{
        const height=Math.max(1,row.keywords.length)*56-12;
        return h('div',{key:group,className:'cpx-keymap-group'},
          h('div',{className:'cpx-keymap-words'},row.keywords.map((word,index)=>h('div',{key:index,className:'cpx-keymap-word'},
            h('input',{className:'cmx-input',value:word,maxLength:100,disabled,'aria-label':`反应 ${group+1} 的关键词 ${index+1}`,onChange:event=>update(next=>{next[group].keywords[index]=event.target.value;})}),
            h('button',{type:'button',className:'cpx-keymap-remove',disabled,'aria-label':`移除关键词 ${group+1}-${index+1}`,onClick:()=>{setSelected(null);update(next=>{next[group].keywords.splice(index,1);});}},'×'),
            h('button',{type:'button',className:'cpx-keymap-port',disabled,draggable:!disabled,'aria-label':`连接关键词 ${group+1}-${index+1}`,'aria-pressed':selected?.group===group&&selected?.word===index,
              onClick:()=>setSelected({group,word:index}),
              onDragStart:event=>{const source={group,word:index};event.dataTransfer.setData('text/x-companion-keyword',JSON.stringify(source));event.dataTransfer.effectAllowed='move';setSelected(source);setWire({x1:event.clientX,y1:event.clientY,x2:event.clientX,y2:event.clientY});},
              onDrag:event=>{if(event.clientX||event.clientY)setWire(previous=>previous?{...previous,x2:event.clientX,y2:event.clientY}:null);},onDragEnd:()=>setWire(null)}),
          )),!row.keywords.length?h('span',{className:'cpx-muted'},'拖入关键词或添加一项'):null),
          h('svg',{className:'cpx-keymap-lines',height,viewBox:`0 0 48 ${height}`,'aria-hidden':true},row.keywords.map((word,index)=>h('path',{key:index,d:`M 0 ${index*56+22} C 24 ${index*56+22}, 24 ${height/2}, 48 ${height/2}`}))),
          h('div',{className:'cpx-keymap-reaction'},
            h('button',{type:'button',className:'cpx-keymap-port',disabled,'aria-label':`连接到反应 ${group+1}`,onClick:()=>connect(group),onDragOver:event=>{event.preventDefault();event.dataTransfer.dropEffect='move';},onDrop:event=>{event.preventDefault();try{connect(group,JSON.parse(event.dataTransfer.getData('text/x-companion-keyword')));}catch{setWire(null);}}}),
            h('textarea',{className:'cmx-input cmx-textarea',value:row.reaction,maxLength:2000,disabled,'aria-label':`反应提示 ${group+1}`,placeholder:'例如：先安慰，再问问发生了什么',onChange:event=>update(next=>{next[group].reaction=event.target.value;}),onBlur:()=>{setSelected(null);onChange(merge(rows));}}),
            h('div',{className:'cpx-keymap-actions'},h(ui.Button,{disabled,onClick:()=>update(next=>{next[group].keywords.push('');})},'添加关键词'),h(ui.Button,{disabled,onClick:()=>{setSelected(null);onChange(rows.filter((_,index)=>index!==group));}},'删除反应')),
          ),
        );
      }),
      h(ui.Button,{disabled,onClick:()=>onChange(rows.concat({keywords:[''],reaction:''}))},'添加反应'),
      wire?h('svg',{className:'cpx-keymap-preview','aria-hidden':true},h('line',wire)):null,
    );
  }
  P.ui.KeywordMap=KeywordMap;
})(P);
