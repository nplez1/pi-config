// Same-name search overrides for Pi's built-in find and grep.
import {createFastFindTool,createFastGrepTool,fastSearchEnabled} from './builtin-fast-engine.mjs';
export default pi=>{
 pi.on('session_start',async(_event,ctx)=>{
  if(!fastSearchEnabled())return;
  const active=new Set(pi.getActiveTools()),all=pi.getAllTools();
  if(!['find','grep'].some(name=>active.has(name)&&all.find(x=>x.name===name)?.sourceInfo?.source==='builtin'))return;
  for(const [name,make] of [['find',createFastFindTool],['grep',createFastGrepTool]]){
   const current=all.find(x=>x.name===name);
   // Never replace another extension's custom/remote/sandbox tool.
   if(!active.has(name)||current?.sourceInfo?.source!=='builtin')continue;
   const onDecision=process.env.PI_FAST_SEARCH_TRACE === '1' ? value=>process.stderr.write('FAST_SEARCH_DECISION='+JSON.stringify({name,backend:value.backend})+'\n') : undefined;
   pi.registerTool(make(ctx.cwd,{onDecision}));
  }
 });
};
