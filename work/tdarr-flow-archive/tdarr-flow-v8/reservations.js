// Reservations conservatively charge all jobs sharing this ledger, even across
// different reported filesystem devices. They reserve the full estimate until release; unrelated writers,
// output exceeding the estimate, remounts, and filesystem quotas are not covered.
const reservationFs = require('fs');
const reservationPath = require('path');
const reservationCrypto = require('crypto');
const RESERVATION_DIR = '.tdarr-av1-reservations';
const RESERVATION_LOCK = '.tdarr-av1-reservations.lock';
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
    if (!r || r.version!==1 || !/^[a-f0-9]{48}$/.test(r.token) || !/^\d+$/.test(r.device) || !/^[1-9]\d*$/.test(r.bytes) || !/^\d+$/.test(r.floorBytes)) throw Error('Invalid fields');
    return r;
  } catch (e) { throw Error(`Invalid reservation record ${name}: ${e.message || e}`); }
}
// bytes and floorBytes are bigint byte counts; root is common to all jobs.
// candidate must be the actual existing destination directory. The caller must
// save the returned JSON-serializable handle for every success/error cleanup.
async function reserveCapacity({root, candidate, bytes, floorBytes=0n, timeoutMs=30000, pollMs=50}) {
  root=reservationRoot(root);
  reservationAmount(bytes,'bytes'); reservationAmount(floorBytes,'floorBytes',true);
  if (typeof candidate !== 'string' || !reservationPath.isAbsolute(candidate)) throw Error('Candidate must be an absolute existing directory');
  return reservationCritical(root, dir => {
    const stat=reservationFs.statSync(candidate,{bigint:true});
    if (!stat.isDirectory()) throw Error('Candidate must be a directory');
    const device=String(stat.dev), space=reservationFs.statfsSync(candidate,{bigint:true});
    if (typeof space.bavail !== 'bigint' || typeof space.bsize !== 'bigint' || space.bavail < 0n || space.bsize <= 0n) throw Error('Cannot determine available capacity');
    const available=space.bavail * space.bsize;
    let outstanding=0n, floor=floorBytes;
    for (const name of reservationFs.readdirSync(dir)) {
      const r=reservationRecord(dir,name);
      // Device IDs can alias the same physical storage (e.g. Unraid FUSE).
      // Charge every outstanding reservation conservatively against every candidate.
      outstanding += BigInt(r.bytes); if (BigInt(r.floorBytes)>floor) floor=BigInt(r.floorBytes);
    }
    if (available < outstanding + bytes + floor) throw Error('Insufficient available capacity for reservation');
    const id=reservationCrypto.randomBytes(24).toString('hex'), token=reservationCrypto.randomBytes(24).toString('hex');
    const record={version:1,token,device,bytes:String(bytes),floorBytes:String(floorBytes),createdAt:new Date().toISOString(),pid:process.pid};
    reservationFs.writeFileSync(reservationPath.join(dir,`${id}.json`),JSON.stringify(record),{flag:'wx',mode:0o600});
    return {root,id,token};
  },timeoutMs,pollMs);
}
async function releaseCapacity(handle, {timeoutMs=30000,pollMs=50}={}) {
  if (!handle || !/^[a-f0-9]{48}$/.test(handle.id) || !/^[a-f0-9]{48}$/.test(handle.token)) throw Error('Invalid reservation handle');
  const root=reservationRoot(handle.root);
  return reservationCritical(root, dir => {
    const name=`${handle.id}.json`, r=reservationRecord(dir,name);
    if (r.token !== handle.token) throw Error('Reservation owner mismatch');
    reservationFs.unlinkSync(reservationPath.join(dir,name));
  },timeoutMs,pollMs);
}
if (typeof module !== 'undefined') module.exports = {reserveCapacity, releaseCapacity};
