#!/usr/bin/env python3
import json, os, pathlib, re
root=pathlib.Path(__file__).resolve().parent
flow=json.loads((root/'base/flow-template-v3.json').read_text())
plugin=next(p for p in flow['flowPlugins'] if p['id']=='arc_av1_monolithic')
e=plugin['inputsDB']['code']
def one(old,new):
 global e
 n=e.count(old)
 if n!=1: raise RuntimeError(f'Expected 1 match, got {n}: {old[:80]}')
 e=e.replace(old,new,1)
source_identity=(root/'source_identity.js').read_text().rstrip()
audio_timing=(root/'audio_timing.js').read_text().rstrip()
e=(root/'policy.js').read_text()+'\n'+audio_timing+'\n'+source_identity+'\n'+e
one('''module.exports = async (args) => {
  if (!args.variables) args.variables = {};''', '''module.exports = async (args) => {
  let originalGuardFd=null;
  try {
  if (!args.variables) args.variables = {};''')
one('''  const toSrtCodecIDs = ["mov_text", "tx3g", "c608", "eia_608"];''', '''  const toSrtCodecIDs = ["mov_text", "tx3g", "c608", "eia_608"];
  const inputContainer = String(args.inputFileObj?.container || path.extname(inputPath).slice(1)).toLowerCase();
  const isMatroskaContainer = ["mkv", "mka", "mks", "matroska"].includes(inputContainer);
  const shouldConvertSubToSrt = stream => {
    const codec = String(stream.codec_name || "").toLowerCase();
    const codecId = String(stream.codec_tag_string || stream.codec_id || "").toLowerCase();
    if (isMatroskaContainer && ["ass", "ssa"].includes(codec)) return false;
    return toSrtCodecs.includes(codec) || toSrtCodecIDs.includes(codecId);
  };''')
one('if (toSrtCodecs.includes(c) || toSrtCodecIDs.includes(cid)) {', 'if (shouldConvertSubToSrt(s)) {')
one('return (toSrtCodecs.includes(c) || toSrtCodecIDs.includes(cid)) ? "subrip" : s.codec_name;', 'return shouldConvertSubToSrt(s) ? "subrip" : s.codec_name;')
one('''    // Video Mapping & Encoding / Stream-Copy Arguments
    cmdArgs.push("-map", `0:${mainVideo.index}`);
    if (doCopyVideo) {''', '''    // Video Mapping & Encoding / Stream-Copy Arguments
    cmdArgs.push("-map", `0:${mainVideo.index}`);
    // Prevent FFmpeg's automatic sync mode from silently dropping or duplicating decoded frames.
    if (!doCopyVideo) cmdArgs.push("-fps_mode:v", "passthrough");
    if (hdrClass === "untagged") cmdArgs.push(...untaggedColorRangeArgs(hdrClass,sdrSource));
    if (doCopyVideo) {''')
e,n=re.subn(r'const webhookUrl\s*=\s*"https://discord\.com/api/webhooks/[^"\n]+"\s*;', 'const webhookUrl = process.env.TDARR_DISCORD_WEBHOOK;', e)
if n==0 and e.count('const webhookUrl = process.env.TDARR_DISCORD_WEBHOOK;')==1: pass
elif n!=1: raise RuntimeError('Expected one engine webhook declaration to externalize')
one('''function runTimelineProcess(bin, argv, onLine) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = timelineSpawn(bin, argv, {stdio:['ignore','pipe','pipe']}); }
    catch (e) { reject(e); return; }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, 4 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    const lines = timelineReadline.createInterface({input:proc.stdout, crlfDelay:Infinity});
    lines.on('line', line => { if (onLine) onLine(line); });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', (status, signal) => {
      clearTimeout(timer);
      if (status !== 0) reject(new Error(`${bin} ${timedOut?'timed out':`failed (${status ?? signal})`}: ${stderr.trim().slice(-400)}`));
      else resolve();
    });
  });
}''',
'''function runTimelineProcess(bin, argv, onLine, onProgress, onDiagnostic, timeoutMs=12*60*60*1000, idleTimeoutMs=30*60*1000) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = timelineSpawn(bin, argv, {stdio:['ignore','pipe','pipe'],detached:true}); }
    catch (e) { reject(e); return; }
    if (typeof trackReservationChild==='function') trackReservationChild(proc);
    let stderr = '';
    let timeoutReason = '';
    let lineError=null;
    const terminate=()=>{ if (typeof terminateReservationChild==='function') terminateReservationChild(proc,'SIGKILL'); else proc.kill('SIGKILL'); };
    const timer = setTimeout(() => { timeoutReason = `maximum runtime ${Math.round(timeoutMs/60000)} minutes`; terminate(); }, timeoutMs);
    if (timer.unref) timer.unref();
    let idleTimer=null;
    const refreshIdleTimer=()=>{
      if (!(idleTimeoutMs>0)) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer=setTimeout(()=>{ timeoutReason=`no process output for ${Math.round(idleTimeoutMs/60000)} minutes`; terminate(); },idleTimeoutMs);
      if (idleTimer.unref) idleTimer.unref();
    };
    refreshIdleTimer();
    proc.stdout.on('data',refreshIdleTimer);
    proc.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8192);
      refreshIdleTimer();
      if(typeof onDiagnostic==='function'&&!lineError){
        try { onDiagnostic(stderr,true); }
        catch(err) { lineError=err; terminate(); }
      }
    });
    const lines = timelineReadline.createInterface({input:proc.stdout, crlfDelay:Infinity});
    let progressRecord={};
    const sampleFps=createFpsSampler();
    lines.on('line', line => {
      if (onLine && !lineError) {
        try { onLine(line); }
        catch (err) { lineError=err; terminate(); return; }
      }
      const split=String(line).indexOf('=');
      if(split<0)return;
      const key=String(line).slice(0,split),value=String(line).slice(split+1).trim();
      if(key==='out_time_us'||key==='fps'||key==='frame')progressRecord[key]=value;
      if(key==='progress'&&typeof onProgress==='function'){
        const timeUs=Number(progressRecord.out_time_us);
        if(Number.isFinite(timeUs))try{onProgress(timeUs,sampleFps(progressRecord.frame,progressRecord.fps));}catch(_){}
        progressRecord={};
      }
    });
    proc.on('error', err => { clearTimeout(timer); if(idleTimer)clearTimeout(idleTimer); if (typeof untrackReservationChild==='function') untrackReservationChild(proc); reject(err); });
    proc.on('close', (status, signal) => {
      clearTimeout(timer);
      if(idleTimer)clearTimeout(idleTimer);
      if (typeof untrackReservationChild==='function') untrackReservationChild(proc);
      const processReason = timeoutReason ? `timed out: ${timeoutReason}` : `failed (${status ?? signal})`;
      if (typeof onDiagnostic==='function') { try { onDiagnostic(stderr); } catch (_) {} }
      if(lineError) { reject(lineError); return; }
      if (status !== 0) reject(new Error(`${bin} ${processReason}: ${stderr.trim().slice(-800)}`));
      else resolve(stderr);
    });
  });
}''')
one('async function verifyVideoTimeline(ffprobe, ffmpeg, source, output, sourceIndex, outputIndex, tracks) {', 'async function verifyVideoTimeline(ffprobe, ffmpeg, source, output, sourceIndex, outputIndex, tracks, updateWorker, durationHints, assertSourceStable, audioTimestampRepairIndices=[]) {')
one("  const a=await measureStreamTimeline(ffprobe,source,sourceIndex,'video');\n  const b=await measureStreamTimeline(ffprobe,output,outputIndex,'video');", '''  const timelinePairCount=1+tracks.audio.length+tracks.subtitle.length;
  let completedTimelinePairs=0,lastTimelinePercent=90;
  const scanTimelinePair=async operation=>{
    const pairIndex=completedTimelinePairs++;
    const reportPart=(part,ratio)=>{
      const progress=Math.max(0,Math.min(1,Number(ratio)||0));
      const fraction=(pairIndex+(part+progress)/2)/timelinePairCount;
      const percentage=Math.min(96,90+6*fraction);
      if(percentage>=lastTimelinePercent+0.05||fraction>=1){lastTimelinePercent=percentage;reportWorkerProgress(updateWorker,{percentage,fps:0,status:"Validation: packet timelines"});}
    };
    if(typeof assertSourceStable==='function')assertSourceStable();
    await operation(ratio=>reportPart(0,ratio),ratio=>reportPart(1,ratio));
    if(typeof assertSourceStable==='function')assertSourceStable();
    reportPart(1,1);
  };
  reportWorkerProgress(updateWorker,{percentage:90,fps:0,status:"Validation: packet timelines"});
  let a,b;
  await scanTimelinePair(async(sourceProgress,outputProgress)=>{
    a=await measureStreamTimeline(ffprobe,source,sourceIndex,'video',sourceProgress,durationHints?.source,'source');
    b=await measureStreamTimeline(ffprobe,output,outputIndex,'video',outputProgress,durationHints?.output,'candidate');
  });''')
one('''async function measureStreamTimeline(ffprobe, file, streamIndex, type) {
  let first=Infinity, last=-Infinity, count=0, invalid=0;
  await runTimelineProcess(ffprobe, ['-v','error','-select_streams',String(streamIndex),'-show_packets','-show_entries','packet=pts_time,duration_time','-of','compact=p=0:nk=0',file], line => {
    const ptsMatch=line.match(/(?:^|\\|)pts_time=([^|]+)/), durMatch=line.match(/(?:^|\\|)duration_time=([^|]+)/);
    if (!ptsMatch) return;
    if (ptsMatch[1] === 'N/A' || !Number.isFinite(Number(ptsMatch[1]))) { invalid++; return; }
    const pts=Number(ptsMatch[1]);
    const duration=durMatch && durMatch[1] !== 'N/A' ? Number(durMatch[1]) : 0;
    first=Math.min(first,pts);
    last=Math.max(last,pts+(Number.isFinite(duration)&&duration>0?duration:0));
    count++;
  });
  if (invalid) throw new Error(`${type} timeline has ${invalid} packets with missing timestamps`);
  if (count===0 && type==='subtitle') return {empty:true};
  if (count===0 || !Number.isFinite(first) || !Number.isFinite(last) || (type==='video' && (count<2 || !(last>first)))) throw new Error(`${type} timeline is unavailable or too short to verify`);
  return {first,last,duration:last-first,packets:count,empty:false};
}''', '''async function measureStreamTimeline(ffprobe, file, streamIndex, type, onProgress, durationHint, role='file') {
  let first=Infinity, last=-Infinity, count=0, packetCount=0, invalid=0, missingPtsCount=0, missingTimestampCount=0;
  let previousDts=null,outputDtsNonIncreasingCount=0;
  const missingPtsPackets=[],missingTimestampPackets=[];
  let missingPtsBitmap=Buffer.alloc(0),missingTimestampBitmap=Buffer.alloc(0);
  const markMissingPacket=(bitmap,ordinal)=>{
    const byteIndex=Math.floor(ordinal/8);
    if(byteIndex>=bitmap.length){
      const grown=Buffer.alloc(Math.max(byteIndex+1,bitmap.length?bitmap.length*2:1024));
      bitmap.copy(grown);
      bitmap=grown;
    }
    bitmap[byteIndex]|=1<<(ordinal%8);
    return bitmap;
  };
  let fileBytes=0,lastPosition=0,lastRatio=0,lastReported=-1,lastReportAt=0,hasPacketPosition=false;
  try { fileBytes=fs.statSync(file).size; } catch (_) {}
  const emitProgress=(packet)=>{
    if(typeof onProgress!=='function')return;
    const position=Number(packet.position),pts=Number(packet.pts);
    if(Number.isFinite(position)&&position>=0){lastPosition=Math.max(lastPosition,position);hasPacketPosition=true;}
    let ratio=fileBytes>0&&hasPacketPosition?lastPosition/fileBytes:(Number.isFinite(pts)&&durationHint>0?pts/durationHint:0);
    ratio=Math.max(lastRatio,Math.max(0,Math.min(1,Number.isFinite(ratio)?ratio:0)));
    lastRatio=ratio;
    const now=Date.now();
    if(ratio-lastReported>=0.002||now-lastReportAt>=1000||ratio>=1){lastReported=ratio;lastReportAt=now;try{onProgress(ratio);}catch(_){}}
  };
  await runTimelineProcess(ffprobe, ['-v','error','-select_streams',String(streamIndex),'-show_packets','-show_entries','packet=pts_time,dts_time,duration_time,pos','-of','compact=p=0:nk=0',file], line => {
    const ptsMatch=line.match(/(?:^|\\|)pts_time=([^|]+)/), dtsMatch=line.match(/(?:^|\\|)dts_time=([^|]+)/), durMatch=line.match(/(?:^|\\|)duration_time=([^|]+)/), posMatch=line.match(/(?:^|\\|)pos=([^|]+)/);
    if (!ptsMatch && !dtsMatch) return;
    const packetOrdinal=packetCount++;
    const pts=ptsMatch && ptsMatch[1] !== 'N/A' ? Number(ptsMatch[1]) : NaN;
    const dts=dtsMatch && dtsMatch[1] !== 'N/A' ? Number(dtsMatch[1]) : NaN;
    if (Number.isFinite(dts)) {
      if (previousDts!==null && dts<=previousDts) outputDtsNonIncreasingCount++;
      previousDts=dts;
    }
    if(!Number.isFinite(pts)){
      missingPtsCount++;
      if(missingPtsPackets.length<1024)missingPtsPackets.push(packetOrdinal);
      if(type==='audio')missingPtsBitmap=markMissingPacket(missingPtsBitmap,packetOrdinal);
    }
    if(!Number.isFinite(pts)&&!Number.isFinite(dts)){
      missingTimestampCount++;
      if(missingTimestampPackets.length<1024)missingTimestampPackets.push(packetOrdinal);
      if(type==='audio')missingTimestampBitmap=markMissingPacket(missingTimestampBitmap,packetOrdinal);
    }
    const duration=durMatch && durMatch[1] !== 'N/A' ? Number(durMatch[1]) : 0;
    emitProgress({pts:Number.isFinite(pts)?pts:dts,position:posMatch&&posMatch[1]!=='N/A'?Number(posMatch[1]):NaN});
    const timelineTime=type==='audio'&&!Number.isFinite(pts)?dts:pts;
    if (!Number.isFinite(timelineTime)) { invalid++; return; }
    first=Math.min(first,timelineTime);
    last=Math.max(last,timelineTime+(Number.isFinite(duration)&&duration>0?duration:0));
    count++;
  });
  if(typeof onProgress==='function')try{onProgress(1);}catch(_){}
  if (invalid && type!=='audio') {
    const firstMissing=(missingTimestampPackets[0] ?? missingPtsPackets[0]);
    const packetText=firstMissing===undefined?'':' (first at packet '+(firstMissing+1)+')';
    throw new Error(`${type} ${role} stream ${streamIndex} has ${invalid} packets without a usable ${type==='audio'?'PTS or DTS':'PTS'}${packetText}`);
  }
  if (count===0 && type==='subtitle') return {empty:true};
  if (count===0 && type==='audio' && packetCount>0) throw new Error(`audio ${role} stream ${streamIndex} has no packets with usable PTS or DTS`);
  if (count===0 || !Number.isFinite(first) || !Number.isFinite(last) || (type==='video' && (count<2 || !(last>first)))) throw new Error(`${type} ${role} stream ${streamIndex} timeline is unavailable or too short to verify`);
  const bitmapBytes=Math.ceil(packetCount/8);
  return {first,last,duration:last-first,packets:count,totalPackets:packetCount,outputDtsNonIncreasingCount,missingPtsCount,missingPtsPackets,missingPtsTruncated:missingPtsCount>missingPtsPackets.length,missingPtsBitmap:missingPtsBitmap.subarray(0,bitmapBytes),missingTimestampCount,missingTimestampPackets,missingTimestampsTruncated:missingTimestampCount>missingTimestampPackets.length,missingTimestampBitmap:missingTimestampBitmap.subarray(0,bitmapBytes),empty:false};
}''')
one("  const decode=['-v','error','-xerror','-i',output,'-map',`0:${outputIndex}`];", "  const arcDevice=process.env.TDARR_ARC_DEVICE || '/dev/dri/renderD129';\n  const decode=['-v','error','-xerror','-progress','pipe:1','-nostats','-init_hw_device',`vaapi=va:${arcDevice}`,'-init_hw_device','qsv=hw@va','-hwaccel','qsv','-hwaccel_device','hw','-hwaccel_output_format','qsv','-i',output,'-map',`0:${outputIndex}`];")
one("  for (const [,dstIndex] of tracks.audio) decode.push('-map',`0:${dstIndex}`);", '')
one('  await runTimelineProcess(ffmpeg,decode);', '''  reportWorkerProgress(updateWorker,{percentage:96,fps:0,status:"Validation: strict output video decode"});
  try {
    await runTimelineProcess(ffmpeg,decode,null,(timeUs,fps)=>{
      const ratio=a.duration>0?Math.min(1,Math.max(0,timeUs/1000000/a.duration)):0;
      const data={percentage:96+3*ratio,status:"Validation: strict output video decode"};
      if(Number.isFinite(fps)&&fps>0)data.fps=fps;
      reportWorkerProgress(updateWorker,data);
    });
    if (tracks.audio.length) {
      const audioDecode=withDecoderThreads(['-v','error','-xerror','-progress','pipe:1','-nostats','-i',output],getDecodeThreadCount());
      for (const [,dstIndex] of tracks.audio) audioDecode.push('-map',`0:${dstIndex}`);
      audioDecode.push('-f','null','-');
      await runTimelineProcess(ffmpeg,audioDecode,null,(timeUs,fps)=>{
        const duration=Number(durationHints?.output)||a.duration;
        const ratio=duration>0?Math.min(1,Math.max(0,timeUs/1000000/duration)):0;
        const data={percentage:99+0.9*ratio,status:"Validation: retained audio decode"};
        if(Number.isFinite(fps)&&fps>0)data.fps=fps;
        reportWorkerProgress(updateWorker,data);
      });
    }
  } catch (outputError) {
    const sourceCorruption=[],sourceDiagnostics=[];
    const decodeSource=async (index,type) => {
      const args=withDecoderThreads(['-v','error','-xerror','-i',source,'-map',`0:${index}`,'-f','null','-'],getDecodeThreadCount());
      try {
        await runTimelineProcess(ffmpeg,args);
        sourceDiagnostics.push(`${type} source stream ${index}: decoded cleanly`);
      } catch (sourceError) {
        const detail=String(sourceError?.message || sourceError);
        const recognized=type==='video'?isKnownVideoCorruptionDiagnostic(detail):isKnownAudioCorruptionDiagnostic(detail);
        sourceDiagnostics.push(`${type} source stream ${index}: ${recognized?'recognized corruption':'decode diagnostic'}: ${detail.slice(-300)}`);
        if(recognized)sourceCorruption.push(`${type} source stream ${index}: ${detail.slice(-500)}`);
      }
    };
    await decodeSource(sourceIndex,'video');
    for (const [srcIndex] of tracks.audio) await decodeSource(srcIndex,'audio');
    const candidateDetail=String(outputError?.message || outputError).slice(-500);
    const sourceDetail=sourceDiagnostics.join(' | ').slice(-700) || 'source decode details unavailable';
    if(sourceCorruption.length)throw new Error(`[Source media corruption] ${sourceCorruption.join(' | ')}; candidate decode failed: ${candidateDetail}; source decode details: ${sourceDetail}`);
    throw new Error(`Candidate video/audio decode failed; strict source decodes did not confirm known source corruption. Source decode details: ${sourceDetail}; candidate decode: ${candidateDetail}`);
  }''')
one('  return await verifyVideoTimeline(ffprobeBin, expected.ffmpegBin || "ffmpeg", sourcePath, outputPath, sourceVideo.index, video[0].index, tracks);', '  return await verifyVideoTimeline(ffprobeBin, expected.ffmpegBin || "ffmpeg", sourcePath, outputPath, sourceVideo.index, video[0].index, tracks, expected.updateWorker, {source:resolveProbeDuration(src),output:resolveProbeDuration(dst)}, expected.assertOriginalUnchanged, expected.audioTimestampRepairIndices || []);')
one('    const specific = lines.filter(l => /error|failed|unsupported|invalid|cannot|only one of them|ratecontrol|qsv|vaapi/i.test(l));\n    const chosen = specific.length > 0 ? specific.slice(-3) : lines.slice(-3);\n    return chosen.join(" | ").substring(0, 240);',
r'''    const specific = lines.filter(l => /\b(?:error|failed|unsupported|invalid|cannot|could not|only one of them|ratecontrol)\b/i.test(l)
      && !/discarding stream metadata .* because the stream is being re-encoded/i.test(l));
    const causal = specific.filter(l => !/task finished with error|terminating thread with error|conversion failed/i.test(l));
    const chosen = causal.length ? causal.slice(-6) : lines.slice(-12);
    return chosen.join(" | ").substring(0, 1200);''')
one('''    log(`[Safety check failed] ${err.message || err}. Original will not be replaced.`);''',
r'''    const detail=String(err?.message || err);
    const alreadyClassified=/^\[(?:safety check failed|source media corruption)\]/i.test(detail);
    const originalGuard=/^Original library file changed during processing/i.test(detail);
    const reason=alreadyClassified?detail:originalGuard?`[Original guard] ${detail}`:`[Safety check failed] ${detail}`;
    log(`${reason}${/[.!?]$/.test(reason)?'':'.'} Original will not be replaced.`);''')
# Always re-probe; Tdarr's cached stream/format metadata may be stale after replacement.
a=e.index('  let streams = args.inputFileObj?.ffProbeData?.streams;')
b=e.index('\n  const badImageCodecs',a)
e=e[:a]+'''  let streams;
  try {
    const probed = JSON.parse(execFileSync(ffprobeBin, ["-v", "error", "-show_streams", "-show_format", "-of", "json", inputPath], {encoding:"utf8", timeout:120000, maxBuffer:16*1024*1024}));
    streams = probed.streams || [];
    args.inputFileObj.ffProbeData = probed;
  } catch (err) {
    log(`[Probe] Fresh stream and marker probe failed: ${err.message || err}`);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
'''+e[b:]
one('  const mainVideo = videoStreams[0];', '''  const mainVideo = videoStreams[0];
  if (videoStreams.length > 1) {
    for (const extraVideo of videoStreams.slice(1)) {
      const extraIndex=Number(extraVideo.index);
      let decodedFrames=null,progressEnded=false,probeStderr='';
      try {
        if(!Number.isSafeInteger(extraIndex)||extraIndex<0)throw Error("stream index is invalid");
        probeStderr=await runTimelineProcess(ffmpegBin,withDecoderThreads([
          "-v","error","-xerror","-progress","pipe:1","-nostats","-i",inputPath,
          "-map",`0:${extraIndex}`,"-an","-sn","-dn","-frames:v","1","-f","null","-"
        ],getDecodeThreadCount()),line=>{
          const text=String(line).trim();
          const frame=text.match(/^frame=(\\d+)$/);
          if(frame)decodedFrames=Number(frame[1]);
          if(text==="progress=end")progressEnded=true;
        });
        if(!progressEnded||decodedFrames===null)throw Error("FFmpeg did not report a decoded-frame result");
        if(String(probeStderr||"").trim())throw Error(`FFmpeg emitted diagnostics: ${String(probeStderr).trim().slice(-500)}`);
      } catch(err) {
        const detail=String(err?.message||err).replace(/\\s+/g," ").trim().slice(-700);
        const reason=`[Video guard] Additional video stream ${Number.isSafeInteger(extraIndex)?extraIndex:"unknown"} could not be safely classified: ${detail}; keeping original.`;
        if(!args.variables)args.variables={};if(!args.variables.user)args.variables.user={};
        args.variables.user.failure_reason=reason;log(reason);
        return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
      }
      if(decodedFrames>0) {
        const reason=`[Video guard] Additional video stream ${extraIndex} decoded at least one frame; multiple-video policy is unsupported; keeping original.`;
        if(!args.variables)args.variables={};if(!args.variables.user)args.variables.user={};
        args.variables.user.failure_reason=reason;log(reason);
        return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
      }
      log(`[Video guard] Video stream ${extraIndex} produced zero decoded frames; ignoring this empty stream.`);
    }
  }''')
one('    originalSnapshot = { realPath: fs.realpathSync(originalPath),', '    if (fs.realpathSync(inputPath) !== fs.realpathSync(originalPath)) throw new Error("Working file differs from original library file");\n    originalGuardFd=fs.openSync(originalPath,"r");\n    originalSnapshot = { realPath: fs.realpathSync(originalPath),')
one('  // 2. Stream Probing', '''  const saveOriginalSnapshot = (stat, realPath, contentHash) => {
    const previousHash=args.variables.user.original_snapshot?.contentHash;
    originalSnapshot={realPath,dev:stat.dev,ino:stat.ino,size:stat.size,mtimeNs:stat.mtimeNs,ctimeNs:stat.ctimeNs};
    const saved={path:originalPath,realPath,dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)};
    const verifiedHash=contentHash||previousHash;
    if(verifiedHash)saved.contentHash=verifiedHash;
    args.variables.user.original_snapshot=saved;
  };
  const originalSourceSizeInBytes=Number(originalSnapshot.size);
  const initialWorkerProgressDetails={
    sourceFileSizeInBytes:originalSourceSizeInBytes,
    initialOutputSizeBytes:originalSourceSizeInBytes,
    initialEstimateBytes:originalSourceSizeInBytes,
    status:"Preparing: source probe and preflight",
    workerLog:"Preparing source metadata and safety checks.",
    lastPluginDetails:{source:"Community",id:"arc_av1_monolithic",number:"1/1"}
  };
  reportWorkerProgress(args.updateWorker,{percentage:0.1,fps:0,status:initialWorkerProgressDetails.status},initialWorkerProgressDetails);
  const assertOriginalUnchanged = () => {
    const current=fs.statSync(originalPath,{bigint:true});
    const realPath=fs.realpathSync(originalPath);
    const changed=[];
    if(realPath!==originalSnapshot.realPath)changed.push('path');
    if(current.dev!==originalSnapshot.dev)changed.push('device');
    if(current.ino!==originalSnapshot.ino)changed.push('inode');
    if(current.size!==originalSnapshot.size)changed.push('size');
    if(current.mtimeNs!==originalSnapshot.mtimeNs)changed.push('mtime');
    if(current.ctimeNs!==originalSnapshot.ctimeNs)changed.push('ctime');
    if(!changed.length)return;
    const sameStableMetadata=realPath===originalSnapshot.realPath&&current.size===originalSnapshot.size&&current.mtimeNs===originalSnapshot.mtimeNs;
    const identityMoved=current.dev!==originalSnapshot.dev||current.ino!==originalSnapshot.ino;
    let verificationError='';
    if(sameStableMetadata&&identityMoved&&originalGuardFd!==null){
      try{
        const comparison=compareOpenFileToPath(originalGuardFd,originalPath);
        if(comparison.identical){
          const previousHash=args.variables.user.original_snapshot?.contentHash;
          if(previousHash&&previousHash!==comparison.hash)throw new Error('previously verified content hash changed');
          const after=fs.statSync(originalPath,{bigint:true});
          if(fs.realpathSync(originalPath)!==realPath||after.dev!==current.dev||after.ino!==current.ino||after.size!==current.size||after.mtimeNs!==current.mtimeNs||after.ctimeNs!==current.ctimeNs)throw new Error('path changed during byte comparison');
          saveOriginalSnapshot(current,realPath,comparison.hash);
          log(`[Original guard] File identity changed (${changed.join(', ')}) but the current file is byte-for-byte identical; treating it as a Mover relocation.`);
          return;
        }
        verificationError='byte comparison found different contents';
      }catch(err){verificationError=String(err?.message||err);}
    }
    throw new Error(`Original library file changed during processing (changed fields: ${changed.join(', ')}${verificationError?`; relocation verification failed: ${verificationError}`:''})`);
  };

  // 2. Stream Probing''')
one('''  const src = probe(sourcePath);
  const dst = probe(outputPath);''', '''  if(typeof expected.assertOriginalUnchanged==='function')expected.assertOriginalUnchanged();
  const src = probe(sourcePath);
  const dst = probe(outputPath);
  if(typeof expected.assertOriginalUnchanged==='function')expected.assertOriginalUnchanged();''')
one('''    const current = fs.statSync(originalPath, { bigint: true });
    if (fs.realpathSync(originalPath) !== originalSnapshot.realPath || current.dev !== originalSnapshot.dev || current.ino !== originalSnapshot.ino || current.size !== originalSnapshot.size || current.mtimeNs !== originalSnapshot.mtimeNs || current.ctimeNs !== originalSnapshot.ctimeNs) {
      throw new Error("Original library file changed during processing");
    }''', '    assertOriginalUnchanged();')
one('  const tracks = {};\n  for (const type of ["audio", "subtitle"]) {', '''  if (!expected.hdr10 && !expected.hlg && !expected.untagged) validateSdrColor(expected.sdrSource || sourceVideo, video[0]);
  validateAspect(sourceVideo, video[0]);
  if (sourceVideo.width !== video[0].width || sourceVideo.height !== video[0].height) throw new Error("Output video dimensions differ from source");
  if (!expected.sourceFrameScan) {
    const countFrames = (file, index) => {
      const raw = execFileSync(ffprobeBin, ["-v","error","-threads",String(getDecodeThreadCount()),"-select_streams",String(index),"-count_frames","-show_entries","stream=nb_read_frames","-of","json",file], {encoding:"utf8",timeout:12*60*60*1000,maxBuffer:1024*1024});
      const count = Number(JSON.parse(raw).streams?.[0]?.nb_read_frames);
      if (!Number.isSafeInteger(count) || count < 1) throw new Error("Video frame count unavailable");
      return count;
    };
    const sourceFrames=countFrames(sourcePath,sourceVideo.index), outputFrames=countFrames(outputPath,video[0].index);
    if (sourceFrames !== outputFrames) throw new Error(`Video frame count differs: ${sourceFrames} -> ${outputFrames}`);
  }
  const tracks = {};
  for (const type of ["audio", "subtitle"]) {''')
one('  const vCodec = (mainVideo.codec_name || "").toLowerCase();', '''  const markerKey = Object.keys(args.inputFileObj?.ffProbeData?.format?.tags || {}).find(k => k.toLowerCase() === "encoded_by");
  if (isCompletedEncode(String(mainVideo.codec_name || "").toLowerCase(), markerKey ? {[markerKey]:args.inputFileObj.ffProbeData.format.tags[markerKey]} : {})) {
    log("[Arc AV1] Previously processed output; no additional generation.");
    return {outputFileObj:args.inputFileObj,outputNumber:4,variables:args.variables};
  }
  const frameEstimate=estimateVideoFrames(mainVideo,Number(args.inputFileObj?.ffProbeData?.format?.duration || 0));
  const is12Bit = String(mainVideo.pix_fmt || "").toLowerCase().includes("12") || Number(mainVideo.bits_per_raw_sample || 0) === 12;
  let preflightInfoVideo, preflightBasic;
  try {
    const mediaInfo=JSON.parse(execFileSync("mediainfo", ["--Output=JSON", inputPath], {encoding:"utf8", timeout:120000, maxBuffer:16*1024*1024}));
    const infoVideos=(mediaInfo.media?.track || []).filter(t=>String(t["@type"] || "").toLowerCase()==="video");
    preflightInfoVideo=infoVideos.find(t=>Number.isSafeInteger(Number(t.StreamOrder))&&Number(t.StreamOrder)===Number(mainVideo.index));
    if (!preflightInfoVideo && infoVideos.length===1) preflightInfoVideo=infoVideos[0];
    if (!preflightInfoVideo) throw Error(`MediaInfo could not match selected video stream ${mainVideo.index}`);
    preflightBasic=classifyVideo(mainVideo,preflightInfoVideo);
  } catch (err) {
    args.variables.user.failure_reason=`[Video guard] ${err.message || err}; original retained.`;
    log(args.variables.user.failure_reason);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
  let selectedQuality;
  try {
    selectedQuality=selectQualityValue();
    // These checks depend only on the probed stream header. Ignore field_order
    // here because the full decoded-frame scan remains authoritative for it.
    guardSourceVideo({...mainVideo,field_order:"progressive"});
    validateAspect(mainVideo,mainVideo,false);
    if (is12Bit && preflightBasic !== "sdr") throw new Error("12-bit conversion is only verified for tagged SDR sources; HDR, Dolby Vision, and untagged 12-bit video remain held");
    if (preflightBasic !== "sdr") validateMediaInfoHdrColors(mainVideo,preflightInfoVideo);
  } catch (err) {
    args.variables.user.failure_reason=`[Video guard] ${err.message || err}; original retained.`;
    log(args.variables.user.failure_reason);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
  try {
    fs.accessSync(gpuDevice,fs.constants.R_OK|fs.constants.W_OK);
  } catch(err) {
    args.variables.user.failure_reason=`[Arc GPU] Device not accessible: ${gpuDevice}: ${err.message || err}; original retained.`;
    log(args.variables.user.failure_reason);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
  let hybridPreflight='not_hybrid';
  try {
    hybridPreflight=preflightHybridHdr(mainVideo,preflightInfoVideo);
    if(hybridPreflight==='dovi81_hdr10plus_candidate') log("[HDR preflight] DV 8.1/HDR10+ hybrid has a verified HDR10 base candidate; continuing full source scan and strict output validation.");
    if(hybridPreflight==='dovi7_hdr10plus_candidate') log("[HDR preflight] DV Profile 7/HDR10+ hybrid has a verified HDR10-compatible base layer; continuing full source scan and strict output validation.");
  } catch(err) {
    const reason=`[HDR guard] ${err.message || err}; original retained.`;
    args.variables.user.failure_reason=reason;log(reason);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
  let preflightDoviRoute=null,preflightHdrSource=null,preflightHdrLightOverride=null,preflightLevel6=null;
  try {
    preflightDoviRoute=preflightDolbyHdrRoute(mainVideo,preflightInfoVideo,hybridPreflight);
    if(preflightDoviRoute) {
      initialWorkerProgressDetails.status="Precheck: Dolby Vision metadata";
      initialWorkerProgressDetails.workerLog="Checking Dolby Vision base-layer metadata before the full source scan.";
      reportWorkerProgress(args.updateWorker,{percentage:0.5,fps:0,status:initialWorkerProgressDetails.status},initialWorkerProgressDetails);
      const preflightHdrFrames=readHdrFrames(ffprobeBin,inputPath,mainVideo.index);
      preflightHdrSource=mergeHdrMetadata(mainVideo,preflightHdrFrames,{allowMissingLight:true});
      const resolved=await resolveHdrLight(preflightHdrSource,preflightDoviRoute,async()=>{
        preflightLevel6=await extractDolbyLevel6(ffmpegBin,inputPath,mainVideo.index,null,true);
        return preflightLevel6.value;
      });
      preflightHdrSource=resolved.metadata;
      preflightHdrLightOverride=resolved.override;
      const level6Status=preflightLevel6?" and Dolby Level 6 checks":"";
      log(`[HDR preflight] Dolby Vision route ${preflightDoviRoute} passed metadata${level6Status} before the full source scan.`);
    }
  } catch(err) {
    args.variables.user.failure_reason=`[HDR guard] ${err.message || err}; original retained.`;
    log(args.variables.user.failure_reason);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
  const scanOptions={staticMetadata:true,timestamps:true,failFast:true,scanRole:"source",sourceBasic:preflightBasic,threads:getDecodeThreadCount(),expectedColor:mainVideo,expectedFrames:frameEstimate,expectedDuration:Number(mainVideo.duration || args.inputFileObj?.ffProbeData?.format?.duration || 0),assertUnchanged:assertOriginalUnchanged,onProgress:(frames,total,complete,fps,ratio)=>reportWorkerProgress(args.updateWorker,{percentage:1+7*(complete?1:Number.isFinite(ratio)?Math.min(0.99,Math.max(0,ratio)):total>0?Math.min(0.99,frames/total):0),fps,status:"Precheck: full source video scan"},initialWorkerProgressDetails)};
  let frameScan;
  try {
    initialWorkerProgressDetails.status="Precheck: full source video scan";
    initialWorkerProgressDetails.workerLog="Full CPU source frame, color, HDR, and timestamp scan.";
    reportWorkerProgress(args.updateWorker,{percentage:1,fps:0,status:initialWorkerProgressDetails.status},initialWorkerProgressDetails);
    log("[Source precheck] Running the full CPU source frame, color, HDR, and timestamp scan before encoding.");
    frameScan=await inspectVideoFrames(ffprobeBin,inputPath,mainVideo.index,scanOptions);
    assertOriginalUnchanged();
    if(preflightLevel6 && preflightLevel6.frames!==frameScan.frames) throw Error(`Dolby Level 6 frame count mismatch (${preflightLevel6.frames} / ${frameScan.frames})`);
    if (frameScan.interlaced) throw Error("Interlaced video frames are unsupported");
    if (frameScan.colorInfo.conflict) throw Error("Source frame color signaling conflicts with the stream");
    validateSdrFrameSignaling(preflightBasic,frameScan);
  } catch (err) {
    const detail=String(err?.message || err);
    const sourceCorruption=isKnownVideoCorruptionDiagnostic(detail) || detail.toLowerCase().includes('[source media corruption]');
    const sourceDetail=detail.replace(/^(?:\\[Source media corruption\\]\\s*)+/i,'');
    if (!args.variables) args.variables={}; if (!args.variables.user) args.variables.user={};
    const originalGuard=/^Original library file changed during processing/i.test(detail);
    args.variables.user.failure_reason=sourceCorruption ? `[Source media corruption] ${sourceDetail}` : originalGuard ? `[Original guard] ${detail}; original retained.` : `[Video guard] ${detail}; original retained.`;
    log(args.variables.user.failure_reason);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
  reportWorkerProgress(args.updateWorker,{percentage:8,fps:0,status:"Precheck: classify source color and HDR"},initialWorkerProgressDetails);
  let sourceScanFailureDetail="";
  const vCodec = (mainVideo.codec_name || "").toLowerCase();''')
one('  // 2. Audio & Subtitle stream count & codec checks', '''  if (expected.requireMarker && !Object.entries(dst.format?.tags || {}).some(([k,v]) => k.toLowerCase() === "encoded_by" && String(v) === (expected.outputMarker || "ArcAV1_QSV_V15"))) throw new Error("Output completion marker missing");
  let outputFrameScan;
  if (expected.sourceFrameScan || expected.hdr10) {
    reportWorkerProgress(expected.updateWorker,{percentage:82,fps:0,status:"Validation: output frame, color, and HDR scan"});
    const expectedFrames=expected.sourceFrameScan?.frames || estimateVideoFrames(video[0],Number(dst.format?.duration || 0));
    if(typeof expected.assertOriginalUnchanged==='function')expected.assertOriginalUnchanged();
    outputFrameScan = await inspectVideoFrames(ffprobeBin,outputPath,video[0].index,{staticMetadata:!!expected.hdr10 || !!expected.hlg || !!expected.untagged,timestamps:!!expected.sourceFrameScan,failFast:true,scanRole:"candidate",rejectDolbyVision:!!expected.hdr10 || !!expected.hlg || !!expected.untagged,rejectHdr10Plus:!!expected.hdr10 || !!expected.hlg || !!expected.untagged,threads:getDecodeThreadCount(),expectedColor:video[0],expectedFrames,assertUnchanged:expected.assertOriginalUnchanged,onProgress:(frames,total,complete,fps)=>reportWorkerProgress(expected.updateWorker,{percentage:82+8*(complete?1:total>0?Math.min(0.99,frames/total):0),fps,status:"Validation: output frame, color, and HDR scan"})});
    if(typeof expected.assertOriginalUnchanged==='function')expected.assertOriginalUnchanged();
    reportWorkerProgress(expected.updateWorker,{percentage:90,fps:0,status:"Validation: output frame scan complete"});
    if (outputFrameScan.colorInfo.conflict) throw Error("Output frame color signaling conflicts with the stream");
    if (expected.sourceFrameScan) compareVideoTimestamps(expected.sourceFrameScan,outputFrameScan);
  }
  if (expected.hdr10) {
    if (!expected.sourceHdr) throw new Error("HDR10 source metadata missing");
    validateHdr10(expected.sourceHdr, video[0]);
    if (outputFrameScan.interlaced || outputFrameScan.dovi || outputFrameScan.hdr10plus || outputFrameScan.otherDynamic) throw new Error("HDR10 output contains unexpected dynamic metadata or interlacing");
    const hdrRequirements=hdrFrameMetadataRequirements(expected.sourceHdr,expected.optionalHdrStatic);
    checkHdrFrameStatic(expected.sourceHdr,outputFrameScan,hdrRequirements.requireLight,hdrRequirements.requireMastering);
  }
  if (expected.hlg) {
    validateHlg(expected.sourceHdr,video[0]);
    if (outputFrameScan.interlaced || outputFrameScan.dovi || outputFrameScan.hdr10plus || outputFrameScan.otherDynamic || outputFrameScan.staticInfo.mastering || outputFrameScan.staticInfo.light || outputFrameScan.staticInfo.conflict) throw Error("HLG output contains unexpected HDR metadata");
  }
  if (expected.untagged) {
    validateUntaggedOutput(expected.sdrSource,video[0],outputFrameScan);
    if (outputFrameScan.interlaced || outputFrameScan.dovi || outputFrameScan.hdr10plus || outputFrameScan.otherDynamic || outputFrameScan.staticInfo.mastering || outputFrameScan.staticInfo.light || outputFrameScan.staticInfo.conflict) throw Error("Untagged output contains unexpected HDR metadata");
  }

  // 2. Audio & Subtitle stream count & codec checks''')
one('  const isEncodedByUs = Boolean(encodedByKey && String(formatTags[encodedByKey]).includes("ArcAV1_QSV"));','''  const isEncodedByUs = false;
  let hdrClass, hdrSource, sdrSource, hdrLightOverride = null;
  delete args.variables.user.hdr_conversion;
  try {
    const infoVideos = [preflightInfoVideo];
    const basic = preflightBasic;
    if (isVerifiedSdr(basic,frameScan)) {
      validateEffectiveSdrTransfer(mainVideo,infoVideos[0],frameScan);
      sdrSource = effectiveSdrSource(mainVideo,infoVideos[0],frameScan);
      hdrClass = "sdr";
      const unspecifiedSdrFields=["color_transfer","color_primaries"].filter(field=>isUnknownColorValue(sdrSource[field]));
      if (unspecifiedSdrFields.length && normalizeSdrMatrix(mainVideo.color_space)) log(`[Color] Recognized SDR ${normalizeSdrMatrix(mainVideo.color_space)} matrix; ${unspecifiedSdrFields.join(" and ")} remain unspecified.`);
    } else if (isUntaggedVideo(mainVideo,infoVideos[0],frameScan)) {
      hdrClass = "untagged";
      sdrSource = {...mainVideo};
      const effectiveRange=inferUntaggedColorRange(mainVideo,infoVideos[0],frameScan);
      if (!effectiveRange) throw new Error("Untagged SDR YUV range could not be inferred safely");
      sdrSource.color_range=effectiveRange;
      log(`[Color] Input transfer, primaries, and matrix are unspecified; using ${effectiveRange==='tv'?'TV limited':'PC full'} range for the untagged SDR YUV encode.`);
    } else {
      hdrClass = determineHdrRoute(mainVideo,infoVideos[0],frameScan);
      if (hdrClass === "hlg") {
        if (frameScan.staticInfo.mastering || frameScan.staticInfo.light || frameScan.staticInfo.conflict) throw Error("HLG source has additional static HDR metadata that is not verified");
        hdrSource = mainVideo;
        validateHlg(hdrSource,hdrSource);
      } else {
        const canUseDolbyLevel6 = hdrClass === "dovi81_hdr10" || hdrClass === "dovi7_hdr10" || hdrClass === "dovi81_hdr10plus_hdr10" || hdrClass === "dovi7_hdr10plus_hdr10";
        const doviProfile=route=>/^dovi(7|81)_hdr10(?:plus_hdr10)?$/.exec(String(route || ''))?.[1] || '';
        if(doviProfile(preflightDoviRoute) && doviProfile(preflightDoviRoute)===doviProfile(hdrClass) && preflightHdrSource) {
          hdrSource=preflightHdrSource;
          hdrLightOverride=preflightHdrLightOverride;
        } else {
          hdrSource = mergeHdrMetadata(mainVideo,readHdrFrames(ffprobeBin,inputPath,mainVideo.index),{allowMissingLight:canUseDolbyLevel6,allowMissingAll:hdrClass==="hdr10"});
          const resolved = await resolveHdrLight(hdrSource,hdrClass,() => extractDolbyLevel6(ffmpegBin,inputPath,mainVideo.index,frameScan.frames));
          hdrSource = resolved.metadata; hdrLightOverride = resolved.override;
        }
        checkHdrFrameStatic(hdrSource,frameScan,!canUseDolbyLevel6 && hdrClass!=="hdr10",hdrClass!=="hdr10");
      }
      if (hdrClass === "hdr10plus_hdr10") {
        args.variables.user.hdr_conversion = "HDR10+ to HDR10 base layer; HDR10+ dynamic metadata removed";
        log(`[HDR] ${args.variables.user.hdr_conversion}`);
      }
      if (hdrClass === "dovi81_hdr10plus_hdr10") {
        args.variables.user.hdr_conversion = "Hybrid Dolby Vision 8.1 and HDR10+ to verified HDR10; both dynamic metadata formats removed";
        log(`[HDR] ${args.variables.user.hdr_conversion}`);
      }
      if (hdrClass === "dovi7_hdr10plus_hdr10") {
        args.variables.user.hdr_conversion = "Hybrid Dolby Vision Profile 7 and HDR10+ to verified HDR10 base layer; Dolby Vision and HDR10+ dynamic metadata removed";
        log(`[HDR] ${args.variables.user.hdr_conversion}`);
      }
      if (hdrClass === "dovi81_hdr10") {
        args.variables.user.hdr_conversion = "Dolby Vision 8.1 to HDR10 base layer; Dolby Vision dynamic metadata removed";
        log(`[HDR] ${args.variables.user.hdr_conversion}`);
      }
      if (hdrClass === "dovi7_hdr10") {
        args.variables.user.hdr_conversion = "Dolby Vision Profile 7 to HDR10 base layer; Dolby Vision enhancement layer and dynamic metadata removed";
        log(`[HDR] ${args.variables.user.hdr_conversion}`);
      }
    }
  } catch (err) {
    log(`[HDR guard] ${err.message || err}; original retained.`);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }''')

a=e.index('  // Quality-based ICQ encoding is used; no bitrate clamp is applied.')
b=e.index('\n  // 10-bit & Hardware Compatibility Detection',a)
e=e[:a]+'''  // Every eligible source, including AV1 produced by older flows, is re-encoded.
  const isOversizedAV1 = false;
  const isAlreadyAV1 = false;
  quality = selectedQuality;
'''+e[b:]
one('  const rawSizeMB = (args.originalLibraryFile?.file_size || args.inputFileObj?.file_size || (fs.statSync(inputPath).size / (1024 * 1024)));','  const rawSizeMB = fs.statSync(inputPath).size / (1024 * 1024);')
one('  const isTargetRam = typeof targetDir === "string" && targetDir.startsWith("/dev/shm");', '  const isTargetRam = BigInt.asUintN(32,fs.statfsSync(targetDir,{bigint:true}).type) === 16914836n;')
one('Math.abs((d.first-s.first)-shift)>tolerance || Math.abs((d.last-s.last)-shift)>tolerance', 'Math.abs((d.first-s.first)-shift)>0.1 || Math.abs((d.last-s.last)-shift)>0.1')
one('        "-look_ahead", "1",\n        "-look_ahead_depth", "40",\n','')
one('  const needsProactiveHybrid = isH26410bit || isVC1 || isNon420Chroma;', '  const needsProactiveHybrid = !useQsvDecode(mainVideo);')
one('    cmdArgs.push("-i", inputPath);', '    if (hdrLightOverride) cmdArgs.push("-content_light", hdrLightOverride);\n    if (useHybrid && !forceStreamCopy) cmdArgs.push("-threads", String(getDecodeThreadCount()));\n    cmdArgs.push("-i", inputPath);\n    if (is12Bit && !forceStreamCopy) cmdArgs.push("-sws_dither", "ed");')
one('''        } else {
          cmdArgs.push(`-c:s:${idx}`, "copy");
        }
''', r'''        } else {
          cmdArgs.push(`-c:s:${idx}`, "copy");
          if (c === "hdmv_pgs_subtitle" || ['ass','ssa'].includes(c)) {
            cmdArgs.push(`-bsf:s:${idx}`, "setts=pts=if(eq(PTS\\,NOPTS)\\,NOPTS\\,max(PTS\\,PREV_OUTPTS)):dts=if(eq(DTS\\,NOPTS)\\,NOPTS\\,max(DTS\\,PREV_OUTDTS))");
          }
        }
''')
one('        cmdArgs.push("-vf", "format=p010le");', '        cmdArgs.push("-vf", hdrClass === "hdr10plus_hdr10" ? "sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,format=p010le" : "format=p010le");')
one('''      if (useHybrid) {
        cmdArgs.push("-vf", hdrClass === "hdr10plus_hdr10" ? "sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,format=p010le" : "format=p010le");
      } else if (is10Bit) {
        cmdArgs.push("-vf", "vpp_qsv");
      } else {
        cmdArgs.push("-vf", "vpp_qsv=format=p010");
      }''', '''      const baseVideoFilter=useHybrid ? "format=p010le" : is10Bit ? "vpp_qsv" : "vpp_qsv=format=p010";
      const sourceHasContentLight=(hdrSource?.side_data_list || []).some(x=>x.side_data_type==="Content light level metadata");
      const videoFilter=composeVideoFilterChain(baseVideoFilter,{
        removeHdr10Plus:hdrClass==="hdr10plus_hdr10" || hdrClass==="dovi81_hdr10plus_hdr10" || hdrClass==="dovi7_hdr10plus_hdr10",
        removeContentLight:isHdr && !sourceHasContentLight
      });
      cmdArgs.push("-vf",videoFilter);''')
one('    const cmdArgs = ["-y", "-fflags", "+genpts+igndts"];', '    const cmdArgs = ["-y", "-xerror", "-fflags", "+genpts+igndts"];')
one('encoded_by=ArcAV1_QSV','encoded_by=ArcAV1_QSV_V15')
one('cmdArgs.push("-metadata:g", "encoded_by=ArcAV1_QSV_V15");', 'cmdArgs.push("-metadata:g", forceStreamCopy ? "encoded_by=ArcAV1_SeekHeal_V15" : "encoded_by=ArcAV1_QSV_V15");')
one('      codec: expectedVideoCodec,\n', '      codec: expectedVideoCodec,\n      requireMarker: true,\n      hdr10: hdrClass === "hdr10" || hdrClass === "dovi81_hdr10" || hdrClass === "dovi7_hdr10" || hdrClass === "hdr10plus_hdr10" || hdrClass === "dovi81_hdr10plus_hdr10" || hdrClass === "dovi7_hdr10plus_hdr10",\n      optionalHdrStatic: hdrClass === "hdr10",\n      hlg: hdrClass === "hlg",\n      untagged: hdrClass === "untagged",\n      sourceClass: hdrClass,\n      sourceHdr: hdrSource,\n      sdrSource,\n      sourceFrameScan: frameScan,\n      outputMarker: isBloat ? \"ArcAV1_SeekHeal_V15\" : \"ArcAV1_QSV_V15\",\n')
one('      sourceFrameScan: frameScan,\n', '      sourceFrameScan: frameScan,\n      updateWorker: args.updateWorker,\n      assertOriginalUnchanged: assertOriginalUnchanged,\n      audioTimestampRepairIndices: Array.from(audioTimestampRepairs.keys()),\n')
one('    const valResult = await validateOutput(ffprobeBin, inputPath, outputPath, {', '    reportWorkerProgress(args.updateWorker,{percentage:80,fps:0,status:"Validation: output streams and metadata"});\n    const valResult = await validateOutput(ffprobeBin, inputPath, outputPath, {')
a=e.index('  log(`[Arc AV1 Single-Pass] Processing:')
b=e.index('\n  // Cleanup temporary clamped chapters file',a)
e=e[:a]+'''  log(`[Arc AV1] Processing ${inputPath} using global ICQ ${quality}; ${pipelineMode}`);
  const sourceBytes = Number(originalSnapshot.size);
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 1) throw new Error("Original size is invalid");
  args.variables.user.original_size_mb = sourceBytes / (1024 * 1024);
  let isBloat = false;
  const attempt = await runSingleQuality(quality, sourceBytes, async (q) => {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    let result = await runFfmpeg(needsProactiveHybrid, false);
    if (result.error) return {ok:false, ffmpeg:result};
    const reachedLimit = r => fs.existsSync(outputPath) && fs.statSync(outputPath).size >= sourceBytes && (r.signal === 'SIGXFSZ' || /file too large/i.test(String(r.stderr || '')));
    if (reachedLimit(result)) { log(`[Size guard] ICQ ${q} encode hit the source-size cap.`); return {ok:true,size:sourceBytes,ffmpeg:result}; }
    const decodeFailure = /error while decoding|failed to decode|decoder[^\\n]*(?:error|failed)|error submitting packet to decoder|failed to get (?:a )?frame/i.test(String(result.stderr || ""));
    if (result.status !== 0 && !needsProactiveHybrid && decodeFailure) {
      log(`[Arc AV1] Full GPU decode failed at ICQ ${q}: ${extractFfmpegError(result.stderr)}. Trying CPU decode with Arc encode.`);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      result = await runFfmpeg(true, false);
      pipelineMode = `Hybrid (CPU Decode + Arc QSV AV1 Encode)`;
      if (reachedLimit(result)) { log(`[Size guard] ICQ ${q} encode hit the source-size cap.`); return {ok:true,size:sourceBytes,ffmpeg:result}; }
    }
    if (result.status !== 0 || !fs.existsSync(outputPath)) return {ok:false, ffmpeg:result};
    const size = fs.statSync(outputPath).size;
    log(`[Arc AV1] ICQ ${q} produced ${size} bytes; source ${sourceBytes} bytes.`);
    return {ok:true, size, ffmpeg:result};
  });
  let res = attempt.result?.ffmpeg || {status: 1, stderr: `No smaller output at ICQ ${attempt.quality}`};
  if (!attempt.ok && attempt.reason !== "encoder") {
    if (attempt.reason !== "quality_floor") log(`[Arc AV1] Could not verify a valid output size at ICQ ${attempt.quality}.`);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res = {status:1, qualityFloor:attempt.reason === "quality_floor", stderr:`No smaller output at ICQ ${attempt.quality}: ${attempt.reason}`};
  }
'''+e[b:]
a=e.index('  // Bloat Protection (> maxRatioPct for tier)')
b=e.index('\n  // 10. Persist Pipeline Metadata',a)
e=e[:a]+'  cleanupChapters();\n'+e[b:]
one('  const isBloat = !isAlreadyAV1 && (ratioPct > maxRatioPct);','  // isBloat is set only by the strictly smaller, validated seek-heal fallback.')
exec((root/'build_additions.py').read_text())
one('    return spawnSync(ffmpegBin, cmdArgs, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });', '''    const progressStart=forceStreamCopy?80:10,progressEnd=forceStreamCopy?82:80;
    // Encodes stop at source size. Remux file-size limits grow only after the shared cache ledger grants capacity.
    const processSizeLimit=forceStreamCopy?reservedOutputBytes:sourceBytes;
    const processReason=forceStreamCopy
      ? "Size guard fallback: stream-copy the source video with seek-healing mux flags; preserve audio/subtitle processing."
      : `Arc QSV AV1 encode at ICQ ${quality}; validate the resulting video, color metadata, audio, and subtitles.`;
    const workerDetails={
      CLIType:ffmpegBin,
      preset:cmdArgs.join(" "),
      workerLog:processReason,
      status:forceStreamCopy?"Fallback: seek-healing remux":`Encoding: Arc QSV AV1 at ICQ ${quality}`,
      sourceFileSizeInBytes:sourceBytes,
      outputPath,
      lastPluginDetails:{
        source:"Community",
        id:"arc_av1_monolithic",
        number:"1/1"
      }
    };
    const remuxCapacity=forceStreamCopy?{
      outputPath,
      initialBytes:reservedOutputBytes,
      headroomBytes:512n*1024n*1024n,
      chunkBytes:1024n*1024n*1024n,
      grow:(requiredBytes,usedBytes)=>growCapacityReservation(args.variables.user.cache_reservation,requiredBytes,usedBytes,{marginBytes:64n*1024n*1024n}),
      onLimit:bytes=>{
        args.variables.user.cache_reservation_bytes=String(bytes);
        log(`[Cache reservation] Expanded seek-healing remux capacity to ${bytes} bytes on ${targetDir}.`);
      }
    }:undefined;
    return runLimitedFfmpeg({command:"prlimit",argv:[`--fsize=${processSizeLimit}:unlimited`, "--", ffmpegBin, ...cmdArgs],durationSec,updateWorker:args.updateWorker,workerDetails,progressStart,progressEnd,capacity:remuxCapacity});''')
one('    const cmdArgs = ["-y", "-xerror", "-fflags", "+genpts+igndts"];', '    const cmdArgs = ["-y", "-xerror", "-progress", "pipe:1", "-nostats", "-fflags", "+genpts+igndts"];')
one('    const errReason = errTail\n      ? `FFmpeg exit ${res.status}: ${errTail}`', '    const errReason = res.error\n      ? `Unable to start the size-limited encoder: ${res.error.message || res.error}`\n      : errTail\n      ? `FFmpeg exit ${res.status}: ${errTail}`')
one('  if (res.status !== 0 || !fs.existsSync(outputPath)) {', '''  if (res.qualityFloor) {
    log(`[Size guard] No smaller output at ICQ ${attempt.quality}; trying a source-video stream-copy remux with seek healing.`);
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    const remuxRes = await runFfmpeg(false, true);
    cleanupChapters();
    if (remuxRes.status !== 0 || !fs.existsSync(outputPath)) {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
      const remuxError = extractFfmpegError(remuxRes.stderr);
      const remuxExit = remuxRes.capacityError ? `Cache reservation growth stopped the remux: ${remuxRes.capacityError.message || remuxRes.capacityError}` : remuxRes.error ? `FFmpeg could not start: ${remuxRes.error.message || remuxRes.error}` : `FFmpeg exit ${remuxRes.status ?? "unknown"}${remuxRes.signal ? ` (${remuxRes.signal})` : ""}`;
      const remuxOutput = fs.existsSync(outputPath) ? `output ${fs.statSync(outputPath).size} bytes` : "output missing";
      const reason = `${remuxExit}; ${remuxOutput}${remuxError ? `; stderr: ${remuxError}` : ""}`;
      log(`[Size guard] Seek-healing remux failed (${reason}); original retained.`);
      return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
    }
    const remuxBytes = fs.statSync(outputPath).size;
    const remuxLimit=remuxRes.fileSizeLimit ?? reservedOutputBytes;
    if (BigInt(remuxBytes) > remuxLimit) {
      try { fs.unlinkSync(outputPath); } catch (_) {}
      log(`[Cache reservation] Seek-healing remux exceeded its granted output capacity (${remuxBytes} bytes vs ${remuxLimit}); original retained.`);
      return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
    }
    isBloat = true;
    quality = null;
    pipelineMode = "Size Bloat Fallback (Original Video Stream-Copy + Seek Healed)";
    res = {status:0,stderr:remuxRes.stderr || ""};
    log(`[Size guard] Seek-healing remux completed at ${remuxBytes} bytes (source ${sourceBytes}); ${remuxBytes>sourceBytes?"the repaired output is larger than source and will be preserved":"the repaired output is smaller than source"}. Validating before replacement.`);
  }
  if (res.status !== 0 || !fs.existsSync(outputPath)) {''')
one('''  } catch (e) {
    log(`[Arc AV1] Job failed: ${e.message || e}`);
    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
  }
};''', '''  } catch (e) {
    log(`[Arc AV1] Job failed: ${e.message || e}`);
    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
  }
  } finally {
    if(originalGuardFd!==null){try{require('fs').closeSync(originalGuardFd);}catch(_){}}
  }
};''')
e=(root/'progress.js').read_text()+'\n'+e
plugin['inputsDB']['code']=e
flow['flowPlugins'].append({'name':'Discord: Already Processed (Info)','sourceRepo':'Community','pluginName':'customFunction','version':'1.0.0','inputsDB':{'code':'module.exports = async args => ({outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables});'},'fpEnabled':True,'id':'already_completed','position':{'x':1380,'y':850}})
flow['flowEdges'].append({'source':'arc_av1_monolithic','sourceHandle':'4','target':'already_completed','targetHandle':None,'id':'edge_already_completed'})
flow['flowPlugins'].append({'name':'End handled notice','sourceRepo':'Community','pluginName':'customFunction','version':'1.0.0','inputsDB':{'code':'module.exports = async args => ({outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables});'},'fpEnabled':True,'id':'handled_end','position':{'x':1740,'y':850}})
flow['flowEdges'].append({'source':'already_completed','sourceHandle':'1','target':'handled_end','targetHandle':None,'id':'edge_already_processed_end'})

# Keep Arr endpoints and credentials in the node environment; never bake them into a flow export.
arr_config=(root/'arr_config.js').read_text().rstrip()
if arr_config.count('const ARR_CONFIG = {')!=1: raise RuntimeError('Arr configuration template must define exactly one target map')
arr_iso=next(p for p in flow['flowPlugins'] if p['id']=='notify_arr_iso')
arr_action=(root/'arr_action.js').read_text()
if arr_action.count('__ARR_CONFIG_DECLARATION__')!=1: raise RuntimeError('Arr action must contain one configuration placeholder')
arr_iso['name']='Arr: ISO rescan or confirmed source-corruption search'
arr_iso['inputsDB']['code']=arr_action.replace('__ARR_CONFIG_DECLARATION__',arr_config)
success_arr=next(p for p in flow['flowPlugins'] if p['id']=='notify_arr')
success_code=success_arr['inputsDB']['code']
if success_code.count('__ARR_CONFIG_DECLARATION__')!=1: raise RuntimeError('Success Arr node must contain one configuration placeholder')
success_arr['inputsDB']['code']=success_code.replace('__ARR_CONFIG_DECLARATION__',arr_config)

notify=next(p for p in flow['flowPlugins'] if p['id']=='discord_success')
notify_code=notify['inputsDB']['code']
old_sizes='  const origMB = args.originalLibraryFile?.file_size || 0;\n  const newMB = args.inputFileObj?.file_size || args.variables?.user?.final_size_mb || 0;'
new_sizes='  const origMB = args.variables?.user?.original_size_mb || args.originalLibraryFile?.file_size || 0;\n  const newMB = args.variables?.user?.final_size_mb || args.inputFileObj?.file_size || 0;'
if notify_code.count(old_sizes)!=1: raise RuntimeError('Unexpected success notifier size calculation')
notify_code=notify_code.replace(old_sizes,new_sizes,1)
notify_code,n=re.subn(r'const webhookUrl\s*=\s*(?:process\.env\.TDARR_DISCORD_WEBHOOK\s*\|\|\s*)?"https://discord\.com/api/webhooks/[^"\n]+"\s*;', 'const webhookUrl = process.env.TDARR_DISCORD_WEBHOOK;',notify_code)
if n==0 and notify_code.count('const webhookUrl = process.env.TDARR_DISCORD_WEBHOOK;')==1: pass
elif n!=1: raise RuntimeError('Unexpected success notifier webhook declaration')
old_payload='  const payload = JSON.stringify({\n    embeds: [{'
if notify_code.count(old_payload)!=1: raise RuntimeError('Unexpected success notifier payload')
notify_code=notify_code.replace(old_payload,'  const payload = JSON.stringify({\n    allowed_mentions: {parse: []},\n    embeds: [{',1)
notify_anchor='  const payload = JSON.stringify({'
assert notify_code.count(notify_anchor)==1
notify['inputsDB']['code']=notify_code.replace(notify_anchor, '  if (args.variables?.user?.hdr_conversion) descLines.push(`🌈 **HDR:** ${args.variables.user.hdr_conversion}`);\n\n'+notify_anchor)
# Keep Discord credentials out of Tdarr plugin code and its input logs.
already=next(p for p in flow['flowPlugins'] if p['id']=='already_completed')
already_template=(root/'already_notify.js').read_text()
if '__TDARR_DISCORD_WEBHOOK__' in already_template: raise RuntimeError('Already-processed notifier must not embed a webhook')
already['inputsDB']['code']=already_template
template=(root/'failure_notify.js').read_text()
if '__TDARR_DISCORD_WEBHOOK__' in template: raise RuntimeError('Failure notifier must not embed a webhook')
notifier=template
for plugin_id,name,y in [('notify_failure','Notify Failure or ISO Warning',600),('notify_failure_on_error','Notify unexpected error',780)]:
 flow['flowPlugins'].append({'name':name,'sourceRepo':'Community','pluginName':'customFunction','version':'1.0.0','inputsDB':{'code':notifier},'fpEnabled':True,'id':plugin_id,'position':{'x':1800,'y':y}})
for edge in flow['flowEdges']:
 if edge['source'] in ('cleanup_failure','notify_arr_iso') and edge['target']=='fail_flow': edge['target']='notify_failure'
 if edge['source']=='cleanup_failure' and edge['target']=='notify_failure': edge['target']='notify_arr_iso'
flow['flowEdges'].extend([
 {'source':'notify_failure','sourceHandle':'1','target':'fail_flow','targetHandle':None,'id':'edge_failure_notify_fail'},
 {'source':'notify_failure','sourceHandle':'2','target':'handled_end','targetHandle':None,'id':'edge_iso_warning_handled'},
 {'source':'cleanup_on_error','sourceHandle':'1','target':'notify_failure_on_error','targetHandle':None,'id':'edge_error_cleanup_notify'},
])
if any('https://discord.com/api/webhooks/' in p.get('inputsDB',{}).get('code','') for p in flow['flowPlugins']):
 raise RuntimeError('Refusing to export plugin code with an embedded Discord webhook')
guard=next(p for p in flow['flowPlugins'] if p['id']=='original_recheck')
guard['inputsDB']['code']=source_identity+'\n'+guard['inputsDB']['code']
old_snapshot_check="    if (!s.isFile() || fs.realpathSync(original)!==saved.realPath || String(s.dev)!==saved.dev || String(s.ino)!==saved.ino || String(s.size)!==saved.size || String(s.mtimeNs)!==saved.mtimeNs || String(s.ctimeNs)!==saved.ctimeNs) throw new Error('Original changed since job began');"
new_snapshot_check="""    if (!s.isFile()) throw new Error('Original is not a regular file');
    const realPath=fs.realpathSync(original);
    const changed=[];
    if(realPath!==saved.realPath)changed.push('path');
    if(String(s.dev)!==saved.dev)changed.push('device');
    if(String(s.ino)!==saved.ino)changed.push('inode');
    if(String(s.size)!==saved.size)changed.push('size');
    if(String(s.mtimeNs)!==saved.mtimeNs)changed.push('mtime');
    if(String(s.ctimeNs)!==saved.ctimeNs)changed.push('ctime');
    if(changed.length){
      const sameStableMetadata=realPath===saved.realPath&&String(s.size)===saved.size&&String(s.mtimeNs)===saved.mtimeNs;
      if(!sameStableMetadata||!/^([a-f0-9]{64})$/.test(String(saved.contentHash||'')))throw new Error(`Original changed since job began; changed fields: ${changed.join(', ')}`);
      const beforeHash=fs.statSync(original,{bigint:true});
      const beforeRealPath=fs.realpathSync(original);
      if(beforeRealPath!==realPath||beforeHash.dev!==s.dev||beforeHash.ino!==s.ino||beforeHash.size!==s.size||beforeHash.mtimeNs!==s.mtimeNs||beforeHash.ctimeNs!==s.ctimeNs)throw new Error('Original changed while preparing relocation verification');
      const currentHash=hashFilePath(original);
      const afterHash=fs.statSync(original,{bigint:true});
      if(fs.realpathSync(original)!==beforeRealPath||afterHash.dev!==beforeHash.dev||afterHash.ino!==beforeHash.ino||afterHash.size!==beforeHash.size||afterHash.mtimeNs!==beforeHash.mtimeNs||afterHash.ctimeNs!==beforeHash.ctimeNs)throw new Error('Original changed during relocation verification');
      if(currentHash!==saved.contentHash)throw new Error(`Original changed since job began; changed fields: ${changed.join(', ')}; byte comparison failed`);
      Object.assign(saved,{realPath,dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs)});
      log(`[Original guard] File identity changed (${changed.join(', ')}) after processing, but byte-for-byte verification passed; treating it as a Mover relocation.`);
    }"""
if guard['inputsDB']['code'].count(old_snapshot_check)!=1: raise RuntimeError('Unexpected original snapshot check')
guard['inputsDB']['code']=guard['inputsDB']['code'].replace(old_snapshot_check,new_snapshot_check,1)
old_guard='    log(`[Original guard] ${e.message || e}. Original will not be replaced.`);'
new_guard='    if (!args.variables) args.variables={}; if (!args.variables.user) args.variables.user={};\n    args.variables.user.failure_reason=`[Original guard] ${e.message || e}. Original will not be replaced.`;\n    log(args.variables.user.failure_reason);'
if guard['inputsDB']['code'].count(old_guard)!=1: raise RuntimeError('Unexpected original guard')
guard['inputsDB']['code']=guard['inputsDB']['code'].replace(old_guard,new_guard)
fail=next(p for p in flow['flowPlugins'] if p['id']=='fail_flow')
fail.setdefault('inputsDB',{}).update({'customErrorMessage':'{{{args.variables.user.failure_reason}}}', 'failureCategory':'custom', 'customCategoryName':'transcode', 'includeDiagnostics':False, 'showPerformanceMetrics':False, 'analyzeVariables':False})
flow['_id']='ArcAV1_SinglePass_UnattendedV15'
flow['name']='AV1 Intel Arc QSV [Single ICQ, Seek-Heal Fallback V15]'
flow['description']=(
    'Automates Intel Arc QSV AV1 encoding at ICQ 22 for eligible video. A full source precheck and candidate validation guard replacement; if AV1 does not reduce size, the flow tries a validated seek-healing remux using the source video. '
    'Supported HDR and Dolby Vision paths use guarded metadata handling; unsupported or ambiguous sources are held. Audio and subtitle tracks follow the flow’s retention policy. '
    'Item-scoped Arr searches run only for confirmed source corruption; ISO deletion requests an Arr rescan. Discord reports success, failure, already-processed files, and ISO deletion/rescan status.'
)
out=root/'flow.json'
fd=os.open(out,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
with os.fdopen(fd,'w') as f: json.dump(flow,f,ensure_ascii=False,indent=2);f.write('\n')
os.chmod(out,0o600)
print(f'Built {out}, {len(flow["flowPlugins"])} plugins')
