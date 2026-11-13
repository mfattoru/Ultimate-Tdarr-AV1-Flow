# Executed by build.py with the flow and V5 engine in scope.
import re

# Replace the inherited job-lifetime mutex with short-lived admission locks.
old_lock=(root.parent/'tdarr-flow-v3/capacity_lock.js').read_text()
if e.count(old_lock)!=1: raise RuntimeError('V3 lock module not found exactly once')
e=e.replace(old_lock,'',1)
a=e.index('  // Serialize these AV1 jobs across the configured shared cache mount.')
b=e.index('  // A per-job directory prevents collisions for identical basenames.',a)
e=e[:a]+'''  try {
  // Cache reservations permit concurrent jobs while coordinating available space.
  const reservationRootDir = process.env.TDARR_RESERVATION_ROOT || "/transcode_cache";
  const envMinFreeMB = parseInt(process.env.TDARR_MIN_FREE_SPACE_MB || args.variables?.user?.min_cache_free_mb || 0, 10);
  const minFloorMB = Number.isSafeInteger(envMinFreeMB) && envMinFreeMB > 0 ? envMinFreeMB : 20480;
  const reservedOutputBytes = ((originalSnapshot.size * 5n + 3n) / 4n) + 64n * 1024n * 1024n;
  const maxOutputBytes = reservedOutputBytes - 32n * 1024n * 1024n;
  const candidates = [];
  // Do not use tmpfs/ramfs: physical and cgroup memory are not reserved by statfs.
  for (const candidate of [process.env.TDARR_DEDICATED_CACHE, args.variables?.user?.dedicated_cache_dir, args.workDir, "/transcode_cache", "/temp", "/mnt/cache", "/app/unmappedNodeCache"]) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || !fs.existsSync(candidate)) continue;
    const real = fs.realpathSync(candidate);
    if (real === "/dev/shm" || real.startsWith("/dev/shm/")) continue;
    const fsType = fs.statfsSync(real,{bigint:true}).type;
    if (typeof fsType !== "bigint") throw Error("Cannot determine cache filesystem type");
    const magic = BigInt.asUintN(32,fsType);
    if (magic === 16914836n || magic === 2240043254n) continue; // tmpfs or ramfs
    if (!candidates.includes(real)) candidates.push(real);
  }
  let selectedDir = null;
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      const floorBytes = BigInt(minFloorMB) * 1024n * 1024n;
      const handle = await reserveCapacity({root:reservationRootDir,candidate:real,bytes:reservedOutputBytes,floorBytes});
      args.variables.user.cache_reservation = handle;
      selectedDir = real;
      log(`[Cache reservation] Reserved ${reservedOutputBytes} bytes on ${real}; other jobs may run when capacity permits.`);
      break;
    } catch (err) {
      if (/Insufficient available capacity for reservation/.test(String(err.message || err))) {
        log(`[Cache reservation] Insufficient available capacity on ${candidate}; trying the next candidate.`);
        continue;
      }
      throw err;
    }
  }
  if (!selectedDir) throw Error("No cache directory has enough unreserved space for this job");

''' +e[b:]
# Cap each attempt below its reserved cache budget; incomplete outputs still fail validation.
one('      "-max_muxing_queue_size", "2048",\n      outputPath', '      "-max_muxing_queue_size", "2048",\n      "-fs", String(maxOutputBytes),\n      outputPath')

# PGS data are split/merged into different container packets. Preserve and
# compare actual SUP segments and their timestamps instead of packet counts.
one('    tracks[type] = from.map((index, i) => [index, to[i]]);', '    tracks[type] = from.map((index, i) => [index, to[i], (src.streams || []).find(s => s.index === index)?.codec_name]);')
one('    for (const [srcIndex,dstIndex] of tracks[type]) {', '    for (const [srcIndex,dstIndex,sourceCodec] of tracks[type]) {')
one("      const s=await measureStreamTimeline(ffprobe,source,srcIndex,type);", "      if (type === 'subtitle' && sourceCodec === 'hdmv_pgs_subtitle') { await verifyPgsSegments(ffmpeg,source,output,srcIndex,dstIndex,shift); continue; }\n      const s=await measureStreamTimeline(ffprobe,source,srcIndex,type);")

# The central failure notifier owns failure alerts and deduplicates the error hook.
for tag in ['Discord Failure Notifier','Discord Incompatible','Discord Undersized','Discord ISO Deleted']:
 pattern=re.compile(r'\s*await sendWebhookWithRetry\(webhookUrl,\s*\w+,\s*"'+re.escape(tag)+r'",\s*3\);')
 e,n=pattern.subn('',e)
 if n!=1: raise RuntimeError('Unexpected notifier count for '+tag+': '+str(n))
for fragment in ['`[Arc AV1 Single-Pass] File not found or inaccessible:', '`[Arc AV1 Single-Pass] No valid video stream found in:', '`[Arc AV1 Single-Pass] Incompatible pixel format', '`[Size Guard] Output file undersized:']:
 old='console.log('+fragment;new='log('+fragment
 if e.count(old)!=1: raise RuntimeError('Unexpected log match: '+fragment)
 e=e.replace(old,new,1)

# Capture the specific reason while retaining normal Tdarr logging and errors.
e += '''
const runV6ArcJob = module.exports;
module.exports = async (args) => {
  if (!args.variables) args.variables={};
  if (!args.variables.user) args.variables.user={};
  delete args.variables.user.failure_notified;
  delete args.variables.user.failure_reason;
  let reason = '';
  const previous = args.jobLog;
  args.jobLog = message => {
    const text=String(message || '');
    if (/safety check failed|iso guard|\\[hdr guard\\]|\\[video guard\\]|\\[original guard\\]|\\[arc gpu\\]|\\[probe\\]|\\[cache reservation\\]|transcode execution failed|\\[size guard\\]|job failed|file not found|no valid video|incompatible pixel/i.test(text)) reason=text;
    if (typeof previous === 'function') { try { previous(message); } catch (_) {} }
  };
  try {
    const result=await runV6ArcJob(args);
    if (result.outputNumber===2) args.variables.user.failure_reason=(reason || 'Arc AV1 processing failed; inspect the Tdarr job log.').slice(0,1500);
    if (result.outputNumber===3) args.variables.user.failure_reason="Disc image removed; check the Arr rescan log.";
    return result;
  } catch (err) {
    args.variables.user.failure_reason=`Unexpected flow error: ${String(err?.message || err)}`.slice(0,1500);
    throw err;
  } finally { args.jobLog=previous; }
};
'''
# Include utilities before the actual engine export.
e=(root/'reservations.js').read_text()+'\n'+(root/'pgs.js').read_text()+'\n'+e

# Every path that reaches cleanup releases only this job's reservation.
release='''if (args.variables?.user?.cache_reservation) {
    try { await releaseCapacity(args.variables.user.cache_reservation); delete args.variables.user.cache_reservation; }
    catch (err) { log(`[Cache reservation] Release failed; inspect the reservation ledger: ${err.message || err}`); }
  }'''
for p in flow['flowPlugins']:
 if p['id'] not in ('cleanup_success','cleanup_failure','cleanup_on_error'): continue
 code=p['inputsDB']['code']
 if code.count(old_lock)!=1 or code.count('releaseCapacityLock(args.variables, log);')!=1: raise RuntimeError('Unexpected cleanup structure: '+p['id'])
 code=code.replace(old_lock,'',1).replace('releaseCapacityLock(args.variables, log);',release,1)
 if p['id']=='cleanup_success':
  code=code.replace('  const output = args.variables?.user?.safety_temp_output;', '  const output = args.variables?.user?.safety_temp_output;\n  let cleanupComplete = false;')
  code=code.replace('      log(`[Cache cleanup] Safely removed job cache: ${tempDir}`);', '      cleanupComplete = true;\n      log(`[Cache cleanup] Safely removed job cache: ${tempDir}`);')
  code=code.replace('  if (args.variables?.user) {\n    delete args.variables.user.safety_temp_dir;', '  if (args.variables?.user && cleanupComplete) {\n    delete args.variables.user.safety_temp_dir;')
 p['inputsDB']['code']=(root/'reservations.js').read_text()+'\n'+code
