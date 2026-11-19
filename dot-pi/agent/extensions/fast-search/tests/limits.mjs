// Executed inside Pi-Bolt by probe-limits.mjs: the find result-limit boundary.
//
// Pi 1.5.0 reported the limit when exactly `limit` files matched; 1.5.1 fixed
// that comparison, so 1.5.2 asks a custom glob operation for `limit + 1` entries
// and reports the limit only when it gets more than `limit`. The fast find path
// must hand native exactly that: a list cut to `limit` makes native's comparison
// never fire, and the notice silently disappears.
//
// `forceExternal` runs the accelerated path directly instead of racing native,
// so a `fd` winner proves the result came from the fast path rather than from
// native having finished first.
import {createFindToolDefinition} from '@earendil-works/pi-coding-agent';
import {createFastFindTool} from '../builtin-fast-engine.mjs';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';

const LIMITS=[0,1,2,3,4,5,6];
const COUNTS=[1,3,5];

export default pi=>pi.on('session_start',async(_event,ctx)=>{
 const rows=[];
 try{
  const base=process.env.FAST_LIMIT_ROOT;
  await rm(base,{recursive:true,force:true});
  for(const count of COUNTS){
   const dir=path.join(base,'n'+count);await mkdir(dir,{recursive:true});
   for(let i=0;i<count;i++)await writeFile(path.join(dir,'f'+i+'.txt'),'x\n');
   // A file the pattern must not match, so a stray match cannot fake the count.
   await writeFile(path.join(dir,'noise.md'),'x\n');
  }
  for(const count of COUNTS)for(const limit of LIMITS){
   const dir=path.join(base,'n'+count);
   const args={path:dir,pattern:'*.txt',limit};
   const decisions=[];
   const fast=createFastFindTool(dir,{forceExternal:true,onDecision:x=>decisions.push(x)});
   const actual=await fast.execute('fast',args,undefined,undefined,{cwd:dir});
   const expected=await createFindToolDefinition(dir).execute('native',args,undefined,undefined,{cwd:dir});
   const notice=result=>result.content.map(x=>x.text??'').join('').includes('results limit reached');
   rows.push({count,limit,winner:decisions.at(-1)?.backend,
    equal:JSON.stringify(actual)===JSON.stringify(expected),
    nativeNotice:notice(expected),fastNotice:notice(actual),
    // Native clamps a limit below 1 up to 1 before it compares.
    expectNotice:count>Math.max(1,limit),
    text:actual.content.map(x=>x.text??'').join('')});
  }
 }catch(error){rows.push({error:String(error.stack||error)})}
 finally{
  await writeFile(process.env.FAST_LIMIT_OUT,JSON.stringify({rows})+'\n');
  ctx.shutdown();
 }
});
