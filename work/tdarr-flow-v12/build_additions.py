# Executed by build.py with the flow and V5 engine in scope.
import re

# Replace the inherited job-lifetime mutex with short-lived admission locks.
old_lock=(root/'base/capacity_lock.js').read_text()
if e.count(old_lock)!=1: raise RuntimeError('V3 lock module not found exactly once')
e=e.replace(old_lock,'',1)
a=e.index('  // Serialize these AV1 jobs across the configured shared cache mount.')
b=e.index('  // A per-job directory prevents collisions for identical basenames.',a)
e=e[:a]+'''  try {
  // Cache reservations permit concurrent jobs while coordinating available space.
  const reservationRootDir = process.env.TDARR_RESERVATION_ROOT || "/transcode_cache";
  const envMinFreeMB = parseInt(process.env.TDARR_MIN_FREE_SPACE_MB || args.variables?.user?.min_cache_free_mb || 0, 10);
  const minFloorMB = Number.isSafeInteger(envMinFreeMB) && envMinFreeMB > 0 ? envMinFreeMB : 20480;
  const envMinRamFreeMB = parseInt(process.env.TDARR_MIN_RAM_FREE_MB || args.variables?.user?.min_ram_free_mb || 0, 10);
  const minRamFloorMB = Number.isSafeInteger(envMinRamFreeMB) && envMinRamFreeMB > 0 ? envMinRamFreeMB : 2048;
  const envMinSystemRamFreeMB = parseInt(process.env.TDARR_MIN_SYSTEM_RAM_FREE_MB || args.variables?.user?.min_system_ram_free_mb || 0, 10);
  const minSystemRamFloorMB = Number.isSafeInteger(envMinSystemRamFreeMB) && envMinSystemRamFreeMB > 0 ? envMinSystemRamFreeMB : 4096;
  const reservedOutputBytes = ((originalSnapshot.size * 5n + 3n) / 4n) + 64n * 1024n * 1024n;
  const maxOutputBytes = reservedOutputBytes - 32n * 1024n * 1024n;
  const candidates = [];
  // Prefer bounded /dev/shm when capacity allows; configured disk paths remain fallbacks.
  for (const candidate of ["/dev/shm", process.env.TDARR_DEDICATED_CACHE, args.variables?.user?.dedicated_cache_dir, args.workDir, "/transcode_cache", "/temp", "/mnt/cache", "/app/unmappedNodeCache"]) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || !fs.existsSync(candidate)) continue;
    try {
      const real = fs.realpathSync(candidate);
      const fsType = fs.statfsSync(real,{bigint:true}).type;
      if (typeof fsType !== "bigint") { log(`[Cache reservation] Cannot determine filesystem type for ${candidate}; skipping.`); continue; }
      const magic = BigInt.asUintN(32,fsType);
      if (magic === 2240043254n) { log(`[Cache reservation] Skipping unbounded ramfs candidate ${candidate}.`); continue; }
      if (!candidates.includes(real)) candidates.push(real);
    } catch (err) { log(`[Cache reservation] Cannot inspect ${candidate}; trying the next cache.`); }
  }
  let selectedDir = null;
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      const magic = BigInt.asUintN(32,fs.statfsSync(real,{bigint:true}).type);
      const isRamCache = magic === 16914836n;
      const floorBytes = BigInt(isRamCache ? minRamFloorMB : minFloorMB) * 1024n * 1024n;
      const systemRamFloorBytes = BigInt(isRamCache ? minSystemRamFloorMB : 0) * 1024n * 1024n;
      const handle = await reserveCapacity({root:reservationRootDir,candidate:real,bytes:reservedOutputBytes,floorBytes,systemRamFloorBytes});
      args.variables.user.cache_reservation = handle;
      selectedDir = real;
      log(`[Cache reservation] Reserved ${reservedOutputBytes} bytes on ${real} (${isRamCache ? "RAM" : "disk"}); other jobs may run when capacity permits.`);
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
# Tie the reservation to the exact temporary directory created for this job.
one('  args.variables.user.safety_temp_dir = targetDir;', '  args.variables.user.safety_temp_dir = targetDir;\n  await registerReservationWorkspace(args.variables.user.cache_reservation, targetDir);')
# Encodes remain capped below the initial estimate. Seek-heal remuxes use the
# dynamically expanded RLIMIT reservation instead of a static FFmpeg -fs cap.
one('      "-max_muxing_queue_size", "2048",\n      outputPath', '      "-max_muxing_queue_size", "2048",\n      ...(!forceStreamCopy ? ["-fs", String(maxOutputBytes)] : []),\n      outputPath')

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
  let reason = '', fallbackReason = '', remuxDetail = '';
  const previous = args.jobLog;
  args.jobLog = message => {
    const text=String(message || '');
    const relevant=/safety check failed|source media corruption|iso guard|\\[hdr guard\\]|\\[video guard\\]|\\[original guard\\]|\\[arc gpu\\]|\\[probe\\]|\\[cache reservation\\]|transcode execution failed|\\[size guard\\]|job failed|file not found|no valid video|incompatible pixel/i.test(text);
    if (relevant && !/ICQ \\d+ reached the source size/i.test(text)) {
      if (!fallbackReason) fallbackReason=text;
      if (/seek-healing remux/i.test(text)) remuxDetail=text;
      else if (/safety check failed|source media corruption|iso guard|\\[hdr guard\\]|\\[video guard\\]|\\[original guard\\]|\\[arc gpu\\]|\\[probe\\]|\\[cache reservation\\]|transcode execution failed|\\[size guard\\] no smaller output at icq|job failed|file not found|no valid video|incompatible pixel/i.test(text)) reason=text;
    }
    if (typeof previous === 'function') { try { previous(message); } catch (_) {} }
  };
  let reservationHeartbeatTimer=null;
  const heartbeatReservation=()=>{
    const handle=args.variables?.user?.cache_reservation;
    if (!handle) return;
    heartbeatCapacityReservation(handle).catch(err=>{
      if (typeof args.jobLog==='function') { try { args.jobLog(`[Cache reservation] Lease heartbeat failed: ${err.message || err}`); } catch (_) {} }
    });
  };
  try {
    reservationHeartbeatTimer=setInterval(heartbeatReservation,30000);
    if (reservationHeartbeatTimer.unref) reservationHeartbeatTimer.unref();
    const result=await runV6ArcJob(args);
    if (result.outputNumber===2) args.variables.user.failure_reason=([reason || fallbackReason,remuxDetail].filter(Boolean).join(' ') || 'Arc AV1 processing failed; inspect the Tdarr job log.').slice(0,1500);
    if (result.outputNumber===3) args.variables.user.failure_reason="Disc image removed; check the Arr rescan log.";
    return result;
  } catch (err) {
    args.variables.user.failure_reason=`Unexpected flow error: ${String(err?.message || err)}`.slice(0,1500);
    throw err;
  } finally {
    if (reservationHeartbeatTimer) clearInterval(reservationHeartbeatTimer);
    args.jobLog=previous;
  }
};
'''
# Include utilities before the actual engine export.
e=(root/'reservations.js').read_text()+'\n'+(root/'pgs.js').read_text()+'\n'+e

# Every path that reaches cleanup releases only this job's reservation.
release='''if (args.variables?.user?.cache_reservation) {
    try { await releaseCapacity(args.variables.user.cache_reservation); delete args.variables.user.cache_reservation; }
    catch (err) { log(`[Cache reservation] Release failed; inspect the reservation ledger: ${err.message || err}`); }
  }'''
# Carry ASS/SSA preservation into success notices and make remux outcomes clear.
one('''    log(`[Output Validation] Validated output: duration ${valResult.sourceDuration ? valResult.sourceDuration + 's -> ' : ''}${valResult.outputDuration}s; 1 ${expectedVideoCodec} video stream, ${finalAudioStreams.length} audio, ${finalSubStreams.length} subtitles.`);''', '''    log(`[Output Validation] Validated output: duration ${valResult.sourceDuration ? valResult.sourceDuration + 's -> ' : ''}${valResult.outputDuration}s; 1 ${expectedVideoCodec} video stream, ${finalAudioStreams.length} audio, ${finalSubStreams.length} subtitles.`);
    args.variables.user.ass_subtitle_preserved_count=isMatroskaContainer?finalSubStreams.filter(s=>['ass','ssa'].includes(String(s.codec_name||'').toLowerCase())).length:0;''')
success=next((p for p in flow['flowPlugins'] if p['id']=='discord_success'),None)
if not success: raise RuntimeError('Success notifier plugin not found')
success_code=success['inputsDB']['code']
old_hdr='  const payload = JSON.stringify({'
new_hdr='''  const styledSubtitleCount=Number(args.variables?.user?.ass_subtitle_preserved_count||0);
  if (Number.isSafeInteger(styledSubtitleCount)&&styledSubtitleCount>0) descLines.push(`💬 **Styled subtitles:** ${styledSubtitleCount} ASS/SSA track${styledSubtitleCount===1?'':'s'} preserved`);
'''+old_hdr
if success_code.count(old_hdr)!=1: raise RuntimeError('Expected one success notifier HDR line')
success_code=success_code.replace(old_hdr,new_hdr,1)
if success_code.count('Tracks normalized')!=1: raise RuntimeError('Expected one larger-output size label')
success_code=success_code.replace('Tracks normalized','Seek-heal remux',1)
if success_code.count('Original Video Preserved • Bloat Protected')!=1: raise RuntimeError('Expected one fallback bitrate label')
success_code=success_code.replace('Original Video Preserved • Bloat Protected','Original Video Stream-Copied • Seek-Healed',1)
success['inputsDB']['code']=success_code
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
