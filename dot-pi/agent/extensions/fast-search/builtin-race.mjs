// Race a compatible candidate backend against native. A fast-path failure
// never replaces native output; the losing operation is aborted immediately.
export async function raceSearch({signal,native,fast,fastDelayMs=0}){
 if(signal?.aborted)throw new Error('Operation aborted');
 const nativeAbort=new AbortController(),fastAbort=new AbortController();
 let abortResult;const aborted=new Promise(resolve=>{abortResult=resolve});
 const abortBoth=()=>{nativeAbort.abort();fastAbort.abort()};
 const onAbort=()=>{abortBoth();abortResult({kind:'abort'})};
 signal?.addEventListener('abort',onAbort,{once:true});
 if(signal?.aborted)onAbort();
 const tagged=(kind,operation,childSignal)=>Promise.resolve().then(()=>{
  if(childSignal.aborted)throw new Error('Operation aborted');
  return operation(childSignal);
 }).then(value=>({kind,ok:true,value}),error=>({kind,ok:false,error}));
 const waitForFast=childSignal=>new Promise((resolve,reject)=>{
  if(childSignal.aborted){reject(new Error('Operation aborted'));return}
  if(!fastDelayMs){resolve();return}
  const timer=setTimeout(()=>{childSignal.removeEventListener('abort',cancel);resolve()},fastDelayMs);
  const cancel=()=>{clearTimeout(timer);childSignal.removeEventListener('abort',cancel);reject(new Error('Operation aborted'))};
  childSignal.addEventListener('abort',cancel,{once:true});
 });
 const n=tagged('native',native,nativeAbort.signal),f=tagged('fast',async childSignal=>{await waitForFast(childSignal);if(childSignal.aborted)throw new Error('Operation aborted');return fast(childSignal)},fastAbort.signal);
 try{
  let first=await Promise.race([n,f,aborted]),fastError;
  if(first.kind==='fast'&&!first.ok){fastError=first.error;fastAbort.abort();first=await Promise.race([n,aborted]);}
  if(first.kind==='abort'||signal?.aborted)throw new Error('Operation aborted');
  if(first.kind==='fast')nativeAbort.abort();else fastAbort.abort();
  if(!first.ok)throw first.error;
  return {value:first.value,winner:first.kind,fastError};
 }finally{
  abortBoth();signal?.removeEventListener('abort',onAbort);
 }
}
