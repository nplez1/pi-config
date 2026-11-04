import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,chmod} from 'node:fs/promises';import {watch} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
import {collectFdCandidates,collectRgCandidateFiles,mandatoryBasenameLiteral,mandatoryBasenameLiterals,mandatoryGrepLiteral,mandatoryGrepLiterals,NativeFallback} from '../builtin-fast-candidates.mjs';
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'candidate-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}
test('safe candidate extraction refuses ambiguous glob syntax',()=>{
 for(const [p,expected] of [['**/*docs-search-tool*','docs-search-tool'],['*.txt','.txt'],['*ab*cd*','ab'],['**/AGENTS.md','AGENTS.md']])assert.equal(mandatoryBasenameLiteral(p),expected);
 assert.deepEqual(mandatoryBasenameLiterals('*.{ts,tsx}'),['.ts','.tsx']);
 for(const p of ['*','src/**/*.ts','[ab]*','a?b','{a,b}','x\\*y','/tmp/*'])assert.equal(mandatoryBasenameLiterals(p),null,p);
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
test('fd candidate superset ignores .fdignore and preserves spaces, newlines, dirs and symlinks',async t=>{
 const root=await fixture(t);await mkdir(path.join(root,'.git'));await mkdir(path.join(root,'match-dir'));await writeFile(path.join(root,'.fdignore'),'match*\n');
 for(const n of ['match-file ','match\nline','.match-hidden','.github-match'])await writeFile(path.join(root,n),'x');
 await writeFile(path.join(root,'.git','match-secret'),'x');await symlink('match-dir',path.join(root,'match-link'));
 const all=await collectFdCandidates({root,pattern:'*match*'});const names=all.map(x=>x.rel).sort();
 assert.deepEqual(names,['.github-match','.match-hidden','match\nline','match-dir','match-file ','match-link'].sort());
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
test('abort terminates an uncooperative fd process group',async t=>{
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
test('oversized candidate output falls back to native without returning a prefix',async t=>{
 const root=await fixture(t),fake=path.join(root,'fake.sh');await writeFile(fake,"#!/bin/sh\ni=0; while [ $i -lt 100 ]; do printf '%s\\000' \"$4/item-$i.txt\"; i=$((i+1)); done\n");await chmod(fake,0o700);
 await assert.rejects(collectFdCandidates({root,pattern:'*.txt',fdPath:fake,maxBytes:100}),NativeFallback);
});
test('child failure and invalid UTF-8 output fall back rather than claim empty',async t=>{
 const root=await fixture(t),fake=path.join(root,'fake.sh');await writeFile(fake,"#!/bin/sh\nprintf '\\377\\000'\n");await chmod(fake,0o700);
 await assert.rejects(collectFdCandidates({root,pattern:'*.txt',fdPath:fake}),NativeFallback);
});
