// PGS packets may be regrouped by Matroska/FFmpeg. Compare the actual SUP
// segment sequence and its timestamps rather than container packet counts.
const pgsCrypto = require('crypto');
const pgsSpawn = require('child_process').spawn;
const PGS_TICKS = 90000;
function pgsMeasurementUnavailable(message) {
  return Object.assign(Error(message),{validation:{outcome:'inconclusive',stage:'timelines',code:'pgs_measurement_unavailable',message}});
}
function pgsExtractionFailure(error,stderr,processError) {
  // A failed extractor can end a pipe before a complete SUP header arrives.
  // Preserve that process cause instead of presenting its partial output as a
  // proven media mismatch. An interrupted extractor cannot establish that the
  // candidate differs, including an interruption needed to stop a bad parser.
  const fromProcess=processError?.processFailure;
  const cause=error?.processFailure?error:fromProcess?processError:error;
  const wrapped=Error(`${cause.message || cause}${stderr.trim()?`: ${stderr.trim().slice(-400)}`:''}`);
  for(const field of ['code','processFailure','validation'])if(cause[field]!==undefined)wrapped[field]=cause[field];
  return wrapped;
}
function managePgsProcess(proc,label) {
  let timeoutReason='',idleTimer=null,settled=false;
  const stop=()=>{
    if(typeof terminateReservationChild==='function')terminateReservationChild(proc,'SIGKILL');
    else proc.kill('SIGKILL');
  };
  if(typeof trackReservationChild==='function')trackReservationChild(proc);
  const maxTimer=setTimeout(()=>{timeoutReason='maximum runtime of 12 hours';stop();},12*60*60*1000);
  if(maxTimer.unref)maxTimer.unref();
  const refreshIdle=()=>{
    if(idleTimer)clearTimeout(idleTimer);
    idleTimer=setTimeout(()=>{timeoutReason='30 minutes without process output';stop();},30*60*1000);
    if(idleTimer.unref)idleTimer.unref();
  };
  const streams=new Set([proc.stdout,proc.stderr,...(proc.stdio||[])].filter(stream=>stream&&typeof stream.on==='function'));
  refreshIdle();
  streams.forEach(stream=>stream.on('data',refreshIdle));
  const cleanup=()=>{
    if(settled)return;
    settled=true;clearTimeout(maxTimer);if(idleTimer)clearTimeout(idleTimer);
    if(typeof untrackReservationChild==='function')untrackReservationChild(proc);
  };
  const closed=new Promise((resolve,reject)=>{
    proc.on('error',error=>{cleanup();error.processFailure={status:null,signal:null,timedOut:false};reject(error);});
    proc.on('close',(code,signal)=>{
      const reason=timeoutReason||`failed (${code ?? signal})`;
      cleanup();
      if(code===0)resolve();
      else reject(Object.assign(Error(`${label} ${reason}`),{processFailure:{status:code,signal,timedOut:!!timeoutReason}}));
    });
  });
  return {closed,stop};
}
async function parsePgsSegments(stream) {
  let pending=Buffer.alloc(0);
  const result=[];
  for await (const chunk of stream) {
    pending=Buffer.concat([pending,Buffer.from(chunk)]);
    while (pending.length>=13) {
      if (pending[0]!==0x50 || pending[1]!==0x47) throw Error('Invalid PGS segment header');
      const length=pending.readUInt16BE(11), end=13+length;
      if (pending.length<end) break;
      result.push({pts:pending.readUInt32BE(2),dts:pending.readUInt32BE(6),type:pending[10],hash:pgsCrypto.createHash('sha256').update(pending.subarray(13,end)).digest('hex')});
      if (result.length>1000000) throw pgsMeasurementUnavailable('PGS segment count exceeds safety limit');
      pending=pending.subarray(end);
    }
  }
  if (pending.length) throw Error('Truncated PGS segment');
  return result;
}
function comparePgsSegments(source,output,shift,tolerance=0.1) {
  if (!Array.isArray(source) || !Array.isArray(output)) throw pgsMeasurementUnavailable('PGS subtitle segment scan unavailable');
  if (source.length!==output.length) throw Error('PGS subtitle segment count changed');
  if (!Number.isFinite(shift) || !Number.isFinite(tolerance) || tolerance<0) throw pgsMeasurementUnavailable('Invalid PGS timestamp comparison');
  const delta=(a,b)=>(((b-a+0x80000000)>>>0)-0x80000000)/PGS_TICKS;
  for (let i=0;i<source.length;i++) {
    const a=source[i],b=output[i];
    if (a.type!==b.type || a.hash!==b.hash) throw Error(`PGS subtitle segment ${i} changed`);
    if (Math.abs(delta(a.pts,b.pts)-shift)>tolerance) throw Error(`PGS subtitle timestamp differs at segment ${i}`);
    if (a.dts && (!b.dts || Math.abs(delta(a.dts,b.dts)-shift)>tolerance)) throw Error(`PGS subtitle decode timestamp differs at segment ${i}`);
  }
}
function attachPgsProgress(proc,durationSec,onProgress) {
  let progressBuffer='',progressRecord={};
  const stream=proc.stdio?.[3];
  if(!stream)return;
  stream.on('data',chunk=>{
    progressBuffer+=chunk.toString();
    let newline;
    while((newline=progressBuffer.indexOf('\n'))>=0){
      const line=progressBuffer.slice(0,newline).trim();progressBuffer=progressBuffer.slice(newline+1);
      const separator=line.indexOf('=');if(separator<0)continue;
      const key=line.slice(0,separator),value=line.slice(separator+1).trim();
      if(key==='out_time_us')progressRecord.outTimeUs=Number(value);
      if(key==='progress'){
        const ratio=Number(durationSec)>0&&Number.isFinite(progressRecord.outTimeUs)?Math.max(0,Math.min(1,progressRecord.outTimeUs/1000000/Number(durationSec))):0;
        if(typeof onProgress==='function')try{onProgress(ratio);}catch(_){}
        progressRecord={};
      }
    }
  });
}
async function extractPgsSegments(ffmpeg,file,index,durationSec,onProgress) {
  const proc=pgsSpawn(ffmpeg,['-v','error','-copyts','-progress','pipe:3','-nostats','-i',file,'-map',`0:${index}`,'-c:s','copy','-f','sup','pipe:1'],{stdio:['ignore','pipe','pipe','pipe'],detached:true});
  let stderr='';
  proc.stderr.on('data',x=>stderr=(stderr+x.toString()).slice(-8192));
  const lifecycle=managePgsProcess(proc,'PGS extraction');
  attachPgsProgress(proc,durationSec,onProgress);
  try { const [segments]=await Promise.all([parsePgsSegments(proc.stdout),lifecycle.closed]);return segments; }
  catch(e){lifecycle.stop();let processError;try{await lifecycle.closed;}catch(error){processError=error;}throw pgsExtractionFailure(e,stderr,processError);}
}
async function extractPgsSegmentsBatch(ffmpeg,file,indices,durationSec,onProgress) {
  if(!Array.isArray(indices)||indices.some(index=>!Number.isSafeInteger(index)||index<0))throw Error('Invalid PGS stream index list');
  if(indices.length===0)return new Map();
  const firstOutputFd=4;
  const argv=['-v','error','-copyts','-progress','pipe:3','-nostats','-i',file];
  indices.forEach((index,position)=>argv.push('-map',`0:${index}`,'-c:s','copy','-f','sup',`pipe:${firstOutputFd+position}`));
  const stdio=['ignore','ignore','pipe','pipe',...indices.map(()=> 'pipe')];
  const proc=pgsSpawn(ffmpeg,argv,{stdio,detached:true});
  let stderr='';
  proc.stderr.on('data',x=>stderr=(stderr+x.toString()).slice(-8192));
  const lifecycle=managePgsProcess(proc,'PGS batch extraction');
  attachPgsProgress(proc,durationSec,onProgress);
  const parsing=Promise.all(indices.map(async(index,position)=>[index,await parsePgsSegments(proc.stdio[firstOutputFd+position])]));
  try {
    const [rows]=await Promise.all([parsing,lifecycle.closed]);
    return new Map(rows);
  } catch(error) {
    lifecycle.stop();
    let processError;
    try{await lifecycle.closed;}catch(error){processError=error;}
    throw pgsExtractionFailure(error,stderr,processError);
  }
}
async function verifyPgsSegments(ffmpeg,source,output,sourceIndex,outputIndex,shift,onSourceProgress,onOutputProgress,sourceDuration,outputDuration) {
  let a;
  try{a=await extractPgsSegments(ffmpeg,source,sourceIndex,sourceDuration,onSourceProgress);}
  catch(error){if(error.processFailure || error.code)throw error;throw pgsMeasurementUnavailable(`Source PGS extraction could not be verified: ${error.message || error}`);}
  const b=await extractPgsSegments(ffmpeg,output,outputIndex,outputDuration,onOutputProgress);
  comparePgsSegments(a,b,shift);
}
async function verifyPgsSegmentsBatch(ffmpeg,source,output,tracks,shift,onSourceProgress,onOutputProgress,sourceDuration,outputDuration) {
  if(!Array.isArray(tracks)||tracks.some(pair=>!Array.isArray(pair)||pair.length!==2||pair.some(index=>!Number.isSafeInteger(index)||index<0)))throw Error('Invalid PGS stream pair list');
  if(tracks.length===0)return;
  let sourceByIndex;
  try{sourceByIndex=await extractPgsSegmentsBatch(ffmpeg,source,tracks.map(pair=>pair[0]),sourceDuration,onSourceProgress);}
  catch(error){if(error.processFailure || error.code)throw error;throw pgsMeasurementUnavailable(`Source PGS extraction could not be verified: ${error.message || error}`);}
  const outputByIndex=await extractPgsSegmentsBatch(ffmpeg,output,tracks.map(pair=>pair[1]),outputDuration,onOutputProgress);
  for(const [sourceIndex,outputIndex] of tracks)comparePgsSegments(sourceByIndex.get(sourceIndex),outputByIndex.get(outputIndex),shift);
}
if(typeof module!=='undefined') module.exports={parsePgsSegments,comparePgsSegments,extractPgsSegments,verifyPgsSegments,extractPgsSegmentsBatch,verifyPgsSegmentsBatch};
