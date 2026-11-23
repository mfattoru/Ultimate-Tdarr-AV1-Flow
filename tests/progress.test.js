'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {runLimitedFfmpeg,runSingleQuality,reportWorkerProgress}=require('../src/progress');

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

test('runSingleQuality classifies encoder failure, invalid size, quality floor, and smaller encode',async()=>{
 assert.deepEqual(await runSingleQuality(22,1000,async()=>({ok:false,code:1})),{ok:false,quality:22,reason:'encoder',result:{ok:false,code:1}});
 assert.deepEqual(await runSingleQuality(22,1000,async()=>({ok:true,size:0})),{ok:false,quality:22,reason:'size',result:{ok:true,size:0}});
 assert.deepEqual(await runSingleQuality(22,1000,async()=>({ok:true,size:1000})),{ok:false,quality:22,reason:'quality_floor',result:{ok:true,size:1000}});
 assert.deepEqual(await runSingleQuality(22,1000,async()=>({ok:true,size:750})),{ok:true,quality:22,result:{ok:true,size:750}});
});

test('remux progress falls back to prlimit when updateLimit is not provided and handles prlimit failure',async t=>{
 const outputPath=fixture(t);
 const script=`const fs=require('fs'),p=process.argv[1];fs.writeFileSync(p,Buffer.alloc(900));setInterval(()=>{},1000)`;
 const prevPath=process.env.PATH;
 process.env.PATH='/nonexistent';
 let result;
 try{
  result=await runLimitedFfmpeg({
   command:process.execPath,
   argv:['-e',script,outputPath],
   durationSec:1,
   capacity:{outputPath,initialBytes:1000n,headroomBytes:500n,chunkBytes:1000n,pollMs:10,grow:async required=>required}
  });
 }finally{
  if(prevPath===undefined)delete process.env.PATH;
  else process.env.PATH=prevPath;
 }
 assert.ok(result.capacityError instanceof Error);
 assert.ok(result.signal==='SIGTERM'||result.signal==='SIGKILL');
});

test('createStageProgressPlan allocates route-weighted contiguous budgets and redistributes skipped phases',()=>{
 const {createStageProgressPlan,stageProgressValue}=require('../src/progress');
 assert.equal(typeof createStageProgressPlan,'function');
 assert.equal(typeof stageProgressValue,'function');
 const width=r=>r.end-r.start;
 for(const route of ['qsv','hybrid','sw_hdr']){
  const full=createStageProgressPlan({route,startPercent:0,endPercent:99.9});
  const total=Object.values(full).reduce((sum,r)=>sum+width(r),0);
  const weightOf=r=>(width(r)/total)*100;
  assert.ok(weightOf(full.audioPrecheck)>=3.5,`${route} audioPrecheck weight should be >=3.5, got ${weightOf(full.audioPrecheck)}`);
  assert.ok(weightOf(full.timelines)>=5,`${route} timelines weight should be >=5, got ${weightOf(full.timelines)}`);
  assert.ok(Math.abs(total-99.9)<1e-6,`${route} widths must sum to 99.9, got ${total}`);
 }

 const qsv=createStageProgressPlan({route:'qsv'});
 const stages=['sourceScan','audioPrecheck','encode','remux','candidateFrames','timelines','videoDecode','audioDecode'];
 assert.equal(qsv.sourceScan.start,1);
 assert.ok(Math.abs(qsv.audioDecode.end-99.9)<1e-6);
 for(let i=1;i<stages.length;i++)assert.ok(Math.abs(qsv[stages[i]].start-qsv[stages[i-1]].end)<1e-6);
 assert.ok(width(qsv.encode)<25,`qsv encode width should be <25%, got ${width(qsv.encode)}`);
 assert.ok(width(qsv.sourceScan)+width(qsv.candidateFrames)>=55,'CPU frame scans must carry majority of QSV job bar');
 assert.ok(width(qsv.videoDecode)>=7,'videoDecode needs enough span for long 4K60 decodes');

 const swHdr=createStageProgressPlan({route:'sw_hdr'});
 assert.ok(width(swHdr.encode)>width(qsv.encode),'sw_hdr should allocate more bar width to encoding than qsv');

 const retry=createStageProgressPlan({route:'qsv',hasSourceScan:false,hasAudioPrecheck:false,hasEncode:false,hasRemux:false});
 assert.equal(retry.sourceScan.start,1);
 assert.equal(retry.sourceScan.end,1);
 assert.equal(retry.encode.end,1);
 assert.equal(retry.candidateFrames.start,1);
 assert.ok(Math.abs(retry.audioDecode.end-99.9)<1e-6);
 assert.ok(width(retry.candidateFrames)>50);

 const reanchored=createStageProgressPlan({route:'sw_hdr',startPercent:32.5,hasSourceScan:false,hasAudioPrecheck:false});
 assert.equal(reanchored.encode.start,32.5);
 assert.ok(Math.abs(reanchored.audioDecode.end-99.9)<1e-6);

 assert.equal(stageProgressValue({start:10,end:28},0),10);
 assert.equal(stageProgressValue({start:10,end:28},1),28);
 assert.equal(stageProgressValue({start:10,end:28},-0.5),10);
 assert.equal(stageProgressValue({start:10,end:28},2),28);
 assert.equal(stageProgressValue({start:10,end:28},NaN),10);
 assert.equal(stageProgressValue({start:10,end:28},0.5),19);
});

test('reportWorkerProgress clamps percentages monotonically within a job and resets only on explicit resetProgress',()=>{
 const updates=[];
 const cb=payload=>updates.push(payload);
 const details={sourceFileSizeInBytes:1024};
 reportWorkerProgress(cb,{percentage:0.1,status:'start',resetProgress:true},details);
 reportWorkerProgress(cb,{percentage:60.1,status:'encode'},details);
 reportWorkerProgress(cb,{percentage:58.9,status:'encode'},details);
 reportWorkerProgress(cb,{percentage:63.8,status:'validate'},details);
 reportWorkerProgress(cb,{percentage:0.1,status:'next job',resetProgress:true},details);
 assert.deepEqual(updates.map(u=>u.percentage),[0.1,60.1,60.1,63.8,0.1]);
 assert.equal('resetProgress' in updates[0],false);
});

test('stageProgressValue uses 0.01% precision on narrow stages and createStallSafeProgressEmitter emits heartbeats during silent waits',async()=>{
 const {stageProgressValue,createStallSafeProgressEmitter}=require('../src/progress');
 assert.equal(typeof createStallSafeProgressEmitter,'function');
 const narrow={start:28.69,end:29.43};
 const steps=new Set();
 for(let i=0;i<=50;i++) steps.add(stageProgressValue(narrow,i/50));
 assert.ok(steps.size>=30,`expected >=30 distinct 0.01% values across 0.74% width, got ${steps.size}`);
 assert.equal(stageProgressValue(narrow,0.5),29.06);

 const updates=[];
 const emitter=createStallSafeProgressEmitter({
  updateWorker:p=>updates.push(p),
  range:narrow,
  status:'Precheck: audio DTS scan',
  minStep:0.02,
  heartbeatIntervalMs:15
 });
 await emitter.run(async()=>{
  emitter.update(0.1);
  await new Promise(resolve=>setTimeout(resolve,65));
  emitter.update(1);
 });
 assert.ok(updates.length>=3,`expected ratio + heartbeat updates, got ${JSON.stringify(updates)}`);
 for(let i=1;i<updates.length;i++) assert.ok(updates[i].percentage>=updates[i-1].percentage);
 assert.ok(updates.slice(1,-1).some(u=>u.percentage>updates[0].percentage&&u.percentage<narrow.end),'heartbeat must nudge percentage strictly inside stage range');
 assert.equal(updates.at(-1).percentage,29.43);
});


test('createStallSafeProgressEmitter defaults to 120s/0.01% and continues micro-nudging past ceilingBeforeEnd',async()=>{
 const {createStallSafeProgressEmitter}=require('../src/progress');
 const origSetInterval=globalThis.setInterval;
 const origClearInterval=globalThis.clearInterval;
 const origDateNow=Date.now;
 let nowOffsetMs=0;
 let nextId=5000;
 const timers=new Map();
 Date.now=()=>origDateNow()+nowOffsetMs;
 globalThis.setInterval=(fn,ms,...rest)=>{
  const id=nextId++;
  timers.set(id,{fn,ms});
  return {id,unref(){return this;}};
 };
 globalThis.clearInterval=h=>{
  if(h&&typeof h==='object'&&typeof h.id==='number') timers.delete(h.id);
  else return origClearInterval(h);
 };
 try {
  const updates=[];
  const narrow={start:28.69,end:28.72};
  const emitter=createStallSafeProgressEmitter({
   updateWorker:p=>updates.push(p),
   range:narrow,
   status:'Precheck: audio DTS scan'
  });
  await emitter.run(async()=>{
   assert.equal(timers.size,1);
   const [timer]=[...timers.values()];
   assert.equal(timer.ms,120000,'default heartbeatIntervalMs must be 120000');
   for(let i=0;i<6;i++){
    nowOffsetMs+=125000;
    timer.fn();
   }
   emitter.update(1);
  });
  assert.equal(timers.size,0);
  const pcts=updates.map(u=>Number(u.percentage));
  assert.ok(pcts.length>=8,`expected >=8 updates, got ${JSON.stringify(pcts)}`);
  for(let i=1;i<pcts.length;i++) assert.ok(pcts[i]>pcts[i-1],`heartbeat must keep strictly advancing past ceilingBeforeEnd: ${pcts[i-1]} -> ${pcts[i]}`);
  assert.ok(pcts.slice(1,-1).some(p=>p>28.71&&p<28.72),`expected micro-nudge between 28.71 and 28.72, got ${JSON.stringify(pcts)}`);
  assert.equal(pcts.at(-1),28.72);
 } finally {
  Date.now=origDateNow;
  globalThis.setInterval=origSetInterval;
  globalThis.clearInterval=origClearInterval;
 }
});

test('createStallSafeProgressEmitter resetOnStart re-anchors saturated stage range on fallback retries',async()=>{
 const {createStallSafeProgressEmitter}=require('../src/progress');
 const updates=[];
 const cb=payload=>updates.push(payload);
 const range={start:89.01,end:97.92};

 const qsv=createStallSafeProgressEmitter({updateWorker:cb,range,status:'Validation: strict output video decode',minStep:0.01});
 await qsv.run(async()=>{
  qsv.update(0.5);
  qsv.update(1);
 });
 assert.equal(updates.at(-1).percentage,97.92);

 // Default emitter without resetOnStart stays clamped at 97.92
 const clampedStart=updates.length;
 const clamped=createStallSafeProgressEmitter({updateWorker:cb,range,status:'No-reset emitter',minStep:0.01});
 await clamped.run(async()=>{
  clamped.update(0.25);
 });
 assert.ok(updates.slice(clampedStart).every(u=>u.percentage===97.92));

 // Fallback emitter with resetOnStart=true resets cleanly to 89.01 and progresses monotonically within retry
 const resetStart=updates.length;
 const isolated=createStallSafeProgressEmitter({updateWorker:cb,range,status:'Validation: timestamp-isolated software decode',minStep:0.01,resetOnStart:true});
 await isolated.run(async()=>{
  isolated.update(0.5,140);
  isolated.update(0.2,120); // must remain monotonic within retry itself
  isolated.update(1,145);
 });
 const retryUpdates=updates.slice(resetStart);
 assert.equal(retryUpdates[0].percentage,89.01);
 assert.equal('resetProgress' in retryUpdates[0],false);
 assert.ok(retryUpdates[1].percentage>89.01 && retryUpdates[1].percentage<97.92);
 assert.equal(retryUpdates.at(-1).percentage,97.92);
 for(let i=1;i<retryUpdates.length;i++) assert.ok(retryUpdates[i].percentage>=retryUpdates[i-1].percentage);
});
