const test=require('node:test');
const assert=require('node:assert/strict');
const {newValidationReport,validationUnavailable,validationStage,completeValidation,verifyCandidateDecodes}=require('../src/validation');
const corruption=text=>/invalid data found|corrupt decoded frame/i.test(text);
const failure=(message,processFailure)=>Object.assign(Error(message),processFailure?{processFailure}:{});
function options(overrides={}) {
  return {report:newValidationReport(),canUseQsv:true,audioTracks:[],sourceVideoIndex:0,
    runVideo:async()=>'',runAudio:async()=>'',checkSource:async()=>'',
    isCorruption:()=>corruption,...overrides};
}

const muxTimestampError='[null @ 0x55f8a6427a40] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 146774 >= 146774';
test('ASS subtitle attachments must retain their payloads and identifying metadata',()=>{
 const {validateRetainedAttachments}=require('../src/validation');
 const source=[{index:17,codec_type:'attachment',extradata_hash:`SHA256:${'a'.repeat(64)}`,tags:{filename:'font.ttf',mimetype:'font/ttf'}}];
 const output=[{index:4,codec_type:'attachment',extradata_hash:`SHA256:${'a'.repeat(64)}`,tags:{filename:'font.ttf',mimetype:'font/ttf'}}];
 assert.doesNotThrow(()=>validateRetainedAttachments(source,output,[17]));
 assert.doesNotThrow(()=>validateRetainedAttachments([{...source[0],tags:{FILENAME:'font.ttf',MIMETYPE:'font/ttf'}}],output,[17]));
 assert.throws(()=>validateRetainedAttachments([{...source[0],tags:{FILENAME:'other.ttf',MIMETYPE:'font/ttf'}}],output,[17]),e=>e.validation?.outcome==='rejected');
 assert.throws(()=>validateRetainedAttachments(source,[],[17]),e=>e.validation?.outcome==='rejected');
 assert.throws(()=>validateRetainedAttachments(source,[{...output[0],extradata_hash:`SHA256:${'b'.repeat(64)}`}],[17]),e=>e.validation?.outcome==='rejected');
 assert.throws(()=>validateRetainedAttachments(source,[{...output[0],extradata_hash:undefined}],[17]),e=>e.validation?.outcome==='inconclusive');
 assert.throws(()=>validateRetainedAttachments(source,[{...output[0],tags:{filename:'other.ttf',mimetype:'font/ttf'}}],[17]),e=>e.validation?.outcome==='rejected');
});
test('video packet order worsening requires review even if frames were decoded',()=>{
 const {validateVideoPacketDts}=require('../src/validation');
 assert.throws(()=>validateVideoPacketDts({outputDtsNonIncreasingCount:0},{outputDtsNonIncreasingCount:2}),e=>e.validation?.outcome==='inconclusive'&&e.validation.code==='video_packet_dts_unverified');
 assert.doesNotThrow(()=>validateVideoPacketDts({outputDtsNonIncreasingCount:2},{outputDtsNonIncreasingCount:2}));
 assert.throws(()=>validateVideoPacketDts({},{}),e=>e.validation?.outcome==='inconclusive');
});
test('isolated decode requires an end marker and the complete decoded frame count',async()=>{
 const {verifyTimestampIsolatedVideo}=require('../src/validation');
 const run=lines=>async (_bin,_args,onLine)=>{for(const line of lines)onLine(line);return '';};
 await assert.rejects(verifyTimestampIsolatedVideo({ffmpeg:'ffmpeg',input:'candidate.mkv',index:0,threads:4,expectedFrames:4,runProcess:run(['frame=3','progress=end'])}),/frame count/i);
 await assert.rejects(verifyTimestampIsolatedVideo({ffmpeg:'ffmpeg',input:'candidate.mkv',index:0,threads:4,expectedFrames:4,runProcess:run(['frame=4'])}),/complete/i);
 await verifyTimestampIsolatedVideo({ffmpeg:'ffmpeg',input:'candidate.mkv',index:0,threads:4,expectedFrames:4,runProcess:run(['frame=4','progress=end'])});
});
test('isolated decode reads every frame with real FFmpeg',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
 if(cp.spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0)return t.skip('FFmpeg is unavailable');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tdarr-isolated-decode-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const input=path.join(dir,'sample.mkv');
 const created=cp.spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=24','-frames:v','8','-c:v','ffv1',input],{encoding:'utf8'});
 assert.equal(created.status,0,created.stderr);
 const {verifyTimestampIsolatedVideo}=require('../src/validation');
 const runProcess=async (bin,argv,onLine)=>{
  const result=cp.spawnSync(bin,argv,{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  result.stdout.split(/\r?\n/).forEach(onLine);
  return result.stderr;
 };
 assert.equal(await verifyTimestampIsolatedVideo({ffmpeg:'ffmpeg',input,index:0,threads:2,expectedFrames:8,runProcess}),'');
});
test('timestamp mux failure does not retry or approve an unverified candidate',async()=>{
 const modes=[],o=options({runVideo:async mode=>{modes.push(mode);throw Error(muxTimestampError);}});
 await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='inconclusive');
 assert.deepEqual(modes,['qsv']);
});
test('isolated timestamp decode can recover only after independent timing checks',async()=>{
 const modes=[],o=options({candidatePacketTimestampsVerified:true,runVideo:async mode=>{modes.push(mode);if(mode==='qsv')throw Error(muxTimestampError);return '';}});
 await verifyCandidateDecodes(o);completeValidation(o.report);
 assert.deepEqual(modes,['qsv','timestamp-isolated']);
 assert.equal(o.report.outcome,'recovered');
 assert.equal(o.report.recoveries[0].code,'timestamp_isolated_decode');
});
test('timestamp isolation cannot hide a candidate decode error',async()=>{
 const o=options({candidatePacketTimestampsVerified:true,runVideo:async mode=>{if(mode==='qsv')throw Error(muxTimestampError);throw Error('Invalid data found');}});
 await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='rejected');
});
test('timestamp isolation is not used when a mux error also reports corrupt decoded video',async()=>{
 const modes=[],o=options({candidatePacketTimestampsVerified:true,runVideo:async mode=>{modes.push(mode);if(mode==='qsv')throw Error(`${muxTimestampError}\ncorrupt decoded frame`);return '';}});
 await verifyCandidateDecodes(o);
 assert.deepEqual(modes,['qsv','software']);
});
test('timestamp isolation recovers from QSV exit-0 libva init plus null-muxer DTS diagnostics and handles truncation',async()=>{
 const modes=[],o=options({candidatePacketTimestampsVerified:true,runVideo:async mode=>{
  modes.push(mode);
  if(mode==='qsv')return `libva info: VA-API version 1.22.0\nlibva info: Trying to open /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so\n... diagnostics truncated ...\n${muxTimestampError}\nLast message repeated 2 times`;
  return '';
 }});
 await verifyCandidateDecodes(o);completeValidation(o.report);
 assert.deepEqual(modes,['qsv','timestamp-isolated']);
 assert.equal(o.report.outcome,'recovered');
 assert.equal(o.report.recoveries[0].code,'timestamp_isolated_decode');
});
test('timestamp isolation is not used when a mux error is mixed with an unrecognized diagnostic',async()=>{
 const modes=[],o=options({candidatePacketTimestampsVerified:true,runVideo:async mode=>{
  modes.push(mode);
  if(mode==='qsv')throw Error(`libva info: VA-API version 1.22.0\n${muxTimestampError}\n[matroska @ 0x55f8a6427a40] Read error at pos. 1234`);
  return '';
 }});
 await verifyCandidateDecodes(o);completeValidation(o.report);
 assert.deepEqual(modes,['qsv','software']);
 assert.equal(o.report.outcome,'recovered');
 assert.equal(o.report.recoveries[0].code,'qsv_decode_fallback');
});

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

test('QSV failure followed by software failure records failed qsv_decode_fallback recovery',async()=>{
  const o=options({
    canUseQsv:true,
    runVideo:async mode=>{
      if(mode==='qsv')throw failure('QSV device init error',{status:1,signal:null,timedOut:false});
      throw failure('Software decode failed',{status:1,signal:null,timedOut:false});
    }
  });
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='inconclusive');
  assert.equal(o.report.recoveries[0].code,'qsv_decode_fallback');
  assert.equal(o.report.recoveries[0].outcome,'failed');
});

test('the known non-fatal TrueHD diagnostic does not block completed candidate audio verification',async()=>{
  const diagnostic='[truehd @ 0x55f8a6427a40] quant_step_size larger than huff_lsbs';
  const o=options({audioTracks:[[1,1]],runAudio:async()=>diagnostic});
  await verifyCandidateDecodes(o);completeValidation(o.report);
  assert.equal(o.report.outcome,'passed');
  assert.deepEqual(o.report.checks,[{stage:'video_decode',outcome:'passed'},{stage:'audio_decode',outcome:'passed'}]);
});

test('FFmpeg repeat summaries for the known TrueHD warning preserve a successful audio decode',async()=>{
  const o=options({audioTracks:[[1,1]],runAudio:async()=> '[truehd @ 0x561b6dd496c0] quant_step_size larger than huff_lsbs\n    Last message repeated 4 times'});
  await verifyCandidateDecodes(o);completeValidation(o.report);
  assert.equal(o.report.outcome,'passed');
});

test('a TrueHD repeat summary cannot hide another decoder error',async()=>{
  const diagnostic='[truehd @ 0x561b6dd496c0] quant_step_size larger than huff_lsbs\nLast message repeated 4 times\n[aac] unrecognized decoder error';
  const o=options({audioTracks:[[1,1]],runAudio:async()=>diagnostic});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='inconclusive');
});
test('a nonzero TrueHD decode is not excused by the known warning',async()=>{
  const diagnostic='[truehd @ 0x561b6dd496c0] quant_step_size larger than huff_lsbs\nLast message repeated 4 times';
  const o=options({audioTracks:[[1,1]],runAudio:async()=>{throw failure(diagnostic,{status:1,signal:null,timedOut:false});}});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='inconclusive');
});

test('unrecognized candidate audio diagnostics remain inconclusive',async()=>{
  const o=options({audioTracks:[[1,1]],runAudio:async()=> '[aac] Unrecognized decoder diagnostic'});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='inconclusive');
  assert.equal(o.report.failure.code,'decode_unverified');
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
test('validation stages report elapsed time and outcome on success and failure',async()=>{
 const events=[],report=newValidationReport();
 report.stageLogger=entry=>events.push(entry);
 await validationStage(report,'streams',async()=>42);
 await assert.rejects(validationStage(report,'frames',async()=>{throw Error('frame mismatch');},'rejected'));
 assert.deepEqual(events.map(x=>[x.stage,x.outcome]),[['streams','started'],['streams','passed'],['frames','started'],['frames','rejected']]);
 assert.ok(events.every(x=>Number.isFinite(x.elapsedMs)&&x.elapsedMs>=0));
});
test('validation failure preserves the beginning and end of a long diagnostic',async()=>{
 const report=newValidationReport();
 await assert.rejects(validationStage(report,'frames',async()=>{throw Error('FIRST-DIAGNOSTIC '+ 'x'.repeat(2000)+' LAST-DIAGNOSTIC');}));
 assert.match(report.failure.message,/FIRST-DIAGNOSTIC/);
 assert.match(report.failure.message,/LAST-DIAGNOSTIC/);
 assert.ok(report.failure.message.length<=800);
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

test('isolated decode reports throttled frame progress and completion without changing pass behavior',async()=>{
  const {verifyTimestampIsolatedVideo}=require('../src/validation');
  const updates=[];
  const lines=[
    'frame=2',
    'fps=48.5',
    'progress=continue',
    'frame=4',
    'fps=52.0',
    'progress=continue',
    'frame=6',
    'fps=55.0',
    'progress=end'
  ];
  await verifyTimestampIsolatedVideo({
    ffmpeg:'ffmpeg',
    input:'candidate.mkv',
    index:0,
    threads:4,
    expectedFrames:6,
    runProcess:async (_bin,_args,onLine)=>{for(const line of lines)onLine(line);return '';},
    onProgress:(frames,total,complete,fps)=>updates.push({frames,total,complete,fps})
  });
  assert.ok(updates.length>=2,`expected throttled progress updates, got ${updates.length}`);
  assert.deepEqual(updates[0],{frames:2,total:6,complete:false,fps:48.5});
  assert.deepEqual(updates[updates.length-1],{frames:6,total:6,complete:true,fps:55.0});
});


test('measureStreamTimelinesBatch scans multiple stream types in one pass with exact bitsets and subtitle filtering',async()=>{
  const {measureStreamTimelinesBatch}=require('../src/validation');
  const calls=[];const progress=[];
  const result=await measureStreamTimelinesBatch(
    'ffprobe',
    'unused-source.mkv',
    [
      {index:0,type:'video'},
      {index:1,type:'audio'},
      {index:2,type:'subtitle',ignoreEmptySubtitleMaxBytes:2},
      {index:3,type:'subtitle'}
    ],
    async(bin,argv,onLine)=>{
      calls.push({bin,argv});
      for(const line of [
        'stream_index=0|pts_time=0.000|dts_time=0.000|duration_time=0.040|pos=100|size=5000',
        'stream_index=1|pts_time=N/A|dts_time=0.000|duration_time=0.020|pos=200|size=1200',
        'stream_index=99|pts_time=50.0|dts_time=50.0|duration_time=0.040|pos=300|size=900',
        'stream_index=2|pts_time=1.000|dts_time=1.000|duration_time=0.500|pos=400|size=2',
        'stream_index=2|pts_time=2.000|dts_time=2.000|duration_time=0.500|pos=500|size=25',
        'stream_index=0|pts_time=0.040|dts_time=0.040|duration_time=0.040|pos=600|size=4500',
        'stream_index=1|pts_time=0.020|dts_time=0.020|duration_time=0.020|pos=700|size=1100'
      ]) onLine(line);
    },
    ratio=>progress.push(ratio),
    10,
    'source'
  );
  assert.equal(calls.length,1);
  assert.equal(calls[0].argv.includes('-select_streams'),false);
  assert.ok(calls[0].argv.includes('packet=stream_index,pts_time,dts_time,duration_time,pos,size'));
  assert.equal(result.size,4);

  const v=result.get(0);
  assert.equal(v.packets,2);
  assert.equal(v.first,0);
  assert.ok(Math.abs(v.last-0.08)<1e-6);

  const a=result.get(1);
  assert.equal(a.totalPackets,2);
  assert.equal(a.missingPtsCount,1);
  assert.equal(a.missingPtsBitmap[0]&1,1);
  assert.equal(a.missingTimestampCount,0);

  const s2=result.get(2);
  assert.equal(s2.packets,1);
  assert.equal(s2.first,2);
  assert.equal(s2.last,2.5);

  const s3=result.get(3);
  assert.deepEqual(s3,{empty:true});
  assert.equal(result.has(99),false);
  assert.equal(progress.at(-1),1);
});

test('measureStreamTimelinesBatch preserves single-target -select_streams and missing-timestamp errors',async()=>{
  const {measureStreamTimelinesBatch}=require('../src/validation');
  let seenArgv;
  const single=await measureStreamTimelinesBatch(
    'ffprobe',
    'unused.mkv',
    [{index:0,type:'video'}],
    async(_bin,argv,onLine)=>{
      seenArgv=argv;
      onLine('pts_time=0.000|dts_time=0.000|duration_time=0.040|pos=10');
      onLine('pts_time=0.040|dts_time=0.040|duration_time=0.040|pos=20');
    },
    undefined,
    1,
    'candidate'
  );
  assert.equal(seenArgv[seenArgv.indexOf('-select_streams')+1],'0');
  assert.ok(seenArgv.includes('packet=pts_time,dts_time,duration_time,pos'));
  assert.equal(single.get(0).packets,2);

  await assert.rejects(
    measureStreamTimelinesBatch(
      'ffprobe',
      'unused.mkv',
      [{index:0,type:'video'},{index:1,type:'audio'}],
      async(_bin,_argv,onLine)=>{
        onLine('stream_index=0|pts_time=0.000|dts_time=0.000|duration_time=0.040|pos=10');
        onLine('stream_index=0|pts_time=N/A|dts_time=0.040|duration_time=0.040|pos=20');
      },
      undefined,
      1,
      'candidate'
    ),
    err=>err.validation?.outcome==='inconclusive'&&/video candidate stream 0 has 1 packets without a usable PTS \(first at packet 2\)/.test(err.message)
  );
});

test('proactive timestamp-isolated decode bypasses QSV and software null-mux decodes when matched DTS ties are verified',async()=>{
  const modes=[],o=options({candidatePacketTimestampsVerified:true,proactiveTimestampIsolated:true,runVideo:async mode=>{modes.push(mode);return '';}});
  await verifyCandidateDecodes(o);completeValidation(o.report);
  assert.deepEqual(modes,['timestamp-isolated']);
  assert.equal(o.report.outcome,'recovered');
  assert.equal(o.report.recoveries[0].code,'timestamp_isolated_decode');
});

test('proactive timestamp-isolated decode is ignored when candidate packet timestamps are unverified',async()=>{
  const modes=[],o=options({candidatePacketTimestampsVerified:false,proactiveTimestampIsolated:true,runVideo:async mode=>{modes.push(mode);return '';}});
  await verifyCandidateDecodes(o);completeValidation(o.report);
  assert.deepEqual(modes,['qsv']);
  assert.equal(o.report.outcome,'passed');
});

test('proactive timestamp-isolated decode still rejects corrupt candidates',async()=>{
  const o=options({candidatePacketTimestampsVerified:true,proactiveTimestampIsolated:true,runVideo:async()=>{throw Error('Invalid data found');}});
  await assert.rejects(verifyCandidateDecodes(o),e=>e.validation?.outcome==='rejected');
});
