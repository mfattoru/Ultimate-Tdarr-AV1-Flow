// FFmpeg's machine-readable progress is written to stdout; stderr retains a bounded error tail.
const {spawn: progressSpawn} = require('child_process');
const progressFs = require('fs');
const progressWorkerContext = new WeakMap();
const createFpsSampler = () => {
  let lastFrame = null, lastSampleAt = 0, lastFps = 0;
  return (frameValue, reportedFpsValue) => {
    const reportedFps = Number(reportedFpsValue);
    const frame = Number(frameValue);
    const now = Date.now();
    let measuredFps = 0;
    if (Number.isSafeInteger(frame) && frame >= 0) {
      if (lastFrame === null) {
        lastFrame = frame;
        lastSampleAt = now;
      } else {
        const elapsed = (now - lastSampleAt) / 1000;
        if (elapsed >= 0.25) {
          const delta = frame - lastFrame;
          if (delta > 0) measuredFps = delta / elapsed;
          lastFrame = frame;
          lastSampleAt = now;
        }
      }
    }
    if (Number.isFinite(reportedFps) && reportedFps > 0) lastFps = reportedFps;
    else if (measuredFps > 0) lastFps = measuredFps;
    return lastFps > 0 ? Math.round(lastFps * 10) / 10 : 0;
  };
};
const progressFileSize = file => {
  if (typeof file !== 'string' || !file) return undefined;
  try { return progressFs.statSync(file).size; } catch (_) { return 0; }
};
const reportWorkerProgress = (updateWorker,data,workerDetails,mediaRatio) => {
  if (typeof updateWorker !== 'function') return;
  try {
    const payload={...data};
    const previous=progressWorkerContext.get(updateWorker) || {};
    const context={
      workerDetails:workerDetails && typeof workerDetails === 'object' ? workerDetails : previous.workerDetails,
      mediaRatio:Number.isFinite(mediaRatio) ? mediaRatio : previous.mediaRatio
    };
    if (context.workerDetails) progressWorkerContext.set(updateWorker,context);
    const details=context.workerDetails;
    if (details) {
      for (const key of ['CLIType','preset','workerLog','lastPluginDetails']) {
        if (details[key] !== undefined) payload[key]=details[key];
      }
      const outputSizeBytes=progressFileSize(details.outputPath);
      if (outputSizeBytes !== undefined) {
        const outputSizeGiB=outputSizeBytes/(1024*1024*1024);
        payload.outputFileSizeInGbytes=outputSizeGiB;
        payload.estSize=0;
        if (outputSizeBytes > 0 && Number.isFinite(context.mediaRatio) && context.mediaRatio >= 0.03) {
          const estimate=outputSizeGiB/Math.min(1,context.mediaRatio);
          if (Number.isFinite(estimate) && estimate > 0) payload.estSize=estimate;
        }
      }
    }
    const result=updateWorker(payload);
    if (result && typeof result.catch === 'function') result.catch(()=>{});
  } catch (_) {} // UI failures must not affect the encode.
};
const runLimitedFfmpeg = ({command,argv,durationSec,updateWorker,workerDetails,progressStart=0,progressEnd=100,capacity}) => new Promise(resolve => {
  let child, startError, stderr='', buffer='', record={},capacityError=null,limit=capacity?BigInt(capacity.initialBytes):null,growth=null,processExited=false;
  const sampleFps=createFpsSampler();
  const start=Number.isFinite(progressStart)?Math.min(99.9,Math.max(0,progressStart)):0;
  const end=Number.isFinite(progressEnd)?Math.min(100,Math.max(start,progressEnd)):100;
  const emit = (data,mediaRatio) => reportWorkerProgress(updateWorker,data,workerDetails,mediaRatio);
  const parseLine = line => {
    const i=line.indexOf('='); if(i<0)return;
    const key=line.slice(0,i),value=line.slice(i+1).trim();
    if (key==='out_time_us' || key==='fps' || key==='frame') record[key]=value;
    if (key!=='progress') return;
    const us=Number(record.out_time_us), duration=Number(durationSec),fps=sampleFps(record.frame,record.fps);
    if (record.out_time_us!==undefined && Number.isFinite(us) && us>=0 && Number.isFinite(duration) && duration>0) {
      const ratio=Math.min(1,Math.max(0,us/1000000/duration));
      const percentage=Math.min(99.9,end,Math.max(start,Math.round((start+ratio*(end-start))*10)/10));
      const data={percentage}; if(Number.isFinite(fps)&&fps>0)data.fps=fps;
      emit(data,ratio);
    }
    record={};
  };
  try {child=progressSpawn(command,argv,{stdio:['ignore','pipe','pipe'],detached:true});}
  catch(error) {resolve({status:null,error,stderr:''});return;}
  if(typeof trackReservationChild==='function')trackReservationChild(child);
  const onExit=()=>{if(typeof terminateReservationChild==='function')terminateReservationChild(child,'SIGKILL');else try{child.kill('SIGKILL');}catch(_){}};
  process.once('exit',onExit);
  const stopForCapacity=error=>{
    if(processExited||capacityError)return;
    capacityError=error instanceof Error?error:Error(String(error||'Cache capacity reservation failed'));
    if(typeof terminateReservationChild==='function')terminateReservationChild(child,'SIGTERM');else try{child.kill('SIGTERM');}catch(_){}
    const killTimer=setTimeout(()=>{if(!processExited){if(typeof terminateReservationChild==='function')terminateReservationChild(child,'SIGKILL');else try{child.kill('SIGKILL');}catch(_){}}},1000);
    if(killTimer.unref)killTimer.unref();
  };
  const growOutputLimit=async()=>{
    if(!capacity||processExited||growth||capacityError)return;
    let used=0n;
    try{used=progressFs.statSync(capacity.outputPath,{bigint:true}).size;}catch(_){return;}
    const headroom=BigInt(capacity.headroomBytes||512n*1024n*1024n);
    if(used<limit-headroom)return;
    if(used>=limit){stopForCapacity(Error(`Remux reached its reserved file-size limit (${limit} bytes)`));return;}
    growth=(async()=>{
      const grow=capacity.grow;
      if(typeof grow!=='function')throw Error('Cache reservation growth is unavailable');
      const chunk=BigInt(capacity.chunkBytes||1024n*1024n*1024n);
      const increments=[chunk,chunk/4n,chunk/16n,chunk/64n,1n].filter((value,index,all)=>value>0n&&all.indexOf(value)===index);
      let lastError;
      for(const increment of increments){
        const requested=limit+increment;
        try{
          const granted=BigInt(await grow(requested,used));
          if(granted<requested)throw Error('Reservation growth returned less capacity than requested');
          if(typeof capacity.updateLimit==='function')await capacity.updateLimit(child.pid,granted);
          else await new Promise((ok,fail)=>{
            let updater;
            try{updater=progressSpawn('prlimit',[`--pid=${child.pid}`,`--fsize=${granted}:unlimited`],{stdio:['ignore','ignore','pipe']});}
            catch(error){fail(error);return;}
            let detail='';updater.stderr?.on('data',chunk=>detail=(detail+String(chunk)).slice(-4096));
            updater.on('error',fail);updater.on('close',status=>status===0?ok():fail(Error(`prlimit could not extend the remux file-size limit (${status}): ${detail.trim()}`)));
          });
          limit=granted;
          if(typeof capacity.onLimit==='function')capacity.onLimit(limit);
          return;
        }catch(error){
          lastError=error;
          if(processExited)return;
          if(!/insufficient available capacity/i.test(String(error?.message||error)))break;
        }
      }
      if(!processExited)throw(lastError||Error('Unable to grow the cache reservation'));
    })().catch(stopForCapacity).finally(()=>{growth=null;});
  };
  const capacityTimer=capacity?setInterval(()=>{void growOutputLimit();},capacity.pollMs||100):null;
  if(capacityTimer?.unref)capacityTimer.unref();
  emit({percentage:start,fps:0});
  if(child.stdout)child.stdout.on('data',chunk=>{
    buffer+=String(chunk);
    let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).replace(/\r$/,'');buffer=buffer.slice(i+1);parseLine(line);}
    if(buffer.length>65536)buffer=buffer.slice(-65536);
  });
  if(child.stderr)child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-1024*1024);});
  child.on('error',error=>{startError=error;});
  child.on('close',(status,signal)=>{
    processExited=true;
    if(capacityTimer)clearInterval(capacityTimer);
    process.removeListener('exit',onExit);
    if(typeof untrackReservationChild==='function')untrackReservationChild(child);
    if(buffer)parseLine(buffer);
    Promise.resolve(growth).then(()=>resolve({status,signal,error:startError,stderr,capacityError,fileSizeLimit:limit}));
  });
});
const runSingleQuality = async (quality, sourceSize, run) => {
  const result=await run(quality);
  if (!result.ok) return {ok:false,quality,reason:'encoder',result};
  if (!Number.isSafeInteger(result.size) || result.size<1) return {ok:false,quality,reason:'size',result};
  if (result.size<sourceSize) return {ok:true,quality,result};
  return {ok:false,quality,reason:'quality_floor',result};
};
module.exports={runLimitedFfmpeg,runSingleQuality,reportWorkerProgress};
