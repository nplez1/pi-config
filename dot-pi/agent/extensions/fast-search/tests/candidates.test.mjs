import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,chmod} from 'node:fs/promises';import {watch} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
import {collectFdCandidates,collectRgCandidateFiles,mandatoryBasenameLiteral,mandatoryBasenameLiterals,mandatoryGrepLiteral,mandatoryGrepLiterals,NativeFallback,resolveExecutable} from '../builtin-fast-candidates.mjs';
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'candidate-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}
// Windows cannot spawn a shell script or a .cmd without a shell, and NTFS forbids
// control bytes in a filename, so the POSIX-only fixtures say so instead of
// failing. Everything that only needs a real fd runs on both platforms.
const isWindows=process.platform==='win32';const posixOnly=reason=>isWindows?{skip:reason}:{};
test('safe candidate extraction refuses ambiguous glob syntax',()=>{
 for(const [p,expected] of [['**/*docs-search-tool*','docs-search-tool'],['*.txt','.txt'],['*ab*cd*','ab'],['**/AGENTS.md','AGENTS.md']])assert.equal(mandatoryBasenameLiteral(p),expected);
 assert.deepEqual(mandatoryBasenameLiterals('*.{ts,tsx}'),['.ts','.tsx']);
 for(const p of ['*','src/**/*.ts','[ab]*','a?b','{a,b}','x\\*y','/tmp/*'])assert.equal(mandatoryBasenameLiterals(p),null,p);
});
test('resolveExecutable finds a bare command name across the Windows PATHEXT list',async t=>{
 const root=await fixture(t),bin=process.platform==='win32'?'fd.exe':'fd';
 await writeFile(path.join(root,bin),'');if(process.platform!=='win32')await chmod(path.join(root,bin),0o755);
 const originalPath=process.env.PATH||'';process.env.PATH=root+path.delimiter+originalPath;
 t.after(()=>{process.env.PATH=originalPath});
 assert.equal(resolveExecutable('fd').toLowerCase(),path.join(root,bin).toLowerCase());
 assert.equal(resolveExecutable('definitely-not-a-real-tool-xyz'),null);
});
test('resolveExecutable ignores Windows entries it could not spawn',async t=>{
 if(process.platform!=='win32')return t.skip('Windows PATH semantics');
 const root=await fixture(t);
 // An extensionless shim (what a git-bash or npm install leaves) and a .cmd can
 // only run through a shell, so resolving one would turn every search into a
 // spawn that fails instead of a clean fallback to native.
 await writeFile(path.join(root,'fd'),'');await writeFile(path.join(root,'fd.cmd'),'');
 const originalPath=process.env.PATH||'';process.env.PATH=root;
 t.after(()=>{process.env.PATH=originalPath});
 assert.equal(resolveExecutable('fd'),null);
 await writeFile(path.join(root,'fd.exe'),'');
 assert.equal(resolveExecutable('fd').toLowerCase(),path.join(root,'fd.exe').toLowerCase());
});
test('grep prefilter extracts only an obligatory ASCII literal prefix',()=>{
 assert.equal(mandatoryGrepLiteral('^name: ["\\\']?docs-(ci|pr)'),'name: ');
 assert.equal(mandatoryGrepLiteral('error.*'),'error');assert.equal(mandatoryGrepLiteral('abc?',{}),'ab');
 assert.equal(mandatoryGrepLiteral('x',{literal:true}),'x');assert.equal(mandatoryGrepLiteral('x.*'),'x');
 assert.equal(mandatoryGrepLiteral('.*needle'),'needle');assert.equal(mandatoryGrepLiteral('^.*?needle'),'needle');
 assert.equal(mandatoryGrepLiteral('\\bneedle\\b'),'needle');assert.equal(mandatoryGrepLiteral('.*a?'),null);
 assert.equal(mandatoryGrepLiteral('foo|bar'),null);assert.deepEqual(mandatoryGrepLiterals('foo|bar'),['foo','bar']);
 assert.deepEqual(mandatoryGrepLiterals('^foo.*|^bar(?=z)'),['foo','bar']);assert.equal(mandatoryGrepLiterals('foo|.'),null);
 assert.equal(mandatoryGrepLiteral('(?=foo)bar'),null);assert.equal(mandatoryGrepLiteral('foo\nbar',{literal:true}),null);
});
test('generated regex matches always contain an advertised prefilter literal',()=>{
 let state=0x5d91a13;const rand=()=>{state=(state*1664525+1013904223)>>>0;return state};
 const atoms=['ab','cd','xy','a','b','c','.', '[ab]', '(?:ab|cd)', '(?:xy)?','\\d','\\s','\\b'];
 const suffixes=['','*','+','?','{0,2}','{1,2}'];const alphabet='abcdxy 01\n';let checked=0;
 for(let i=0;i<800;i++){
  const branch=()=>{let s=rand()%2?'^':'';for(let j=0;j<1+rand()%4;j++)s+=atoms[rand()%atoms.length]+suffixes[rand()%suffixes.length];return s};
  const pattern=branch()+(rand()%3===0?'|'+branch():'');let regex;try{regex=new RegExp(pattern,'m')}catch{continue}
  const literals=mandatoryGrepLiterals(pattern);if(!literals)continue;
  for(let j=0;j<100;j++){let text='';for(let k=0;k<rand()%20;k++)text+=alphabet[rand()%alphabet.length];if(regex.test(text)){checked++;assert.ok(literals.some(x=>text.includes(x)),JSON.stringify({pattern,text,literals}));}}
 }
 assert.ok(checked>0);
});
test('rg prefilter returns only matching supplied files, including binary bytes',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'one.txt'),'Name: alpha\n');await writeFile(path.join(root,'two.txt'),Buffer.from('x\0name: beta\n'));await writeFile(path.join(root,'other.txt'),'none\n');
 const out=await collectRgCandidateFiles({root,files:['one.txt','two.txt','other.txt'],literal:'name:',ignoreCase:true});assert.deepEqual(out,['one.txt','two.txt']);
 const union=await collectRgCandidateFiles({root,files:['one.txt','two.txt','other.txt'],literals:['name:','none'],ignoreCase:true});assert.deepEqual(union,['one.txt','other.txt','two.txt']);
});
test('fd candidate superset ignores .fdignore and preserves spaces, odd names, dirs and symlinks',async t=>{
 const root=await fixture(t);await mkdir(path.join(root,'.git'));await mkdir(path.join(root,'match-dir'));await writeFile(path.join(root,'.fdignore'),'match*\n');
 // NTFS forbids control bytes, so the awkward name is a non-ASCII one there;
 // either way the name is one a naive encoder or shell would mangle.
 const odd=isWindows?'match \u00fcn\u00efcode':'match\nline';
 for(const n of ['match-file ',odd,'.match-hidden','.github-match'])await writeFile(path.join(root,n),'x');
 await writeFile(path.join(root,'.git','match-secret'),'x');
 // A junction is the directory symlink Windows can create without privilege.
 await symlink(isWindows?path.join(root,'match-dir'):'match-dir',path.join(root,'match-link'),isWindows?'junction':undefined);
 const all=await collectFdCandidates({root,pattern:'*match*'});const names=all.map(x=>x.rel).sort();
 assert.deepEqual(names,['.github-match','.match-hidden',odd,'match-dir','match-file ','match-link'].sort());
 assert.equal(all.find(x=>x.rel==='match-dir').kind,'dir');assert.equal(all.find(x=>x.rel==='match-link').kind,'symlink');
 const files=await collectFdCandidates({root,pattern:'*match*',filesOnly:true});assert.ok(files.every(x=>x.kind==='file'));assert.equal(files.some(x=>x.rel==='match-link'),false);
});
test('brace alternatives use a conservative union without losing candidates',async t=>{
 const root=await fixture(t);for(const n of ['one.ts','two.tsx','three.js'])await writeFile(path.join(root,n),'x');
 const out=await collectFdCandidates({root,pattern:'*.{ts,tsx}'});assert.deepEqual(out.map(x=>x.rel).sort(),['one.ts','two.tsx']);
});
test('fd candidate prefilter remains case-sensitive',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'lower.txt'),'x');await writeFile(path.join(root,'upper.TXT'),'x');
 const out=await collectFdCandidates({root,pattern:'*.txt'});assert.deepEqual(out.map(x=>x.rel),['lower.txt']);
});
test('complex glob candidate enumeration never narrows to basename literals',async t=>{
 const root=await fixture(t);await mkdir(path.join(root,'src'));await writeFile(path.join(root,'src','a.ts'),'x');await writeFile(path.join(root,'other.txt'),'x');
 for(const pattern of ['*','src/**/*.ts','[ab]*','a?b','{a,b}','x\\\\*y','/tmp/*']){
  const values=(await collectFdCandidates({root,pattern})).map(x=>x.rel);assert.ok(values.includes('src/a.ts'),pattern);assert.ok(values.includes('other.txt'),pattern);
 }
});
test('a missing binary, invalid glob, bad root and aborted search fail to native',async t=>{
 const root=await fixture(t);await assert.rejects(collectFdCandidates({root,pattern:'*\0'}),NativeFallback);
 await assert.rejects(collectFdCandidates({root,pattern:'*.txt',fdPath:path.join(root,'absent')}),NativeFallback);
 const c=new AbortController();c.abort();await assert.rejects(collectFdCandidates({root,pattern:'*.txt',signal:c.signal}),/Operation aborted/);
});
// POSIX-only premise: the process-group kill this asserts (trap TERM, then
// SIGKILL the group) does not exist on Windows, where the implementation does
// not spawn detached and child.kill() is TerminateProcess — there is no
// uncooperative child to escalate against.
test('abort terminates an uncooperative fd process group',posixOnly('needs a shell script and POSIX process-group kill semantics'),async t=>{
 const root=await fixture(t),fake=path.join(root,'fake.sh'),pidFile=path.join(root,'pid');
 await writeFile(fake,`#!/bin/sh\ntrap '' TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 60; done\n`);await chmod(fake,0o700);
 const controller=new AbortController(),watcher=watch(root,(_event,name)=>{if(String(name)==='pid')controller.abort()});
 const timer=setTimeout(()=>controller.abort(),10000),started=Date.now();
 await assert.rejects(collectFdCandidates({root,pattern:'*.txt',fdPath:fake,signal:controller.signal}),/Operation aborted/);clearTimeout(timer);watcher.close();
 assert.ok(Date.now()-started<12000);const pid=Number((await readFile(pidFile,'utf8')).trim());
 assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});
test('spawn errors fail back without hanging',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'one.txt'),'needle');
 await assert.rejects(collectFdCandidates({root,pattern:'*.txt',fdPath:path.join(root,'missing-fd')}),NativeFallback);
 await assert.rejects(collectRgCandidateFiles({root,files:['one.txt'],literal:'needle',rgPath:path.join(root,'missing-rg')}),NativeFallback);
});
// Real fd, tiny ceiling: the overflow path needs no fake binary, so it runs
// everywhere. 40 names are well past a 64-byte budget.
test('oversized candidate output falls back to native without returning a prefix',async t=>{
 if(!resolveExecutable('fd'))return t.skip('fd is required to exercise the overflow path');
 const root=await fixture(t);for(let i=0;i<40;i++)await writeFile(path.join(root,`item-${i}.txt`),'x');
 await assert.rejects(collectFdCandidates({root,pattern:'*',maxBytes:64}),NativeFallback);
});
// A real binary that rejects fd's arguments is a child failure with stderr and a
// non-zero exit — the exact shape the fallback must catch, on either platform.
test('a child that rejects fd arguments falls back rather than claim empty',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'one.txt'),'x');
 const notFd=resolveExecutable('rg');assert.ok(notFd,'rg is needed for this test');
 await assert.rejects(collectFdCandidates({root,pattern:'*.txt',fdPath:notFd}),NativeFallback);
});
test('invalid UTF-8 output falls back rather than claim empty',posixOnly('needs a shell script as the fake fd; Windows cannot spawn one without a shell'),async t=>{
 const root=await fixture(t),fake=path.join(root,'fake.sh');await writeFile(fake,"#!/bin/sh\nprintf '\\377\\000'\n");await chmod(fake,0o700);
 await assert.rejects(collectFdCandidates({root,pattern:'*.txt',fdPath:fake}),NativeFallback);
});
