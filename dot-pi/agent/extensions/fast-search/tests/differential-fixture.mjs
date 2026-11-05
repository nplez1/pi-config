// Installed Pi-Bolt native tools versus candidate implementations, no LLM.
import {createFindToolDefinition,createGrepToolDefinition} from '@earendil-works/pi-coding-agent';
import {mkdir,writeFile,symlink,rm,chmod} from 'node:fs/promises';import {execFileSync} from 'node:child_process';
import path from 'node:path';import {pathToFileURL} from 'node:url';import {performance} from 'node:perf_hooks';

export default pi=>pi.on('session_start',async(_event,ctx)=>{
 const base=process.env.FAST_DIFF_ROOT,root=path.join(base,'repo');
 const put=async(name,text='x')=>{const f=path.join(root,name);await mkdir(path.dirname(f),{recursive:true});await writeFile(f,text)};
 try {
  await mkdir(root,{recursive:true});await mkdir(path.join(root,'truly-empty'));execFileSync('git',['init','-q',root]);
  await writeFile(path.join(process.env.HOME,'global-ignore'),'global-secret.txt\n');await writeFile(path.join(process.env.HOME,'.gitconfig'),`[core]\n excludesfile = ${path.join(process.env.HOME,'global-ignore')}\n`);
  for(const [name,text] of [
   ['Alpha.TXT','needle\n'],['lower.txt','foobar\nneedle\n'],['trailing.txt ','needle\n'],['line\nbreak.txt','needle\n'],
   ['visible/AGENTS.md','name: docs-search-tool\n'],['visible/a.spec.ts','needle\n'],['visible/empty-dir/placeholder','x'],
   ['ignored/secret.txt','needle\n'],['ignored/reinclude.txt','needle\n'],['skipthis.txt','needle\n'],
   ['fd-only.txt','needle\n'],['rg-only.txt','needle\n'],['excluded.txt','needle\n'],['global-secret.txt','globalneedle\n'],['keep.tmp','needle\n'],['drop.tmp','needle\n'],
   ['nested/.gitignore','ignored-nested.txt\n'],['nested/ignored-nested.txt','needle\n'],['nested/visible.txt','needle\n'],
   ['count/a.txt','needle\n'],['count/b.txt','needle\n'],['count/c.txt','needle\n'],['1 results limit reached.txt','needle\n']]) await put(name,text);
  await put('.gitignore','ignored/\n*.tmp\n!keep.tmp\n');await put('.ignore','skipthis.txt\n');await put('.fdignore','fd-only.txt\n');await put('.rgignore','rg-only.txt\n');await put('.git/info/exclude','excluded.txt\n');
  await mkdir(path.join(root,'nested-repo','.git'),{recursive:true});await put('nested-repo/.gitignore','nested-ignore.txt\n');await put('nested-repo/nested-ignore.txt','needle\n');await put('nested-repo/fd-only.txt','needle\n');await put('nested-repo/global-secret.txt','globalneedle\n');
  await put('onlyignored/.gitignore','secret.txt\n');await put('onlyignored/secret.txt','private-needle\n');await put('onlyignored/public.txt','ordinary\n');await put('onlyignored/context.txt','before\ncontextneedle\nmiddle\ncontextneedle\nafter\n');await put('onlyignored/lone-cr.txt','before\rstill-before\ncrneedle\nafter\rstill-after\n');await put('onlyignored/weird\\slash.txt','backslashneedle\n');await put('onlyignored/..weird/match.txt','dotdotneedle\n');await put('onlyignored/long-content.txt','x'.repeat(700)+'needlelong\n');await put('onlyignored/a\u00a0b.txt','unicodeneedle\n');await put('onlyignored/a b.txt','ordinary\n');
  await symlink('visible',path.join(root,'link-visible'));await symlink('lower.txt',path.join(root,'link-file.txt'));
  await mkdir(path.join(root,'bulk'));for(let batch=0;batch<8;batch++)await Promise.all(Array.from({length:100},(_,i)=>put(`bulk/bigfile-${String(batch*100+i).padStart(4,'0')}-${'x'.repeat(80)}.dat`)));
  for(let batch=0;batch<2;batch++)await Promise.all(Array.from({length:70},(_,i)=>put(`grepbulk/nested/data-${batch*70+i}.dat`,'bulkneedle '+ 'x'.repeat(440)+'\n')));
  const nativeFind=createFindToolDefinition(root),nativeGrep=createGrepToolDefinition(root);
  const {createFastFindTool,createFastGrepTool}=await import(process.env.FAST_ENGINE_MODULE);
  const decisions=[];const fastFind=createFastFindTool(root,{onDecision:x=>decisions.push(x),forceExternal:true}),fastGrep=createFastGrepTool(root,{onDecision:x=>decisions.push(x),forceExternal:true});
  const raceFind=createFastFindTool(root,{onDecision:x=>decisions.push(x)}),raceGrep=createFastGrepTool(root,{onDecision:x=>decisions.push(x)});const argsCtx={cwd:root};
  const fc=[
   {pattern:'*.txt',limit:1000},{pattern:'**/*fd-only*',limit:1000},{pattern:'*ignored*',limit:1000},
   {pattern:'**/AGENTS.md',limit:1000},{pattern:'*line*',limit:1000},{pattern:'*trailing*',limit:1000},
   {pattern:'*link*',limit:1000},{pattern:'*count*',limit:2},{pattern:'*.txt',limit:2},{pattern:'*results*',limit:1},{pattern:'*global-secret*',limit:1000},
   {pattern:'*.{txt,md}',limit:1000},{pattern:'**/*.{txt,ts}',limit:1000},
   {pattern:'src/**/*.spec.ts',limit:1000},{pattern:'[',limit:1000},{pattern:'*',limit:3},
   {pattern:'**/*.txt',limit:1000},{pattern:'visible/*.spec.ts',limit:1000},{pattern:'[Aa]*',limit:1000},
   {pattern:'?????.txt',limit:1000},{pattern:'{lower.txt,AGENTS.md}',limit:1000},{pattern:'**',limit:3},
   {path:path.join(root,'truly-empty'),pattern:'{a,b}'.repeat(11),limit:1000},
   {path:path.join(root,'visible'),pattern:'*.ts',limit:1000},{path:path.join(root,'link-visible'),pattern:'*.ts',limit:1000},
   {path:path.join(root,'missing-dir'),pattern:'*.txt',limit:1000},{path:path.join(root,'lower.txt'),pattern:'*.txt',limit:1000},
   {pattern:'*bigfile*',limit:2000},{pattern:'*bigfile*',limit:500},
  ];
  const gc=[
   {pattern:'needle',literal:true,glob:'*.txt',limit:100},{pattern:'needle',literal:true,glob:'*.txt',limit:1},
   {pattern:'^name: ["\']?docs-(ci|search)',ignoreCase:true,glob:'AGENTS.md',limit:100},
   {pattern:'foo(?=bar)',glob:'*.txt',limit:100},{pattern:'needle',literal:true,glob:'*.txt',context:1,limit:100},
   {pattern:'absent-needle',literal:true,glob:'*.txt',limit:100},{pattern:'[',glob:'*.txt',limit:100},
   {pattern:'needle',literal:true,limit:100},{pattern:'needle',literal:true,glob:'',limit:100},
   {pattern:'needle',literal:true,glob:'*',limit:100},{pattern:'needle',literal:true,glob:'!*.txt',limit:100},
   {pattern:'needle',literal:true,glob:'visible/*.ts',limit:100},{pattern:'needle',literal:true,glob:'[av]*',limit:100},
   {pattern:'n',literal:true,glob:'*.txt',limit:3},{pattern:'n.*',glob:'*.txt',limit:3},
   {path:path.join(root,'onlyignored'),pattern:'private-needle',literal:true,glob:'*.txt',limit:100},
   {path:path.join(root,'onlyignored'),pattern:'private-needle',literal:true,limit:100},
   {path:path.join(root,'onlyignored'),pattern:'contextneedle',literal:true,limit:100},
   {path:path.join(root,'onlyignored'),pattern:'contextneedle',literal:true,glob:'',limit:100},
   {path:path.join(root,'onlyignored'),pattern:'contextneedle',literal:true,glob:'!*.txt',limit:100},
   {path:path.join(root,'onlyignored'),pattern:'contextneedle',literal:true,glob:'*.txt',limit:100},
   {path:`~/${path.relative(process.env.HOME,path.join(root,'onlyignored'))}`,pattern:'contextneedle',literal:true,limit:100},
   {path:`@${path.join(root,'onlyignored')}`,pattern:'contextneedle',literal:true,limit:100},
   {path:path.join(root,'onlyignored'),pattern:'.*contextneedle',limit:100},
   {path:path.join(root,'onlyignored'),pattern:'\\bcontextneedle\\b',limit:100},
   {path:path.join(root,'onlyignored'),pattern:'contextneedle',literal:true,glob:'*.txt',context:1,limit:100},
   {path:path.join(root,'onlyignored'),pattern:'contextneedle',literal:true,glob:'*.txt',context:2,limit:100},
   {path:path.join(root,'onlyignored'),pattern:'crneedle',literal:true,glob:'*.txt',context:1,limit:100},
   {path:path.join(root,'onlyignored'),pattern:'private-needle|contextneedle',glob:'*.txt',context:1,limit:100},
   {path:path.join(root,'onlyignored'),pattern:'private-needle|contextneedle',glob:'*.{txt,md}',context:1,limit:100},
   {path:path.join(root,'onlyignored'),pattern:'backslashneedle',literal:true,glob:'*.txt',limit:100},
   {path:path.join(root,'onlyignored'),pattern:'dotdotneedle',literal:true,glob:'*.txt',limit:100},
   {path:path.join(root,'onlyignored'),pattern:'unicodeneedle',literal:true,glob:'*.txt',limit:100},
   {path:pathToFileURL(path.join(root,'onlyignored')).href,pattern:'contextneedle',literal:true,glob:'*.txt',limit:100},
   {path:path.join(root,'onlyignored'),pattern:'needlelong',literal:true,glob:'*.txt',limit:100},
   {path:path.join(root,'grepbulk'),pattern:'bulkneedle',literal:true,glob:'*.dat',limit:1000},
  ];
  const comparable=async(tool,args)=>{try{return{value:await tool.execute('diff',args,undefined,undefined,argsCtx)}}catch(e){return{error:String(e.message||e)}}};
  const out=[];for(const [kind,cases,baseTool,fastTool,raceTool] of [['find',fc,nativeFind,fastFind,raceFind],['grep',gc,nativeGrep,fastGrep,raceGrep]]){
   for(const args of cases){const before=performance.now(),native=await comparable(baseTool,args);decisions.length=0;const external=await comparable(fastTool,args);
    const eligibleRoots=[path.join(root,'onlyignored'),`~/${path.relative(process.env.HOME,path.join(root,'onlyignored'))}`,`@${path.join(root,'onlyignored')}`];
    const expectBackend=kind==='grep'&&eligibleRoots.includes(args.path)&&(['contextneedle','.*contextneedle','\\bcontextneedle\\b'].includes(args.pattern))&&[undefined,'','!*.txt'].includes(args.glob)?'rg':
     kind==='grep'&&args.pattern==='crneedle'?'rg':undefined;
    out.push({kind,args,mode:'forced',native,external,decision:decisions.at(-1),expectBackend,equal:JSON.stringify(native)===JSON.stringify(external),elapsedMs:Math.round(performance.now()-before)});
    decisions.length=0;const raced=await comparable(raceTool,args);
    out.push({kind,args,mode:'race',native,external:raced,decision:decisions.at(-1),equal:JSON.stringify(native)===JSON.stringify(raced)});
   }
  }
  await put('locked/secret-locked.txt','needle\n');await chmod(path.join(root,'locked'),0);
  const lockedArgs={pattern:'*secret-locked*',limit:1000},lockedNative=await comparable(nativeFind,lockedArgs);decisions.length=0;const lockedFast=await comparable(fastFind,lockedArgs);
  out.push({kind:'find',args:lockedArgs,native:lockedNative,external:lockedFast,decision:decisions.at(-1),equal:JSON.stringify(lockedNative)===JSON.stringify(lockedFast)});
  await new Promise((resolve,reject)=>process.stderr.write('BUILTIN_DIFFERENTIAL='+JSON.stringify(out)+'\n',error=>error?reject(error):resolve()));
 }catch(error){process.stderr.write('BUILTIN_DIFFERENTIAL_ERROR='+String(error.stack||error)+'\n')}
 finally{await chmod(path.join(root,'locked'),0o700).catch(()=>{});await rm(root,{recursive:true,force:true});ctx.shutdown()}
});
