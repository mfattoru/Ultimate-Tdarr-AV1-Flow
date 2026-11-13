'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {reserveCapacity, releaseCapacity} = require('./reservations');

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

test('actual free space and outstanding estimates are both charged as files grow', async t => {
  const dir=fixture(t), available=free(dir), amount=available/2n;
  const first=await reserveCapacity(options(dir, amount));
  const s=fs.statfsSync, reduced=available-amount/2n;
  fs.statfsSync=(p, opts) => p===dir ? {bavail:reduced,bsize:1n} : s(p,opts);
  try { await assert.rejects(reserveCapacity(options(dir, amount)), /insufficient/i); }
  finally { fs.statfsSync=s; }
  await releaseCapacity(first);
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
  const script=`const {reserveCapacity}=require(process.argv[1]); reserveCapacity({root:process.argv[2],candidate:process.argv[2],bytes:BigInt(process.argv[3]),floorBytes:0n,timeoutMs:5000,pollMs:5}).then(()=>console.log('admitted')).catch(e=>{console.log(e.message);process.exitCode=1})`;
  const run=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['-e',script,path.join(__dirname,'reservations.js'),dir,String(amount)]); let out=''; p.stdout.on('data',x=>out+=x); p.on('error',reject); p.on('close',code=>resolve({code,out}));});
  const results=await Promise.all([run(),run()]);
  assert.equal(results.filter(x=>x.code===0).length,1,JSON.stringify(results));
  assert.match(results.find(x=>x.code!==0).out,/insufficient/i);
});

test('all reservations share a conservative budget and highest configured floor', async t => {
  const root=fixture(t), a=path.join(root,'a'), b=path.join(root,'b');
  fs.mkdirSync(a);fs.mkdirSync(b);
  const originalStat=fs.statSync, originalSpace=fs.statfsSync;
  fs.statSync=(p,opts)=>(p===a||p===b)&&opts?.bigint?{dev:p===a?1n:2n,isDirectory:()=>true}:originalStat(p,opts);
  fs.statfsSync=(p,opts)=>(p===a||p===b)?{bavail:1000n,bsize:1n}:originalSpace(p,opts);
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
 const oldStat=fs.statSync,oldSpace=fs.statfsSync;
 fs.statSync=(p,opts)=>(p===a||p===b)&&opts?.bigint?{dev:p===a?1n:2n,isDirectory:()=>true}:oldStat(p,opts);
 fs.statfsSync=(p,opts)=>(p===a||p===b)?{bavail:1000n,bsize:1n}:oldSpace(p,opts);
 try {const one=await reserveCapacity({...options(root,600n),candidate:a});await assert.rejects(reserveCapacity({...options(root,500n),candidate:b}),/insufficient/i);await releaseCapacity(one);}
 finally {fs.statSync=oldStat;fs.statfsSync=oldSpace;}
});
