# Executed by build.py with the flow and V5 engine in scope.
import re

one('  if (isUndersized) {', '''  if (isUndersized) {
    if (quarantinedCandidate) {
      const sizeFailureReport={version:1,outcome:"rejected",stage:"size_policy",checks:[{stage:"size_policy",outcome:"rejected",code:"candidate_size_policy"}],failure:{outcome:"rejected",stage:"size_policy",code:"candidate_size_policy",message:`Quarantined candidate failed the current size floor (${newSizeMB.toFixed(2)} MB, ${ratioPct.toFixed(1)}% of source).`}};
      args.variables.user.validation_report=sizeFailureReport;
      try {
        quarantinedCandidate=await updateQuarantineFailure(quarantinedCandidate,sizeFailureReport);
        args.variables.user.quarantine_entry=quarantinedCandidate;
        log(`[Quarantine] Candidate remains stored after failing the current size policy (${quarantinedCandidate.candidatePath}).`);
      } catch (quarantineError) {
        log(`[Quarantine] Could not update the stored candidate's size-policy report: ${quarantineError.message || quarantineError}; the candidate remains untouched.`);
      }
    }
''')

# Replace the inherited job-lifetime mutex with short-lived admission locks.
old_lock=(src/'base/capacity_lock.js').read_text()
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
one('  args.variables.user.safety_temp_output = outputPath;', '''  args.variables.user.safety_temp_output = outputPath;
  if (quarantinedCandidate) {
    const cachedCandidateSize = BigInt(fs.statSync(quarantinedCandidate.candidatePath).size);
    if (cachedCandidateSize > reservedOutputBytes) {
      await growCapacityReservation(args.variables.user.cache_reservation,cachedCandidateSize,0n,{marginBytes:64n*1024n*1024n});
      log(`[Cache reservation] Expanded scratch capacity for ${cachedCandidateSize}-byte quarantined candidate.`);
    }
    fs.copyFileSync(quarantinedCandidate.candidatePath,outputPath,fs.constants.COPYFILE_EXCL);
    if (hashFilePath(outputPath) !== quarantinedCandidate.candidateHash) {
      try { fs.unlinkSync(outputPath); } catch (_) {}
      throw Error('Quarantined candidate changed while copying into the current job cache');
    }
    args.variables.user.quarantine_entry=quarantinedCandidate;
    log(`[Quarantine] Copied the stored candidate into this job cache for current validation; the quarantine original remains untouched until replacement succeeds.`);
  }
  if (!quarantinedCandidate && normalizedAssContents.size > 0) {
    for (const [streamIndex, normAssText] of normalizedAssContents) {
      const normAssPath = path.join(targetDir, `normalized-sub-${streamIndex}.ass`);
      fs.writeFileSync(normAssPath, normAssText, {mode: 0o600});
      normalizedAssPaths.set(streamIndex, normAssPath);
    }
    log(`[Subtitle precheck] Wrote ${normalizedAssPaths.size} normalized ASS/SSA stream file(s) into job scratch.`);
  }
''')
# Encodes remain capped below the initial estimate. Seek-heal remuxes use the
# dynamically expanded RLIMIT reservation instead of a static FFmpeg -fs cap.
one('      "-max_muxing_queue_size", "2048",\n      outputPath', '      "-max_muxing_queue_size", "2048",\n      ...(!forceStreamCopy ? ["-fs", String(maxOutputBytes)] : []),\n      outputPath')

# PGS data are split/merged into different container packets. Preserve and
# compare actual SUP segments and their timestamps instead of packet counts.
one('  const timelinePairCount=1+tracks.audio.length+tracks.subtitle.length;', '  const pgsSubtitleCount=tracks.subtitle.filter(track=>track[2]===\'hdmv_pgs_subtitle\').length;\n  const timelinePairCount=1+tracks.audio.length+(tracks.subtitle.length-pgsSubtitleCount)+(pgsSubtitleCount?1:0);')
one('    tracks[type] = from.map((index, i) => [index, to[i]]);', '    tracks[type] = from.map((index, i) => [index, to[i], (src.streams || []).find(s => s.index === index)?.codec_name, (dst.streams || []).find(s => s.index === to[i])?.codec_name]);')
one('    for (const [srcIndex,dstIndex] of tracks[type]) {', '    for (const [srcIndex,dstIndex,sourceCodec,outputCodec] of tracks[type]) {')
one('  const shift=b.first-a.first;\n  for (const type of [\'audio\',\'subtitle\']) {', '  const shift=b.first-a.first;\n  const subtitleTimestampRepairs=[];\n  const audioTimestampFindings=[];\n  const pgsTracksToVerify=[];\n  for (const type of [\'audio\',\'subtitle\']) {')
one("      const s=await measureStreamTimeline(ffprobe,source,srcIndex,type);\n      const d=await measureStreamTimeline(ffprobe,output,dstIndex,type);", "      if (type === 'subtitle' && sourceCodec === 'hdmv_pgs_subtitle') { pgsTracksToVerify.push([srcIndex,dstIndex]); continue; }\n      if (type === 'subtitle' && ['ass','ssa'].includes(String(sourceCodec||'').toLowerCase()) && String(outputCodec||'').toLowerCase()===String(sourceCodec||'').toLowerCase()) {\n        let sourcePackets,outputPackets;\n        await scanTimelinePair(async(sourceProgress,outputProgress)=>{\n          sourcePackets=await readSubtitlePackets(ffprobe,source,srcIndex,sourceProgress,durationHints?.source);\n          outputPackets=await readSubtitlePackets(ffprobe,output,dstIndex,outputProgress,durationHints?.output);\n        });\n        const timingResult=validateCopiedSubtitlePackets(sourcePackets,outputPackets,shift);\n        if (timingResult.adjustedPackets || timingResult.reorderedPackets) subtitleTimestampRepairs.push({sourceIndex:srcIndex,...timingResult});\n        continue;\n      }\n      let s,d;\n      await scanTimelinePair(async(sourceProgress,outputProgress)=>{\n        s=await measureStreamTimeline(ffprobe,source,srcIndex,type,sourceProgress,durationHints?.source,'source');\n        d=await measureStreamTimeline(ffprobe,output,dstIndex,type,outputProgress,durationHints?.output,'candidate');\n      });\n      if (s.empty && d.empty) continue;\n      if (type==='audio' && audioTimestampRepairIndices.includes(srcIndex)) {\n        if (s.totalPackets!==d.totalPackets) throw new Error(`Repaired audio packet count differs for stream ${srcIndex}: source ${s.totalPackets}, candidate ${d.totalPackets}`);\n        if (d.outputDtsNonIncreasingCount!==0) throw new Error(`Repaired audio output DTS is still non-increasing for stream ${srcIndex} (${d.outputDtsNonIncreasingCount} packet transition(s))`);\n        audioTimestampFindings.push({sourceIndex:srcIndex,message:`bounded timestamp repair passed: ${s.totalPackets} packets preserved; candidate DTS is strictly increasing`});\n      }\n      if (type==='audio' && (s.missingPtsCount || d.missingPtsCount || s.missingTimestampCount || d.missingTimestampCount)) {\n        if ((d.missingPtsCount || d.missingTimestampCount) && s.totalPackets!==d.totalPackets) throw new Error(`Output audio stream ${srcIndex} has ${d.totalPackets} packets vs source ${s.totalPackets}; packet ordinals cannot safely establish whether missing timestamps were introduced`);\n        const findIntroducedMissing=(candidateBitmap,sourceBitmap,packetCount)=>{\n          let count=0,first=-1;\n          const byteCount=Math.ceil(packetCount/8);\n          for(let byteIndex=0;byteIndex<byteCount;byteIndex++){\n            let introduced=(candidateBitmap[byteIndex]||0)&~(sourceBitmap[byteIndex]||0);\n            if(!introduced)continue;\n            if(first<0){for(let bit=0;bit<8;bit++)if(introduced&(1<<bit)){first=byteIndex*8+bit;break;}}\n            while(introduced){introduced&=introduced-1;count++;}\n          }\n          return {count,first};\n        };\n        const introducedPts=findIntroducedMissing(d.missingPtsBitmap,s.missingPtsBitmap,d.totalPackets);\n        const introducedTimestamps=findIntroducedMissing(d.missingTimestampBitmap,s.missingTimestampBitmap,d.totalPackets);\n        if (introducedPts.count || introducedTimestamps.count) {\n          const details=[];\n          if(introducedPts.count)details.push(`${introducedPts.count} packet(s) missing PTS newly in candidate (first packet ${introducedPts.first+1})`);\n          if(introducedTimestamps.count)details.push(`${introducedTimestamps.count} packet(s) missing both PTS and DTS newly in candidate (first packet ${introducedTimestamps.first+1})`);\n          throw new Error(`Output audio stream ${srcIndex} worsened source timestamp coverage: ${details.join('; ')}; source had ${s.missingPtsCount} packet(s) without PTS and ${s.missingTimestampCount} without PTS or DTS`);\n        }\n        if(s.missingPtsCount && !d.missingPtsCount) audioTimestampFindings.push({sourceIndex:srcIndex,message:`source had ${s.missingPtsCount} packet(s) without PTS; candidate supplies PTS for all`});\n        else if(d.missingPtsCount) audioTimestampFindings.push({sourceIndex:srcIndex,message:`preserved ${d.missingPtsCount} source packet(s) without PTS; DTS was used where available`});\n        if(s.missingTimestampCount && !d.missingTimestampCount) audioTimestampFindings.push({sourceIndex:srcIndex,message:`candidate restored usable timestamps for ${s.missingTimestampCount} source packet(s)`});\n        else if(d.missingTimestampCount) audioTimestampFindings.push({sourceIndex:srcIndex,message:`preserved ${d.missingTimestampCount} source packet(s) without either PTS or DTS`});\n      }")
one('return {sourceDuration:a.duration,outputDuration:b.duration};', 'return {sourceDuration:a.duration,outputDuration:b.duration,subtitleTimestampRepairs,audioTimestampFindings};')
one("  const arcDevice=process.env.TDARR_ARC_DEVICE || '/dev/dri/renderD129';", "  if(pgsTracksToVerify.length)await scanTimelinePair((sourceProgress,outputProgress)=>verifyPgsSegmentsBatch(ffmpeg,source,output,pgsTracksToVerify,shift,sourceProgress,outputProgress,durationHints?.source,durationHints?.output));\n  const arcDevice=process.env.TDARR_ARC_DEVICE || '/dev/dri/renderD129';")

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
    const relevant=/safety check failed|source media corruption|iso guard|\\[hdr guard\\]|\\[video guard\\]|\\[original guard\\]|\\[arc gpu\\]|\\[probe\\]|\\[cache reservation\\]|\\[quarantine\\]|transcode execution failed|\\[size guard\\]|job failed|file not found|no valid video|incompatible pixel/i.test(text);
    if (relevant && !/ICQ \\d+ reached the source size/i.test(text)) {
      if (!fallbackReason) fallbackReason=text;
      if (/seek-healing remux/i.test(text)) remuxDetail=text;
      else if (/safety check failed|source media corruption|iso guard|\\[hdr guard\\]|\\[video guard\\]|\\[original guard\\]|\\[arc gpu\\]|\\[probe\\]|\\[cache reservation\\]|\\[quarantine\\]|transcode execution failed|\\[size guard\\] no smaller output at icq|job failed|file not found|no valid video|incompatible pixel/i.test(text)) reason=text;
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
e=(src/'reservations.js').read_text()+'\n'+(src/'pgs.js').read_text()+'\n'+(src/'subtitle_timing.js').read_text()+'\n'+e

# Every path that reaches cleanup releases only this job's reservation.
release='''if (args.variables?.user?.cache_reservation) {
    try { await releaseCapacity(args.variables.user.cache_reservation); delete args.variables.user.cache_reservation; }
    catch (err) { log(`[Cache reservation] Release failed; inspect the reservation ledger: ${err.message || err}`); }
  }'''
# Carry ASS/SSA preservation into success notices and make remux outcomes clear.
one('''    log(`[Output Validation] Validated output: duration ${valResult.sourceDuration ? valResult.sourceDuration + 's -> ' : ''}${valResult.outputDuration}s; 1 ${expectedVideoCodec} video stream, ${finalAudioStreams.length} audio, ${finalSubStreams.length} subtitles.`);''', '''    log(`[Output Validation] Validated output: duration ${valResult.sourceDuration ? valResult.sourceDuration + 's -> ' : ''}${valResult.outputDuration}s; 1 ${expectedVideoCodec} video stream, ${finalAudioStreams.length} audio, ${finalSubStreams.length} subtitles.`);
    for (const repair of valResult.subtitleTimestampRepairs || []) log(`[Subtitle timing] ASS/SSA stream 0:${repair.sourceIndex}: ${repair.reorderedPackets ? `reordered ${repair.reorderedPackets} out-of-order packet(s); ` : ""}normalized ${repair.adjustedPackets} timestamped packet(s); maximum adjustment ${repair.maxAdjustmentSeconds.toFixed(3)}s.`);
    for (const finding of valResult.audioTimestampFindings || []) log(`[Audio timeline] Stream 0:${finding.sourceIndex}: ${finding.message}.`);
    args.variables.user.ass_subtitle_preserved_count=isMatroskaContainer?finalSubStreams.filter(s=>['ass','ssa'].includes(String(s.codec_name||'').toLowerCase())).length:0;''')
one('  args.variables.user.final_size_mb = finalMB;', '''  args.variables.user.final_size_mb = finalMB;
  args.variables.user.original_size_bytes = sourceBytes;
  args.variables.user.final_size_bytes = fs.statSync(outputPath).size;''')
one("    args.variables.user.ass_subtitle_preserved_count=isMatroskaContainer?finalSubStreams.filter(s=>['ass','ssa'].includes(String(s.codec_name||'').toLowerCase())).length:0;", '''    args.variables.user.ass_subtitle_preserved_count=isMatroskaContainer?finalSubStreams.filter(s=>['ass','ssa'].includes(String(s.codec_name||'').toLowerCase())).length:0;
    const notifyLanguageNames={eng:'English',jpn:'Japanese',spa:'Spanish',ita:'Italian',zho:'Chinese',und:'Undetermined'};
    const notifyTrackLanguages=tracks=>{
      const labels=[...new Set(tracks.map(s=>normalizeLang(s.tags?.language||s.tags?.LANGUAGE||'und')).map(code=>notifyLanguageNames[code]||code.toUpperCase()))];
      if(!labels.length)return 'none';
      return labels.slice(0,4).join(', ')+(labels.length>4?` +${labels.length-4} more`:'');
    };
    args.variables.user.audio_track_count=finalAudioStreams.length;
    args.variables.user.audio_track_languages=notifyTrackLanguages(finalAudioStreams);
    args.variables.user.subtitle_track_count=finalSubStreams.length;
    args.variables.user.subtitle_track_languages=notifyTrackLanguages(finalSubStreams);''')
success=next((p for p in flow['flowPlugins'] if p['id']=='discord_success'),None)
if not success: raise RuntimeError('Success notifier plugin not found')
success_code=success['inputsDB']['code']
old_transcode_end='  const transcodeEndTs = args.variables?.user?.transcode_end_ts;'
if success_code.count(old_transcode_end)!=1: raise RuntimeError('Unexpected success notifier transcode timing block')
success_code=success_code.replace(old_transcode_end,old_transcode_end+'\n  const wasQuarantined = /^Quarantined /.test(String(args.variables?.user?.qsv_mode || ""));',1)
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
size_start=success_code.index('  let sizeStr = "";')
size_end=success_code.index('  const origVidKbps =',size_start)
new_size_block='''  const originalBytes=Number(args.variables?.user?.original_size_bytes);
  const outputBytes=Number(args.variables?.user?.final_size_bytes);
  const hasExactSizes=Number.isSafeInteger(originalBytes)&&originalBytes>0&&Number.isSafeInteger(outputBytes)&&outputBytes>0;
  const formatByteDelta=bytes=>bytes>=1024*1024?formatSize(bytes/(1024*1024)):bytes>=1024?`${(bytes/1024).toFixed(1)} KB`:`${bytes} B`;
  let sizeStr = "";
  if (origMB > 0 && newMB > 0) {
    if (hasExactSizes) {
      const deltaBytes=originalBytes-outputBytes;
      const pct=Math.abs(deltaBytes/originalBytes*100).toFixed(1);
      const change=deltaBytes>0?`-${pct}% • ${formatByteDelta(deltaBytes)} saved`:deltaBytes<0?`+${pct}% • ${formatByteDelta(-deltaBytes)} added`:'same size';
      sizeStr = `\\`${formatSize(origMB)}\\` ➔ \\`${formatSize(newMB)}\\` **(${change})**`;
    } else {
      const ratio = ((newMB / origMB) * 100).toFixed(1);
      const diffMB = origMB - newMB;
      if (diffMB > 0.05) {
        const pctSaved = (100 - ratio).toFixed(1);
        sizeStr = `\\`${formatSize(origMB)}\\` ➔ \\`${formatSize(newMB)}\\` **(-${pctSaved}% • ${formatSize(diffMB)} saved)**`;
      } else if (diffMB < -0.05) {
        const pctAdded = (ratio - 100).toFixed(1);
        sizeStr = `\\`${formatSize(origMB)}\\` ➔ \\`${formatSize(newMB)}\\` **(+${pctAdded}% • ${formatSize(-diffMB)} added)**`;
      } else {
        sizeStr = `\\`${formatSize(origMB)}\\` **(size unchanged)**`;
      }
    }
  } else {
    sizeStr = `\\`${formatSize(newMB || origMB)}\\``;
  }

'''
success_code=success_code[:size_start]+new_size_block+success_code[size_end:]
bitrate_start=success_code.index('  const qualVal = args.variables?.user?.quality_value;')
bitrate_end=success_code.index('\n\n  const medium =',bitrate_start)
new_bitrate_block='''  const qualVal = args.variables?.user?.quality_value;
  let bitrateStr = "";
  if (transcodeStartTs && transcodeEndTs && origVidKbps > 0 && newVidKbps > 0) {
    const qualDesc = qualVal ? `ICQ ${qualVal}` : "ICQ mode";
    bitrateStr = `\\`${formatBitrate(origVidKbps)}\\` ➔ \\`${formatBitrate(newVidKbps)}\\` **(${qualDesc})**`;
  } else if (wasQuarantined) {
    const kind=/seek-heal/i.test(String(args.variables?.user?.qsv_mode||''))?'stored seek-heal candidate':'stored AV1 candidate';
    bitrateStr = `\\`${formatBitrate(newVidKbps || origVidKbps)}\\` **(${kind})**`;
  } else if (isFallback) {
    bitrateStr = `\\`${formatBitrate(origVidKbps || newVidKbps)}\\` **(source video copied)**`;
  } else if (origVidKbps > 0 || newVidKbps > 0) {
    bitrateStr = `\\`${formatBitrate(newVidKbps || origVidKbps)}\\` **(stream copy)**`;
  }'''
success_code=success_code[:bitrate_start]+new_bitrate_block+success_code[bitrate_end:]
desc_start=success_code.index('  const descLines = [')
desc_end=success_code.index('\n  const payload = JSON.stringify({',desc_start)
new_desc_block='''  const wasEncoded=Boolean(transcodeStartTs&&transcodeEndTs);
  const cpuDecode=/CPU Decode|Downsample/i.test(String(pipelineMode||''));
  const softwareEncode=/Software SVT-AV1/i.test(String(pipelineMode||''));
  const methodLine=wasQuarantined
    ? `🔁 **Method:** Quarantined candidate revalidated • no encode ran`
    : isFallback
      ? `🛠️ **Result:** AV1 was not smaller; validated seek-heal remux kept the original video stream.`
    : wasEncoded
      ? softwareEncode
        ? `⚙️ **Method:** Software SVT-AV1 encode at CRF 28`
        : `⚙️ **Method:** Intel Arc QSV AV1 encode • ${cpuDecode?'CPU decode/conversion':'Arc QSV decode'}`
      : `🛠️ **Method:** Validated seek-heal remux • original video stream copied`;
  const audioCount=Number(args.variables?.user?.audio_track_count||0);
  const audioLanguages=String(args.variables?.user?.audio_track_languages||'not reported');
  const subtitleCount=Number(args.variables?.user?.subtitle_track_count||0);
  const subtitleLanguages=String(args.variables?.user?.subtitle_track_languages||'not reported');
  const styledSubtitleCount=Number(args.variables?.user?.ass_subtitle_preserved_count||0);
  const subtitleStyle=styledSubtitleCount>0?` • ${styledSubtitleCount} styled ASS/SSA track${styledSubtitleCount===1?'':'s'} preserved`:'';
  const descLines = [
    `📁 **Size:** ${sizeStr}`,
    `📊 **Estimated video bitrate:** ${bitrateStr || "\\`Preserved\\`"}`,
    methodLine,
    `🔊 **Audio:** ${audioCount} track${audioCount===1?'':'s'} • ${audioLanguages}`,
    `💬 **Subtitles:** ${subtitleCount} track${subtitleCount===1?'':'s'} • ${subtitleLanguages}${subtitleStyle}`,
    `✅ **Validation:** Full stream, timing, subtitle, and A/V decode checks passed`,
    `⏱️ **Processing time:** ${totalDurationStr} • ${mediumTag} scratch`
  ];
  if(args.variables?.user?.validation_report?.outcome==='recovered')descLines.push('🛠️ **Verification recovery:** Arc verification failed; full software video verification passed.');'''
success_code=success_code[:desc_start]+new_desc_block+success_code[desc_end:]
old_footer='text: isFallback ? "Tdarr AV1 Flow • Size Bloat Fallback Success" : (statusStr.includes("Compliant") ? "Tdarr AV1 Flow • Verified Compliant" : "Tdarr AV1 Flow • Transcode Success")'
new_footer='text: wasQuarantined ? "Tdarr AV1 Flow • Quarantined candidate revalidated" : isFallback ? "Tdarr AV1 Flow • Seek-heal remux validated • Source video preserved" : (statusStr.includes("Compliant") ? "Tdarr AV1 Flow • Validated remux" : "Tdarr AV1 Flow • AV1 encode validated")'
if success_code.count(old_footer)!=1: raise RuntimeError('Unexpected success footer text')
success_code=success_code.replace(old_footer,new_footer,1)
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
  quarantine_cleanup='''  if (args.variables?.user?.quarantine_entry) {
    try {
      const entry=args.variables.user.quarantine_entry;
      await removeQuarantineCandidate(entry);
      delete args.variables.user.quarantine_entry;
      log(`[Quarantine] Removed validated candidate after successful replacement: ${entry.candidatePath}`);
    } catch (err) {
      log(`[Quarantine] Replacement succeeded, but the stored candidate could not be removed: ${err.message || err}`);
    }
  }
'''
  if code.count('  if (args.variables?.user?.cache_reservation) {')!=1: raise RuntimeError('Unexpected success cleanup reservation block')
  code=code.replace('  if (args.variables?.user?.cache_reservation) {',quarantine_cleanup+'  if (args.variables?.user?.cache_reservation) {',1)
 helper_code=(src/'reservations.js').read_text()+'\n'
 if p['id']=='cleanup_success': helper_code+=(src/'quarantine.js').read_text()+'\n'
 p['inputsDB']['code']=helper_code+code

# V14 preserves the established language selection but stream-copies retained audio,
# checking source audio before video encoding and validating the candidate afterward.
one('  const finalAudioStreams = candidateAudio.filter(s => !prunedAudioIndices.has(s.index));\n\n  // 6. Subtitle Filtering & Safe Format Normalization (eng, ita, spa, und)', '''  const finalAudioStreams = candidateAudio.filter(s => !prunedAudioIndices.has(s.index));
  const audioTimestampRepairs = new Map();

  // Full-decode the audio tracks that will actually be kept, before reserving scratch or encoding video.
  const precheckRetainedSourceAudio = async () => {
    if (finalAudioStreams.length === 0) {
      log("[Audio precheck] No retained audio tracks; source audio decode skipped.");
      reportWorkerProgress(args.updateWorker,{percentage:10,fps:0,status:"Precheck: no retained audio tracks"},initialWorkerProgressDetails);
      return;
    }
    log(`[Audio precheck] Full software decode of ${finalAudioStreams.length} retained source audio track(s) before the Arc encode.`);
    const decodeAudioStreams=async (streams,startPercent,endPercent) => {
      const decodeArgs=withDecoderThreads(["-v","error","-xerror","-progress","pipe:1","-nostats","-i",inputPath],getDecodeThreadCount());
      for (const stream of streams) decodeArgs.push("-map",`0:${stream.index}`);
      decodeArgs.push("-f","null","-");
      reportWorkerProgress(args.updateWorker,{percentage:startPercent,fps:0,status:"Precheck: retained audio decode"},initialWorkerProgressDetails);
      const stderr=await runTimelineProcess(ffmpegBin,decodeArgs,null,(timeUs)=>{
        const decodedSec=Number(timeUs)/1000000;
        const ratio=durationSec>0 && Number.isFinite(decodedSec)?Math.min(1,Math.max(0,decodedSec/durationSec)):0;
        reportWorkerProgress(args.updateWorker,{percentage:startPercent+(endPercent-startPercent)*ratio,fps:0,status:"Precheck: retained audio decode"},initialWorkerProgressDetails);
      });
      if(isVerificationInfrastructureDiagnostic(stderr))throw Error(String(stderr).trim());
      return String(stderr || "").trim();
    };
    const logTrackPassed=(stream,diagnostic)=>{
      if (diagnostic) log(`[Audio precheck] Non-fatal FFmpeg diagnostic on source stream 0:${stream.index}: ${diagnostic.slice(-400)}`);
      const language=normalizeLang(stream.tags?.language || stream.tags?.LANGUAGE || "und");
      log(`[Audio precheck] Audio source stream 0:${stream.index} (${language}) passed full decode.`);
    };
    for (let position=0; position<finalAudioStreams.length; position++) {
      const stream=finalAudioStreams[position];
      const percentStart=8+position/finalAudioStreams.length;
      const percentEnd=8+(position+1)/finalAudioStreams.length;
      let lastAudioProgress=percentStart-1;
      log(`[Audio precheck] Scanning DTS order for retained source stream 0:${stream.index}.`);
      reportWorkerProgress(args.updateWorker,{percentage:percentStart,fps:0,status:"Precheck: audio DTS scan"},initialWorkerProgressDetails);
      const timing=await scanAudioDtsPackets(ffprobeBin,inputPath,stream.index,stream.time_base,runTimelineProcess,ratio=>{
        const percentage=percentStart+(percentEnd-percentStart)*Math.max(0,Math.min(1,Number(ratio)||0));
        if(percentage>=lastAudioProgress+0.02||percentage>=percentEnd){lastAudioProgress=percentage;reportWorkerProgress(args.updateWorker,{percentage,fps:0,status:"Precheck: audio DTS scan"},initialWorkerProgressDetails);}
      },originalSourceSizeInBytes);
      if (timing.backwardSteps===0) {
        if (timing.nonIncreasingSteps>0) log(`[Audio precheck] Source audio stream 0:${stream.index} has ${timing.nonIncreasingSteps} equal DTS transition(s) at time base ${stream.time_base}; these are preserved without repair.`);
        continue;
      }
      if (!timing.repairable) {
        const cause=timing.timeBaseKnown?`${timing.missingDts} packet(s) without DTS`:`no valid stream time base (${stream.time_base || "missing"})`;
        throw new Error(`[Audio guard] Source audio stream 0:${stream.index} has ${timing.backwardSteps} backward DTS transition(s), but ${cause}; a bounded copy repair cannot be proven safe.`);
      }
      if (!timing.withinLimit) throw new Error(`[Audio guard] Source audio stream 0:${stream.index} needs up to ${(timing.maxRepairSeconds*1000).toFixed(1)} ms of DTS correction, above the ${MAX_AUDIO_TIMESTAMP_REPAIR_SECONDS*1000} ms repair limit.`);
      audioTimestampRepairs.set(stream.index,timing);
      log(`[Audio precheck] Source audio timestamp repair: stream 0:${stream.index}; ${timing.backwardSteps} backward DTS transition(s), ${timing.nonIncreasingSteps-timing.backwardSteps} equal transition(s) preserved, ${timing.adjustedPackets} packet(s) adjusted, maximum ${(timing.maxRepairSeconds*1000).toFixed(1)} ms (limit ${MAX_AUDIO_TIMESTAMP_REPAIR_SECONDS*1000} ms); compressed audio remains stream-copied.`);
    }
    try {
      const diagnostic=await decodeAudioStreams(finalAudioStreams,9,10);
      if (isKnownAudioCorruptionDiagnostic(diagnostic)) throw new Error(diagnostic);
      for (const stream of finalAudioStreams) logTrackPassed(stream,diagnostic);
    } catch (batchError) {
      const batchDetail=String(batchError?.message || batchError).replace(/\\s+/g," ").slice(-700);
      log("[Audio precheck] Combined decode failed; isolating retained tracks to identify the cause.");
      for (let position=0; position<finalAudioStreams.length; position++) {
        const stream=finalAudioStreams[position];
        const language=normalizeLang(stream.tags?.language || stream.tags?.LANGUAGE || "und");
        try {
          const diagnostic=await decodeAudioStreams([stream],9+position/finalAudioStreams.length,9+(position+1)/finalAudioStreams.length);
          if (isKnownAudioCorruptionDiagnostic(diagnostic)) throw new Error(diagnostic);
          logTrackPassed(stream,diagnostic);
        } catch (decodeError) {
          const detail=String(decodeError?.message || decodeError).replace(/\\s+/g," ").slice(-700);
          const recognized=isKnownAudioCorruptionDiagnostic(detail);
          const prefix=recognized?"[Source media corruption]":"[Audio guard]";
          throw new Error(`${prefix} Audio source stream 0:${stream.index} (${language}) failed its full source decode precheck: ${detail}`);
        }
      }
      throw new Error(`[Audio guard] Combined retained audio decode failed, although each stream passed separately: ${batchDetail}`);
    }
    reportWorkerProgress(args.updateWorker,{percentage:10,fps:0,status:"Precheck: retained audio decode complete"},initialWorkerProgressDetails);
  };

  // 6. Subtitle Filtering & Safe Format Normalization (eng, ita, spa, und)''')
one('  try {\n  // Cache reservations permit concurrent jobs while coordinating available space.', '  try {\n  const audioPrecheckStartedAt=Date.now();\n  await precheckRetainedSourceAudio();\n  log(`[Audio precheck] Completed in ${((Date.now()-audioPrecheckStartedAt)/1000).toFixed(2)}s.`);\n  reportWorkerProgress(args.updateWorker,{percentage:10,fps:0,status:"Preparing: reserve cache and build output"},initialWorkerProgressDetails);\n  // Cache reservations permit concurrent jobs while coordinating available space.')
one('''        const isTranscodedToEac3 = ch > 2 && (c !== "eac3" || ch > 6);
        let actualCodec = "Audio";
        let finalCh = ch || 2;

        // Convert surround (>2ch) to E-AC3 5.1 @ 640k unless it is already E-AC3 <=6ch
        if (isTranscodedToEac3) {
          cmdArgs.push(`-c:a:${idx}`, "eac3", `-b:a:${idx}`, "640k");
          if (ch > 6) cmdArgs.push(`-ac:a:${idx}`, "6");
          actualCodec = "E-AC-3";
          finalCh = 6;
        } else {
          cmdArgs.push(`-c:a:${idx}`, "copy");
          if (c === "dts" && prof.includes("dts-hd")) {
            actualCodec = "DTS-HD MA";
          } else {
            actualCodec = codecDisplayMap[c] || (c ? c.toUpperCase() : "Audio");
          }
        }''','''        let actualCodec = "Audio";
        let finalCh = ch || 2;

        // Preserve the selected source audio bitstream and channel layout unchanged.
        cmdArgs.push(`-c:a:${idx}`, "copy");
        if (audioTimestampRepairs.has(s.index)) cmdArgs.push(`-bsf:a:${idx}`, audioTimestampRepairBsf());
        if (c === "dts" && prof.includes("dts-hd")) {
          actualCodec = "DTS-HD MA";
        } else {
          actualCodec = codecDisplayMap[c] || (c ? c.toUpperCase() : "Audio");
        }''')
one('''    const expectedAudioCodecs = finalAudioStreams.map(s => {
      const ch = parseInt(s.channels || 0, 10);
      const c = (s.codec_name || "").toLowerCase();
      const isTranscodedToEac3 = ch > 2 && (c !== "eac3" || ch > 6);
      return isTranscodedToEac3 ? "eac3" : s.codec_name;
    });''','    const expectedAudioCodecs = finalAudioStreams.map(s => s.codec_name);')
one('''  finalAudioStreams.forEach(s => {
    const ch = parseInt(s.channels || 0, 10);
    const c = (s.codec_name || "").toLowerCase();
    const isTranscodedToEac3 = ch > 2 && (c !== "eac3" || ch > 6);
    if (isTranscodedToEac3) {
      newAudioKbps += 640;
    } else {
      newAudioKbps += Math.round(parseInt(s.bit_rate || s.tags?.BPS || (ch > 2 ? 640 : 192), 10) / 1000);
    }
  });''','''  finalAudioStreams.forEach(s => {
    const ch = parseInt(s.channels || 0, 10);
    const reportedKbps = Math.round(parseInt(s.bit_rate || s.tags?.BPS || 0, 10) / 1000);
    newAudioKbps += reportedKbps > 0 && reportedKbps < 15000 ? reportedKbps : (ch > 2 ? 640 : 192);
  });''')
