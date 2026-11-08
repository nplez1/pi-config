// Conservative fd candidate enumeration for a same-contract find/grep backend.
// A candidate prefilter must be a provable superset; anything uncertain falls
// back to the installed native tool rather than silently dropping coverage.
import { spawn } from 'node:child_process';
import { lstat,stat } from 'node:fs/promises';
import { accessSync,constants } from 'node:fs';
import { TextDecoder } from 'node:util';
import path from 'node:path';
import {nativeExpandBraces} from './builtin-native-compat.mjs';

export class NativeFallback extends Error {}

function waitForChildClose(child,onError){
  return new Promise(resolve=>{
    let timer,finished=false;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);resolve(value)};
    child.once('error',error=>{
      onError(error);
      // Node normally emits close after error; do not hang forever on a runtime
      // that does not. Destroy the pipes if that contract is not honoured.
      if(!finished)timer=setTimeout(()=>{child.stdout?.destroy();child.stderr?.destroy();finish({code:null,childSignal:'error-timeout'})},2500);
    });
    child.once('close',(code,childSignal)=>finish({code,childSignal}));
  });
}

export function mandatoryBasenameLiterals(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length>4096 || pattern.includes('\0')) return null;
  let expanded;try{expanded=nativeExpandBraces(pattern)}catch{return null}
  if(expanded.length>32)return null;
  const literals=[];
  for(const item of expanded){
    const base=item.startsWith('**/')?item.slice(3):item;
    if(base.includes('/')||!/^[A-Za-z0-9._*-]+$/.test(base))return null;
    const pieces=base.split('*').filter(Boolean).sort((a,b)=>b.length-a.length);
    if(!pieces[0]||pieces[0].length<2)return null;literals.push(pieces[0]);
  }
  return [...new Set(literals)];
}
export function mandatoryBasenameLiteral(pattern){const values=mandatoryBasenameLiterals(pattern);return values?.length===1?values[0]:null;}

export function mandatoryGrepLiterals(pattern, {literal=false} = {}) {
  if (typeof pattern !== 'string' || !pattern || pattern.length>4096 || /[^\x20-\x7e]/.test(pattern)) return null;
  if (literal) return [pattern];
  const body=pattern.startsWith('(?i)')?pattern.slice(4):pattern;
  // Each top-level alternative needs its own mandatory prefix. A union of
  // those prefixes is a safe superset; if any branch lacks one, use native.
  const branches=[];let depth=0,inClass=false,escaped=false,start=0;
  for(let i=0;i<body.length;i++){
    const ch=body[i];if(escaped){escaped=false;continue}if(ch==='\\'){escaped=true;continue}
    if(inClass){if(ch===']')inClass=false;continue}if(ch==='['){inClass=true;continue}
    if(ch==='(')depth++;else if(ch===')')depth--;else if(ch==='|'&&depth===0){branches.push(body.slice(start,i));start=i+1}
  }
  branches.push(body.slice(start));if(branches.length>32)return null;
  const prefixes=[];
  for(let branch of branches){
    // These leading constructs cannot make the following literal optional.
    // Do not skip general groups, assertions, escapes or quantified literals.
    for(;;){
      if(branch.startsWith('^'))branch=branch.slice(1);
      else if(branch.startsWith('\\b')||branch.startsWith('\\B'))branch=branch.slice(2);
      else if(branch.startsWith('.*?'))branch=branch.slice(3);
      else if(branch.startsWith('.*'))branch=branch.slice(2);
      else break;
    }
    let prefix='',i=0;
    for(;i<branch.length;i++){
      const ch=branch[i];
      if(ch==='\\'){
        const next=branch[i+1];if(next && /[.*+?^${}()|[\]\\]/.test(next)){prefix+=next;i++;continue}break;
      }
      if(/[.*+?^${}()|[\]]/.test(ch))break;
      prefix+=ch;
    }
    if(i<branch.length&&(branch[i]==='?'||branch[i]==='*'||branch[i]==='{'))prefix=prefix.slice(0,-1);
    if(prefix.length<1)return null;prefixes.push(prefix);
  }
  return [...new Set(prefixes)];
}
export function mandatoryGrepLiteral(pattern,options){const values=mandatoryGrepLiterals(pattern,options);return values?.length===1?values[0]:null;}

function executableCandidates(base) {
  if (process.platform !== 'win32') return [base];
  // CreateProcess runs only .exe/.com directly. A bare `fd` never matches a
  // WinGet-installed `fd.exe`, and an extensionless shim or a `.cmd` cannot be
  // spawned without a shell at all — advertising one would only turn a working
  // native fallback into a spawn that fails on every search.
  const candidates = [];
  if (/\.[^./\\]+$/.test(base)) candidates.push(base);
  for (const ext of (process.env.PATHEXT || '.COM;.EXE').split(';')) {
    const suffix = ext.trim().toLowerCase();
    if (suffix === '.exe' || suffix === '.com') candidates.push(base + suffix);
  }
  return candidates;
}

export function resolveExecutable(name) {
  const bases = path.isAbsolute(name)
    ? [name]
    : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory, name));
  for (const base of bases) {
    for (const candidate of executableCandidates(base)) {
      try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
    }
  }
  return null;
}

export async function collectFdCandidates({root,pattern,filesOnly=false,signal,maxBytes=64*1024*1024,fdPath,excludePaths=[]}) {
  if(typeof pattern!=='string'||pattern.length>4096||pattern.includes('\0'))throw new NativeFallback('invalid glob');
  // When no safe basename literal exists, enumerate every entry. Matching is
  // still done with the native-compatible glob and ignore rules by the caller.
  const literals=mandatoryBasenameLiterals(pattern);
  if (signal?.aborted) throw new Error('Operation aborted');
  const fd=fdPath ?? resolveExecutable('fd');if(!fd)throw new NativeFallback('fd unavailable');
  const st=await stat(root).catch(()=>null);if(!st?.isDirectory())throw new NativeFallback('root not a directory');
  // The unignored scan is a deliberate superset. Filtering the candidates with
  // the native ignore rules occurs later; it cannot silently miss .fdignore.
  const args=['--no-ignore','--hidden','--case-sensitive','--print0','--show-errors','--color=never','--exclude','.git'];
  for(const rel of excludePaths){
    if(typeof rel!=='string'||!rel||rel.split('/').some(part=>!part||part==='.'||part==='..'||!/^[A-Za-z0-9._-]+$/.test(part)))throw new NativeFallback('unsafe prune path');
    args.push(`--exclude=/${rel}/**`);
  }
  let prefilter;
  if(!literals)prefilter='';
  else if(literals.length===1){args.push('--fixed-strings');prefilter=literals[0];}
  else prefilter=literals.map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  if(filesOnly)args.push('--type','f');
  args.push('--',prefilter,root);
  const chunks=[];let total=0,stderr='',overflow=false,spawnError=null;
  if(signal?.aborted)throw new Error('Operation aborted');
  const child=spawn(fd,args,{stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  let escalation;
  const kill=()=>{
    try{if(process.platform==='win32')child.kill('SIGTERM');else if(child.pid)process.kill(-child.pid,'SIGTERM')}catch{}
    if(!escalation){escalation=setTimeout(()=>{try{if(process.platform==='win32')child.kill('SIGKILL');else if(child.pid)process.kill(-child.pid,'SIGKILL')}catch{}},1000);escalation.unref?.()}
  };
  const onAbort=()=>kill();signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
  child.stdout.on('data',chunk=>{total+=chunk.length;if(total>maxBytes){overflow=true;kill();return}chunks.push(chunk)});
  child.stderr.on('data',chunk=>{if(stderr.length<16384)stderr+=chunk.toString('utf8').slice(0,16384-stderr.length)});
  const closed=await waitForChildClose(child,e=>{spawnError=e;kill()});
  clearTimeout(escalation);signal?.removeEventListener('abort',onAbort);
  if(signal?.aborted)throw new Error('Operation aborted');
  if(overflow)throw new NativeFallback('candidate output exceeded safe buffer');
  if(spawnError||closed.code!==0||closed.childSignal||stderr)throw new NativeFallback('fd could not complete without diagnostics');
  const buffer=Buffer.concat(chunks);if(buffer.length&&buffer[buffer.length-1]!==0)throw new NativeFallback('malformed fd output');
  const decoder=new TextDecoder('utf-8',{fatal:true});let offset=0;const items=[];
  try{
    while(offset<buffer.length){if(items.length%512===0){if(signal?.aborted)throw new Error('Operation aborted');await new Promise(resolve=>setImmediate(resolve));}
      const end=buffer.indexOf(0,offset);const raw=decoder.decode(buffer.subarray(offset,end));offset=end+1;
      if(!path.isAbsolute(raw))throw new Error('non-absolute output');
      const relative=path.relative(root,raw);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('out-of-root output');
      items.push(relative.split(path.sep).join('/'));
    }
  }catch(error){if(signal?.aborted)throw new Error('Operation aborted');throw new NativeFallback('invalid or out-of-root fd output')}
  // lstat distinguishes regular files, directories and symlink entries. A
  // disappearing candidate invalidates this attempt; let native handle it.
  const results=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(32,items.length)},async()=>{while(true){if(signal?.aborted)throw new Error('Operation aborted');const i=next++;if(i>=items.length)return;
    let st;try{st=await lstat(path.join(root,items[i]))}catch{throw new NativeFallback('candidate changed during search')}
    const kind=st.isDirectory()?'dir':st.isSymbolicLink()?'symlink':st.isFile()?'file':null;
    results[i]=kind?{rel:items[i],kind}:null;
  }}));
  return results.filter(Boolean);
}

export async function collectRgCandidateFiles({root,files,literal,literals,ignoreCase=false,signal,rgPath}) {
  if(signal?.aborted)throw new Error('Operation aborted');
  const rg=rgPath ?? resolveExecutable('rg');if(!rg)throw new NativeFallback('rg unavailable');
  const needles=literals??(literal?[literal]:[]);
  if(!Array.isArray(needles)||!needles.length||needles.length>32||needles.some(x=>typeof x!=='string'||!x||/[^\x20-\x7e]/.test(x)))throw new NativeFallback('no safe prefilter');
  const matches=new Set(),allowed=new Set(files.map(x=>path.resolve(root,x)));let index=0;
  while(index<files.length){
    if(signal?.aborted)throw new Error('Operation aborted');
    const batch=[];let bytes=0;
    while(index<files.length && batch.length<200){
      const p=path.resolve(root,files[index]);const n=Buffer.byteLength(p)+1;
      if(batch.length && bytes+n>65536)break;
      batch.push(p);bytes+=n;index++;
    }
    const args=['--no-config','--files-with-matches','--null','--fixed-strings','--text','--encoding=none','--color','never'];
    if(ignoreCase)args.push('--ignore-case');for(const needle of needles)args.push(`--regexp=${needle}`);args.push('--',...batch);
    const child=spawn(rg,args,{stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});const chunks=[];let total=0,stderr='',spawnError=null,overflow=false,escalation;
    const kill=()=>{try{if(process.platform==='win32')child.kill('SIGTERM');else if(child.pid)process.kill(-child.pid,'SIGTERM')}catch{}
      if(!escalation){escalation=setTimeout(()=>{try{if(process.platform==='win32')child.kill('SIGKILL');else if(child.pid)process.kill(-child.pid,'SIGKILL')}catch{}},1000);escalation.unref?.()}};
    const onAbort=()=>kill();signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
    child.stdout.on('data',chunk=>{total+=chunk.length;if(total>64*1024*1024){overflow=true;kill();return}chunks.push(chunk)});
    child.stderr.on('data',chunk=>{if(stderr.length<16384)stderr+=chunk.toString('utf8').slice(0,16384-stderr.length)});
    const closed=await waitForChildClose(child,e=>{spawnError=e;kill()});
    clearTimeout(escalation);signal?.removeEventListener('abort',onAbort);
    if(signal?.aborted)throw new Error('Operation aborted');
    if(overflow||spawnError||![0,1].includes(closed.code)||closed.childSignal||stderr)throw new NativeFallback('rg prefilter did not complete');
    const data=Buffer.concat(chunks);if(data.length&&data[data.length-1]!==0)throw new NativeFallback('malformed rg file output');
    const decoder=new TextDecoder('utf-8',{fatal:true});let offset=0;
    let decoded=0;
    try{while(offset<data.length){if(decoded++%512===0){if(signal?.aborted)throw new Error('Operation aborted');await new Promise(resolve=>setImmediate(resolve));}
      const end=data.indexOf(0,offset),p=path.resolve(decoder.decode(data.subarray(offset,end)));offset=end+1;if(!allowed.has(p))throw new Error('unexpected path');matches.add(p)}}
    catch(error){if(signal?.aborted)throw new Error('Operation aborted');throw new NativeFallback('invalid or unexpected rg path')}
  }
  return [...matches].map(p=>path.relative(root,p).split(path.sep).join('/')).sort();
}
