const test=require('node:test');
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const pgs=require('./pgs');
function segment(pts,type,payload) {
 const content=Buffer.from(payload),header=Buffer.alloc(13);header.write('PG',0,'ascii');header.writeUInt32BE(pts>>>0,2);header.writeUInt32BE(pts>>>0,6);header[10]=type;header.writeUInt16BE(content.length,11);return Buffer.concat([header,content]);
}
function split(buffer,n){const parts=[];for(let i=0;i<buffer.length;i+=n)parts.push(buffer.subarray(i,i+n));return Readable.from(parts);}
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
