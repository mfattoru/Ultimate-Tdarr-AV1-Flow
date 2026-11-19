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
    const reset=Boolean(data && data.resetProgress);
    if ('resetProgress' in payload) delete payload.resetProgress;
    const baseMax=!reset && Number.isFinite(previous.maxPercent) ? previous.maxPercent : 0;
    const incomingPercent=Number(payload.percentage);
    if (Number.isFinite(incomingPercent)) {
      payload.percentage=Math.min(99.9,Math.max(baseMax,incomingPercent));
    }
    const maxPercent=Number.isFinite(Number(payload.percentage)) ? Math.max(baseMax,Number(payload.percentage)) : baseMax;
    const context={
      workerDetails:workerDetails && typeof workerDetails === 'object' ? workerDetails : previous.workerDetails,
      mediaRatio:Number.isFinite(mediaRatio) ? mediaRatio : previous.mediaRatio,
      maxPercent
    };
    progressWorkerContext.set(updateWorker,context);
    const details=context.workerDetails;
    if (details) {
      for (const key of ['CLIType','preset','lastPluginDetails']) {
        if (payload[key] === undefined && details[key] !== undefined) payload[key]=details[key];
      }
      if (payload.status === undefined && details.status !== undefined) payload.status=details.status;
      if (payload.status !== undefined && payload.workerLog === undefined) payload.workerLog=payload.status;
      if (payload.workerLog === undefined && details.workerLog !== undefined) payload.workerLog=details.workerLog;
      const sourceSizeBytes=Number(details.sourceFileSizeInBytes);
      if (Number.isFinite(sourceSizeBytes) && sourceSizeBytes > 0) {
        payload.originalFileSizeInGbytes=sourceSizeBytes/(1024*1024*1024);
      }
      const actualOutputSizeBytes=progressFileSize(details.outputPath);
      const initialOutputSizeBytes=Number(details.initialOutputSizeBytes);
      const hasInitialOutput=Number.isFinite(initialOutputSizeBytes) && initialOutputSizeBytes > 0;
      const outputSizeBytes=actualOutputSizeBytes === undefined
        ? (hasInitialOutput ? initialOutputSizeBytes : undefined)
        : actualOutputSizeBytes > 0 ? actualOutputSizeBytes : (hasInitialOutput ? initialOutputSizeBytes : actualOutputSizeBytes);
      if (outputSizeBytes !== undefined) {
        const outputSizeGiB=outputSizeBytes/(1024*1024*1024);
        payload.outputFileSizeInGbytes=outputSizeGiB;
        payload.estSize=0;
        if (outputSizeBytes > 0 && Number.isFinite(context.mediaRatio) && context.mediaRatio >= 0.03) {
          const estimate=outputSizeGiB/Math.min(1,context.mediaRatio);
          if (Number.isFinite(estimate) && estimate > 0) payload.estSize=estimate;
        } else {
          const initialEstimateBytes=Number(details.initialEstimateBytes);
          if (hasInitialOutput && Number.isFinite(initialEstimateBytes) && initialEstimateBytes > 0) {
            payload.estSize=initialEstimateBytes/(1024*1024*1024);
          }
        }
      }
    }
    const result=updateWorker(payload);
    if (result && typeof result.catch === 'function') result.catch(()=>{});
  } catch (_) {} // UI failures must not affect the encode.
};
const runLimitedFfmpeg = ({command,argv,durationSec,updateWorker,workerDetails,progressStart=0,progressEnd=100,capacity,env}) => new Promise(resolve => {
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
      const percentage=Math.min(99.9,end,Math.max(start,Math.round((start+ratio*(end-start))*100)/100));
      const data={percentage}; if(Number.isFinite(fps)&&fps>0)data.fps=fps;
      emit(data,ratio);
    }
    record={};
  };
  const spawnOptions={stdio:['ignore','pipe','pipe'],detached:true};
  if (env && typeof env==='object') spawnOptions.env={...process.env,...env};
  try {child=progressSpawn(command,argv,spawnOptions);}
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
    if(used>=limit){stopForCapacity(Error(`${capacity.stopOnLimit?'Process':'Remux'} reached its reserved file-size limit (${limit} bytes)`));return;}
    if(capacity.stopOnLimit)return;
    const headroom=BigInt(capacity.headroomBytes||512n*1024n*1024n);
    if(used<limit-headroom)return;
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
const STAGE_PROGRESS_PROFILES = {
  qsv: { sourceScan: 26, audioPrecheck: 4, encode: 17, remux: 2, candidateFrames: 34, timelines: 6, videoDecode: 9, audioDecode: 2 },
  hybrid: { sourceScan: 24, audioPrecheck: 4, encode: 27, remux: 2, candidateFrames: 28, timelines: 5.5, videoDecode: 7.5, audioDecode: 2 },
  sw_hdr: { sourceScan: 24, audioPrecheck: 4, encode: 33, remux: 2, candidateFrames: 24, timelines: 5, videoDecode: 6, audioDecode: 2 }
};
const STAGE_PROGRESS_ORDER = ['sourceScan', 'audioPrecheck', 'encode', 'remux', 'candidateFrames', 'timelines', 'videoDecode', 'audioDecode'];
const createStageProgressPlan = (options = {}) => {
  const weights = STAGE_PROGRESS_PROFILES[options.route] || STAGE_PROGRESS_PROFILES.qsv;
  const start = Number.isFinite(options.startPercent) ? Math.min(99.8, Math.max(0, Number(options.startPercent))) : 1;
  const end = Number.isFinite(options.endPercent) ? Math.min(99.9, Math.max(start, Number(options.endPercent))) : 99.9;
  const activeFlags = {
    sourceScan: options.hasSourceScan !== false,
    audioPrecheck: options.hasAudioPrecheck !== false,
    encode: options.hasEncode !== false,
    remux: options.hasRemux !== undefined ? options.hasRemux !== false : options.hasEncode !== false,
    candidateFrames: options.hasCandidateFrames !== false,
    timelines: options.hasTimelines !== false,
    videoDecode: options.hasVideoDecode !== false,
    audioDecode: options.hasAudioDecode !== false
  };
  const activeWeight = STAGE_PROGRESS_ORDER.reduce((sum, key) => sum + (activeFlags[key] ? weights[key] : 0), 0);
  const span = end - start;
  const plan = {};
  let cursor = start;
  for (const key of STAGE_PROGRESS_ORDER) {
    const width = activeWeight > 0 && activeFlags[key] ? (span * weights[key]) / activeWeight : 0;
    const next = cursor + width;
    plan[key] = { start: cursor, end: next };
    cursor = next;
  }
  if (activeWeight > 0) plan[STAGE_PROGRESS_ORDER[STAGE_PROGRESS_ORDER.length - 1]].end = end;
  return plan;
};
const stageProgressValue = (range, ratio = 0) => {
  const start = Number.isFinite(range?.start) ? Number(range.start) : 0;
  const end = Number.isFinite(range?.end) ? Math.max(start, Number(range.end)) : start;
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, Number(ratio))) : 0;
  return Math.min(99.9, end, Math.max(start, Math.round((start + clamped * (end - start)) * 100) / 100));
};
/** Emit 0.01%-granular monotonic stage progress and keep Tdarr worker updates alive during long child waits. */
const createStallSafeProgressEmitter = ({
  updateWorker,
  range,
  status,
  workerDetails,
  minStep = 0.01,
  heartbeatIntervalMs = 120000,
  defaultFps = 0
} = {}) => {
  const start = Number.isFinite(range?.start) ? Number(range.start) : 0;
  const end = Number.isFinite(range?.end) ? Math.max(start, Number(range.end)) : start;
  const step = Number.isFinite(minStep) && minStep > 0 ? Number(minStep) : 0.01;
  const intervalMs = Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0 ? Number(heartbeatIntervalMs) : 120000;
  const round2 = value => Math.round(value * 100) / 100;
  const round4 = value => Math.round(value * 10000) / 10000;
  const ceilingBeforeEnd = end > start ? Math.max(start, round2(end - 0.01)) : end;
  const microCeiling = end > start ? Math.max(start, round4(end - 0.0001)) : end;
  let lastEmitted = start, lastEmitAt = Date.now(), hasEmitted = false;
  const emitPercent = (percentage, fps) => {
    const bounded = Math.min(99.9, end, Math.max(start, lastEmitted, round4(percentage)));
    lastEmitted = bounded;
    lastEmitAt = Date.now();
    hasEmitted = true;
    const data = { percentage: bounded, status };
    if (Number.isFinite(fps) && fps > 0) data.fps = fps;
    else if (defaultFps !== undefined) data.fps = defaultFps;
    reportWorkerProgress(updateWorker, data, workerDetails);
  };
  return {
    update(ratio = 0, fps = 0) {
      const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, Number(ratio))) : 0;
      const next = stageProgressValue({ start, end }, clamped);
      if (!hasEmitted || next >= lastEmitted + step || clamped >= 1) emitPercent(next, fps);
    },
    async run(operation) {
      if (!hasEmitted) emitPercent(start, 0);
      const timer = typeof updateWorker === 'function' ? setInterval(() => {
        if (Date.now() - lastEmitAt < intervalMs) return;
        const nudged2 = Math.min(ceilingBeforeEnd, round2(lastEmitted + 0.01));
        if (nudged2 > lastEmitted) {
          emitPercent(nudged2, 0);
        } else {
          const nudged4 = Math.min(microCeiling, round4(lastEmitted + 0.0001));
          emitPercent(nudged4 > lastEmitted ? nudged4 : lastEmitted, 0);
        }
      }, intervalMs) : null;
      if (timer?.unref) timer.unref();
      try { return await operation(); }
      finally { if (timer) clearInterval(timer); }
    }
  };
};
const runSingleQuality = async (quality, sourceSize, run) => {
  const result = await run(quality);
  if (!result.ok) return {ok:false,quality,reason:'encoder',result};
  if (!Number.isSafeInteger(result.size) || result.size<1) return {ok:false,quality,reason:'size',result};
  if (result.size<sourceSize) return {ok:true,quality,result};
  return {ok:false,quality,reason:'quality_floor',result};
};
module.exports={runLimitedFfmpeg,runSingleQuality,reportWorkerProgress,createStageProgressPlan,stageProgressValue,createStallSafeProgressEmitter};
