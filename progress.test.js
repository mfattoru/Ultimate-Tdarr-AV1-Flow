'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {runLimitedFfmpeg,reportWorkerProgress}=require('./progress');

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tdarr-progress-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'candidate.mkv');}

test('precheck publishes 100 percent current and target size before an output file exists',()=>{
 const updates=[],sourceSize=2*1024*1024*1024;
 reportWorkerProgress(update=>updates.push(update),{percentage:0.1,fps:0,status:'Preparing: source probe and preflight'}, {
  sourceFileSizeInBytes:sourceSize,
  initialOutputSizeBytes:sourceSize,
  initialEstimateBytes:sourceSize,
  workerLog:'Inspecting source streams before encoding.'
 });
 assert.equal(updates.length,1);
 assert.equal(updates[0].originalFileSizeInGbytes,2);
 assert.equal(updates[0].outputFileSizeInGbytes,2);
 assert.equal(updates[0].estSize,2);
 assert.equal(updates[0].status,'Preparing: source probe and preflight');
});

test('phase labels survive FFmpeg progress updates',async t=>{
 const outputPath=fixture(t),updates=[];
 const script=`const fs=require('fs'),p=process.argv[1];fs.writeFileSync(p,Buffer.alloc(900));console.log('out_time_us=500000\\nfps=24\\nprogress=continue');setTimeout(()=>process.exit(0),40)`;
 const result=await runLimitedFfmpeg({command:process.execPath,argv:['-e',script,outputPath],durationSec:1,progressStart:10,progressEnd:80,updateWorker:update=>updates.push(update),workerDetails:{status:'Encoding: Arc QSV AV1 at ICQ 22',outputPath,sourceFileSizeInBytes:1800}});
 assert.equal(result.status,0);
 assert.ok(updates.some(update=>update.status==='Encoding: Arc QSV AV1 at ICQ 22'));
});

test('remux progress grows the file-size limit only after reservation approval',async t=>{
 const outputPath=fixture(t),growths=[],limits=[];
 const script=`const fs=require('fs'),p=process.argv[1];fs.writeFileSync(p,Buffer.alloc(900));setTimeout(()=>{fs.appendFileSync(p,Buffer.alloc(600));console.log('out_time_us=500000\\nfps=24\\nprogress=continue');setTimeout(()=>process.exit(0),80)},60)`;
 const result=await runLimitedFfmpeg({command:process.execPath,argv:['-e',script,outputPath],durationSec:1,progressStart:80,progressEnd:82,capacity:{outputPath,initialBytes:1000n,headroomBytes:500n,chunkBytes:1000n,pollMs:10,grow:async(required,used)=>{growths.push({required,used});return required;},updateLimit:async(pid,limit)=>limits.push({pid,limit})}});
 assert.equal(result.status,0);
 assert.equal(result.capacityError,null);
 assert.ok(growths.length>=1,'must request more reservation before the output reaches the old cap');
 assert.ok(growths[0].required>1000n);
 assert.ok(growths[0].used<1000n,'growth must occur with write-ahead headroom');
 assert.equal(limits.at(-1).limit,result.fileSizeLimit);
 assert.equal(result.fileSizeLimit,growths.at(-1).required);
});

test('remux stops and reports the original-preserving capacity failure when growth is denied',async t=>{
 const outputPath=fixture(t);
 const script=`const fs=require('fs'),p=process.argv[1];fs.writeFileSync(p,Buffer.alloc(900));setInterval(()=>{},1000)`;
 const result=await runLimitedFfmpeg({command:process.execPath,argv:['-e',script,outputPath],durationSec:1,capacity:{outputPath,initialBytes:1000n,headroomBytes:500n,chunkBytes:1000n,pollMs:10,grow:async()=>{throw Error('Insufficient available capacity to grow reservation');},updateLimit:async()=>{}}});
 assert.equal(result.capacityError.message,'Insufficient available capacity to grow reservation');
 assert.ok(result.signal==='SIGTERM'||result.signal==='SIGKILL');
});

test('stream-copy progress derives FPS from frame deltas when FFmpeg reports fps=0',async t=>{
 const outputPath=fixture(t),updates=[];
 const script=`const fs=require('fs'),p=process.argv[1];fs.writeFileSync(p,Buffer.alloc(900));console.log('frame=100\\nout_time_us=1000000\\nfps=0\\nprogress=continue');setTimeout(()=>{console.log('frame=140\\nout_time_us=2000000\\nfps=0\\nprogress=continue');setTimeout(()=>process.exit(0),40)},350)`;
 const result=await runLimitedFfmpeg({command:process.execPath,argv:['-e',script,outputPath],durationSec:2,progressStart:80,progressEnd:82,updateWorker:update=>updates.push(update)});
 assert.equal(result.status,0);
 assert.ok(updates.some(update=>Number.isFinite(update.fps)&&update.fps>0),'remux should report measured frames per second');
});

test('runLimitedFfmpeg merges per-invocation env overrides with parent environment',async t=>{
 const outputPath=fixture(t);
 const script="require('fs').writeFileSync(process.argv[1],JSON.stringify({vk:process.env.VK_ICD_FILENAMES||'',driver:process.env.VK_DRIVER_FILES||'',pathSet:Boolean(process.env.PATH)}));";
 const result=await runLimitedFfmpeg({
  command:process.execPath,
  argv:['-e',script,outputPath],
  durationSec:1,
  env:{VK_ICD_FILENAMES:'/usr/share/vulkan/icd.d/intel_icd.json',VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/intel_icd.json'}
 });
 assert.equal(result.status,0);
 const parsed=JSON.parse(fs.readFileSync(outputPath,'utf8'));
 assert.equal(parsed.vk,'/usr/share/vulkan/icd.d/intel_icd.json');
 assert.equal(parsed.driver,'/usr/share/vulkan/icd.d/intel_icd.json');
 assert.equal(parsed.pathSet,true);
});

test('runLimitedFfmpeg enforces fixed stopOnLimit cap without requesting growth',async t=>{
 const outputPath=fixture(t);
 const script=`const fs=require('fs'),p=process.argv[1];fs.writeFileSync(p,Buffer.alloc(500));setTimeout(()=>{fs.appendFileSync(p,Buffer.alloc(600));setInterval(()=>{},1000);},40)`;
 const result=await runLimitedFfmpeg({
  command:process.execPath,
  argv:['-e',script,outputPath],
  durationSec:1,
  capacity:{outputPath,initialBytes:1000n,stopOnLimit:true,pollMs:10,grow:async()=>{throw Error('grow must not run when stopOnLimit is enabled');}}
 });
 assert.match(result.capacityError?.message || '',/file-size limit/i);
 assert.ok(result.signal==='SIGTERM'||result.signal==='SIGKILL');
});
