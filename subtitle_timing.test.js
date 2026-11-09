const test = require('node:test');
const assert = require('node:assert/strict');
const {parseSubtitlePacketLine,validateCopiedSubtitlePackets} = require('./subtitle_timing');

const packet=(pts,dts,duration,payloadHash)=>({pts,dts,duration,payloadHash});

test('parses FFprobe ASS packet timestamps, duration and SHA-256 hash',()=>{
 assert.deepEqual(
  parseSubtitlePacketLine('pts_time=2.450000|dts_time=2.450000|duration_time=0.310000|data_hash=SHA256:abc123'),
  {pts:2.45,dts:2.45,duration:0.31,position:null,payloadHash:'SHA256:abc123'}
 );
});

test('clamps an out-of-order ASS packet without adding an artificial 1 ms shift to equal timestamps',()=>{
 const source=[packet(2.450,2.450,0.2,'a'),packet(2.140,2.140,0.4,'b'),packet(3.100,3.100,0.5,'c')];
 const output=[packet(2.517,2.517,0.2,'a'),packet(2.517,2.517,0.4,'b'),packet(3.167,3.167,0.5,'c')];
 const result=validateCopiedSubtitlePackets(source,output,0.067);
 assert.deepEqual(result,{packetCount:3,adjustedPackets:1,maxAdjustmentSeconds:0.31});
});

test('keeps clean ASS timestamps unchanged apart from the common video shift',()=>{
 const source=[packet(1,1,0.5,'a'),packet(2,2,0.5,'b')];
 const output=[packet(1.067,1.067,0.5,'a'),packet(2.067,2.067,0.5,'b')];
 assert.deepEqual(validateCopiedSubtitlePackets(source,output,0.067),{packetCount:2,adjustedPackets:0,maxAdjustmentSeconds:0});
});

test('rejects timestamp movement larger than the 0.5 second limit',()=>{
 const source=[packet(2.45,2.45,0.2,'a'),packet(1.8,1.8,0.2,'b')];
 const output=[packet(2.45,2.45,0.2,'a'),packet(2.451,2.451,0.2,'b')];
 assert.throws(()=>validateCopiedSubtitlePackets(source,output,0),/exceeds the 0.5s repair limit/);
});

test('rejects changed packet counts or payloads',()=>{
 const source=[packet(1,1,0.2,'same'),packet(2,2,0.2,'second')];
 assert.throws(()=>validateCopiedSubtitlePackets(source,source.slice(0,1),0),/packet count changed/);
 assert.throws(()=>validateCopiedSubtitlePackets(source,[source[0],packet(2,2,0.2,'changed')],0),/payload changed/);
});

test('rejects missing PTS and non-monotonic repaired output',()=>{
 assert.throws(()=>validateCopiedSubtitlePackets([packet(null,1,0.2,'a')],[packet(1,1,0.2,'a')],0),/missing or invalid PTS/);
 assert.throws(()=>validateCopiedSubtitlePackets([packet(1,1,0.2,'a'),packet(2,2,0.2,'b')],[packet(1,1,0.2,'a'),packet(0.9,0.9,0.2,'b')],0),/output PTS is not monotonic/);
});
test('unavailable source subtitle measurements stay inconclusive while newly lost candidate PTS rejects',async()=>{
 const {newValidationReport,validationStage}=require('./validation');
 const {validateCopiedSubtitlePackets}=require('./subtitle_timing');
 const packet={pts:1,dts:1,duration:1,payloadHash:'same'};
 for(const source of [{...packet,pts:null},{...packet,payloadHash:''}]){
  const report=newValidationReport();
  await assert.rejects(validationStage(report,'timelines',()=>validateCopiedSubtitlePackets([source],[packet],0),'rejected'),e=>e.validation?.outcome==='inconclusive');
 }
 const report=newValidationReport();
 await assert.rejects(validationStage(report,'timelines',()=>validateCopiedSubtitlePackets([packet],[{...packet,pts:null}],0),'rejected'),e=>e.validation?.outcome==='rejected');
});
