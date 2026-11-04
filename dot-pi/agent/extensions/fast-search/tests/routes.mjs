// Executed inside Pi-Bolt by routes.py; compares auto-routing and native results.
import {createFindToolDefinition,createGrepToolDefinition} from '@earendil-works/pi-coding-agent';
import {createFastFindTool,createFastGrepTool} from '../builtin-fast-engine.mjs';import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';
export default pi=>pi.on('session_start',async(_event,ctx)=>{
 try{
  const root=process.env.FAST_ROUTE_ROOT,small=path.join(root,'small'),repo=path.join(root,'repo'),broad=path.join(root,'broad');
  for(const d of [small,repo,broad])await mkdir(d,{recursive:true});await mkdir(path.join(repo,'.git'));
  for(const n of ['one','two','three','four','five'])for(const parent of [repo,broad])await mkdir(path.join(parent,n));
  for(const d of [small,repo,path.join(broad,'one')])await writeFile(path.join(d,'needle.txt'),'needle\n');
  const decisions=[],attempts=[];const opts={onDecision:x=>decisions.push(x),onAttempt:x=>attempts.push(x),forceExternal:true};const fast={find:createFastFindTool(root,opts),grep:createFastGrepTool(root,opts)};
  const native={find:createFindToolDefinition(root),grep:createGrepToolDefinition(root)},results=[];
  for(const [name,target] of [['small',small],['repo',repo],['broad',broad]])for(const kind of ['find','grep']){
   const args=kind==='find'?{path:target,pattern:'*.txt',limit:100}:{path:target,pattern:'needle',literal:true,glob:'*.txt',limit:100};
   decisions.length=0;attempts.length=0;const actual=await fast[kind].execute('fast',args,undefined,undefined,{cwd:root}),expected=await native[kind].execute('native',args,undefined,undefined,{cwd:root});
   results.push({name,kind,equal:JSON.stringify(actual)===JSON.stringify(expected),decision:decisions.at(-1),attempted:attempts.slice()});
  }
  await writeFile(process.env.FAST_ROUTE_OUT,JSON.stringify({results})+'\n');
 }catch(error){await writeFile(process.env.FAST_ROUTE_OUT,JSON.stringify({error:String(error.stack||error)})+'\n')}
 finally{ctx.shutdown()}
});
