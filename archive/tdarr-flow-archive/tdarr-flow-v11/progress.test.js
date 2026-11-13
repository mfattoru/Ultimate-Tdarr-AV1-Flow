const test=require('node:test');
const assert=require('node:assert/strict');
const {runLimitedFfmpeg}=require('./progress');

test('streams FFmpeg progress to the worker before the process exits',async()=>{
 assert.equal(typeof runLimitedFfmpeg,'function');
 const updates=[];
 const script="process.stdout.write('out_time_');setTimeout(()=>process.stdout.write('us=2500000\\nfps=42.0\\nprogress=continue\\n'),20);setTimeout(()=>process.stdout.write('out_time_us=9000000\\nprogress=end\\n'),40);setTimeout(()=>process.exit(0),100)";
 const result=await runLimitedFfmpeg({command:process.execPath,argv:['-e',script],durationSec:10,updateWorker:x=>updates.push(x)});
 assert.equal(result.status,0);assert.ok(updates.some(x=>x.percentage===25&&x.fps===42));assert.ok(updates.some(x=>x.percentage===90));
});

test('keeps progress below 100 and tolerates bad duration or callback errors',async()=>{
 assert.equal(typeof runLimitedFfmpeg,'function');
 const seen=[];
 const script="process.stdout.write('out_time_us=20000000\\nprogress=end\\n')";
 const a=await runLimitedFfmpeg({command:process.execPath,argv:['-e',script],durationSec:10,updateWorker:x=>seen.push(x)});
 assert.equal(a.status,0);assert.ok(seen.every(x=>x.percentage<100));
 const b=await runLimitedFfmpeg({command:process.execPath,argv:['-e',script],durationSec:0,updateWorker:()=>{throw Error('ui down')}});
 assert.equal(b.status,0);
});

test('reports start failures without disguising them as encoder results',async()=>{
 assert.equal(typeof runLimitedFfmpeg,'function');
 const r=await runLimitedFfmpeg({command:'/no/such/tdarr-encoder',argv:[],durationSec:10});
 assert.ok(r.error);assert.equal(r.error.code,'ENOENT');
});
