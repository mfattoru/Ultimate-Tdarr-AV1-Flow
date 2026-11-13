const test=require('node:test');
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const pgs=require('./pgs');
const {newValidationReport,validationStage}=require('./validation');
function segment(pts,type,payload,dts=pts) {
 const content=Buffer.from(payload),header=Buffer.alloc(13);header.write('PG',0,'ascii');header.writeUInt32BE(pts>>>0,2);header.writeUInt32BE(dts>>>0,6);header[10]=type;header.writeUInt16BE(content.length,11);return Buffer.concat([header,content]);
}
function split(buffer,n){const parts=[];for(let i=0;i<buffer.length;i+=n)parts.push(buffer.subarray(i,i+n));return Readable.from(parts);}
function makeFfmpegStub(t,body){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v15-pgs-stub-')),tool=path.join(dir,'ffmpeg-stub');
 fs.writeFileSync(tool,`#!/usr/bin/env node\n${body}\n`);fs.chmodSync(tool,0o755);
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return tool;
}
const src=Buffer.concat([segment(90000,0x16,'composition'),segment(90000,0x14,'palette'),segment(180000,0x80,'end')]);
const dst=Buffer.concat([segment(97470,0x16,'composition'),segment(97470,0x14,'palette'),segment(187470,0x80,'end')]);

test('PGS subtitle verification ignores container packet grouping while preserving segments and relative time',async()=>{
 assert.equal(typeof pgs.parsePgsSegments,'function');assert.equal(typeof pgs.comparePgsSegments,'function');
 const a=await pgs.parsePgsSegments(split(src,1)),b=await pgs.parsePgsSegments(split(dst,37));
 assert.doesNotThrow(()=>pgs.comparePgsSegments(a,b,7470/90000));
});

test('PGS subtitle verification detects missing, changed and retimed segments',async()=>{
 assert.equal(typeof pgs.parsePgsSegments,'function');
 const a=await pgs.parsePgsSegments(split(src,9));
 const missing=await pgs.parsePgsSegments(split(Buffer.concat([segment(97470,0x16,'composition'),segment(187470,0x80,'end')]),7));
 const altered=await pgs.parsePgsSegments(split(Buffer.concat([segment(97470,0x16,'different'),segment(97470,0x14,'palette'),segment(187470,0x80,'end')]),8));
 const retimed=await pgs.parsePgsSegments(split(Buffer.concat([segment(97470,0x16,'composition'),segment(114000,0x14,'palette'),segment(187470,0x80,'end')]),12));
 assert.throws(()=>pgs.comparePgsSegments(a,missing,7470/90000),/segment/i);
 assert.throws(()=>pgs.comparePgsSegments(a,altered,7470/90000),/segment/i);
 assert.throws(()=>pgs.comparePgsSegments(a,retimed,7470/90000),/timestamp/i);
});

test('PGS subtitle verification rejects truncated segments and honors 32-bit PTS wrap',async()=>{
 assert.equal(typeof pgs.parsePgsSegments,'function');
 await assert.rejects(()=>pgs.parsePgsSegments(split(src.subarray(0,src.length-1),4)),/truncat/i);
 const a=await pgs.parsePgsSegments(split(segment(0xfffffff0,0x80,'end'),3));
 const b=await pgs.parsePgsSegments(split(segment(0x10,0x80,'end'),5));
 assert.doesNotThrow(()=>pgs.comparePgsSegments(a,b,32/90000));
});

test('PGS parser rejects invalid headers and incomplete trailing headers',async()=>{
 await assert.rejects(()=>pgs.parsePgsSegments(split(Buffer.alloc(13,0xff),2)),/Invalid PGS segment header/);
 await assert.rejects(()=>pgs.parsePgsSegments(split(Buffer.from([0x50,0x47,0x00]),2)),/Truncated PGS segment/);
});

test('PGS comparison distinguishes unavailable measurements from changed decode timestamps',async()=>{
 const a=await pgs.parsePgsSegments(split(segment(90000,0x80,'end'),5));
 const dtsChanged=await pgs.parsePgsSegments(split(segment(90000,0x80,'end',100000),4));
 const dtsMissing=await pgs.parsePgsSegments(split(segment(90000,0x80,'end',0),3));
 assert.throws(()=>pgs.comparePgsSegments(null,a,0),error=>error.validation?.outcome==='inconclusive');
 assert.throws(()=>pgs.comparePgsSegments(a,a,NaN),error=>error.validation?.outcome==='inconclusive');
 assert.throws(()=>pgs.comparePgsSegments(a,a,0,-1),error=>error.validation?.outcome==='inconclusive');
 assert.throws(()=>pgs.comparePgsSegments(a,dtsChanged,0),/decode timestamp differs/);
 assert.throws(()=>pgs.comparePgsSegments(a,dtsMissing,0),/decode timestamp differs/);
});

test('batched PGS extraction compares each stream and reports progress from FFmpeg',async t=>{
 const sourceBytes=Array.from(src),outputBytes=Array.from(dst);
 const tool=makeFfmpegStub(t,`
const fs=require('node:fs');
const output=process.argv.includes('source.mkv')?${JSON.stringify(sourceBytes)}:${JSON.stringify(outputBytes)};
fs.writeSync(4,Buffer.from(output));
fs.writeSync(5,Buffer.from(output));
fs.writeSync(3,'out_time_us=1000000\\nprogress=continue\\nout_time_us=4000000\\nprogress=end\\n');
`);
 const progress=[];
 const found=await pgs.extractPgsSegmentsBatch(tool,'source.mkv',[10,11],4,ratio=>progress.push(ratio));
 assert.deepEqual(Array.from(found.keys()),[10,11]);
 assert.doesNotThrow(()=>pgs.comparePgsSegments(found.get(10),found.get(11),0));
 assert.deepEqual(progress,[0.25,1]);
 assert.deepEqual(await pgs.extractPgsSegmentsBatch(tool,'source.mkv',[],4),new Map());
 await assert.rejects(()=>pgs.extractPgsSegmentsBatch(tool,'source.mkv',[0,-1]),/Invalid PGS stream index list/);
});

test('single and batched PGS verifiers reject output segment changes',async t=>{
 const sourceBytes=Array.from(src),badOutput=Buffer.concat([segment(120000,0x16,'composition'),segment(120000,0x14,'palette'),segment(210000,0x80,'end')]),outputBytes=Array.from(badOutput);
 const tool=makeFfmpegStub(t,`
const fs=require('node:fs');
const source=process.argv.includes('source.mkv');
const output=${JSON.stringify(sourceBytes)};
const candidate=${JSON.stringify(outputBytes)};
const bytes=Buffer.from(source?output:candidate);
if(process.argv.includes('pipe:1'))fs.writeSync(1,bytes);
else {fs.writeSync(4,bytes);fs.writeSync(5,bytes);}
`);
 await assert.rejects(()=>pgs.verifyPgsSegments(tool,'source.mkv','output.mkv',0,0,0),/PGS subtitle timestamp differs/);
 await assert.rejects(()=>pgs.verifyPgsSegmentsBatch(tool,'source.mkv','output.mkv',[[0,1],[2,3]],0),/PGS subtitle timestamp differs/);
 await assert.rejects(()=>pgs.verifyPgsSegmentsBatch(tool,'source.mkv','output.mkv',[[0,-1]],0),/Invalid PGS stream pair list/);
 await assert.doesNotReject(()=>pgs.verifyPgsSegmentsBatch(tool,'source.mkv','output.mkv',[],0));
});

test('PGS extraction accepts benign stderr when the process exits zero',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v15-pgs-warning-')),tool=path.join(dir,'ffmpeg-stub');
 try {
  const bytes=Array.from(segment(90000,0x80,'end'));
  fs.writeFileSync(tool,`#!/usr/bin/env node\nprocess.stdout.write(Buffer.from(${JSON.stringify(bytes)}));\nprocess.stderr.write('non-fatal remux note\\n');\n`);
  fs.chmodSync(tool,0o755);
  const found=await pgs.extractPgsSegments(tool,'unused.mkv',0);
  assert.equal(found.length,1);
  assert.equal(found[0].type,0x80);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('missing PGS extraction executable remains an inconclusive process failure',async()=>{
 for(const extract of [()=>pgs.extractPgsSegments('/nonexistent/tdarr-ffmpeg','unused.mkv',0),()=>pgs.extractPgsSegmentsBatch('/nonexistent/tdarr-ffmpeg','unused.mkv',[0])]){
  const report=newValidationReport();
  await assert.rejects(validationStage(report,'timelines',extract,'rejected'),e=>e.validation?.outcome==='inconclusive');
 }
});

test('nonzero PGS extraction exit remains inconclusive after empty output parsing',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v15-pgs-error-')),tool=path.join(dir,'ffmpeg-stub');
 try{
  fs.writeFileSync(tool,"#!/usr/bin/env node\nprocess.stderr.write('Cannot allocate memory\\n');process.exitCode=1;\n");fs.chmodSync(tool,0o755);
  for(const extract of [()=>pgs.extractPgsSegments(tool,'unused.mkv',0),()=>pgs.extractPgsSegmentsBatch(tool,'unused.mkv',[0])]){
   const report=newValidationReport();
   await assert.rejects(validationStage(report,'timelines',extract,'rejected'),e=>e.validation?.outcome==='inconclusive');
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
