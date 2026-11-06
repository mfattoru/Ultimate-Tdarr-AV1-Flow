// FFmpeg's machine-readable progress is written to stdout; stderr retains a bounded error tail.
const {spawn: progressSpawn} = require('child_process');
const runLimitedFfmpeg = ({command,argv,durationSec,updateWorker}) => new Promise(resolve => {
  let child, startError, stderr='', buffer='', record={};
  const emit = data => {
    if (typeof updateWorker !== 'function') return;
    try {
      const result=updateWorker(data);
      if (result && typeof result.catch === 'function') result.catch(()=>{});
    } catch (_) {} // UI failures must not affect the encoded file.
  };
  const parseLine = line => {
    const i=line.indexOf('='); if(i<0)return;
    const key=line.slice(0,i),value=line.slice(i+1).trim();
    if (key==='out_time_us' || key==='fps') record[key]=value;
    if (key!=='progress') return;
    const us=Number(record.out_time_us), duration=Number(durationSec),fps=Number(record.fps);
    if (record.out_time_us!==undefined && Number.isFinite(us) && us>=0 && Number.isFinite(duration) && duration>0) {
      const percentage=Math.min(99.9,Math.max(0,Math.round((us/1000000/duration)*1000)/10));
      const data={percentage}; if(Number.isFinite(fps)&&fps>0)data.fps=fps;
      emit(data);
    }
    record={};
  };
  try {child=progressSpawn(command,argv,{stdio:['ignore','pipe','pipe']});}
  catch(error) {resolve({status:null,error,stderr:''});return;}
  const onExit=()=>{try{child.kill('SIGKILL');}catch(_){}};
  process.once('exit',onExit);
  emit({percentage:0,fps:0});
  if(child.stdout)child.stdout.on('data',chunk=>{
    buffer+=String(chunk);
    let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).replace(/\r$/,'');buffer=buffer.slice(i+1);parseLine(line);}
    if(buffer.length>65536)buffer=buffer.slice(-65536);
  });
  if(child.stderr)child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-1024*1024);});
  child.on('error',error=>{startError=error;});
  child.on('close',(status,signal)=>{
    process.removeListener('exit',onExit);
    if(buffer)parseLine(buffer);
    resolve({status,signal,error:startError,stderr});
  });
});
const runQualityAttemptsAsync = async (qualities, sourceSize, run) => {
  for (const quality of qualities) {
    const result=await run(quality);
    if (!result.ok) return {ok:false,quality,reason:'encoder',result};
    if (!Number.isSafeInteger(result.size) || result.size<1) return {ok:false,quality,reason:'size',result};
    if (result.size<sourceSize) return {ok:true,quality,result};
  }
  return {ok:false,quality:qualities[qualities.length-1],reason:'quality_floor'};
};
module.exports={runLimitedFfmpeg,runQualityAttemptsAsync};
