// Validation records are JSON-safe and bounded so diagnostics survive cache cleanup.
const validationDetail=error=>{
  const text=String(error?.message || error || '').trim();
  return text.length>800?`${text.slice(0,350)} ... ${text.slice(-430)}`:text;
};
// FFmpeg often prefixes resource/device failures with "Error while decoding".
// Those diagnostics must take precedence over generic bitstream signatures.
const VERIFICATION_INFRASTRUCTURE_RE=/cannot allocate memory|out of memory|\benomem\b|no space left on device|permission denied|operation not permitted|resource temporarily unavailable|too many open files|input\/output error|\b(?:enospc|eacces|eperm|eagain|enodev|eio)\b|device (?:creation|setup|initiali[sz]ation) failed|failed to (?:create|initiali[sz]e) (?:a |the )?(?:hardware |qsv |vaapi )?(?:device|session)|(?:unknown|no|unsupported) decoder|decoder [^\n]*not found|(?:function|operation) not implemented/i;
const isVerificationInfrastructureDiagnostic=text=>VERIFICATION_INFRASTRUCTURE_RE.test(String(text || ''));
const newValidationReport=()=>({version:1,outcome:'running',stage:'pending',checks:[],recoveries:[]});
const validationFailure=(outcome,stage,code,message,details={})=>{
  const error=Error(message);
  error.validation={outcome,stage,code,message:String(message).slice(-1200),...details};
  return error;
};
const validationUnavailable=(message)=>validationFailure('inconclusive','', 'measurement_unavailable',message);
const validationStage=async(report,stage,operation,mismatchOutcome='inconclusive')=>{
  report.stage=stage;
  const startedAt=Date.now();
  let stageOutcome='inconclusive';
  try { if(typeof report.stageLogger==='function')report.stageLogger({stage,outcome:'started',elapsedMs:0}); } catch (_) {}
  try {
    const value=await operation();
    report.checks.push({stage,outcome:'passed'});
    stageOutcome='passed';
    return value;
  } catch(error) {
    const infrastructure=error?.processFailure || error?.code || !(error instanceof Error) || error.constructor!==Error;
    const originalChanged=/^Original library file changed during processing/i.test(String(error?.message || ''));
    const data=error?.validation || {
      outcome:infrastructure || originalChanged?'inconclusive':mismatchOutcome,
      stage,code:originalChanged?'source_changed':infrastructure?'verification_tool_failed':'validation_mismatch',
      message:validationDetail(error)
    };
    if(!data.stage)data.stage=stage;
    stageOutcome=data.outcome;
    report.outcome=data.outcome;
    report.failure={...data};
    report.stage=report.failure.stage;
    const last=report.checks[report.checks.length-1];
    if(!last || last.stage!==data.stage || last.outcome!==data.outcome || last.code!==data.code)
      report.checks.push({stage:data.stage,outcome:data.outcome,code:data.code});
    if(error?.validation)throw error;
    throw validationFailure(data.outcome,stage,data.code,data.message,data);
  } finally {
    try { if(typeof report.stageLogger==='function')report.stageLogger({stage,outcome:stageOutcome,elapsedMs:Date.now()-startedAt}); } catch (_) {}
  }
};
const completeValidation=report=>{
  if(report.outcome!=='running')throw Error('Cannot approve incomplete or failed validation');
  report.outcome=report.recoveries.length?'recovered':'passed';
  report.stage='complete';
  return report;
};
const validationDecodeInfrastructure=error=>{
  const failure=error?.processFailure;
  return !!(failure?.timedOut || failure?.signal || failure?.infrastructure || error?.code || error instanceof SyntaxError || isVerificationInfrastructureDiagnostic(failure?.diagnostic || validationDetail(error)));
};
const isKnownNonFatalTrueHdDiagnostic=text=>{
  const lines=String(text || '').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  let sawWarning=false,previousWasWarning=false;
  for(const line of lines){
    if(/^\[truehd @ 0x[0-9a-f]+\] quant_step_size larger than huff_lsbs$/i.test(line)){
      sawWarning=true;previousWasWarning=true;
    } else if(previousWasWarning && /^Last message repeated [1-9]\d* times?$/i.test(line)){
      previousWasWarning=false;
    } else return false;
  }
  return sawWarning;
};
const isBenignQsvInitLine=line=>/^libva info:/i.test(line) || /^(?:d?river)\(\) returns 0$/i.test(line);
const isBenignQsvInitializationDiagnostic=text=>{
  const lines=String(text || '').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  return lines.length>0 && lines.every(isBenignQsvInitLine);
};
const isNullMuxDtsOnlyDiagnostic=text=>{
  const lines=String(text || '').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  let sawMuxDts=false,previousWasMuxDts=false;
  for(const line of lines){
    if(/^\[null @ 0x[0-9a-f]+\] Application provided invalid, non monotonically increasing dts to muxer\b/i.test(line)){
      sawMuxDts=true;previousWasMuxDts=true;
    } else if(previousWasMuxDts && /^Last message repeated [1-9]\d* times?$/i.test(line)){
      previousWasMuxDts=false;
    } else if(isBenignQsvInitLine(line) || /^\.\.\. diagnostics truncated \.\.\.$/i.test(line)){
      previousWasMuxDts=false;
    } else return false;
  }
  return sawMuxDts;
};
const validateVideoPacketDts=(source,candidate)=>{
  const before=source?.outputDtsNonIncreasingCount,after=candidate?.outputDtsNonIncreasingCount;
  if(!Number.isSafeInteger(before)||before<0||!Number.isSafeInteger(after)||after<0)
    throw validationUnavailable('Video packet DTS ordering could not be measured');
  if(after>before)throw validationFailure('inconclusive','timelines','video_packet_dts_unverified',`Candidate video has ${after} non-increasing DTS transitions; source has ${before}. Review packet timing before replacement.`);
};
const validateRetainedAttachments=(sourceStreams,candidateStreams,sourceIndices)=>{
  if(!Array.isArray(sourceStreams)||!Array.isArray(candidateStreams)||!Array.isArray(sourceIndices))
    throw validationUnavailable('Attachment stream comparison is unavailable');
  const source=sourceIndices.map(index=>sourceStreams.find(stream=>stream.codec_type==='attachment'&&stream.index===index));
  if(source.some(stream=>!stream))throw validationUnavailable('Retained source attachment is unavailable for verification');
  const output=candidateStreams.filter(stream=>stream.codec_type==='attachment');
  if(output.length!==source.length)throw validationFailure('rejected','streams','attachment_count_mismatch',`Output attachment count ${output.length} does not match expected ${source.length}`);
  for(let index=0;index<source.length;index++){
    const from=source[index],to=output[index];
    if(!/^SHA256:[a-f0-9]{64}$/i.test(String(from.extradata_hash||''))||!/^SHA256:[a-f0-9]{64}$/i.test(String(to.extradata_hash||'')))
      throw validationUnavailable(`Attachment payload hash unavailable at index ${index}`);
    if(from.extradata_hash.toLowerCase()!==to.extradata_hash.toLowerCase())
      throw validationFailure('rejected','streams','attachment_payload_changed',`Attachment payload changed at index ${index}`);
    const tagValue=(stream,name)=>String(Object.entries(stream.tags || {}).find(([key])=>key.toLowerCase()===name)?.[1] || '');
    for(const tag of ['filename','mimetype'])if(tagValue(from,tag)!==tagValue(to,tag))
      throw validationFailure('rejected','streams','attachment_metadata_changed',`Attachment ${tag} changed at index ${index}`);
  }
};
// Synthetic PTS are confined to the null sink; the saved candidate is never changed.
const verifyTimestampIsolatedVideo=async({ffmpeg,input,index,threads,expectedFrames,runProcess,onProgress=null})=>{
  if (!Number.isSafeInteger(expectedFrames) || expectedFrames<1) throw Error('Expected decoded frame count is unavailable');
  const argv=['-v','error','-xerror','-progress','pipe:1','-nostats','-threads',String(threads),'-i',input,
    '-map',`0:${index}`,'-vf','settb=expr=1/1000000,setpts=N','-fps_mode:v','passthrough',
    '-enc_time_base:v','1:1000000','-f','null','-'];
  let frames=null,complete=false,fps=0,lastReportAt=0;
  const stderr=await runProcess(ffmpeg,argv,line=>{
    const trimmed=String(line).trim();
    const match=trimmed.match(/^frame=\s*(\d+)$/);
    if(match)frames=Number(match[1]);
    const fpsMatch=trimmed.match(/^fps=\s*([\d.]+)$/);
    if(fpsMatch)fps=Number(fpsMatch[1])||0;
    const isEnd=trimmed==='progress=end';
    if(isEnd)complete=true;
    if((isEnd||trimmed==='progress=continue')&&typeof onProgress==='function'&&Number.isSafeInteger(frames)){
      const now=Date.now();
      if(isEnd||now-lastReportAt>=1000){
        lastReportAt=now;
        try{onProgress(frames,expectedFrames,isEnd,fps);}catch(_){}
      }
    }
  });
  if(!complete)throw Error('Timestamp-isolated decode did not report complete progress');
  if(frames!==expectedFrames)throw Error(`Timestamp-isolated decode frame count differs: expected ${expectedFrames}, decoded ${frames}`);
  return stderr;
};
const verifyCandidateDecodes=async({report,canUseQsv=true,candidatePacketTimestampsVerified=false,proactiveTimestampIsolated=false,audioTracks=[],sourceVideoIndex=0,runVideo,runAudio,checkSource,isCorruption})=>{
  const clean=async(operation,allowDiagnostic)=>{
    const diagnostic=String(await operation() || '').trim();
    // All decoder commands use -v error. Exit zero with error-level output is
    // not sufficient evidence of a clean decode, except the TrueHD warning
    // already tolerated by the full source precheck when the process exits 0.
    if(diagnostic && !(typeof allowDiagnostic==='function' && allowDiagnostic(diagnostic)))throw Error(diagnostic);
  };
  const failDecode=async(type,errors)=>{
    const isDamage=isCorruption(type);
    const damaged=errors.filter(({error})=>!validationDecodeInfrastructure(error)&&isDamage(validationDetail(error)));
    const sourceDamage=[];
    for(const entry of damaged){
      try {await clean(()=>checkSource(type,entry.sourceIndex));}
      catch(sourceError){
        if(!validationDecodeInfrastructure(sourceError)&&isDamage(validationDetail(sourceError)))
          sourceDamage.push({type,index:entry.sourceIndex,diagnostic:validationDetail(sourceError)});
      }
    }
    const diagnostic=errors.map(({sourceIndex,error})=>`source mapping 0:${sourceIndex}: ${validationDetail(error)}`).join(' | ').slice(-1600);
    const sourceCorruption=sourceDamage.length>0;
    const message=sourceCorruption
      ? `[Source media corruption] ${sourceDamage.map(x=>`${x.type} source stream 0:${x.index}: ${x.diagnostic}`).join(' | ')}; candidate ${type} decode also failed: ${diagnostic}`
      : `Candidate ${type} ${damaged.length?'decode reported corruption':'verification could not complete'}: ${diagnostic}`;
    throw validationFailure(damaged.length?'rejected':'inconclusive',`${type}_decode`,damaged.length?'candidate_decode_corruption':'decode_unverified',message,
      {sourceCorruption,diagnostics:errors.map(({sourceIndex,error})=>({sourceIndex,diagnostic:validationDetail(error)})).slice(0,8),sourceDamage:sourceDamage.slice(0,8)});
  };
  await validationStage(report,'video_decode',async()=>{
    const handleNullMuxTimestamp=async error=>{
      const detail=String(error?.processFailure?.diagnostic || error?.message || error);
      if(!isNullMuxDtsOnlyDiagnostic(detail)
          || validationDecodeInfrastructure(error) || isCorruption('video')(detail)) return false;
      if(!candidatePacketTimestampsVerified) await failDecode('video',[{sourceIndex:sourceVideoIndex,error}]);
      try { await clean(()=>runVideo('timestamp-isolated')); }
      catch(retryError) { await failDecode('video',[{sourceIndex:sourceVideoIndex,error:retryError}]); }
      report.recoveries.push({code:'timestamp_isolated_decode',outcome:'passed',diagnostic:validationDetail(error)});
      return true;
    };
    if(proactiveTimestampIsolated && candidatePacketTimestampsVerified){
      try { await clean(()=>runVideo('timestamp-isolated')); }
      catch(retryError) { await failDecode('video',[{sourceIndex:sourceVideoIndex,error:retryError}]); }
      report.recoveries.push({code:'timestamp_isolated_decode',outcome:'passed',diagnostic:'Proactively routed to timestamp-isolated decode after verified matched candidate DTS ties'});
      return;
    }
    let qsvError;
    if(canUseQsv){
      try {await clean(()=>runVideo('qsv'),isBenignQsvInitializationDiagnostic);return;}
      catch(error){qsvError=error;}
      if(await handleNullMuxTimestamp(qsvError))return;
    }
    try {await clean(()=>runVideo('software'));}
    catch(error){
      if(await handleNullMuxTimestamp(error))return;
      if(qsvError)report.recoveries.push({code:'qsv_decode_fallback',outcome:'failed',diagnostic:validationDetail(qsvError)});
      await failDecode('video',[{sourceIndex:sourceVideoIndex,error}]);
    }
    if(qsvError)report.recoveries.push({code:'qsv_decode_fallback',outcome:'passed',diagnostic:validationDetail(qsvError)});
  });
  if(!audioTracks.length)return;
  await validationStage(report,'audio_decode',async()=>{
    const outputIndices=audioTracks.map(([,index])=>index);
    try {await clean(()=>runAudio(outputIndices),isKnownNonFatalTrueHdDiagnostic);return;}
    catch(batchError){
      if(audioTracks.length===1)await failDecode('audio',[{sourceIndex:audioTracks[0][0],error:batchError}]);
      const errors=[];
      for(const [sourceIndex,outputIndex] of audioTracks){
        try {await clean(()=>runAudio([outputIndex]),isKnownNonFatalTrueHdDiagnostic);}
        catch(error){errors.push({sourceIndex,error});}
      }
      if(errors.length)await failDecode('audio',errors);
      throw validationFailure('inconclusive','audio_decode','audio_batch_unverified',`Combined candidate audio verification failed although individual tracks passed: ${validationDetail(batchError)}`);
    }
  });
};
/** Measure video, audio, and subtitle packet timelines in a single container pass. */
const measureStreamTimelinesBatch = async (ffprobe, file, targets, runProcess, onProgress, durationHint, role='file') => {
  if (!Array.isArray(targets) || targets.length === 0) return new Map();
  const states = new Map();
  const orderedStates = [];
  for (const target of targets) {
    const idx = Number(target?.index);
    const type = target?.type;
    if (!Number.isSafeInteger(idx) || idx < 0 || !['video','audio','subtitle'].includes(type)) {
      throw validationUnavailable(`Invalid timeline scan target: ${JSON.stringify(target)}`);
    }
    const ignoreEmptySubtitleMaxBytes = type === 'subtitle'
      && Number.isSafeInteger(target?.ignoreEmptySubtitleMaxBytes)
      && target.ignoreEmptySubtitleMaxBytes > 0
      ? target.ignoreEmptySubtitleMaxBytes
      : 0;
    const state = {
      index: idx,
      type,
      ignoreEmptySubtitleMaxBytes,
      first: Infinity,
      last: -Infinity,
      count: 0,
      packetCount: 0,
      invalid: 0,
      missingPtsCount: 0,
      missingTimestampCount: 0,
      previousDts: null,
      outputDtsNonIncreasingCount: 0,
      missingDtsCount: 0,
      missingPtsPackets: [],
      missingTimestampPackets: [],
      missingPtsBitmap: Buffer.alloc(0),
      missingTimestampBitmap: Buffer.alloc(0)
    };
    states.set(idx, state);
    orderedStates.push(state);
  }
  const markMissingPacket = (bitmap, ordinal) => {
    const byteIndex = Math.floor(ordinal / 8);
    if (byteIndex >= bitmap.length) {
      const grown = Buffer.alloc(Math.max(byteIndex + 1, bitmap.length ? bitmap.length * 2 : 1024));
      bitmap.copy(grown);
      bitmap = grown;
    }
    bitmap[byteIndex] |= 1 << (ordinal % 8);
    return bitmap;
  };
  const readCompactField = (text, key) => {
    const token = `${key}=`;
    let pos = 0;
    while (true) {
      const found = text.indexOf(token, pos);
      if (found < 0) return undefined;
      if (found === 0 || text.charCodeAt(found - 1) === 124) {
        const valStart = found + token.length;
        const bar = text.indexOf('|', valStart);
        return bar < 0 ? text.slice(valStart) : text.slice(valStart, bar);
      }
      pos = found + 1;
    }
  };
  const needSize = orderedStates.some(s => s.ignoreEmptySubtitleMaxBytes > 0);
  const singleState = orderedStates.length === 1 ? orderedStates[0] : null;
  const packetEntries = singleState
    ? (needSize ? 'packet=pts_time,dts_time,duration_time,pos,size' : 'packet=pts_time,dts_time,duration_time,pos')
    : (needSize ? 'packet=stream_index,pts_time,dts_time,duration_time,pos,size' : 'packet=stream_index,pts_time,dts_time,duration_time,pos');
  const argv = singleState
    ? ['-v','error','-select_streams',String(singleState.index),'-show_packets','-show_entries',packetEntries,'-of','compact=p=0:nk=0',file]
    : ['-v','error','-show_packets','-show_entries',packetEntries,'-of','compact=p=0:nk=0',file];
  let fileBytes = 0, lastPosition = 0, lastRatio = 0, lastReported = -1, lastReportAt = 0, hasPacketPosition = false;
  try { fileBytes = require('fs').statSync(file).size; } catch (_) {}
  const emitProgress = (ptsValue, position) => {
    if (typeof onProgress !== 'function') return;
    if (Number.isFinite(position) && position >= 0) {
      lastPosition = Math.max(lastPosition, position);
      hasPacketPosition = true;
    }
    let ratio = fileBytes > 0 && hasPacketPosition
      ? lastPosition / fileBytes
      : (Number.isFinite(ptsValue) && durationHint > 0 ? ptsValue / durationHint : 0);
    ratio = Math.max(lastRatio, Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0)));
    lastRatio = ratio;
    const now = Date.now();
    if (ratio - lastReported >= 0.002 || now - lastReportAt >= 1000 || ratio >= 1) {
      lastReported = ratio;
      lastReportAt = now;
      try { onProgress(ratio); } catch (_) {}
    }
  };
  await runProcess(ffprobe, argv, line => {
    const text = String(line || '');
    const posRaw = readCompactField(text, 'pos');
    const position = posRaw !== undefined && posRaw !== 'N/A' && posRaw !== '' ? Number(posRaw) : NaN;
    let state = singleState;
    if (!state) {
      const rawIdx = readCompactField(text, 'stream_index');
      if (rawIdx !== undefined && rawIdx.trim() !== '') {
        const idx = Number(rawIdx);
        if (Number.isSafeInteger(idx)) state = states.get(idx);
      }
    }
    if (!state) {
      if (Number.isFinite(position) && position >= 0) emitProgress(NaN, position);
      return;
    }
    const ptsRaw = readCompactField(text, 'pts_time');
    const dtsRaw = readCompactField(text, 'dts_time');
    if (ptsRaw === undefined && dtsRaw === undefined) return;
    const packetOrdinal = state.packetCount++;
    const pts = ptsRaw !== undefined && ptsRaw !== 'N/A' && ptsRaw !== '' ? Number(ptsRaw) : NaN;
    const dts = dtsRaw !== undefined && dtsRaw !== 'N/A' && dtsRaw !== '' ? Number(dtsRaw) : NaN;
    const durRaw = readCompactField(text, 'duration_time');
    const duration = durRaw !== undefined && durRaw !== 'N/A' && durRaw !== '' ? Number(durRaw) : 0;
    const sizeRaw = state.ignoreEmptySubtitleMaxBytes > 0 ? readCompactField(text, 'size') : undefined;
    const packetSize = sizeRaw !== undefined && sizeRaw !== 'N/A' && sizeRaw !== '' ? Number(sizeRaw) : NaN;
    if (Number.isFinite(dts)) {
      if (state.previousDts !== null && dts <= state.previousDts) state.outputDtsNonIncreasingCount++;
      state.previousDts = dts;
    } else state.missingDtsCount++;
    if (!Number.isFinite(pts)) {
      state.missingPtsCount++;
      if (state.missingPtsPackets.length < 1024) state.missingPtsPackets.push(packetOrdinal);
      if (state.type === 'audio') state.missingPtsBitmap = markMissingPacket(state.missingPtsBitmap, packetOrdinal);
    }
    if (!Number.isFinite(pts) && !Number.isFinite(dts)) {
      state.missingTimestampCount++;
      if (state.missingTimestampPackets.length < 1024) state.missingTimestampPackets.push(packetOrdinal);
      if (state.type === 'audio') state.missingTimestampBitmap = markMissingPacket(state.missingTimestampBitmap, packetOrdinal);
    }
    emitProgress(Number.isFinite(pts) ? pts : dts, position);
    if (state.ignoreEmptySubtitleMaxBytes > 0 && Number.isFinite(packetSize) && packetSize <= state.ignoreEmptySubtitleMaxBytes) return;
    const timelineTime = state.type === 'audio' && !Number.isFinite(pts) ? dts : pts;
    if (!Number.isFinite(timelineTime)) { state.invalid++; return; }
    state.first = Math.min(state.first, timelineTime);
    state.last = Math.max(state.last, timelineTime + (Number.isFinite(duration) && duration > 0 ? duration : 0));
    state.count++;
  });
  if (typeof onProgress === 'function') try { onProgress(1); } catch (_) {}
  const results = new Map();
  for (const state of orderedStates) {
    if (state.invalid && state.type !== 'audio') {
      const firstMissing = (state.missingTimestampPackets[0] ?? state.missingPtsPackets[0]);
      const packetText = firstMissing === undefined ? '' : ' (first at packet ' + (firstMissing + 1) + ')';
      throw validationUnavailable(`${state.type} ${role} stream ${state.index} has ${state.invalid} packets without a usable ${state.type === 'audio' ? 'PTS or DTS' : 'PTS'}${packetText}`);
    }
    if (state.count === 0 && state.type === 'subtitle') { results.set(state.index, { empty: true }); continue; }
    if (state.count === 0 && state.type === 'audio' && state.packetCount > 0) throw validationUnavailable(`audio ${role} stream ${state.index} has no packets with usable PTS or DTS`);
    if (state.count === 0 || !Number.isFinite(state.first) || !Number.isFinite(state.last) || (state.type === 'video' && (state.count < 2 || !(state.last > state.first)))) {
      throw validationUnavailable(`${state.type} ${role} stream ${state.index} timeline is unavailable or too short to verify`);
    }
    const bitmapBytes = Math.ceil(state.packetCount / 8);
    results.set(state.index, {
      first: state.first,
      last: state.last,
      duration: state.last - state.first,
      packets: state.count,
      totalPackets: state.packetCount,
      outputDtsNonIncreasingCount: state.outputDtsNonIncreasingCount,
      missingDtsCount: state.missingDtsCount,
      missingPtsCount: state.missingPtsCount,
      missingPtsPackets: state.missingPtsPackets,
      missingPtsTruncated: state.missingPtsCount > state.missingPtsPackets.length,
      missingPtsBitmap: state.missingPtsBitmap.subarray(0, bitmapBytes),
      missingTimestampCount: state.missingTimestampCount,
      missingTimestampPackets: state.missingTimestampPackets,
      missingTimestampsTruncated: state.missingTimestampCount > state.missingTimestampPackets.length,
      missingTimestampBitmap: state.missingTimestampBitmap.subarray(0, bitmapBytes),
      empty: false
    });
  }
  return results;
};
if(typeof module!=='undefined')module.exports={newValidationReport,validationFailure,validationUnavailable,validationStage,completeValidation,validateVideoPacketDts,validateRetainedAttachments,verifyCandidateDecodes,verifyTimestampIsolatedVideo,isVerificationInfrastructureDiagnostic,measureStreamTimelinesBatch};
