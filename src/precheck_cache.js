// Optional evidence associated with a verified quarantine entry. Invalid or
// unavailable evidence is always a cache miss, never an approval.
const precheckFs=require('fs');
const precheckPath=require('path');
const precheckCrypto=require('crypto');
const precheckZlib=require('zlib');
const PRECHECK_MAX_RAW=256*1024*1024;
const PRECHECK_MAX_COMPRESSED=64*1024*1024;
function precheckPathFor(entry) {
  const id=String(entry?.id || ''), sourceHash=String(entry?.sourceHash || '');
  if(!/^[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{24}$/.test(id) || id.split('-')[1]!==sourceHash) throw Error('Invalid precheck source identity');
  const root=precheckFs.realpathSync(entry.root);
  const directory=precheckPath.join(root,'tdarr-av1-quarantine');
  if(entry.quarantineRoot!==directory || entry.candidatePath!==precheckPath.join(directory,`${id}.mkv`) || precheckFs.realpathSync(directory)!==directory) throw Error('Invalid precheck cache path');
  return `${entry.candidatePath}.prechecks.gz`;
}
function validPrecheckEvidence(data) {
  const f=data?.frameScan,a=data?.audio;
  return !!f && Number.isSafeInteger(f.frames) && f.frames>0 && Array.isArray(f.timestamps) && f.timestamps.length===f.frames
    && f.timestamps.every(Number.isFinite)
    && ['interlaced','dovi','hdr10plus','otherDynamic'].every(k=>Number.isSafeInteger(f[k])&&f[k]>=0)
    && !!f.staticInfo && typeof f.staticInfo==='object' && !!f.colorInfo && typeof f.colorInfo==='object'
    && !!a && Array.isArray(a.streams) && Array.isArray(a.repairs)
    && a.streams.every(s=>Number.isSafeInteger(s.index)&&s.index>=0&&typeof s.timeBase==='string')
    && a.repairs.every(r=>Array.isArray(r)&&r.length===2&&Number.isSafeInteger(r[0])&&r[1]&&typeof r[1]==='object');
}
function savePrecheckCache(entry,signature,data) {
  let temporary;
  try {
    if(!/^[a-f0-9]{64}$/.test(signature) || !validPrecheckEvidence(data)) return false;
    const destination=precheckPathFor(entry);
    const payload=JSON.stringify({version:1,sourceHash:entry.sourceHash,signature,data});
    if(Buffer.byteLength(payload)>PRECHECK_MAX_RAW) return false;
    const checksum=precheckCrypto.createHash('sha256').update(payload).digest('hex');
    const compressed=precheckZlib.gzipSync(JSON.stringify({checksum,payload}));
    if(compressed.length>PRECHECK_MAX_COMPRESSED) return false;
    temporary=`${destination}.${precheckCrypto.randomBytes(8).toString('hex')}.tmp`;
    precheckFs.writeFileSync(temporary,compressed,{flag:'wx',mode:0o600});
    precheckFs.renameSync(temporary,destination);
    return true;
  } catch (_) { if(temporary)try{precheckFs.unlinkSync(temporary);}catch(_){} return false; }
}
function loadPrecheckCache(entry,signature) {
  try {
    if(!/^[a-f0-9]{64}$/.test(signature)) return null;
    const file=precheckPathFor(entry),stat=precheckFs.lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>PRECHECK_MAX_COMPRESSED) return null;
    const outer=JSON.parse(precheckZlib.gunzipSync(precheckFs.readFileSync(file),{maxOutputLength:PRECHECK_MAX_RAW+1024}).toString('utf8'));
    if(typeof outer.payload!=='string' || precheckCrypto.createHash('sha256').update(outer.payload).digest('hex')!==outer.checksum) return null;
    const record=JSON.parse(outer.payload);
    if(record.version!==1 || record.sourceHash!==entry.sourceHash || record.signature!==signature || !validPrecheckEvidence(record.data)) return null;
    return record.data;
  } catch (_) { return null; }
}
function removePrecheckCache(entry) {
  try { precheckFs.unlinkSync(precheckPathFor(entry)); } catch (error) { if(error.code!=='ENOENT') throw error; }
}
if(typeof module!=='undefined') module.exports={savePrecheckCache,loadPrecheckCache,removePrecheckCache};
