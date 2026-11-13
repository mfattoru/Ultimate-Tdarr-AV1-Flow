'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {reserveCapacity, registerReservationWorkspace, heartbeatCapacityReservation, trackReservationChild, untrackReservationChild, terminateReservationChild, releaseCapacity, growCapacityReservation} = require('./reservations');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-reservations-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  return dir;
}
function free(dir) { const s = fs.statfsSync(dir, {bigint:true}); return s.bavail * s.bsize; }
function options(root, bytes, floorBytes=0n) { return {root, candidate:root, bytes, floorBytes, timeoutMs:100, pollMs:5}; }

test('reservations include the floor and remain charged until the owner releases', async t => {
  const dir = fixture(t), available=free(dir), amount=available/3n;
  const first=await reserveCapacity(options(dir, amount, available/10n));
  const second=await reserveCapacity(options(dir, amount, available/10n));
  await assert.rejects(reserveCapacity(options(dir, amount, available/10n)), /insufficient/i);
  await assert.rejects(releaseCapacity({...first, token:'0'.repeat(48)}), /owner/i);
  await assert.rejects(reserveCapacity(options(dir, amount, available/10n)), /insufficient/i);
  await releaseCapacity(first);
  const third=await reserveCapacity(options(dir, amount, available/10n));
  await releaseCapacity(second);
  await releaseCapacity(third);
});

test('next admission reclaims a dead worker reservation and only its recorded scratch directory', async t => {
  const dir=fixture(t), workspace=path.join(dir,'tdarr-av1-abandoned'), nested=path.join(dir,'nested','tdarr-av1-outside');
  fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'partial.mkv'),'partial');
  fs.mkdirSync(nested,{recursive:true});fs.writeFileSync(path.join(nested,'keep.txt'),'keep');
  const stale=await reserveCapacity(options(dir,1n));
  const recordPath=path.join(dir,'.tdarr-av1-reservations',`${stale.id}.json`);
  const record=JSON.parse(fs.readFileSync(recordPath,'utf8'));
  record.version=3;record.pid=2147483647;record.candidate=dir;record.workspace=workspace;
  record.heartbeatAt=new Date(Date.now()-16*60*1000).toISOString();
  fs.writeFileSync(recordPath,JSON.stringify(record));
  const unsafe=await reserveCapacity(options(dir,1n));
  const unsafePath=path.join(dir,'.tdarr-av1-reservations',`${unsafe.id}.json`);
  const unsafeRecord=JSON.parse(fs.readFileSync(unsafePath,'utf8'));
  unsafeRecord.pid=2147483647;unsafeRecord.workspace=nested;unsafeRecord.heartbeatAt=new Date(Date.now()-16*60*1000).toISOString();
  fs.writeFileSync(unsafePath,JSON.stringify(unsafeRecord));
  const active=await reserveCapacity(options(dir,1n));
  assert.equal(fs.existsSync(recordPath),false);
  assert.equal(fs.existsSync(workspace),false);
  assert.equal(fs.existsSync(path.join(nested,'keep.txt')),true);
  await releaseCapacity(active);
});

test('a recent heartbeat keeps a dead plugin PID lease through downstream flow cleanup', async t => {
  const dir=fixture(t), workspace=path.join(dir,'tdarr-av1-downstream');
  fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'candidate.mkv'),'candidate');
  const owner=await reserveCapacity(options(dir,1n));
  await registerReservationWorkspace(owner,workspace);
  const recordPath=path.join(dir,'.tdarr-av1-reservations',`${owner.id}.json`);
  const record=JSON.parse(fs.readFileSync(recordPath,'utf8'));
  record.pid=2147483647;
  record.heartbeatAt=new Date().toISOString();
  fs.writeFileSync(recordPath,JSON.stringify(record));

  const next=await reserveCapacity(options(dir,1n));

  assert.equal(fs.existsSync(recordPath),true);
  assert.equal(fs.existsSync(path.join(workspace,'candidate.mkv')),true);
  await releaseCapacity(owner);await releaseCapacity(next);
});

test('a live worker heartbeat keeps its reservation and workspace', async t => {
  const dir=fixture(t), workspace=path.join(dir,'tdarr-av1-live');
  fs.mkdirSync(workspace);
  const active=await reserveCapacity(options(dir,1n));
  await registerReservationWorkspace(active,workspace);
  const before=JSON.parse(fs.readFileSync(path.join(dir,'.tdarr-av1-reservations',`${active.id}.json`),'utf8')).heartbeatAt;
  await new Promise(resolve=>setTimeout(resolve,5));
  await heartbeatCapacityReservation(active);
  const recordPath=path.join(dir,'.tdarr-av1-reservations',`${active.id}.json`);
  const record=JSON.parse(fs.readFileSync(recordPath,'utf8'));
  assert.ok(Date.parse(record.heartbeatAt)>=Date.parse(before));
  const next=await reserveCapacity(options(dir,1n));
  assert.equal(fs.existsSync(recordPath),true);
  assert.equal(fs.existsSync(workspace),true);
  await releaseCapacity(active);await releaseCapacity(next);
});

test('an expired heartbeat does not reclaim a workspace while its local worker is alive', async t => {
  const dir=fixture(t),workspace=path.join(dir,'tdarr-av1-expired');fs.mkdirSync(workspace);
  const stale=await reserveCapacity(options(dir,1n));await registerReservationWorkspace(stale,workspace);
  const recordPath=path.join(dir,'.tdarr-av1-reservations',`${stale.id}.json`);
  const record=JSON.parse(fs.readFileSync(recordPath,'utf8'));
  record.pid=process.pid;
  record.heartbeatAt=new Date(Date.now()-16*60*1000).toISOString();
  fs.writeFileSync(recordPath,JSON.stringify(record));
  const active=await reserveCapacity(options(dir,1n));
  assert.equal(fs.existsSync(recordPath),true);assert.equal(fs.existsSync(workspace),true);
  await releaseCapacity(stale);await releaseCapacity(active);
});

test('SIGTERM cleans only the active job scratch and kills its spawned process group', async t => {
  const dir=fixture(t),workspace=path.join(dir,'tdarr-av1-cancelled');
  const script=`const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');const r=require(process.argv[1]);(async()=>{const root=process.argv[2],workspace=path.join(root,'tdarr-av1-cancelled');const h=await r.reserveCapacity({root,candidate:root,bytes:1n,floorBytes:0n});fs.mkdirSync(workspace);await r.registerReservationWorkspace(h,workspace);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});r.trackReservationChild(child);console.log(child.pid);setInterval(()=>{},1000)})().catch(e=>{console.error(e);process.exit(2)});`;
  const worker=spawn(process.execPath,['-e',script,path.join(__dirname,'reservations.js'),dir],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';worker.stdout.on('data',b=>stdout+=String(b));worker.stderr.on('data',b=>stderr+=String(b));
  const childPid=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`worker did not register child: ${stderr}`)),2000);worker.stdout.on('data',()=>{const pid=Number(stdout.trim());if(Number.isSafeInteger(pid)&&pid>0){clearTimeout(timer);resolve(pid);}});worker.on('error',reject);});
  worker.kill('SIGTERM');
  const result=await new Promise((resolve,reject)=>{worker.on('close',(code,signal)=>resolve({code,signal}));worker.on('error',reject);});
  assert.equal(result.code,143,JSON.stringify(result));
  assert.equal(fs.existsSync(workspace),false);
  for(let i=0;i<20;i++){
    try{process.kill(childPid,0);}catch(e){if(e.code==='ESRCH')return;throw e;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail(`spawned process group ${childPid} remained after worker cancellation`);
});

test('actual free space and outstanding estimates are both charged as files grow', async t => {
  const dir=fixture(t), available=free(dir), amount=available/2n;
  const first=await reserveCapacity(options(dir, amount));
  const s=fs.statfsSync, reduced=available-amount/2n;
  const canonicalDir=fs.realpathSync(dir);
  let simulatedCandidateSpace=false;
  fs.statfsSync=(p, opts) => {
    if (fs.realpathSync(p)===canonicalDir) { simulatedCandidateSpace=true; return {bavail:reduced,bsize:1n,type:0n}; }
    return s(p,opts);
  };
  try {
    await assert.rejects(reserveCapacity(options(dir, amount)), /insufficient/i);
    assert.equal(simulatedCandidateSpace,true,'the fake free-space reading must match reserveCapacity’s canonical candidate path');
  }
  finally { fs.statfsSync=s; }
  await releaseCapacity(first);
});

test('remux reservation grows into free cache capacity without a source-relative ceiling',async t=>{
 const dir=fixture(t),available=free(dir),initial=available/10n,floor=available/10n;
 const handle=await reserveCapacity(options(dir,initial,floor));
 const grown=await growCapacityReservation(handle,available*8n/10n,0n,{marginBytes:1024n});
 assert.equal(grown,available*8n/10n);
 await assert.rejects(reserveCapacity(options(dir,available/5n,floor)),/insufficient/i);
 await releaseCapacity(handle);
});

test('concurrent remux reservation growth cannot spend the same free cache twice',async t=>{
 const dir=fixture(t),available=free(dir),floor=available/10n,initial=available/10n,target=available*6n/10n;
 const first=await reserveCapacity(options(dir,initial,floor)),second=await reserveCapacity(options(dir,initial,floor));
 const attempts=await Promise.allSettled([
  growCapacityReservation(first,target,0n,{marginBytes:1024n}),
  growCapacityReservation(second,target,0n,{marginBytes:1024n})
 ]);
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(attempts.filter(x=>x.status==='rejected').length,1);
 await releaseCapacity(first);await releaseCapacity(second);
});

test('remux reservation growth refuses to consume configured cache headroom',async t=>{
 const dir=fixture(t),available=free(dir),first=await reserveCapacity(options(dir,available/2n,available/4n));
 await assert.rejects(growCapacityReservation(first,available,0n,{marginBytes:1024n}),/insufficient/i);
 await releaseCapacity(first);
});

test('remux reservation growth keeps RAM and disk reservation pools separate',async t=>{
 const root=fixture(t),disk=path.join(root,'disk'),ram=path.join(root,'ram');fs.mkdirSync(disk);fs.mkdirSync(ram);
 const oldStatfs=fs.statfsSync,oldRead=fs.readFileSync;
 fs.statfsSync=(p,opts)=>p===disk||p===ram?{bavail:1000n,bsize:1n,type:p===ram?16914836n:0xef53n}:oldStatfs(p,opts);
 fs.readFileSync=(p,...args)=>p==='/proc/meminfo'?'MemAvailable: 100000000 kB\n':oldRead(p,...args);
 try {
  const diskHandle=await reserveCapacity({root,candidate:disk,bytes:100n,floorBytes:0n});
  const ramHandle=await reserveCapacity({root,candidate:ram,bytes:100n,floorBytes:0n,systemRamFloorBytes:0n});
  assert.equal(await growCapacityReservation(diskHandle,800n,0n,{marginBytes:0n}),800n);
  await releaseCapacity(diskHandle);await releaseCapacity(ramHandle);
 } finally {fs.statfsSync=oldStatfs;fs.readFileSync=oldRead;}
});

test('corrupt records and stale mutexes fail closed', async t => {
  const dir=fixture(t), first=await reserveCapacity(options(dir, 1n));
  const ledger=path.join(dir,'.tdarr-av1-reservations');
  fs.writeFileSync(path.join(ledger,'broken.json'), '{');
  await assert.rejects(reserveCapacity(options(dir, 1n)), /record/i);
  fs.unlinkSync(path.join(ledger,'broken.json'));
  await releaseCapacity(first);
  fs.mkdirSync(path.join(dir,'.tdarr-av1-reservations.lock'));
  await assert.rejects(reserveCapacity(options(dir, 1n)), /timed out/i);
});

test('concurrent processes cannot both spend the same free space', async t => {
  const dir=fixture(t), amount=free(dir)*3n/5n;
  const script=`const {reserveCapacity}=require(process.argv[1]); reserveCapacity({root:process.argv[2],candidate:process.argv[2],bytes:BigInt(process.argv[3]),floorBytes:0n,timeoutMs:5000,pollMs:5}).then(()=>{console.log('admitted');setTimeout(()=>{},1000)}).catch(e=>{console.log(e.message);process.exitCode=1})`;
  const run=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['-e',script,path.join(__dirname,'reservations.js'),dir,String(amount)]); let out=''; p.stdout.on('data',x=>out+=x); p.on('error',reject); p.on('close',code=>resolve({code,out}));});
  const results=await Promise.all([run(),run()]);
  assert.equal(results.filter(x=>x.code===0).length,1,JSON.stringify(results));
  assert.match(results.find(x=>x.code!==0).out,/insufficient/i);
});

test('all reservations share a conservative budget and highest configured floor', async t => {
  const root=fixture(t), a=path.join(root,'a'), b=path.join(root,'b');
  fs.mkdirSync(a);fs.mkdirSync(b);
  const ra=fs.realpathSync(a),rb=fs.realpathSync(b),originalStat=fs.statSync, originalSpace=fs.statfsSync;
  fs.statSync=(p,opts)=>(p===ra||p===rb)&&opts?.bigint?{dev:p===ra?1n:2n,isDirectory:()=>true}:originalStat(p,opts);
  fs.statfsSync=(p,opts)=>(p===ra||p===rb)?{bavail:1000n,bsize:1n,type:0n}:originalSpace(p,opts);
  try {
    const first=await reserveCapacity({...options(root,400n,200n),candidate:a});
    await assert.rejects(reserveCapacity({...options(root,700n,100n),candidate:b}),/insufficient/i);
    const second=await reserveCapacity({...options(root,400n,0n),candidate:b});
    await assert.rejects(reserveCapacity({...options(root,1n,0n),candidate:a}),/insufficient/i);
    await releaseCapacity(first);await releaseCapacity(second);
  } finally {fs.statSync=originalStat;fs.statfsSync=originalSpace;}
});

test('unknown available space and invalid input cannot admit a job', async t => {
  const dir=fixture(t), original=fs.statfsSync;
  await assert.rejects(reserveCapacity(options(dir, 0n)), /positive bigint/i);
  await assert.rejects(reserveCapacity(options(dir, 1)), /bigint/i);
  fs.statfsSync=() => { throw Error('statfs failed'); };
  try { await assert.rejects(reserveCapacity(options(dir,1n)), /statfs failed/); }
  finally { fs.statfsSync=original; }
  const h=await reserveCapacity(options(dir,1n));
  await releaseCapacity(h);
  await assert.rejects(releaseCapacity(h), /record/i);
});

test('distinct device IDs cannot double-spend the same underlying storage through aliases',async t=>{
 const root=fixture(t),a=path.join(root,'a'),b=path.join(root,'b');fs.mkdirSync(a);fs.mkdirSync(b);
 const ra=fs.realpathSync(a),rb=fs.realpathSync(b),oldStat=fs.statSync,oldSpace=fs.statfsSync;
 fs.statSync=(p,opts)=>(p===ra||p===rb)&&opts?.bigint?{dev:p===ra?1n:2n,isDirectory:()=>true}:oldStat(p,opts);
 fs.statfsSync=(p,opts)=>(p===ra||p===rb)?{bavail:1000n,bsize:1n,type:0n}:oldSpace(p,opts);
 try {const one=await reserveCapacity({...options(root,600n),candidate:a});await assert.rejects(reserveCapacity({...options(root,500n),candidate:b}),/insufficient/i);await releaseCapacity(one);}
 finally {fs.statSync=oldStat;fs.statfsSync=oldSpace;}
});

test('child tracking removes idle signal handlers and termination falls back to child.kill', t => {
  const sigtermListeners=process.listenerCount('SIGTERM'),sigintListeners=process.listenerCount('SIGINT'),signals=[];
  const child={kill(signal){signals.push(signal);}};
  trackReservationChild(null);
  trackReservationChild(child);
  assert.equal(process.listenerCount('SIGTERM'),sigtermListeners+1);
  assert.equal(process.listenerCount('SIGINT'),sigintListeners+1);
  untrackReservationChild(child);
  untrackReservationChild(null);
  assert.equal(process.listenerCount('SIGTERM'),sigtermListeners);
  assert.equal(process.listenerCount('SIGINT'),sigintListeners);
  terminateReservationChild(child,'SIGTERM');
  assert.deepEqual(signals,['SIGTERM']);
  assert.doesNotThrow(()=>terminateReservationChild({kill(){throw Error('already exited');}}));
});

test('RAM reservations and growth preserve system headroom and fail closed when MemAvailable is unknown', async t => {
  const dir=fixture(t),realDir=fs.realpathSync(dir),oldStatfs=fs.statfsSync,oldRead=fs.readFileSync;
  const state={meminfo:'MemAvailable: 1000000 kB\n'};
  fs.statfsSync=(target,opts)=>String(target)===realDir
    ? {bavail:1000000000n,bsize:1n,type:16914836n}
    : oldStatfs(target,opts);
  fs.readFileSync=(target,...args)=>String(target)==='/proc/meminfo'
    ? state.meminfo
    : oldRead(target,...args);
  try {
    state.meminfo='unrecognized memory report\n';
    await assert.rejects(reserveCapacity({...options(dir,2048n),systemRamFloorBytes:4096n}),/cannot determine system RAM/i);
    state.meminfo='MemAvailable: 1 kB\n';
    await assert.rejects(reserveCapacity({...options(dir,2048n),systemRamFloorBytes:4096n}),/system RAM headroom/i);
    state.meminfo='MemAvailable: 1000000 kB\n';
    const owner=await reserveCapacity({...options(dir,2048n),systemRamFloorBytes:4096n});
    state.meminfo='MemAvailable: 50000 kB\n';
    await assert.rejects(growCapacityReservation(owner,100000000n,0n,{marginBytes:0n}),/available system RAM/i);
    state.meminfo='MemAvailable: 1000000 kB\n';
    assert.equal(await growCapacityReservation(owner,100000000n,0n,{marginBytes:0n}),100000000n);
    await releaseCapacity(owner);
  } finally {
    fs.statfsSync=oldStatfs;
    fs.readFileSync=oldRead;
  }
});

test('failed reservation record replacement removes its temporary file and keeps the old lease', async t => {
  const dir=fixture(t),owner=await reserveCapacity(options(dir,1n));
  const ledger=path.join(dir,'.tdarr-av1-reservations'),oldRename=fs.renameSync;
  fs.renameSync=()=>{throw Error('simulated atomic rename failure');};
  try {
    await assert.rejects(heartbeatCapacityReservation(owner),/simulated atomic rename failure/);
    await assert.rejects(growCapacityReservation(owner,2n,0n,{marginBytes:0n}),/simulated atomic rename failure/);
  } finally {fs.renameSync=oldRename;}
  const record=JSON.parse(fs.readFileSync(path.join(ledger,`${owner.id}.json`),'utf8'));
  assert.equal(record.bytes,'1');
  assert.deepEqual(fs.readdirSync(ledger).filter(name=>name.endsWith('.tmp')),[]);
  await releaseCapacity(owner);
});
