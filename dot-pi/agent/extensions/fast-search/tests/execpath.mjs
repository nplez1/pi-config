// Executed inside Pi: an unreadable execPath must not disable the extension.
import fastSearch from '../index.js';
export default pi=>{
 Object.defineProperty(process,'execPath',{value:'/nonexistent/unreadable-pi-bin',configurable:true});
 fastSearch(pi);
 pi.on('session_start',(_event,ctx)=>{
  const tools=pi.getAllTools().filter(tool=>tool.name==='find'||tool.name==='grep');
  process.stderr.write('FAST_EXEC_PATH='+JSON.stringify(tools.map(tool=>({name:tool.name,source:tool.sourceInfo})))+'\n');
  ctx.shutdown();
 });
};
