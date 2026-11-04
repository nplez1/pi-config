// Same-contract Pi-Bolt 1.4 search backend.
// fd/rg only generate conservative candidates; native Pi formats results and
// handles cases we cannot prove compatible. No shell command is rewritten.
import { createFindToolDefinition,createGrepToolDefinition,DEFAULT_MAX_BYTES,truncateHead,formatSize,VERSION } from '@earendil-works/pi-coding-agent';
import {stat} from 'node:fs/promises';import path from 'node:path';import {homedir} from 'node:os';
import {createNativeFilter,createNativeFindMatcher,nativeGrepGlobFilter,CannotProveParityError,assertNativeVersion} from './builtin-native-compat.mjs';
import {collectFdCandidates,collectRgCandidateFiles,mandatoryGrepLiterals,resolveExecutable,NativeFallback} from './builtin-fast-candidates.mjs';
import {raceSearch} from './builtin-race.mjs';

// The ignore and glob compatibility code mirrors Pi 1.4.0's native walker;
// other versions remain native until their behavior is verified.
function searchExecutable(name){
 const found=resolveExecutable(name);if(!found)throw new NativeFallback(`${name} unavailable`);
 return found;
}
export async function supportedRuntime(){
 if(process.env.PI_FAST_SEARCH_BACKEND==='native')return false;
 try{assertNativeVersion(VERSION)}catch{return false}
 return true;
}
function fallback(error){return error instanceof NativeFallback||error instanceof CannotProveParityError}
function note(observer,backend,reason){try{observer?.({backend,reason})}catch{}}
const notified=new Set();
function warnOnce(ctx,key,message){if(notified.has(key))return;notified.add(key);try{ctx?.ui?.notify(message,'warning')}catch{}}
function warnIfUnavailable(ctx,error){if(/^(fd|rg) unavailable$/.test(error?.message||''))warnOnce(ctx,error.message,`Fast search: ${error.message}; using the native backend.`)}
function normalLimit(value,defaultValue){const n=value??defaultValue;if(!Number.isSafeInteger(n)||n<1||n>100000)throw new NativeFallback('unusual limit');return n}
async function competitive({forceExternal,signal,native,fast,onDecision,onAttempt,ctx,backend}){
 const attempt=childSignal=>{try{onAttempt?.(backend)}catch{}return fast(childSignal)};
 if(forceExternal){
  try{const value=await attempt(signal);note(onDecision,backend,'native-validated candidate path');return value}
  catch(error){if(signal?.aborted)throw new Error('Operation aborted');warnIfUnavailable(ctx,error);note(onDecision,'native',error?.message||'fast path failed');return native(signal)}
 }
 const result=await raceSearch({signal,native,fast:attempt,fastDelayMs:40});
 if(result.fastError)warnIfUnavailable(ctx,result.fastError);
 note(onDecision,result.winner==='fast'?backend:'native',result.winner==='fast'?'native-validated candidate path':result.fastError?.message||'native finished first');
 return result.value;
}
function patchFindLimitNotice(result,limit){
 if(!result.details?.resultLimitReached)return result;
 const old=`\n\n[${limit} results limit reached`,replacement=`\n\n[${limit} results limit reached. Use limit=${limit*2} for more, or refine pattern`;
 return {...result,content:result.content.map(x=>{
   if(x.type!=='text')return x;const at=x.text.lastIndexOf(old);
   if(at<0)throw new NativeFallback('unexpected native limit notice');
   return {...x,text:x.text.slice(0,at)+replacement+x.text.slice(at+old.length)};
 })};
}

export function createFastFindTool(cwd,{onDecision,onAttempt,forceExternal=false}={}){
 const native=createFindToolDefinition(cwd);
 return {...native,async execute(id,args,signal,onUpdate,ctx){
   if(signal?.aborted)throw new Error('Operation aborted');
   const supported=await supportedRuntime();if(signal?.aborted)throw new Error('Operation aborted');
   if(!supported){
     if(process.env.PI_FAST_SEARCH_BACKEND!=='native')warnOnce(ctx,'runtime','Fast search: this Pi search version is unsupported; using the native backend.');
     note(onDecision,'native','version or opt-out');return native.execute(id,args,signal,onUpdate,ctx);
   }
   return competitive({forceExternal,signal,onDecision,onAttempt,ctx,backend:'fd',native:s=>native.execute(id,args,s,onUpdate,ctx),fast:async signal=>{
     const limit=normalLimit(args.limit,1000);const fdPath=searchExecutable('fd');
     const custom=createFindToolDefinition(cwd,{operations:{
       async exists(root){try{const st=await stat(root);if(!st.isDirectory())throw new NativeFallback('not a directory');return true}catch(e){if(fallback(e))throw e;throw new NativeFallback('path unavailable')}},
       async glob(pattern,root){
         // Compile even for empty roots: invalid/over-complex globs must not
         // become successful empty results merely because fd found no entries.
         const matches=createNativeFindMatcher(pattern);
         const candidates=await collectFdCandidates({root,pattern,signal,fdPath});
         const include=createNativeFilter(root,{requireGit:false});const filtered=[];
         let checked=0;for(const entry of candidates){if(signal?.aborted)throw new Error('Operation aborted');
           if(++checked%256===0)await new Promise(resolve=>setImmediate(resolve));
           if(matches(entry.rel)&&await include(entry.rel,entry.kind))filtered.push(entry);}
         filtered.sort((a,b)=>a.rel<b.rel?-1:a.rel>b.rel?1:0);
         return filtered.slice(0,limit).map(x=>x.rel+(x.kind==='dir'?'/':''));
       },
     }});
     return patchFindLimitNotice(await custom.execute(id,args,signal,undefined,ctx),limit);
   }});
 }};
}

function safeGrepRoot(cwd,input){
 let value=input.path??'.';if(typeof value!=='string')throw new NativeFallback('special root path');
 // Mirror the tested native ordering for @ stripping and home expansion.
 // Unicode-space and file-URL normalization remain native-only.
 if(value.startsWith('@'))value=value.slice(1);
 if(value==='~')value=homedir();else if(value.startsWith('~/'))value=path.join(homedir(),value.slice(2));
 if(value.startsWith('~')||/^file:/i.test(value)||/[^\x20-\x7e]/.test(value))throw new NativeFallback('special root path');
 return path.resolve(cwd,value);
}
function effectiveGlob(glob){return glob?.includes('/')&&!glob.startsWith('/')&&!glob.startsWith('**/')&&!glob.startsWith('!')&&glob!=='**'?`**/${glob}`:glob}
function regexIsValid(pattern){
 try{
  let source=pattern.startsWith('(?i)')?pattern.slice(4):pattern;
  source=source.replace(/\(\?P</g,'(?<');
  // Codepoint escape translation is subtle; leave those patterns to native.
  if(/\\[xu]\{/.test(source))return false;
  new RegExp(source,'m');return true;
 }catch{return false}
}

export function createFastGrepTool(cwd,{onDecision,onAttempt,forceExternal=false}={}){
 const native=createGrepToolDefinition(cwd);
 return {...native,async execute(id,args,signal,onUpdate,ctx){
   if(signal?.aborted)throw new Error('Operation aborted');
   if((args.literal!==undefined&&typeof args.literal!=='boolean')||(args.ignoreCase!==undefined&&typeof args.ignoreCase!=='boolean')){
     note(onDecision,'native','nonboolean flags');return native.execute(id,args,signal,onUpdate,ctx);
   }
   const literals=mandatoryGrepLiterals(args.pattern,{literal:args.literal===true});
   if(!literals||(args.glob!==undefined&&typeof args.glob!=='string')||(args.context!==undefined&&(!Number.isSafeInteger(args.context)||args.context<0))||(!args.literal&&!regexIsValid(args.pattern))){
     note(onDecision,'native','unsupported search');return native.execute(id,args,signal,onUpdate,ctx);
   }
   const supported=await supportedRuntime();if(signal?.aborted)throw new Error('Operation aborted');
   if(!supported){
     if(process.env.PI_FAST_SEARCH_BACKEND!=='native')warnOnce(ctx,'runtime','Fast search: this Pi search version is unsupported; using the native backend.');
     note(onDecision,'native','version or opt-out');return native.execute(id,args,signal,onUpdate,ctx);
   }
   return competitive({forceExternal,signal,onDecision,onAttempt,ctx,backend:'rg',native:s=>native.execute(id,args,s,onUpdate,ctx),fast:async signal=>{
     const limit=normalLimit(args.limit,100);const root=safeGrepRoot(ctx?.cwd||cwd,args);const fdPath=searchExecutable('fd'),rgPath=searchExecutable('rg');
     const st=await stat(root).catch(()=>null);if(!st?.isDirectory())throw new NativeFallback('root not a directory');
     const glob=effectiveGlob(args.glob);
     // No or negative glob must enumerate a superset, not a fake '*' override:
     // a positive override changes native ignore behavior.
     const candidatePattern=glob&&!glob.startsWith('!')?glob:'*';
     const candidates=await collectFdCandidates({root,pattern:candidatePattern,filesOnly:true,signal,fdPath});
     const filter=nativeGrepGlobFilter(glob);const include=createNativeFilter(root,{requireGit:true,override:glob});const files=[];
     let checked=0;for(const entry of candidates){if(signal?.aborted)throw new Error('Operation aborted');
       if(++checked%256===0)await new Promise(resolve=>setImmediate(resolve));
       if(entry.kind==='file'&&filter.take(entry.rel)&&await include(entry.rel,'file'))files.push(entry.rel);}
     files.sort();
     const possible=await collectRgCandidateFiles({root,files,literals,ignoreCase:args.ignoreCase===true||args.pattern.startsWith('(?i)'),signal,rgPath});
     // An invalid JS regex must still fail even if the prefilter saw no files.
     if(!possible.length&&!args.literal)throw new NativeFallback('empty regex candidates need native validation');
     const output=[];let matchCount=0,linesTruncated=false,matchLimitReached=false;
     for(const rel of possible){
       if(signal?.aborted)throw new Error('Operation aborted');
       if(rel.includes('\n')||rel.includes('\r'))throw new NativeFallback('newline filename');
       // Pi normalizes Unicode space characters in explicitly supplied paths.
       // A per-file native call could otherwise inspect a different sibling.
       const full=path.join(root,...rel.split('/')),remaining=limit-matchCount;
       if(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(full))throw new NativeFallback('unicode-space filename');
       const one=await native.execute(id,{...args,path:full,limit:remaining},signal,undefined,ctx);
       const details=one.details??{};
       if(details.truncation||Object.keys(details).some(k=>!['matchLimitReached','linesTruncated'].includes(k)))throw new NativeFallback('unexpected native per-file truncation');
       const blocks=(one.content||[]).filter(x=>x.type==='text');
       if(blocks.length!==1)throw new NativeFallback('unexpected native result');
       let text=blocks[0].text;if(text==='No matches found')continue;
       const notices=[];
       if(details.matchLimitReached)notices.push(`${remaining} matches limit reached. Use limit=${remaining*2} for more, or refine pattern`);
       if(details.linesTruncated){linesTruncated=true;notices.push('Some lines truncated to 500 chars. Use read tool to see full lines');}
       if(notices.length){const suffix=`\n\n[${notices.join('. ')}]`;if(!text.endsWith(suffix))throw new NativeFallback('unexpected native notice');text=text.slice(0,-suffix.length);}
       const base=path.basename(full);
       for(const line of text.split('\n')){
         if(!line.startsWith(base))throw new NativeFallback('unexpected native match formatting');
         const rest=line.slice(base.length);
         if(/^:\d+: /.test(rest))matchCount++;
         else if(!/^-\d+- /.test(rest))throw new NativeFallback('unexpected native context formatting');
         // Native formatPath falls back to basename for any relative path
         // starting with '..', including legal names such as '..notes'.
         output.push((rel.startsWith('..')?base:rel.replace(/\\/g,'/'))+rest);
       }
       if(matchCount>=limit){matchLimitReached=true;break;}
     }
     if(!output.length)return {content:[{type:'text',text:'No matches found'}],details:undefined};
     const truncated=truncateHead(output.join('\n'),{maxLines:Number.MAX_SAFE_INTEGER});let text=truncated.content;const details={},notices=[];
     if(matchLimitReached){details.matchLimitReached=limit;notices.push(`${limit} matches limit reached. Use limit=${limit*2} for more, or refine pattern`);}
     if(truncated.truncated){details.truncation={...truncated,content:''};notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);}
     if(linesTruncated){details.linesTruncated=true;notices.push('Some lines truncated to 500 chars. Use read tool to see full lines');}
     if(notices.length)text+=`\n\n[${notices.join('. ')}]`;
     return {content:[{type:'text',text}],details:Object.keys(details).length?details:undefined};
   }});
 }};
}
