const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_AUDIO_TIMESTAMP_REPAIR_SECONDS,
  analyzeAudioDtsTimeline,
  createAudioDtsAnalyzer,
  parseAudioDtsLine,
  timeBaseToSeconds,
  audioTimestampRepairBsf
} = require('./audio_timing');

test('clean audio DTS values need no correction',()=>{
  const result=analyzeAudioDtsTimeline([0,0.010,0.021,0.032],0.001);
  assert.deepEqual(result,{packetCount:4,missingDts:0,backwardSteps:0,nonIncreasingSteps:0,adjustedPackets:0,maxBackwardStepSeconds:0,maxRepairSeconds:0,withinLimit:true,repairable:true});
});

test('repairs a short backwards DTS run while preserving packet order and a bounded shift',()=>{
  const result=analyzeAudioDtsTimeline([2.058,2.026,2.036,2.047,2.058,2.069],0.001);
  assert.equal(result.backwardSteps,1);
  assert.equal(result.nonIncreasingSteps,1);
  assert.equal(result.adjustedPackets,4);
  assert.ok(Math.abs(result.maxBackwardStepSeconds-0.032)<1e-9);
  assert.ok(Math.abs(result.maxRepairSeconds-0.033)<1e-9);
  assert.equal(result.withinLimit,true);
  assert.equal(result.repairable,true);
});

test('rejects an audio timestamp run that would need more than the 100 ms limit',()=>{
  const result=analyzeAudioDtsTimeline([0,0.100,-0.050],0.001);
  assert.ok(Math.abs(result.maxRepairSeconds-0.151)<1e-9);
  assert.equal(result.withinLimit,false);
  assert.equal(MAX_AUDIO_TIMESTAMP_REPAIR_SECONDS,0.1);
});

test('allows a repair exactly at the 100 ms limit',()=>{
  const result=analyzeAudioDtsTimeline([0,0.100,0.001],0.001);
  assert.equal(result.maxRepairSeconds,0.1);
  assert.equal(result.withinLimit,true);
});

test('preserves equal DTS values when they are valid packet-time-base quantization',()=>{
  const result=analyzeAudioDtsTimeline([0,0.010,0.010,0.020],0.001);
  assert.equal(result.backwardSteps,0);
  assert.equal(result.nonIncreasingSteps,1);
  assert.equal(result.adjustedPackets,0);
  assert.equal(result.maxRepairSeconds,0);
  assert.equal(result.withinLimit,true);
});

test('dense TrueHD-like timestamps on a millisecond time base do not accumulate artificial drift',()=>{
  const tick=0.001;
  const packetInterval=40/48000;
  const values=Array.from({length:12000},(_,packet)=>Math.round(packet*packetInterval/tick)*tick);
  const result=analyzeAudioDtsTimeline(values,tick);
  assert.ok(result.nonIncreasingSteps>1000,'the quantized sample should contain repeated DTS values');
  assert.equal(result.backwardSteps,0);
  assert.equal(result.adjustedPackets,0);
  assert.equal(result.maxRepairSeconds,0);
  assert.equal(result.withinLimit,true);
});

test('missing DTS packets prevent a bounded repair decision',()=>{
  const result=analyzeAudioDtsTimeline([0,0.010,null,0.009],0.001);
  assert.equal(result.missingDts,1);
  assert.equal(result.backwardSteps,0);
  assert.equal(result.repairable,false);
});

test('parses stream time bases and builds a timestamp-only bitstream filter',()=>{
  assert.equal(timeBaseToSeconds('1/1000'),0.001);
  assert.equal(timeBaseToSeconds('1/48000'),1/48000);
  assert.equal(timeBaseToSeconds('0/0'),null);
  assert.equal(parseAudioDtsLine('pts_time=2.000|dts_time=1.999'),'1.999');
  assert.equal(parseAudioDtsLine('pts_time=N/A|dts_time=N/A'),null);
  assert.equal(parseAudioDtsLine('frame|pts_time=2.0'),null);
  const filter=audioTimestampRepairBsf();
  assert.match(filter,/setts=pts=/);
  assert.match(filter,/PREV_OUTDTS/);
  assert.match(filter,/PREV_OUTDTS\+1/);
  assert.match(filter,/PTS\+if/);
  assert.equal(filter,'setts=pts=if(eq(PTS\\,NOPTS)\\,NOPTS\\,PTS+if(eq(PREV_OUTDTS\\,NOPTS)\\,0\\,max(0\\,PREV_OUTDTS+1-DTS))):dts=if(eq(DTS\\,NOPTS)\\,NOPTS\\,if(eq(PREV_OUTDTS\\,NOPTS)\\,DTS\\,max(DTS\\,PREV_OUTDTS+1)))');
});

test('packet scanner streams DTS values through ffprobe without buffering the packet list',async()=>{
  const {scanAudioDtsPackets}=require('./audio_timing');
  let argvSeen;const progress=[];
  const result=await scanAudioDtsPackets('ffprobe','source.mkv',1,'1/1000',async(bin,argv,onLine)=>{
    assert.equal(bin,'ffprobe');
    argvSeen=argv;
    for(const line of ['pts_time=2.058|dts_time=2.058|pos=10','pts_time=2.026|dts_time=2.026|pos=50','pts_time=2.036|dts_time=2.036|pos=100']) onLine(line);
  },ratio=>progress.push(ratio),100);
  assert.ok(argvSeen.includes('-show_packets'));
  assert.ok(argvSeen.includes('packet=pts_time,dts_time,pos'));
  assert.equal(result.packetCount,3);
  assert.equal(result.backwardSteps,1);
  assert.equal(result.nonIncreasingSteps,1);
  assert.equal(result.adjustedPackets,2);
  assert.ok(Math.abs(result.maxRepairSeconds-0.033)<1e-9);
  assert.equal(result.timeBaseKnown,true);
  assert.deepEqual(progress,[0.1,0.5,1]);
});

test('a non-increasing source without a known stream time base cannot be repaired',async()=>{
  const {scanAudioDtsPackets}=require('./audio_timing');
  const result=await scanAudioDtsPackets('ffprobe','source.mkv',1,'0/0',async(bin,argv,onLine)=>{
    onLine('pts_time=2.000|dts_time=2.000');
    onLine('pts_time=1.900|dts_time=1.900');
  });
  assert.equal(result.nonIncreasingSteps,1);
  assert.equal(result.timeBaseKnown,false);
  assert.equal(result.repairable,false);
});
