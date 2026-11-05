// Same-name search overrides for the supported Pi native-search version.
import {createFastFindTool,createFastGrepTool,supportedRuntime} from './builtin-fast-engine.mjs';
export default pi=>{
 pi.on('session_start',async(_event,ctx)=>{
  if(process.env.PI_FAST_SEARCH_BACKEND==='native')return;
  const active=new Set(pi.getActiveTools()),all=pi.getAllTools();
  if(!['find','grep'].some(name=>active.has(name)&&all.find(x=>x.name===name)?.sourceInfo?.source==='builtin'))return;
  // The compatibility rules mirror the reviewed Pi 1.4.0 and 1.5.0 native search semantics.
  if(!await supportedRuntime()){
   try{ctx.ui?.notify?.('Fast search: unsupported Pi search version; retaining original built-in tools.','warning')}catch{}
   return;
  }
  for(const [name,make] of [['find',createFastFindTool],['grep',createFastGrepTool]]){
   const current=all.find(x=>x.name===name);
   // Never replace another extension's custom/remote/sandbox tool.
   if(!active.has(name)||current?.sourceInfo?.source!=='builtin')continue;
   const onDecision=process.env.PI_FAST_SEARCH_TRACE === '1' ? value=>process.stderr.write('FAST_SEARCH_DECISION='+JSON.stringify({name,backend:value.backend})+'\n') : undefined;
   pi.registerTool(make(ctx.cwd,{onDecision}));
  }
 });
};
