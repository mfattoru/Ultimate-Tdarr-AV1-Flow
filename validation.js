// Validation records are JSON-safe and bounded so diagnostics survive cache cleanup.
const validationDetail=error=>String(error?.message || error || '').trim().slice(-800);
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
  try {
    const value=await operation();
    report.checks.push({stage,outcome:'passed'});
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
    report.outcome=data.outcome;
    report.failure={...data};
    report.stage=report.failure.stage;
    const last=report.checks[report.checks.length-1];
    if(!last || last.stage!==data.stage || last.outcome!==data.outcome || last.code!==data.code)
      report.checks.push({stage:data.stage,outcome:data.outcome,code:data.code});
    if(error?.validation)throw error;
    throw validationFailure(data.outcome,stage,data.code,data.message,data);
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
  return lines.length>0 && lines.every(line=>/^\[truehd @ 0x[0-9a-f]+\] quant_step_size larger than huff_lsbs$/i.test(line));
};
const verifyCandidateDecodes=async({report,canUseQsv=true,audioTracks=[],sourceVideoIndex=0,runVideo,runAudio,checkSource,isCorruption})=>{
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
    let qsvError;
    if(canUseQsv){
      try {await clean(()=>runVideo('qsv'));return;}
      catch(error){qsvError=error;}
    }
    try {await clean(()=>runVideo('software'));}
    catch(error){
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
if(typeof module!=='undefined')module.exports={newValidationReport,validationFailure,validationUnavailable,validationStage,completeValidation,verifyCandidateDecodes,isVerificationInfrastructureDiagnostic};
