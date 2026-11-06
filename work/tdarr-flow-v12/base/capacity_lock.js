// Serializes jobs sharing this lock root; other applications are not coordinated.
const capacityFs = require('fs');
const capacityPath = require('path');
const capacityCrypto = require('crypto');
const requiredDiskSpaceMB = (sourceMB, floorMB) => Math.ceil(sourceMB * 1.25) + Math.ceil(floorMB);

async function acquireCapacityLock(root, variables, log, timeoutMs=12*60*60*1000, pollMs=5000) {
  if (!capacityPath.isAbsolute(root) || !capacityFs.statSync(root).isDirectory()) throw new Error('Capacity lock root must be an existing absolute shared directory');
  const lockDir=capacityPath.join(root,'.tdarr-av1-capacity.lock');
  const token=capacityCrypto.randomBytes(24).toString('hex');
  const deadline=Date.now()+timeoutMs;
  let lastLog=0;
  for (;;) {
    let created=false;
    try {
      capacityFs.mkdirSync(lockDir,{mode:0o700}); created=true;
      capacityFs.writeFileSync(capacityPath.join(lockDir,'owner.json'),JSON.stringify({token,pid:process.pid,createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
      variables.user.capacity_lock={dir:lockDir,token};
      return;
    } catch(e) {
      if (created) {
        try { capacityFs.unlinkSync(capacityPath.join(lockDir,'owner.json')); } catch(_) {}
        try { capacityFs.rmdirSync(lockDir); } catch(_) {}
        throw e;
      }
      if (e.code!=='EEXIST') throw e;
      if (Date.now()>=deadline) throw new Error(`Timed out waiting for Tdarr capacity lock ${lockDir}; inspect for a stale lock if no job is active`);
      if (Date.now()-lastLog>=60000) { log(`[Cache capacity] Waiting for another Tdarr AV1 job: ${lockDir}`);lastLog=Date.now(); }
      await new Promise(r=>setTimeout(r,Math.min(pollMs,Math.max(1,deadline-Date.now()))));
    }
  }
}

function releaseCapacityLock(variables, log) {
  const lock=variables?.user?.capacity_lock;
  if (!lock || typeof lock.dir!=='string' || capacityPath.basename(lock.dir)!=='.tdarr-av1-capacity.lock' || typeof lock.token!=='string') return;
  try {
    const owner=JSON.parse(capacityFs.readFileSync(capacityPath.join(lock.dir,'owner.json'),'utf8'));
    if (owner.token!==lock.token) { log('[Cache capacity] Lock owner changed; refusing to remove it'); return; }
    capacityFs.unlinkSync(capacityPath.join(lock.dir,'owner.json'));
    capacityFs.rmdirSync(lock.dir);
    delete variables.user.capacity_lock;
  } catch(e) { log(`[Cache capacity] Could not release lock: ${e.message || e}`); }
}
