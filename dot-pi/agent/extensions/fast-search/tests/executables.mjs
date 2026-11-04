// Executed inside Pi: verify PATH binaries are used and missing ones fall back.
import {createFindToolDefinition,createGrepToolDefinition} from '@earendil-works/pi-coding-agent';
import {createFastFindTool,createFastGrepTool} from '../builtin-fast-engine.mjs';
import {writeFile} from 'node:fs/promises';
export default pi=>pi.on('session_start',async(_event,ctx)=>{
 try{
  const root=process.env.FAST_EXEC_ROOT,decisions=[];
  const options={forceExternal:true,onDecision:decision=>decisions.push(decision)};
  const findArgs={path:root,pattern:'*.txt',limit:100};
  const grepArgs={path:root,pattern:'needle',literal:true,glob:'*.txt',limit:100};
  const nativeFind=createFindToolDefinition(root),nativeGrep=createGrepToolDefinition(root);
  const fastFind=createFastFindTool(root,options),fastGrep=createFastGrepTool(root,options);
  const nf=await nativeFind.execute('nf',findArgs),ng=await nativeGrep.execute('ng',grepArgs);
  const ff=await fastFind.execute('ff',findArgs,undefined,undefined,{cwd:root});
  const fg=await fastGrep.execute('fg',grepArgs,undefined,undefined,{cwd:root});
  await writeFile(process.env.FAST_EXEC_OUT,JSON.stringify({findEqual:JSON.stringify(ff)===JSON.stringify(nf),grepEqual:JSON.stringify(fg)===JSON.stringify(ng),decisions}));
 }catch(error){await writeFile(process.env.FAST_EXEC_OUT,JSON.stringify({error:String(error.stack||error)}))}
 finally{ctx.shutdown()}
});
