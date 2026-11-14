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
const verifyTimestampIsolatedVideo=async({ffmpeg,input,index,threads,expectedFrames,runProcess})=>{
  if (!Number.isSafeInteger(expectedFrames) || expectedFrames<1) throw Error('Expected decoded frame count is unavailable');
  const argv=['-v','error','-xerror','-progress','pipe:1','-nostats','-threads',String(threads),'-i',input,
    '-map',`0:${index}`,'-vf','settb=expr=1/1000000,setpts=N','-fps_mode:v','passthrough',
    '-enc_time_base:v','1:1000000','-f','null','-'];
  let frames=null,complete=false;
  const stderr=await runProcess(ffmpeg,argv,line=>{
    const match=String(line).trim().match(/^frame=\s*(\d+)$/);
    if(match)frames=Number(match[1]);
    if(String(line).trim()==='progress=end')complete=true;
  });
  if(!complete)throw Error('Timestamp-isolated decode did not report complete progress');
  if(frames!==expectedFrames)throw Error(`Timestamp-isolated decode frame count differs: expected ${expectedFrames}, decoded ${frames}`);
  return stderr;
};
const verifyCandidateDecodes=async({report,canUseQsv=true,candidatePacketTimestampsVerified=false,audioTracks=[],sourceVideoIndex=0,runVideo,runAudio,checkSource,isCorruption})=>{
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
if(typeof module!=='undefined')module.exports={newValidationReport,validationFailure,validationUnavailable,validationStage,completeValidation,validateVideoPacketDts,validateRetainedAttachments,verifyCandidateDecodes,verifyTimestampIsolatedVideo,isVerificationInfrastructureDiagnostic};
