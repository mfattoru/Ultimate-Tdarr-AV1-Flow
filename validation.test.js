const test=require('node:test');
const assert=require('node:assert/strict');
const {newValidationReport,validationUnavailable,validationStage,completeValidation,verifyCandidateDecodes}=require('./validation');
const corruption=text=>/invalid data found|corrupt decoded frame/i.test(text);
const failure=(message,processFailure)=>Object.assign(Error(message),processFailure?{processFailure}:{});
function options(overrides={}) {
  return {report:newValidationReport(),canUseQsv:true,audioTracks:[],sourceVideoIndex:0,
    runVideo:async()=>'',runAudio:async()=>'',checkSource:async()=>'',
    isCorruption:()=>corruption,...overrides};
}

test('QSV device failure recovers through one complete software verification',async()=>{
  const modes=[],o=options({runVideo:async mode=>{modes.push(mode);if(mode==='qsv')throw failure('Device creation failed');return '';},checkSource:async()=>{throw Error('source must not be rescanned after successful recovery');}});
  await verifyCandidateDecodes(o);completeValidation(o.report);
  assert.deepEqual(modes,['qsv','software']);
  assert.equal(o.report.outcome,'recovered');
  assert.equal(o.report.recoveries[0].code,'qsv_decode_fallback');
  assert.match(o.report.recoveries[0].diagnostic,/Device creation failed/);
});

test('a QSV corruption diagnostic alone does not establish candidate damage',async()=>{
  const o=options({runVideo:async mode=>{if(mode==='qsv')throw failure('corrupt decoded frame');return '';}});
  await verifyCandidateDecodes(o);completeValidation(o.report);
  assert.equal(o.report.outcome,'recovered');
});

test('unsupported QSV codecs use software directly without a recovery warning',async()=>{
  const modes=[],o=options({canUseQsv:false,runVideo:async mode=>{modes.push(mode);return '';}});
  await verifyCandidateDecodes(o);completeValidation(o.report);
  assert.deepEqual(modes,['software']);assert.equal(o.report.outcome,'passed');
});

test('failed software verification without recognized damage is inconclusive',async()=>{
  const modes=[],o=options({runVideo:async mode=>{modes.push(mode);throw failure(mode==='qsv'?'Device failed':'Cannot allocate memory');}});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='inconclusive');
  assert.deepEqual(modes,['qsv','software']);assert.equal(o.report.outcome,'inconclusive');
});

test('a strict software corruption error rejects the candidate after a clean source check',async()=>{
  const sources=[],o=options({runVideo:async()=>{throw failure('Invalid data found');},checkSource:async(type,index)=>{sources.push([type,index]);return '';}});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='rejected'&&!e.validation.sourceCorruption);
  assert.deepEqual(sources,[['video',0]]);assert.equal(o.report.failure.code,'candidate_decode_corruption');
});

test('source corruption requires an independently failed decode of the affected source stream',async()=>{
  const sources=[],o=options({audioTracks:[[2,1],[4,2]],runAudio:async indices=>{if(indices.includes(2))throw failure('Invalid data found');return '';},checkSource:async(type,index)=>{sources.push([type,index]);throw failure('corrupt decoded frame');}});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.sourceCorruption===true);
  assert.deepEqual(sources,[['audio',4]]);
  assert.equal(o.report.failure.sourceCorruption,true);
});

test('timeout takes precedence over incidental corruption text in process diagnostics',async()=>{
  let sourceChecks=0;
  const o=options({canUseQsv:false,runVideo:async()=>{throw failure('timed out after Invalid data found',{timedOut:true,diagnostic:'Invalid data found'});},checkSource:async()=>{sourceChecks++;}});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='inconclusive');
  assert.equal(sourceChecks,0);
});

test('error-level diagnostics on a zero exit code still require a clean CPU result',async()=>{
  const o=options({runVideo:async()=> 'Invalid data found'});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='rejected');
});

test('a batch audio tool failure stays inconclusive when each individual track passes',async()=>{
  let sourceChecks=0;
  const o=options({audioTracks:[[1,1],[2,2]],runAudio:async indices=>{if(indices.length>1)throw failure('Cannot allocate memory');return '';},checkSource:async()=>{sourceChecks++;}});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='inconclusive');
  assert.equal(sourceChecks,0);
});

test('infrastructure exceptions cannot become confirmed validation mismatches',async()=>{
  const report=newValidationReport();
  await assert.rejects(validationStage(report,'stream_probe',async()=>{throw Object.assign(Error('spawn ENOENT'),{code:'ENOENT'});}),e=>e.validation?.outcome==='inconclusive');
  assert.equal(report.failure.stage,'stream_probe');
  assert.equal(report.outcome,'inconclusive');
});

test('a proven content mismatch remains rejected and cannot be completed as passed',async()=>{
  const report=newValidationReport();
  await assert.rejects(validationStage(report,'streams',async()=>{throw Error('Output audio count 0 does not match expected 1');},'rejected'),e=>e.validation?.outcome==='rejected');
  assert.throws(()=>completeValidation(report),/incomplete|failed/i);
});

test('a successful GPU recovery cannot approve a later failed audio check',async()=>{
  const o=options({audioTracks:[[1,1]],runVideo:async mode=>{if(mode==='qsv')throw Error('Device failed');return '';},runAudio:async()=>{throw Error('Invalid data found');}});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='rejected');
  assert.equal(o.report.outcome,'rejected');assert.equal(o.report.recoveries[0].outcome,'passed');
  assert.throws(()=>completeValidation(o.report),/incomplete|failed/i);
});

test('an interrupted source recheck cannot authorize a source corruption search',async()=>{
  const o=options({canUseQsv:false,runVideo:async()=>{throw Error('Invalid data found');},checkSource:async()=>{throw failure('timed out after Invalid data found',{timedOut:true});}});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='rejected'&&e.validation.sourceCorruption===false);
});

test('nested checks preserve the specific inconclusive stage without duplicating the failure',async()=>{
  const report=newValidationReport();
  await assert.rejects(validationStage(report,'candidate_validation',()=>validationStage(report,'frames',async()=>{throw validationUnavailable('Decoded frame metadata unavailable');},'rejected')));
  assert.equal(report.outcome,'inconclusive');assert.equal(report.failure.stage,'frames');
  assert.deepEqual(report.checks,[{stage:'frames',outcome:'inconclusive',code:'measurement_unavailable'}]);
});

test('resource errors containing decoder-error wording cannot classify media corruption',async()=>{
  let sourceChecks=0;
  const o=options({canUseQsv:false,isCorruption:()=>text=>/error while decoding|invalid data/i.test(text),
    runVideo:async()=>{throw failure('Error while decoding stream #0:0: Cannot allocate memory',{status:1,signal:null,timedOut:false});},
    checkSource:async()=>{sourceChecks++;throw Error('Error while decoding stream #0:0: Cannot allocate memory');}});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='inconclusive'&&e.validation.sourceCorruption===false);
  assert.equal(sourceChecks,0);
});
