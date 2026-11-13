// Reservations conservatively group all disk filesystems together and all
// memory filesystems together. They reserve the full estimate until release;
// unrelated writers, remounts, and filesystem quotas are not covered.
const reservationFs = require('fs');
const reservationPath = require('path');
const reservationCrypto = require('crypto');
const reservationOs = require('os');
const RESERVATION_DIR = '.tdarr-av1-reservations';
const RESERVATION_LOCK = '.tdarr-av1-reservations.lock';
const reservationStaleAfterMs = 15 * 60 * 1000;
let reservationPidNamespace='';
try { reservationPidNamespace=reservationFs.readlinkSync('/proc/self/ns/pid'); } catch (_) {}
const reservationHostId = process.env.TDARR_RESERVATION_HOST_ID || `${reservationOs.hostname()}${reservationPidNamespace?`@${reservationPidNamespace}`:''}`;
const reservationRuntimeKey=Symbol.for('tdarr.av1.reservation.runtime.v1');
const reservationRuntime=globalThis[reservationRuntimeKey] || (globalThis[reservationRuntimeKey]={children:new Set(),jobs:new Map(),sigterm:null,sigint:null});
const reservationSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function reservationRoot(root) {
  if (typeof root !== 'string' || !reservationPath.isAbsolute(root)) throw Error('Reservation root must be an absolute existing directory');
  const real = reservationFs.realpathSync(root);
  if (!reservationFs.statSync(real).isDirectory()) throw Error('Reservation root must be a directory');
  return real;
}
function reservationAmount(value, name, allowZero = false) {
  if (typeof value !== 'bigint' || value < (allowZero ? 0n : 1n)) throw Error(`${name} must be a ${allowZero ? 'nonnegative' : 'positive'} bigint`);
  return value;
}
function reservationLedger(root) {
  const dir = reservationPath.join(root, RESERVATION_DIR);
  try { reservationFs.mkdirSync(dir, {mode:0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  if (!reservationFs.lstatSync(dir).isDirectory()) throw Error('Invalid reservation ledger directory');
  return dir;
}
async function reservationCritical(root, fn, timeoutMs=30000, pollMs=50) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || !Number.isSafeInteger(pollMs) || pollMs < 1) throw Error('Invalid reservation lock timeout or polling interval');
  const lock = reservationPath.join(root, RESERVATION_LOCK), deadline = Date.now() + timeoutMs;
  for (;;) {
    try { reservationFs.mkdirSync(lock, {mode:0o700}); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) throw Error(`Timed out waiting for reservation lock ${lock}; inspect manually before removing a stale lock`);
      await reservationSleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }
  try { return fn(reservationLedger(root)); }
  finally { reservationFs.rmdirSync(lock); }
}
function reservationRecord(dir, name) {
  try {
    if (!/^[a-f0-9]{48}\.json$/.test(name)) throw Error('Unexpected entry');
    const file=reservationPath.join(dir,name);
    if (!reservationFs.lstatSync(file).isFile()) throw Error('Not a file');
    const r=JSON.parse(reservationFs.readFileSync(file,'utf8'));
    if (!r || ![1,2,3].includes(r.version) || !/^[a-f0-9]{48}$/.test(r.token) || !/^\d+$/.test(r.device) || !/^[1-9]\d*$/.test(r.bytes) || !/^\d+$/.test(r.floorBytes) || (r.spaceClass!==undefined && !['disk','ram'].includes(r.spaceClass)) || (r.systemRamFloorBytes!==undefined && !/^\d+$/.test(r.systemRamFloorBytes)) || (r.version>=2 && (typeof r.candidate!=='string' || !reservationPath.isAbsolute(r.candidate))) || (r.version===3 && (!Number.isSafeInteger(r.pid) || r.pid<1 || typeof r.host!=='string' || !r.host || typeof r.heartbeatAt!=='string' || !Number.isFinite(Date.parse(r.heartbeatAt)) || (r.workspace!==undefined && (typeof r.workspace!=='string' || !reservationPath.isAbsolute(r.workspace)))))) throw Error('Invalid fields');
    return r;
  } catch (e) { throw Error(`Invalid reservation record ${name}: ${e.message || e}`); }
}
function reservationWorkerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid,0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}
function safeReservationWorkspace(record) {
  if (typeof record.workspace!=='string' || !reservationPath.isAbsolute(record.workspace) || typeof record.candidate!=='string') return null;
  try {
    const candidate=reservationFs.realpathSync(record.candidate);
    const entry=reservationFs.lstatSync(record.workspace);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    const workspace=reservationFs.realpathSync(record.workspace);
    if (reservationPath.dirname(workspace)!==candidate || !/^tdarr-av1-[A-Za-z0-9_-]+$/.test(reservationPath.basename(workspace))) return null;
    return workspace;
  } catch (_) { return null; }
}
function terminateReservationChild(child,signal='SIGKILL') {
  if (!child) return;
  if (Number.isSafeInteger(child.pid) && child.pid>1) {
    try { process.kill(-child.pid,signal); return; } catch (e) { if (e.code==='ESRCH') return; }
  }
  try { child.kill(signal); } catch (_) {}
}
function removeReservationTerminationHandlersIfIdle() {
  if (reservationRuntime.children.size || reservationRuntime.jobs.size) return;
  if (reservationRuntime.sigterm) process.removeListener('SIGTERM',reservationRuntime.sigterm);
  if (reservationRuntime.sigint) process.removeListener('SIGINT',reservationRuntime.sigint);
  reservationRuntime.sigterm=null;reservationRuntime.sigint=null;
}
function installReservationTerminationHandlers() {
  if (reservationRuntime.sigterm) return;
  const terminate=signal=>{
    for (const child of reservationRuntime.children) terminateReservationChild(child,'SIGKILL');
    for (const job of reservationRuntime.jobs.values()) {
      const workspace=safeReservationWorkspace(job.record);
      if (workspace) { try { reservationFs.rmSync(workspace,{recursive:true,force:true}); } catch (_) {} }
    }
    process.exit(signal==='SIGINT'?130:143);
  };
  reservationRuntime.sigterm=()=>terminate('SIGTERM');
  reservationRuntime.sigint=()=>terminate('SIGINT');
  process.on('SIGTERM',reservationRuntime.sigterm);
  process.on('SIGINT',reservationRuntime.sigint);
}
function trackReservationChild(child) {
  if (!child) return;
  reservationRuntime.children.add(child);
  installReservationTerminationHandlers();
}
function untrackReservationChild(child) {
  if (!child) return;
  reservationRuntime.children.delete(child);
  removeReservationTerminationHandlersIfIdle();
}
function reclaimStaleReservations(dir) {
  const now=Date.now();
  for (const name of reservationFs.readdirSync(dir)) {
    if (!/^[a-f0-9]{48}\.json$/.test(name)) continue;
    const record=reservationRecord(dir,name);
    const sameHost=record.host===reservationHostId;
    const workerAlive=sameHost ? reservationWorkerAlive(record.pid) : true;
    const heartbeat=Date.parse(record.heartbeatAt || record.updatedAt || record.createdAt || '');
    const expired=record.version===3 && Number.isFinite(heartbeat) && now-heartbeat>reservationStaleAfterMs;
    const missingLease=record.version===3 && !Number.isFinite(heartbeat);
    // The engine plugin can exit before downstream replace/cleanup nodes finish
    // consuming its candidate. A dead plugin PID alone therefore does not mean
    // this job's workspace is abandoned; require an expired lease heartbeat too.
    const staleHeartbeat=expired || missingLease;
    if (!staleHeartbeat || (sameHost && workerAlive)) continue;
    const workspace=safeReservationWorkspace(record);
    if (workspace) reservationFs.rmSync(workspace,{recursive:true,force:true});
    reservationFs.unlinkSync(reservationPath.join(dir,name));
    reservationRuntime.jobs.delete(name.slice(0,-5));
  }
  removeReservationTerminationHandlersIfIdle();
}
function writeReservationRecord(file,record) {
  const temp=reservationPath.join(reservationPath.dirname(file),`.${reservationCrypto.randomBytes(12).toString('hex')}.tmp`);
  try {
    reservationFs.writeFileSync(temp,JSON.stringify(record),{flag:'wx',mode:0o600});
    reservationFs.renameSync(temp,file);
  } catch (err) {
    try { reservationFs.unlinkSync(temp); } catch (_) {}
    throw err;
  }
}
// bytes and floorBytes are bigint byte counts; root is common to all jobs.
// candidate must be the actual existing destination directory. The caller must
// save the returned JSON-serializable handle for every success/error cleanup.
async function reserveCapacity({root, candidate, bytes, floorBytes=0n, systemRamFloorBytes=0n, timeoutMs=30000, pollMs=50}) {
  root=reservationRoot(root);
  reservationAmount(bytes,'bytes'); reservationAmount(floorBytes,'floorBytes',true);
  reservationAmount(systemRamFloorBytes,'systemRamFloorBytes',true);
  if (typeof candidate !== 'string' || !reservationPath.isAbsolute(candidate)) throw Error('Candidate must be an absolute existing directory');
  return reservationCritical(root, dir => {
    reclaimStaleReservations(dir);
    candidate=reservationFs.realpathSync(candidate);
    const stat=reservationFs.statSync(candidate,{bigint:true});
    if (!stat.isDirectory()) throw Error('Candidate must be a directory');
    const device=String(stat.dev), space=reservationFs.statfsSync(candidate,{bigint:true});
    if (typeof space.bavail !== 'bigint' || typeof space.bsize !== 'bigint' || typeof space.type !== 'bigint' || space.bavail < 0n || space.bsize <= 0n) throw Error('Cannot determine available capacity');
    const available=space.bavail * space.bsize;
    const magic=BigInt.asUintN(32,space.type);
    const spaceClass=(magic===16914836n || magic===2240043254n) ? 'ram' : 'disk';
    let outstanding=0n, floor=floorBytes, systemRamFloor=systemRamFloorBytes;
    for (const name of reservationFs.readdirSync(dir)) {
      const r=reservationRecord(dir,name);
      // Older V12 records predate spaceClass and were always disk-backed.
      // Keep Unraid disk paths in one conservative pool while isolating RAM.
      if ((r.spaceClass || 'disk') === spaceClass) {
        outstanding += BigInt(r.bytes); if (BigInt(r.floorBytes)>floor) floor=BigInt(r.floorBytes);
        if (BigInt(r.systemRamFloorBytes || '0')>systemRamFloor) systemRamFloor=BigInt(r.systemRamFloorBytes || '0');
      }
    }
    if (available < outstanding + bytes + floor) throw Error('Insufficient available capacity for reservation');
    if (spaceClass === 'ram') {
      let availableRam;
      try {
        const match=reservationFs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+)\s+kB$/m);
        if (!match) throw Error('MemAvailable is unavailable');
        availableRam=BigInt(match[1])*1024n;
      } catch (_) { throw Error('Insufficient available capacity for reservation: cannot determine system RAM'); }
      if (availableRam < outstanding + bytes + floor + systemRamFloor) throw Error('Insufficient available capacity for reservation: system RAM headroom');
    }
    const id=reservationCrypto.randomBytes(24).toString('hex'), token=reservationCrypto.randomBytes(24).toString('hex');
    const now=new Date().toISOString();
    const record={version:3,token,device,spaceClass,candidate,bytes:String(bytes),floorBytes:String(floorBytes),systemRamFloorBytes:String(systemRamFloorBytes),createdAt:now,heartbeatAt:now,pid:process.pid,host:reservationHostId};
    reservationFs.writeFileSync(reservationPath.join(dir,`${id}.json`),JSON.stringify(record),{flag:'wx',mode:0o600});
    const handle={root,id,token};
    reservationRuntime.jobs.set(id,{handle,record});
    installReservationTerminationHandlers();
    return handle;
  },timeoutMs,pollMs);
}
async function registerReservationWorkspace(handle,workspace) {
  if (!handle || !/^[a-f0-9]{48}$/.test(handle.id) || !/^[a-f0-9]{48}$/.test(handle.token)) throw Error('Invalid reservation handle');
  if (typeof workspace!=='string' || !reservationPath.isAbsolute(workspace)) throw Error('Reservation workspace must be an absolute directory');
  const root=reservationRoot(handle.root), realWorkspace=reservationFs.realpathSync(workspace), entry=reservationFs.lstatSync(realWorkspace);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !/^tdarr-av1-[A-Za-z0-9_-]+$/.test(reservationPath.basename(realWorkspace))) throw Error('Reservation workspace must be a job-owned tdarr-av1 directory');
  return reservationCritical(root,dir=>{
    const name=`${handle.id}.json`,file=reservationPath.join(dir,name),own=reservationRecord(dir,name);
    if (own.token!==handle.token) throw Error('Reservation owner mismatch');
    if (reservationPath.dirname(realWorkspace)!==reservationFs.realpathSync(own.candidate)) throw Error('Reservation workspace must be directly inside the reserved cache');
    const updated={...own,version:3,workspace:realWorkspace,heartbeatAt:new Date().toISOString()};
    writeReservationRecord(file,updated);
    reservationRuntime.jobs.set(handle.id,{handle,record:updated});
    return realWorkspace;
  });
}
async function heartbeatCapacityReservation(handle) {
  if (!handle || !/^[a-f0-9]{48}$/.test(handle.id) || !/^[a-f0-9]{48}$/.test(handle.token)) throw Error('Invalid reservation handle');
  const root=reservationRoot(handle.root);
  return reservationCritical(root,dir=>{
    const name=`${handle.id}.json`,file=reservationPath.join(dir,name),own=reservationRecord(dir,name);
    if (own.token!==handle.token) throw Error('Reservation owner mismatch');
    if (own.version!==3) throw Error('Reservation heartbeat requires a current lease record');
    const updated={...own,heartbeatAt:new Date().toISOString()};
    writeReservationRecord(file,updated);
    reservationRuntime.jobs.set(handle.id,{handle,record:updated});
    return updated.heartbeatAt;
  });
}
// Grow this job's maximum output size while its current output is already
// consuming filesystem space. `requiredBytes` is the new total file-size cap;
// `usedBytes` is the candidate's current size and is already reflected in
// statfs/MemAvailable, so only the future bytes must fit alongside other jobs.
async function growCapacityReservation(handle, requiredBytes, usedBytes=0n, {marginBytes=64n*1024n*1024n,timeoutMs=30000,pollMs=50}={}) {
  if (!handle || !/^[a-f0-9]{48}$/.test(handle.id) || !/^[a-f0-9]{48}$/.test(handle.token)) throw Error('Invalid reservation handle');
  reservationAmount(requiredBytes,'requiredBytes');
  reservationAmount(usedBytes,'usedBytes',true);
  reservationAmount(marginBytes,'marginBytes',true);
  if (usedBytes > requiredBytes) throw Error('usedBytes cannot exceed requiredBytes');
  const root=reservationRoot(handle.root);
  return reservationCritical(root, dir => {
    const name=`${handle.id}.json`, own=reservationRecord(dir,name);
    if (own.token !== handle.token) throw Error('Reservation owner mismatch');
    const current=BigInt(own.bytes);
    if (requiredBytes <= current) return current;
    if (![2,3].includes(own.version) || typeof own.candidate!=='string') throw Error('Reservation record cannot be grown; release it and retry with a current flow');
    const candidate=reservationFs.realpathSync(own.candidate);
    const stat=reservationFs.statSync(candidate,{bigint:true});
    if (!stat.isDirectory() || String(stat.dev)!==own.device) throw Error('Reservation candidate device changed');
    const space=reservationFs.statfsSync(candidate,{bigint:true});
    if (typeof space.bavail!=='bigint' || typeof space.bsize!=='bigint' || typeof space.type!=='bigint' || space.bavail<0n || space.bsize<=0n) throw Error('Cannot determine available capacity for reservation growth');
    const magic=BigInt.asUintN(32,space.type), spaceClass=(magic===16914836n || magic===2240043254n)?'ram':'disk';
    if (spaceClass!==own.spaceClass) throw Error('Reservation candidate filesystem class changed');
    let siblings=0n, floor=BigInt(own.floorBytes), systemRamFloor=BigInt(own.systemRamFloorBytes || '0');
    for (const recordName of reservationFs.readdirSync(dir)) {
      if (recordName===name) continue;
      const r=reservationRecord(dir,recordName);
      if ((r.spaceClass || 'disk')===spaceClass) {
        siblings+=BigInt(r.bytes);
        if (BigInt(r.floorBytes)>floor) floor=BigInt(r.floorBytes);
        const systemFloor=BigInt(r.systemRamFloorBytes || '0');
        if (systemFloor>systemRamFloor) systemRamFloor=systemFloor;
      }
    }
    const future=requiredBytes-usedBytes, available=space.bavail*space.bsize;
    const needed=siblings+future+floor+marginBytes;
    if (available<needed) throw Error(`Insufficient available capacity to grow reservation (${available} bytes available; ${needed} bytes protected or required)`);
    if (spaceClass==='ram') {
      let availableRam;
      try {
        const match=reservationFs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+)\s+kB$/m);
        if (!match) throw Error('MemAvailable is unavailable');
        availableRam=BigInt(match[1])*1024n;
      } catch (_) { throw Error('Insufficient available capacity to grow reservation: cannot determine system RAM'); }
      const ramNeeded=siblings+future+floor+systemRamFloor+marginBytes;
      if (availableRam<ramNeeded) throw Error(`Insufficient available system RAM to grow reservation (${availableRam} bytes available; ${ramNeeded} bytes protected or required)`);
    }
    const updated={...own,bytes:String(requiredBytes),updatedAt:new Date().toISOString(),...(own.version===3?{heartbeatAt:new Date().toISOString()}:{})};
    const file=reservationPath.join(dir,name), temp=reservationPath.join(dir,`.${handle.id}.${reservationCrypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      reservationFs.writeFileSync(temp,JSON.stringify(updated),{flag:'wx',mode:0o600});
      reservationFs.renameSync(temp,file);
    } catch (err) {
      try { reservationFs.unlinkSync(temp); } catch (_) {}
      throw err;
    }
    return requiredBytes;
  },timeoutMs,pollMs);
}
async function releaseCapacity(handle, {timeoutMs=30000,pollMs=50}={}) {
  if (!handle || !/^[a-f0-9]{48}$/.test(handle.id) || !/^[a-f0-9]{48}$/.test(handle.token)) throw Error('Invalid reservation handle');
  const root=reservationRoot(handle.root);
  return reservationCritical(root, dir => {
    const name=`${handle.id}.json`, r=reservationRecord(dir,name);
    if (r.token !== handle.token) throw Error('Reservation owner mismatch');
    reservationFs.unlinkSync(reservationPath.join(dir,name));
    reservationRuntime.jobs.delete(handle.id);
    removeReservationTerminationHandlersIfIdle();
  },timeoutMs,pollMs);
}
if (typeof module !== 'undefined') module.exports = {reserveCapacity, registerReservationWorkspace, heartbeatCapacityReservation, trackReservationChild, untrackReservationChild, terminateReservationChild, growCapacityReservation, releaseCapacity};
