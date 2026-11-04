import test from 'node:test';import assert from 'node:assert/strict';import {raceSearch} from '../builtin-race.mjs';
const pending=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
test('native winner aborts an already-started external search',async()=>{
 let fastSignal;const slow=pending(),n=pending(),started=pending();const run=raceSearch({native:()=>n.promise,fast:signal=>{fastSignal=signal;started.resolve();return slow.promise}});
 await started.promise;n.resolve(42);const result=await run;
 assert.equal(result.value,42);assert.equal(result.winner,'native');assert.ok(fastSignal.aborted);slow.reject(new Error('late rejection'));
});
test('native search finishing during the head start never launches the external search',async()=>{
 let started=false;const result=await raceSearch({fastDelayMs:1000,native:async()=>42,fast:()=>{started=true}});
 assert.equal(result.winner,'native');assert.equal(started,false);
});
test('external winner aborts the native search',async()=>{
 let nativeSignal;const slow=pending();const result=await raceSearch({native:signal=>{nativeSignal=signal;return slow.promise},fast:async()=>42});
 assert.equal(result.value,42);assert.equal(result.winner,'fast');assert.ok(nativeSignal.aborted);slow.reject(new Error('late rejection'));
});
test('external failure waits for native and preserves native error',async()=>{
 const n=pending(),result=raceSearch({native:()=>n.promise,fast:async()=>{throw new Error('fallback')}});n.resolve(7);
 assert.deepEqual((await result).value,7);
 const fail=raceSearch({native:async()=>{throw new Error('native fail')},fast:async()=>{throw new Error('fallback')}});await assert.rejects(fail,/native fail/);
});
test('external failure aborts its remaining work while native is pending',{timeout:2000},async()=>{
 const n=pending(),aborted=pending();let fastSignal;
 const result=raceSearch({native:()=>n.promise,fast:async signal=>{fastSignal=signal;signal.addEventListener('abort',()=>aborted.resolve(),{once:true});throw new Error('fallback')}});
 await aborted.promise;assert.ok(fastSignal.aborted);n.resolve(8);assert.equal((await result).value,8);
});
test('immediate abort does not invoke queued operations',async()=>{
 const c=new AbortController();let called=false;
 const result=raceSearch({signal:c.signal,native:()=>{called=true},fast:()=>{called=true}});c.abort();
 await assert.rejects(result,/Operation aborted/);assert.equal(called,false);
});
test('abort returns promptly even if both operations ignore cancellation',async()=>{
 const n=pending(),f=pending(),c=new AbortController();let ns,fs;
 const started=pending();const result=raceSearch({signal:c.signal,native:s=>{ns=s;return n.promise},fast:s=>{fs=s;started.resolve();return f.promise}});await started.promise;c.abort();
 await assert.rejects(result,/Operation aborted/);assert.ok(ns.aborted);assert.ok(fs.aborted);n.reject(new Error('late native'));f.reject(new Error('late fast'));
});
test('already-aborted calls do not start either operation',async()=>{
 const c=new AbortController();c.abort();let called=false;
 await assert.rejects(raceSearch({signal:c.signal,native:()=>{called=true},fast:()=>{called=true}}),/Operation aborted/);assert.equal(called,false);
});
