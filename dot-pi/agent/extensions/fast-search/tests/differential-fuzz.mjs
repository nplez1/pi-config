// Deterministic generated native/fast parity fixtures inside Pi-Bolt, no model.
import {createFindToolDefinition,createGrepToolDefinition} from '@earendil-works/pi-coding-agent';
import {mkdir,writeFile,rm,symlink} from 'node:fs/promises';import path from 'node:path';
import {createFastFindTool,createFastGrepTool} from '../builtin-fast-engine.mjs';
export default pi=>pi.on('session_start',async(_event,ctx)=>{
 const base=process.env.FAST_DIFF_ROOT;let state=0x9e3779b9;const rand=()=>{state=(state*1664525+1013904223)>>>0;return state};const rows=[];
 try{
  const seeds=Number(process.env.FAST_FUZZ_SEEDS||25);if(!Number.isInteger(seeds)||seeds<1||seeds>500)throw new Error('Invalid bounded fuzz seed count');
  for(let seed=0;seed<seeds;seed++){
   const root=path.join(base,`case-${seed}`);await mkdir(root,{recursive:true});if(seed%2===0)await mkdir(path.join(root,'.git','info'),{recursive:true});
   const rules=['*.tmp\n','skip/\n','!keep.txt\n','/anchor.txt\n','*.TXT\n','ignored-?.txt\n','**/nested.tmp\n','[ab]*.txt\n','!beta.txt\n','dir-?/alpha.txt\n','{alpha,beta}.txt\n','\\#literal.txt\n'];
   for(const name of ['.gitignore','.ignore','.fdignore','.rgignore']){let text='';for(const r of rules)if(rand()%3===0)text+=r;if(text)await writeFile(path.join(root,name),text)}
   for(let d=0;d<6;d++){
    const dir=path.join(root,`dir-${d}`);await mkdir(dir,{recursive:true});if(rand()%2===0)await writeFile(path.join(dir,'.ignore'),rand()%2?'*.tmp\n!keep.tmp\n':'ignored-?.txt\n');
    if(d===3&&seed%3===0){await mkdir(path.join(dir,'.git'),{recursive:true});await writeFile(path.join(dir,'.gitignore'),'nested.tmp\n')}
    for(const n of ['alpha.txt','beta.TXT','keep.tmp','nested.tmp','ignored-a.txt','file with space.txt','line\nbreak.txt','café.txt','猫.txt','#literal.txt','AGENTS.md'])await writeFile(path.join(dir,n),n==='AGENTS.md'?'name: docs-search-tool\n':`needle ${seed} ${n}\n`);
   }
   await mkdir(path.join(root,'skip'));await writeFile(path.join(root,'skip','alpha.txt'),'needle\n');await symlink('dir-0',path.join(root,'link-dir'));
   const baseFind=createFindToolDefinition(root),baseGrep=createGrepToolDefinition(root),decisions=[];
   const fastFind=createFastFindTool(root,{onDecision:x=>decisions.push(x),forceExternal:true}),fastGrep=createFastGrepTool(root,{onDecision:x=>decisions.push(x),forceExternal:true});const c={cwd:root};
   const compare=async(kind,args,native,fast)=>{
    const call=async tool=>{try{return{value:await tool.execute('diff',args,undefined,undefined,c)}}catch(e){return{error:String(e.message||e)}}};
    const a=await call(native);decisions.length=0;const b=await call(fast);const equal=JSON.stringify(a)===JSON.stringify(b);rows.push({seed,kind,args,equal,decision:decisions.at(-1),...(equal?{}:{native:a,fast:b})});
   };
   for(const pattern of ['*.txt','*alpha*','**/AGENTS.md','*file*','*skip*','*.{txt,md}'])for(const limit of [2,1000])await compare('find',{pattern,limit},baseFind,fastFind);
   for(const args of [{pattern:'needle',literal:true,glob:'*.txt',limit:100},{pattern:'^name: .*search',glob:'AGENTS.md',limit:100},{pattern:'needle|ordinary',glob:'*.{txt,md}',context:1,limit:100},{pattern:'needle',literal:true,glob:'*.txt',limit:2}])await compare('grep',args,baseGrep,fastGrep);
   await rm(root,{recursive:true,force:true});
  }
  await new Promise((resolve,reject)=>process.stderr.write('BUILTIN_FUZZ='+JSON.stringify(rows)+'\n',error=>error?reject(error):resolve()));
 }catch(error){process.stderr.write('BUILTIN_FUZZ_ERROR='+String(error.stack||error)+'\n')}
 finally{await rm(base,{recursive:true,force:true});ctx.shutdown()}
});
