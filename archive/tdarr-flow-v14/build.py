#!/usr/bin/env python3
import json, os, pathlib, re
root=pathlib.Path(__file__).resolve().parent
flow=json.loads((root/'base/flow-template-v3.json').read_text())
plugin=next(p for p in flow['flowPlugins'] if p['id']=='arc_av1_monolithic')
e=plugin['inputsDB']['code']
def one(old,new):
 global e
 n=e.count(old)
 if n!=1: raise RuntimeError(f'Expected 1 match, got {n}: {old[:80]}')
 e=e.replace(old,new,1)
e=(root/'policy.js').read_text()+'\n'+e
one('''  const toSrtCodecIDs = ["mov_text", "tx3g", "c608", "eia_608"];''', '''  const toSrtCodecIDs = ["mov_text", "tx3g", "c608", "eia_608"];
  const inputContainer = String(args.inputFileObj?.container || path.extname(inputPath).slice(1)).toLowerCase();
  const isMatroskaContainer = ["mkv", "mka", "mks", "matroska"].includes(inputContainer);
  const shouldConvertSubToSrt = stream => {
    const codec = String(stream.codec_name || "").toLowerCase();
    const codecId = String(stream.codec_tag_string || stream.codec_id || "").toLowerCase();
    if (isMatroskaContainer && ["ass", "ssa"].includes(codec)) return false;
    return toSrtCodecs.includes(codec) || toSrtCodecIDs.includes(codecId);
  };''')
one('if (toSrtCodecs.includes(c) || toSrtCodecIDs.includes(cid)) {', 'if (shouldConvertSubToSrt(s)) {')
one('return (toSrtCodecs.includes(c) || toSrtCodecIDs.includes(cid)) ? "subrip" : s.codec_name;', 'return shouldConvertSubToSrt(s) ? "subrip" : s.codec_name;')
one('''    // Video Mapping & Encoding / Stream-Copy Arguments
    cmdArgs.push("-map", `0:${mainVideo.index}`);
    if (doCopyVideo) {''', '''    // Video Mapping & Encoding / Stream-Copy Arguments
    cmdArgs.push("-map", `0:${mainVideo.index}`);
    // Prevent FFmpeg's automatic sync mode from silently dropping or duplicating decoded frames.
    if (!doCopyVideo) cmdArgs.push("-fps_mode:v", "passthrough");
    if (hdrClass === "untagged") cmdArgs.push(...untaggedColorRangeArgs(hdrClass,sdrSource));
    if (doCopyVideo) {''')
e,n=re.subn(r'const webhookUrl\s*=\s*"https://discord\.com/api/webhooks/[^"\n]+"\s*;', 'const webhookUrl = process.env.TDARR_DISCORD_WEBHOOK;', e)
if n==0 and e.count('const webhookUrl = process.env.TDARR_DISCORD_WEBHOOK;')==1: pass
elif n!=1: raise RuntimeError('Expected one engine webhook declaration to externalize')
one('''function runTimelineProcess(bin, argv, onLine) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = timelineSpawn(bin, argv, {stdio:['ignore','pipe','pipe']}); }
    catch (e) { reject(e); return; }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, 4 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    const lines = timelineReadline.createInterface({input:proc.stdout, crlfDelay:Infinity});
    lines.on('line', line => { if (onLine) onLine(line); });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', (status, signal) => {
      clearTimeout(timer);
      if (status !== 0) reject(new Error(`${bin} ${timedOut?'timed out':`failed (${status ?? signal})`}: ${stderr.trim().slice(-400)}`));
      else resolve();
    });
  });
}''',
'''function runTimelineProcess(bin, argv, onLine, onProgress) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = timelineSpawn(bin, argv, {stdio:['ignore','pipe','pipe'],detached:true}); }
    catch (e) { reject(e); return; }
    if (typeof trackReservationChild==='function') trackReservationChild(proc);
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; if (typeof terminateReservationChild==='function') terminateReservationChild(proc,'SIGKILL'); else proc.kill('SIGKILL'); }, 4 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    const lines = timelineReadline.createInterface({input:proc.stdout, crlfDelay:Infinity});
    let progressRecord={};
    const sampleFps=createFpsSampler();
    lines.on('line', line => {
      if (onLine) onLine(line);
      const split=String(line).indexOf('=');
      if(split<0)return;
      const key=String(line).slice(0,split),value=String(line).slice(split+1).trim();
      if(key==='out_time_us'||key==='fps'||key==='frame')progressRecord[key]=value;
      if(key==='progress'&&typeof onProgress==='function'){
        const timeUs=Number(progressRecord.out_time_us);
        if(Number.isFinite(timeUs))try{onProgress(timeUs,sampleFps(progressRecord.frame,progressRecord.fps));}catch(_){}
        progressRecord={};
      }
    });
    proc.on('error', err => { clearTimeout(timer); if (typeof untrackReservationChild==='function') untrackReservationChild(proc); reject(err); });
    proc.on('close', (status, signal) => {
      clearTimeout(timer);
      if (typeof untrackReservationChild==='function') untrackReservationChild(proc);
      const processReason = timedOut ? 'timed out' : status !== 0 ? `failed (${status ?? signal})` : 'exited 0 but emitted stderr';
      if (status !== 0 || stderr.trim()) reject(new Error(`${bin} ${processReason}: ${stderr.trim().slice(-400)}`));
      else resolve();
    });
  });
}''')
one('async function verifyVideoTimeline(ffprobe, ffmpeg, source, output, sourceIndex, outputIndex, tracks) {', 'async function verifyVideoTimeline(ffprobe, ffmpeg, source, output, sourceIndex, outputIndex, tracks, updateWorker) {')
one("  const decode=['-v','error','-xerror','-i',output,'-map',`0:${outputIndex}`];", "  const decode=['-v','error','-xerror','-progress','pipe:1','-nostats','-i',output,'-map',`0:${outputIndex}`];")
one('  await runTimelineProcess(ffmpeg,decode);', '''  reportWorkerProgress(updateWorker,{percentage:92,fps:0});
  try {
    await runTimelineProcess(ffmpeg,decode,null,(timeUs,fps)=>{
      const ratio=a.duration>0?Math.min(1,Math.max(0,timeUs/1000000/a.duration)):0;
      const data={percentage:92+7*ratio};
      if(Number.isFinite(fps)&&fps>0)data.fps=fps;
      reportWorkerProgress(updateWorker,data);
    });
  } catch (outputError) {
    const sourceCorruption=[],sourceDiagnostics=[];
    const decodeSource=async (index,type) => {
      const args=['-v','error','-xerror','-i',source,'-map',`0:${index}`,'-f','null','-'];
      try {
        await runTimelineProcess(ffmpeg,args);
        sourceDiagnostics.push(`${type} source stream ${index}: decoded cleanly`);
      } catch (sourceError) {
        const detail=String(sourceError?.message || sourceError);
        const recognized=type==='video'?isKnownVideoCorruptionDiagnostic(detail):isKnownAudioCorruptionDiagnostic(detail);
        sourceDiagnostics.push(`${type} source stream ${index}: ${recognized?'recognized corruption':'decode diagnostic'}: ${detail.slice(-300)}`);
        if(recognized)sourceCorruption.push(`${type} source stream ${index}: ${detail.slice(-500)}`);
      }
    };
    await decodeSource(sourceIndex,'video');
    for (const [srcIndex] of tracks.audio) await decodeSource(srcIndex,'audio');
    const candidateDetail=String(outputError?.message || outputError).slice(-500);
    const sourceDetail=sourceDiagnostics.join(' | ').slice(-700) || 'source decode details unavailable';
    if(sourceCorruption.length)throw new Error(`[Source media corruption] ${sourceCorruption.join(' | ')}; candidate decode failed: ${candidateDetail}; source decode details: ${sourceDetail}`);
    throw new Error(`Candidate video/audio decode failed; strict source decodes did not confirm known source corruption. Source decode details: ${sourceDetail}; candidate decode: ${candidateDetail}`);
  }''')
one('  return await verifyVideoTimeline(ffprobeBin, expected.ffmpegBin || "ffmpeg", sourcePath, outputPath, sourceVideo.index, video[0].index, tracks);', '  return await verifyVideoTimeline(ffprobeBin, expected.ffmpegBin || "ffmpeg", sourcePath, outputPath, sourceVideo.index, video[0].index, tracks, expected.updateWorker);')
one('    const specific = lines.filter(l => /error|failed|unsupported|invalid|cannot|only one of them|ratecontrol|qsv|vaapi/i.test(l));\n    const chosen = specific.length > 0 ? specific.slice(-3) : lines.slice(-3);\n    return chosen.join(" | ").substring(0, 240);',
r'''    const specific = lines.filter(l => /\b(?:error|failed|unsupported|invalid|cannot|could not|only one of them|ratecontrol)\b/i.test(l)
      && !/discarding stream metadata .* because the stream is being re-encoded/i.test(l));
    const causal = specific.filter(l => !/task finished with error|terminating thread with error|conversion failed/i.test(l));
    const chosen = causal.length ? causal.slice(-6) : lines.slice(-12);
    return chosen.join(" | ").substring(0, 1200);''')
one('''    log(`[Safety check failed] ${err.message || err}. Original will not be replaced.`);''',
r'''    const detail=String(err?.message || err);
    const alreadyClassified=/^\[(?:safety check failed|source media corruption)\]/i.test(detail);
    const reason=alreadyClassified?detail:`[Safety check failed] ${detail}`;
    log(`${reason}${/[.!?]$/.test(reason)?'':'.'} Original will not be replaced.`);''')
# Always re-probe; Tdarr's cached stream/format metadata may be stale after replacement.
a=e.index('  let streams = args.inputFileObj?.ffProbeData?.streams;')
b=e.index('\n  const badImageCodecs',a)
e=e[:a]+'''  let streams;
  try {
    const probed = JSON.parse(execFileSync(ffprobeBin, ["-v", "error", "-show_streams", "-show_format", "-of", "json", inputPath], {encoding:"utf8", timeout:120000, maxBuffer:16*1024*1024}));
    streams = probed.streams || [];
    args.inputFileObj.ffProbeData = probed;
  } catch (err) {
    log(`[Probe] Fresh stream and marker probe failed: ${err.message || err}`);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
'''+e[b:]
one('  const mainVideo = videoStreams[0];', '''  const allVideoStreams = streams.filter(s => s.codec_type === "video" && !s.disposition?.attached_pic && !s.disposition?.timed_thumbnails);
  if (allVideoStreams.length > 1) {
    log("[Video guard] Multiple video streams require a safe multi-video policy; keeping original.");
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
  const mainVideo = videoStreams[0];''')
one('    originalSnapshot = { realPath: fs.realpathSync(originalPath),', '    if (fs.realpathSync(inputPath) !== fs.realpathSync(originalPath)) throw new Error("Working file differs from original library file");\n    originalSnapshot = { realPath: fs.realpathSync(originalPath),')
one('  const tracks = {};\n  for (const type of ["audio", "subtitle"]) {', '''  if (!expected.hdr10 && !expected.hlg && !expected.untagged) validateSdrColor(expected.sdrSource || sourceVideo, video[0]);
  validateAspect(sourceVideo, video[0]);
  if (sourceVideo.width !== video[0].width || sourceVideo.height !== video[0].height) throw new Error("Output video dimensions differ from source");
  if (!expected.sourceFrameScan) {
    const countFrames = (file, index) => {
      const raw = execFileSync(ffprobeBin, ["-v","error","-select_streams",String(index),"-count_frames","-show_entries","stream=nb_read_frames","-of","json",file], {encoding:"utf8",timeout:4*60*60*1000,maxBuffer:1024*1024});
      const count = Number(JSON.parse(raw).streams?.[0]?.nb_read_frames);
      if (!Number.isSafeInteger(count) || count < 1) throw new Error("Video frame count unavailable");
      return count;
    };
    const sourceFrames=countFrames(sourcePath,sourceVideo.index), outputFrames=countFrames(outputPath,video[0].index);
    if (sourceFrames !== outputFrames) throw new Error(`Video frame count differs: ${sourceFrames} -> ${outputFrames}`);
  }
  const tracks = {};
  for (const type of ["audio", "subtitle"]) {''')
one('  const vCodec = (mainVideo.codec_name || "").toLowerCase();', '''  const markerKey = Object.keys(args.inputFileObj?.ffProbeData?.format?.tags || {}).find(k => k.toLowerCase() === "encoded_by");
  if (isCompletedEncode(String(mainVideo.codec_name || "").toLowerCase(), markerKey ? {[markerKey]:args.inputFileObj.ffProbeData.format.tags[markerKey]} : {})) {
    log("[Arc AV1] Previously processed output; no additional generation.");
    return {outputFileObj:args.inputFileObj,outputNumber:4,variables:args.variables};
  }
  const frameEstimate=estimateVideoFrames(mainVideo,Number(args.inputFileObj?.ffProbeData?.format?.duration || 0));
  const is12Bit = String(mainVideo.pix_fmt || "").toLowerCase().includes("12") || Number(mainVideo.bits_per_raw_sample || 0) === 12;
  let preflightInfoVideo, preflightBasic;
  try {
    const mediaInfo=JSON.parse(execFileSync("mediainfo", ["--Output=JSON", inputPath], {encoding:"utf8", timeout:120000, maxBuffer:16*1024*1024}));
    const infoVideos=(mediaInfo.media?.track || []).filter(t=>String(t["@type"] || "").toLowerCase()==="video");
    if (infoVideos.length!==1) throw Error("MediaInfo did not identify exactly one video stream");
    preflightInfoVideo=infoVideos[0];
    preflightBasic=classifyVideo(mainVideo,preflightInfoVideo);
  } catch (err) {
    log(`[HDR guard] ${err.message || err}; original retained.`);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
  const sourceDurationForSamples=Number(mainVideo.duration || args.inputFileObj?.ffProbeData?.format?.duration || 0);
  const sampleEligible=canUseSamplePrecheck(preflightBasic,mainVideo);
  const canUseSamplePrecheckForFile=sampleEligible && sourceDurationForSamples>16;
  const sampleWindows=canUseSamplePrecheckForFile ? preflightSampleWindows(sourceDurationForSamples) : null;
  const sampleFrameEstimate=sampleWindows ? (estimateSampleFrames(mainVideo,sampleWindows) || frameEstimate) : frameEstimate;
  const scanOptions=(windows,expectedFrames)=>({staticMetadata:true,timestamps:true,expectedColor:mainVideo,expectedFrames,sampleWindows:windows || undefined,onProgress:(frames,total,complete,fps)=>reportWorkerProgress(args.updateWorker,{percentage:1+7*(complete?1:total>0?Math.min(0.99,frames/total):0),fps})});
  let frameScan;
  try {
    reportWorkerProgress(args.updateWorker,{percentage:1,fps:0});
    log(sampleWindows ? "[Source precheck] Sampling 5-second CPU decodes at the beginning, middle, and end; full source scan is deferred unless a later check fails." : "[Source precheck] Running full CPU frame scan for HDR10+, Dolby Vision, HLG, untagged or ambiguous color, short-duration, or non-progressive-tagged input.");
    try {
      frameScan=await inspectVideoFrames(ffprobeBin,inputPath,mainVideo.index,scanOptions(sampleWindows,sampleFrameEstimate));
    } catch (sampleErr) {
      if (!sampleWindows) throw sampleErr;
      log(`[Source precheck] Sample scan failed (${sampleErr.message || sampleErr}); retrying with a full CPU source scan.`);
      frameScan=await inspectVideoFrames(ffprobeBin,inputPath,mainVideo.index,scanOptions(null,frameEstimate));
    }
    if (frameScan.interlaced) throw Error("Interlaced video frames are unsupported");
    if (frameScan.colorInfo.conflict) throw Error("Source frame color signaling conflicts with the stream");
    validateSdrFrameSignaling(preflightBasic,frameScan);
    guardSourceVideo({...mainVideo,field_order:"progressive"});
    // Stream field_order is only a hint for the source. The full decoded-frame
    // scan above decides whether this input is actually interlaced.
    validateAspect(mainVideo, mainVideo, false);
  } catch (err) {
    log(`[Video guard] ${err.message || err}; original retained.`);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
  let sourceScanFailureDetail="";
  const scanFullSourceAfterFailure=async (cause,progressBase=80)=>{
    if (!Array.isArray(frameScan?.sampleWindows) || !frameScan.sampleWindows.length || frameScan.fullTimelineCheckAttempted) return "";
    log(`[Source diagnosis] Running a full CPU source scan after ${cause}.`);
    try {
      const fullScan=await inspectVideoFrames(ffprobeBin,inputPath,mainVideo.index,{staticMetadata:true,timestamps:true,expectedColor:mainVideo,expectedFrames:frameEstimate,onProgress:(frames,total,complete,fps)=>reportWorkerProgress(args.updateWorker,{percentage:progressBase+8*(complete?1:total>0?Math.min(0.99,frames/total):0),fps})});
      if (fullScan.interlaced) log("[Source diagnosis] The full source scan found interlaced frames.");
      if (fullScan.colorInfo.conflict) log("[Source diagnosis] The full source scan found conflicting frame color signaling.");
      if (!fullScan.interlaced && !fullScan.colorInfo.conflict) log("[Source diagnosis] The full source scan completed without a recognized source decode fault.");
      return "";
    } catch (sourceErr) {
      const detail=String(sourceErr?.message || sourceErr);
      if (isKnownVideoCorruptionDiagnostic(detail)) return detail;
      log(`[Source diagnosis] The full source scan could not complete after ${cause}: ${detail.slice(-800)}`);
      return "";
    }
  };
  const vCodec = (mainVideo.codec_name || "").toLowerCase();''')
one('  // 2. Audio & Subtitle stream count & codec checks', '''  if (expected.requireMarker && !Object.entries(dst.format?.tags || {}).some(([k,v]) => k.toLowerCase() === "encoded_by" && String(v) === (expected.outputMarker || "ArcAV1_QSV_V14"))) throw new Error("Output completion marker missing");
  let outputFrameScan;
  if (expected.sourceFrameScan || expected.hdr10) {
    reportWorkerProgress(expected.updateWorker,{percentage:82,fps:0});
    const expectedFrames=expected.sourceFrameScan?.sampleWindows ? estimateVideoFrames(video[0],Number(dst.format?.duration || 0)) : expected.sourceFrameScan?.frames || estimateVideoFrames(video[0],Number(dst.format?.duration || 0));
    outputFrameScan = await inspectVideoFrames(ffprobeBin,outputPath,video[0].index,{staticMetadata:!!expected.hdr10 || !!expected.hlg || !!expected.untagged,timestamps:!!expected.sourceFrameScan,expectedColor:video[0],expectedFrames,onProgress:(frames,total,complete,fps)=>reportWorkerProgress(expected.updateWorker,{percentage:82+8*(complete?1:total>0?Math.min(0.99,frames/total):0),fps})});
    reportWorkerProgress(expected.updateWorker,{percentage:91,fps:0});
    if (outputFrameScan.colorInfo.conflict) throw Error("Output frame color signaling conflicts with the stream");
    if (expected.sourceFrameScan) {
      try {
        compareVideoTimestamps(expected.sourceFrameScan,outputFrameScan);
      } catch (sampleError) {
        if (!Array.isArray(expected.sourceFrameScan.sampleWindows) || !expected.sourceFrameScan.sampleWindows.length) throw sampleError;
        const sampleDetail=String(sampleError?.message || sampleError);
        log(`[Timeline check] Sampled source/output comparison differed (${sampleDetail}); running a full CPU source scan and comparing complete frame timelines.`);
        expected.sourceFrameScan.fullTimelineCheckAttempted=true;
        let fullSourceScan;
        try {
          const fullSourceEstimate=estimateVideoFrames(sourceVideo,Number(src.format?.duration || 0));
          fullSourceScan=await inspectVideoFrames(ffprobeBin,sourcePath,sourceVideo.index,{staticMetadata:true,timestamps:true,expectedColor:sourceVideo,expectedFrames:fullSourceEstimate,onProgress:(frames,total,complete,fps)=>reportWorkerProgress(expected.updateWorker,{percentage:91+(complete?1:total>0?Math.min(0.99,frames/total):0),fps})});
        } catch (sourceScanError) {
          const detail=String(sourceScanError?.message || sourceScanError);
          if (isKnownVideoCorruptionDiagnostic(detail)) throw Error(`[Source media corruption] Full source scan confirmed malformed video data after sampled timeline mismatch: ${detail}`);
          throw Error(`Full source timeline scan failed after sampled mismatch (${sampleDetail}): ${detail}`);
        }
        if (fullSourceScan.interlaced) throw Error("Full source timeline scan found interlaced frames");
        if (fullSourceScan.colorInfo.conflict) throw Error("Full source timeline scan found conflicting frame color signaling");
        if (expected.sourceClass === "sdr") {
          validateSdrFrameSignaling("sdr",fullSourceScan);
          if (!isVerifiedSdr("sdr",fullSourceScan)) throw Error("Full source timeline scan did not confirm the SDR classification");
        }
        if (expected.hdr10) {
          if (fullSourceScan.dovi || fullSourceScan.hdr10plus || fullSourceScan.otherDynamic) throw Error("Full source timeline scan found dynamic HDR metadata on the static HDR10 route");
          checkHdrFrameStatic(expected.sourceHdr,fullSourceScan,!expected.optionalHdrStatic,!expected.optionalHdrStatic);
        }
        try {
          compareVideoTimestamps(fullSourceScan,outputFrameScan);
        } catch (fullError) {
          throw Error(`Sampled source/output timeline differed (${sampleDetail}); full source/output timeline also differed: ${fullError.message || fullError}`);
        }
        Object.assign(expected.sourceFrameScan,fullSourceScan);
        delete expected.sourceFrameScan.sampleWindows;
        expected.sourceFrameScan.fullTimelineCheckAttempted=true;
        log("[Timeline check] Full source/output frame counts and timestamps match; continuing validation after the sampled-window discrepancy.");
      }
    }
  }
  if (expected.hdr10) {
    if (!expected.sourceHdr) throw new Error("HDR10 source metadata missing");
    validateHdr10(expected.sourceHdr, video[0]);
    if (outputFrameScan.interlaced || outputFrameScan.dovi || outputFrameScan.hdr10plus || outputFrameScan.otherDynamic) throw new Error("HDR10 output contains unexpected dynamic metadata or interlacing");
    checkHdrFrameStatic(expected.sourceHdr,outputFrameScan,!expected.optionalHdrStatic,!expected.optionalHdrStatic);
  }
  if (expected.hlg) {
    validateHlg(expected.sourceHdr,video[0]);
    if (outputFrameScan.interlaced || outputFrameScan.dovi || outputFrameScan.hdr10plus || outputFrameScan.otherDynamic || outputFrameScan.staticInfo.mastering || outputFrameScan.staticInfo.light || outputFrameScan.staticInfo.conflict) throw Error("HLG output contains unexpected HDR metadata");
  }
  if (expected.untagged) {
    validateUntaggedOutput(expected.sdrSource,video[0],outputFrameScan);
    if (outputFrameScan.interlaced || outputFrameScan.dovi || outputFrameScan.hdr10plus || outputFrameScan.otherDynamic || outputFrameScan.staticInfo.mastering || outputFrameScan.staticInfo.light || outputFrameScan.staticInfo.conflict) throw Error("Untagged output contains unexpected HDR metadata");
  }

  // 2. Audio & Subtitle stream count & codec checks''')
one('  const isEncodedByUs = Boolean(encodedByKey && String(formatTags[encodedByKey]).includes("ArcAV1_QSV"));','''  const isEncodedByUs = false;
  let hdrClass, hdrSource, sdrSource, hdrLightOverride = null;
  delete args.variables.user.hdr_conversion;
  try {
    const infoVideos = [preflightInfoVideo];
    const basic = preflightBasic;
    if (is12Bit && basic !== "sdr") throw new Error("12-bit conversion is only verified for tagged SDR sources; HDR, Dolby Vision, and untagged 12-bit video remain held");
    if (isVerifiedSdr(basic,frameScan)) {
      validateEffectiveSdrTransfer(mainVideo,infoVideos[0],frameScan);
      sdrSource = effectiveSdrSource(mainVideo,infoVideos[0],frameScan);
      hdrClass = "sdr";
      const unspecifiedSdrFields=["color_transfer","color_primaries"].filter(field=>isUnknownColorValue(sdrSource[field]));
      if (unspecifiedSdrFields.length && normalizeSdrMatrix(mainVideo.color_space)) log(`[Color] Recognized SDR ${normalizeSdrMatrix(mainVideo.color_space)} matrix; ${unspecifiedSdrFields.join(" and ")} remain unspecified.`);
    } else if (isUntaggedVideo(mainVideo,infoVideos[0],frameScan)) {
      hdrClass = "untagged";
      sdrSource = {...mainVideo};
      const effectiveRange=inferUntaggedColorRange(mainVideo,infoVideos[0],frameScan);
      if (!effectiveRange) throw new Error("Untagged SDR YUV range could not be inferred safely");
      sdrSource.color_range=effectiveRange;
      log(`[Color] Input transfer, primaries, and matrix are unspecified; using ${effectiveRange==='tv'?'TV limited':'PC full'} range for the untagged SDR YUV encode.`);
    } else {
      hdrClass = determineHdrRoute(mainVideo,infoVideos[0],frameScan);
      if (hdrClass === "hlg" || hdrClass === "dovi84_hlg") {
        if (frameScan.staticInfo.mastering || frameScan.staticInfo.light || frameScan.staticInfo.conflict) throw Error("HLG source has additional static HDR metadata that is not verified");
        hdrSource = hdrClass === "dovi84_hlg" ? {...mainVideo,side_data_list:(mainVideo.side_data_list || []).filter(s=>!/dolby|dovi/i.test(String(s.side_data_type || "")))} : mainVideo;
        validateHlg(hdrSource,hdrSource);
      } else {
        const canUseDolbyLevel6 = hdrClass === "dovi81_hdr10" || hdrClass === "dovi7_hdr10";
        hdrSource = mergeHdrMetadata(mainVideo,readHdrFrames(ffprobeBin,inputPath,mainVideo.index),{allowMissingLight:canUseDolbyLevel6,allowMissingAll:hdrClass==="hdr10"});
        checkHdrFrameStatic(hdrSource,frameScan,!canUseDolbyLevel6 && hdrClass!=="hdr10",hdrClass!=="hdr10");
        const resolved = await resolveHdrLight(hdrSource,hdrClass,() => extractDolbyLevel6(ffmpegBin,inputPath,mainVideo.index,frameScan.frames));
        hdrSource = resolved.metadata; hdrLightOverride = resolved.override;
      }
      if (hdrClass === "hdr10plus_hdr10") {
        args.variables.user.hdr_conversion = "HDR10+ to HDR10 base layer; HDR10+ dynamic metadata removed";
        log(`[HDR] ${args.variables.user.hdr_conversion}`);
      }
      if (hdrClass === "dovi84_hlg") {
        args.variables.user.hdr_conversion = "Dolby Vision 8.4 to HLG base layer; Dolby Vision dynamic metadata removed";
        log(`[HDR] ${args.variables.user.hdr_conversion}`);
      }
      if (hdrClass === "dovi81_hdr10") {
        args.variables.user.hdr_conversion = "Dolby Vision 8.1 to HDR10 base layer; Dolby Vision dynamic metadata removed";
        log(`[HDR] ${args.variables.user.hdr_conversion}`);
      }
      if (hdrClass === "dovi7_hdr10") {
        args.variables.user.hdr_conversion = "Dolby Vision Profile 7 to HDR10 base layer; Dolby Vision enhancement layer and dynamic metadata removed";
        log(`[HDR] ${args.variables.user.hdr_conversion}`);
      }
    }
  } catch (err) {
    log(`[HDR guard] ${err.message || err}; original retained.`);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }''')

a=e.index('  // Quality-based ICQ encoding is used; no bitrate clamp is applied.')
b=e.index('\n  // 10-bit & Hardware Compatibility Detection',a)
e=e[:a]+'''  // Every eligible source, including AV1 produced by older flows, is re-encoded.
  const isOversizedAV1 = false;
  const isAlreadyAV1 = false;
  quality = selectQualityValue();
'''+e[b:]
one('  const rawSizeMB = (args.originalLibraryFile?.file_size || args.inputFileObj?.file_size || (fs.statSync(inputPath).size / (1024 * 1024)));','  const rawSizeMB = fs.statSync(inputPath).size / (1024 * 1024);')
one('  const isTargetRam = typeof targetDir === "string" && targetDir.startsWith("/dev/shm");', '  const isTargetRam = BigInt.asUintN(32,fs.statfsSync(targetDir,{bigint:true}).type) === 16914836n;')
one('Math.abs((d.first-s.first)-shift)>tolerance || Math.abs((d.last-s.last)-shift)>tolerance', 'Math.abs((d.first-s.first)-shift)>0.1 || Math.abs((d.last-s.last)-shift)>0.1')
one('        "-look_ahead", "1",\n        "-look_ahead_depth", "40",\n','')
one('  const needsProactiveHybrid = isH26410bit || isVC1 || isNon420Chroma;', '  const needsProactiveHybrid = !useQsvDecode(mainVideo);')
one('    cmdArgs.push("-i", inputPath);', '    if (hdrLightOverride) cmdArgs.push("-content_light", hdrLightOverride);\n    cmdArgs.push("-i", inputPath);\n    if (is12Bit && !forceStreamCopy) cmdArgs.push("-sws_dither", "ed");')
one('''        } else {
          cmdArgs.push(`-c:s:${idx}`, "copy");
        }
''', r'''        } else {
          cmdArgs.push(`-c:s:${idx}`, "copy");
          if (c === "hdmv_pgs_subtitle") {
            cmdArgs.push(`-bsf:s:${idx}`, "setts=pts=if(eq(PTS\\,NOPTS)\\,NOPTS\\,max(PTS\\,PREV_OUTPTS+1)):dts=if(eq(DTS\\,NOPTS)\\,NOPTS\\,max(DTS\\,PREV_OUTDTS+1))");
          }
        }
''')
one('        cmdArgs.push("-vf", "format=p010le");', '        cmdArgs.push("-vf", hdrClass === "hdr10plus_hdr10" ? "sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,format=p010le" : "format=p010le");')
one('    const cmdArgs = ["-y", "-fflags", "+genpts+igndts"];', '    const cmdArgs = ["-y", "-xerror", "-fflags", "+genpts+igndts"];')
one('encoded_by=ArcAV1_QSV','encoded_by=ArcAV1_QSV_V14')
one('cmdArgs.push("-metadata:g", "encoded_by=ArcAV1_QSV_V14");', 'cmdArgs.push("-metadata:g", forceStreamCopy ? "encoded_by=ArcAV1_SeekHeal_V14" : "encoded_by=ArcAV1_QSV_V14");')
one('      codec: expectedVideoCodec,\n', '      codec: expectedVideoCodec,\n      requireMarker: true,\n      hdr10: hdrClass === "hdr10" || hdrClass === "dovi81_hdr10" || hdrClass === "dovi7_hdr10" || hdrClass === "hdr10plus_hdr10",\n      optionalHdrStatic: hdrClass === "hdr10",\n      hlg: hdrClass === "hlg" || hdrClass === "dovi84_hlg",\n      untagged: hdrClass === "untagged",\n      sourceClass: hdrClass,\n      sourceHdr: hdrSource,\n      sdrSource,\n      sourceFrameScan: frameScan,\n      outputMarker: isBloat ? \"ArcAV1_SeekHeal_V14\" : \"ArcAV1_QSV_V14\",\n')
one('      sourceFrameScan: frameScan,\n', '      sourceFrameScan: frameScan,\n      updateWorker: args.updateWorker,\n')
a=e.index('  log(`[Arc AV1 Single-Pass] Processing:')
b=e.index('\n  // Cleanup temporary clamped chapters file',a)
e=e[:a]+'''  log(`[Arc AV1] Processing ${inputPath} using global ICQ ${quality}; ${pipelineMode}`);
  const sourceBytes = Number(originalSnapshot.size);
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 1) throw new Error("Original size is invalid");
  args.variables.user.original_size_mb = sourceBytes / (1024 * 1024);
  let isBloat = false;
  const attempt = await runSingleQuality(quality, sourceBytes, async (q) => {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    let result = await runFfmpeg(needsProactiveHybrid, false);
    if (result.error) return {ok:false, ffmpeg:result};
    const reachedLimit = r => fs.existsSync(outputPath) && fs.statSync(outputPath).size >= sourceBytes && (r.signal === 'SIGXFSZ' || /file too large/i.test(String(r.stderr || '')));
    if (reachedLimit(result)) { log(`[Size guard] ICQ ${q} encode hit the source-size cap.`); return {ok:true,size:sourceBytes,ffmpeg:result}; }
    const decodeFailure = /error while decoding|failed to decode|decoder[^\\n]*(?:error|failed)|error submitting packet to decoder|failed to get (?:a )?frame/i.test(String(result.stderr || ""));
    if (result.status !== 0 && !needsProactiveHybrid && decodeFailure) {
      log(`[Arc AV1] Full GPU decode failed at ICQ ${q}: ${extractFfmpegError(result.stderr)}. Trying CPU decode with Arc encode.`);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      result = await runFfmpeg(true, false);
      pipelineMode = `Hybrid (CPU Decode + Arc QSV AV1 Encode)`;
      if (reachedLimit(result)) { log(`[Size guard] ICQ ${q} encode hit the source-size cap.`); return {ok:true,size:sourceBytes,ffmpeg:result}; }
    }
    if (result.status !== 0 || !fs.existsSync(outputPath)) return {ok:false, ffmpeg:result};
    const size = fs.statSync(outputPath).size;
    log(`[Arc AV1] ICQ ${q} produced ${size} bytes; source ${sourceBytes} bytes.`);
    return {ok:true, size, ffmpeg:result};
  });
  let res = attempt.result?.ffmpeg || {status: 1, stderr: `No smaller output at ICQ ${attempt.quality}`};
  if (!attempt.ok && attempt.reason !== "encoder") {
    if (attempt.reason !== "quality_floor") log(`[Arc AV1] Could not verify a valid output size at ICQ ${attempt.quality}.`);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res = {status:1, qualityFloor:attempt.reason === "quality_floor", stderr:`No smaller output at ICQ ${attempt.quality}: ${attempt.reason}`};
  }
'''+e[b:]
a=e.index('  // Bloat Protection (> maxRatioPct for tier)')
b=e.index('\n  // 10. Persist Pipeline Metadata',a)
e=e[:a]+'  cleanupChapters();\n'+e[b:]
one('  const isBloat = !isAlreadyAV1 && (ratioPct > maxRatioPct);','  // isBloat is set only by the strictly smaller, validated seek-heal fallback.')
exec((root/'build_additions.py').read_text())
one('    return spawnSync(ffmpegBin, cmdArgs, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });', '''    const progressStart=forceStreamCopy?80:10,progressEnd=forceStreamCopy?82:80;
    // Encodes stop at source size. Remux file-size limits grow only after the shared cache ledger grants capacity.
    const processSizeLimit=forceStreamCopy?reservedOutputBytes:sourceBytes;
    const processReason=forceStreamCopy
      ? "Size guard fallback: stream-copy the source video with seek-healing mux flags; preserve audio/subtitle processing."
      : `Arc QSV AV1 encode at ICQ ${quality}; validate the resulting video, color metadata, audio, and subtitles.`;
    const workerDetails={
      CLIType:ffmpegBin,
      preset:cmdArgs.join(" "),
      workerLog:processReason,
      outputPath,
      lastPluginDetails:{
        source:"Community",
        id:"arc_av1_monolithic",
        number:"1/1"
      }
    };
    const remuxCapacity=forceStreamCopy?{
      outputPath,
      initialBytes:reservedOutputBytes,
      headroomBytes:512n*1024n*1024n,
      chunkBytes:1024n*1024n*1024n,
      grow:(requiredBytes,usedBytes)=>growCapacityReservation(args.variables.user.cache_reservation,requiredBytes,usedBytes,{marginBytes:64n*1024n*1024n}),
      onLimit:bytes=>{
        args.variables.user.cache_reservation_bytes=String(bytes);
        log(`[Cache reservation] Expanded seek-healing remux capacity to ${bytes} bytes on ${targetDir}.`);
      }
    }:undefined;
    return runLimitedFfmpeg({command:"prlimit",argv:[`--fsize=${processSizeLimit}:unlimited`, "--", ffmpegBin, ...cmdArgs],durationSec,updateWorker:args.updateWorker,workerDetails,progressStart,progressEnd,capacity:remuxCapacity});''')
one('    const cmdArgs = ["-y", "-xerror", "-fflags", "+genpts+igndts"];', '    const cmdArgs = ["-y", "-xerror", "-progress", "pipe:1", "-nostats", "-fflags", "+genpts+igndts"];')
one('    const errReason = errTail\n      ? `FFmpeg exit ${res.status}: ${errTail}`', '    const errReason = res.error\n      ? `Unable to start the size-limited encoder: ${res.error.message || res.error}`\n      : errTail\n      ? `FFmpeg exit ${res.status}: ${errTail}`')
one('  if (res.status !== 0 || !fs.existsSync(outputPath)) {', '''  if (res.qualityFloor) {
    log(`[Size guard] No smaller output at ICQ ${attempt.quality}; trying a source-video stream-copy remux with seek healing.`);
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    const remuxRes = await runFfmpeg(false, true);
    cleanupChapters();
    if (remuxRes.status !== 0 || !fs.existsSync(outputPath)) {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
      const remuxError = extractFfmpegError(remuxRes.stderr);
      const remuxExit = remuxRes.capacityError ? `Cache reservation growth stopped the remux: ${remuxRes.capacityError.message || remuxRes.capacityError}` : remuxRes.error ? `FFmpeg could not start: ${remuxRes.error.message || remuxRes.error}` : `FFmpeg exit ${remuxRes.status ?? "unknown"}${remuxRes.signal ? ` (${remuxRes.signal})` : ""}`;
      const remuxOutput = fs.existsSync(outputPath) ? `output ${fs.statSync(outputPath).size} bytes` : "output missing";
      const reason = `${remuxExit}; ${remuxOutput}${remuxError ? `; stderr: ${remuxError}` : ""}`;
      log(`[Size guard] Seek-healing remux failed (${reason}); original retained.`);
      return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
    }
    const remuxBytes = fs.statSync(outputPath).size;
    const remuxLimit=remuxRes.fileSizeLimit ?? reservedOutputBytes;
    if (BigInt(remuxBytes) > remuxLimit) {
      try { fs.unlinkSync(outputPath); } catch (_) {}
      log(`[Cache reservation] Seek-healing remux exceeded its granted output capacity (${remuxBytes} bytes vs ${remuxLimit}); original retained.`);
      return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
    }
    isBloat = true;
    quality = null;
    pipelineMode = "Size Bloat Fallback (Original Video Stream-Copy + Seek Healed)";
    res = {status:0,stderr:remuxRes.stderr || ""};
    log(`[Size guard] Seek-healing remux completed at ${remuxBytes} bytes (source ${sourceBytes}); ${remuxBytes>sourceBytes?"the repaired output is larger than source and will be preserved":"the repaired output is smaller than source"}. Validating before replacement.`);
  }
  if (res.status !== 0 || !fs.existsSync(outputPath)) {''')
one('    const size = fs.statSync(outputPath).size;', '''    if (Array.isArray(frameScan?.sampleWindows) && isKnownVideoCorruptionDiagnostic(result.stderr)) {
      sourceScanFailureDetail=await scanFullSourceAfterFailure("a recognized video decode warning during encode",80);
      if (sourceScanFailureDetail) return {ok:false,ffmpeg:{...result,status:1,stderr:`Full source scan confirmed malformed video data: ${sourceScanFailureDetail}`}};
    }
    const size = fs.statSync(outputPath).size;''')
one('    log(`[Arc AV1 Single-Pass] Transcode execution failed critically: ${errReason}`);', '''    log(`[Arc AV1 Single-Pass] Transcode execution failed critically: ${errReason}`);
    if (Array.isArray(frameScan?.sampleWindows)) {
      if (!sourceScanFailureDetail) sourceScanFailureDetail=await scanFullSourceAfterFailure("encode failure",80);
      if (sourceScanFailureDetail) log(`[Video guard] ${sourceScanFailureDetail}; original retained.`);
    }''')
one('''    log(`${reason}${/[.!?]$/.test(reason)?'':'.'} Original will not be replaced.`);''', '''    log(`${reason}${/[.!?]$/.test(reason)?'':'.'} Original will not be replaced.`);
    if (Array.isArray(frameScan?.sampleWindows) && !alreadyClassified) {
      sourceScanFailureDetail=await scanFullSourceAfterFailure("output validation failure",91);
      if (sourceScanFailureDetail) log(`[Video guard] ${sourceScanFailureDetail}; original retained.`);
    }''')
e=(root/'progress.js').read_text()+'\n'+e
plugin['inputsDB']['code']=e
flow['flowPlugins'].append({'name':'Discord: Already Processed (Info)','sourceRepo':'Community','pluginName':'customFunction','version':'1.0.0','inputsDB':{'code':'module.exports = async args => ({outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables});'},'fpEnabled':True,'id':'already_completed','position':{'x':1380,'y':850}})
flow['flowEdges'].append({'source':'arc_av1_monolithic','sourceHandle':'4','target':'already_completed','targetHandle':None,'id':'edge_already_completed'})
flow['flowPlugins'].append({'name':'End handled notice','sourceRepo':'Community','pluginName':'customFunction','version':'1.0.0','inputsDB':{'code':'module.exports = async args => ({outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables});'},'fpEnabled':True,'id':'handled_end','position':{'x':1740,'y':850}})
flow['flowEdges'].append({'source':'already_completed','sourceHandle':'1','target':'handled_end','targetHandle':None,'id':'edge_already_processed_end'})

# Preserve the existing Arr endpoints/credentials while replacing the action logic with a source-controlled template.
arr_iso=next(p for p in flow['flowPlugins'] if p['id']=='notify_arr_iso')
arr_code=arr_iso['inputsDB']['code']
arr_config_match=re.search(r'  const ARR_CONFIG = \{[\s\S]*?\n  \};',arr_code)
if not arr_config_match: raise RuntimeError('Could not preserve Arr configuration while replacing the action handler')
arr_action=(root/'arr_action.js').read_text()
if arr_action.count('__ARR_CONFIG_DECLARATION__')!=1: raise RuntimeError('Arr action template must contain exactly one config placeholder')
arr_iso['name']='Arr: ISO rescan or confirmed source-corruption search'
arr_iso['inputsDB']['code']=arr_action.replace('__ARR_CONFIG_DECLARATION__',arr_config_match.group(0))

notify=next(p for p in flow['flowPlugins'] if p['id']=='discord_success')
notify_code=notify['inputsDB']['code']
old_sizes='  const origMB = args.originalLibraryFile?.file_size || 0;\n  const newMB = args.inputFileObj?.file_size || args.variables?.user?.final_size_mb || 0;'
new_sizes='  const origMB = args.variables?.user?.original_size_mb || args.originalLibraryFile?.file_size || 0;\n  const newMB = args.variables?.user?.final_size_mb || args.inputFileObj?.file_size || 0;'
if notify_code.count(old_sizes)!=1: raise RuntimeError('Unexpected success notifier size calculation')
notify_code=notify_code.replace(old_sizes,new_sizes,1)
notify_code,n=re.subn(r'const webhookUrl\s*=\s*(?:process\.env\.TDARR_DISCORD_WEBHOOK\s*\|\|\s*)?"https://discord\.com/api/webhooks/[^"\n]+"\s*;', 'const webhookUrl = process.env.TDARR_DISCORD_WEBHOOK;',notify_code)
if n==0 and notify_code.count('const webhookUrl = process.env.TDARR_DISCORD_WEBHOOK;')==1: pass
elif n!=1: raise RuntimeError('Unexpected success notifier webhook declaration')
old_payload='  const payload = JSON.stringify({\n    embeds: [{'
if notify_code.count(old_payload)!=1: raise RuntimeError('Unexpected success notifier payload')
notify_code=notify_code.replace(old_payload,'  const payload = JSON.stringify({\n    allowed_mentions: {parse: []},\n    embeds: [{',1)
notify_anchor='  const payload = JSON.stringify({'
assert notify_code.count(notify_anchor)==1
notify['inputsDB']['code']=notify_code.replace(notify_anchor, '  if (args.variables?.user?.hdr_conversion) descLines.push(`🌈 **HDR:** ${args.variables.user.hdr_conversion}`);\n\n'+notify_anchor)
# Keep Discord credentials out of Tdarr plugin code and its input logs.
already=next(p for p in flow['flowPlugins'] if p['id']=='already_completed')
already_template=(root/'already_notify.js').read_text()
if '__TDARR_DISCORD_WEBHOOK__' in already_template: raise RuntimeError('Already-processed notifier must not embed a webhook')
already['inputsDB']['code']=already_template
template=(root/'failure_notify.js').read_text()
if '__TDARR_DISCORD_WEBHOOK__' in template: raise RuntimeError('Failure notifier must not embed a webhook')
notifier=template
for plugin_id,name,y in [('notify_failure','Notify Failure or ISO Warning',600),('notify_failure_on_error','Notify unexpected error',780)]:
 flow['flowPlugins'].append({'name':name,'sourceRepo':'Community','pluginName':'customFunction','version':'1.0.0','inputsDB':{'code':notifier},'fpEnabled':True,'id':plugin_id,'position':{'x':1800,'y':y}})
for edge in flow['flowEdges']:
 if edge['source'] in ('cleanup_failure','notify_arr_iso') and edge['target']=='fail_flow': edge['target']='notify_failure'
 if edge['source']=='cleanup_failure' and edge['target']=='notify_failure': edge['target']='notify_arr_iso'
flow['flowEdges'].extend([
 {'source':'notify_failure','sourceHandle':'1','target':'fail_flow','targetHandle':None,'id':'edge_failure_notify_fail'},
 {'source':'notify_failure','sourceHandle':'2','target':'handled_end','targetHandle':None,'id':'edge_iso_warning_handled'},
 {'source':'cleanup_on_error','sourceHandle':'1','target':'notify_failure_on_error','targetHandle':None,'id':'edge_error_cleanup_notify'},
])
if any('https://discord.com/api/webhooks/' in p.get('inputsDB',{}).get('code','') for p in flow['flowPlugins']):
 raise RuntimeError('Refusing to export plugin code with an embedded Discord webhook')
guard=next(p for p in flow['flowPlugins'] if p['id']=='original_recheck')
old_guard='    log(`[Original guard] ${e.message || e}. Original will not be replaced.`);'
new_guard='    if (!args.variables) args.variables={}; if (!args.variables.user) args.variables.user={};\n    args.variables.user.failure_reason=`[Original guard] ${e.message || e}. Original will not be replaced.`;\n    log(args.variables.user.failure_reason);'
if guard['inputsDB']['code'].count(old_guard)!=1: raise RuntimeError('Unexpected original guard')
guard['inputsDB']['code']=guard['inputsDB']['code'].replace(old_guard,new_guard)
fail=next(p for p in flow['flowPlugins'] if p['id']=='fail_flow')
fail.setdefault('inputsDB',{}).update({'customErrorMessage':'{{{args.variables.user.failure_reason}}}', 'failureCategory':'custom', 'customCategoryName':'transcode', 'includeDiagnostics':False, 'showPerformanceMetrics':False, 'analyzeVariables':False})
flow['_id']='ArcAV1_SinglePass_UnattendedV14'
flow['name']='AV1 Intel Arc QSV [Single ICQ, Seek-Heal Fallback V14 - REVIEW]'
base_description=flow.get('description') or ''
flow['description']=base_description.rstrip()+'\nV14: one global QSV ICQ encode, capacity-bounded source-video seek-heal remux when the AV1 output is not smaller, ISO refetch warnings, already-processed info notices, Profile 7 Level 6 fallback, live progress, and capacity-reserved RAM-first scratch.'
flow['description']+='\nQuality decision (2026-11-02): keep Arc QSV ICQ 22 provisionally. Live SDR VMAF v1 scored 96.62 (TV 3H) / 98.02 (phone 5H) on Sample 4K Film and 96.62 / 97.66 on Sample Anime Series; the Sample Anime Series full file fell 21.7%. A matched 20 s excerpt from an 80 GB HDR10 source scored 106.18 on Netflix’s 4K HDR model at ICQ 22, with static HDR metadata retained. This supports the tested SDR/HDR10 quality samples only. See QUALITY_DECISION.md before production.'
flow['description']+='\nHDR route smoke tests (2026-11-02): direct live Arc QSV runs produced clean-decode output for Dolby Vision P7 to static HDR10, Dolby Vision P8.1 to HDR10 with the Level 6 189/89 fallback, and HDR10+ to static HDR10 with dynamic metadata removed. Synthetic HLG retained BT.2020/HLG signaling. These are route and metadata checks, not matched quality checks or an end-to-end V13 Tdarr job. No genuine HLG or Dolby Vision 8.4 source was found among 212 named 2160p videos. Hybrid Dolby Vision/HDR10+ remains held. See HDR_LIVE_VALIDATION.md.'
flow['description']+='\nCodec handling candidate update: supported 4:2:2/4:4:4 formats are normalized to 10-bit 4:2:0; tagged SDR 12-bit is error-diffused to 10-bit. Non-direct-QSV sources use CPU decode while AV1 encoding remains Arc QSV. The local FFmpeg matrix is software-only; Arc validation of these broader codec paths remains pending. See CODEC_COVERAGE.md.'
flow['description']+='\nFailure notices distinguish malformed H.264 source scans from output subtitle packet mismatches and give next steps. Subtitle count mismatches keep the original and do not trigger automatic deletion or Arr refetch. See FAILURE_DIAGNOSTICS.md.'
flow['description']+='\nRecognized video bitstream errors from the pre-encode source scan, or strict output-decode failures independently reproduced by decoding the original video/audio stream, trigger an item-scoped Sonarr EpisodeSearch or Radarr MoviesSearch only after matching the exact file. The original remains in place; no file deletion, quarantine, monitoring change, or broad series/movie search is performed. Arr profile/upgrade rules determine whether a replacement is accepted.'
flow['description']+='\nSource precheck policy: tagged progressive SDR and verified static HDR10 videos longer than 16 seconds use three 5-second software-decoded samples at the beginning, middle, and end; sample intervals end at absolute timestamps to account for FFprobe seeking back to keyframes. HDR10+, Dolby Vision, HLG, untagged/ambiguous, short, partially tagged SDR, or non-progressive-tagged video keeps the full CPU source scan. If a sampled source/output timeline comparison fails, the flow fully scans the source and compares its complete frame count and timestamps against the candidate’s already-complete output scan; it proceeds only if that full comparison passes. Other encode/output validation failures keep the original unless every check passes. Sampled routes do not prove exact frame equality outside their three windows when the sample comparison passes.'
flow['description']+='\nUntagged SDR YUV handling: keep transfer, primaries, and matrix unspecified. If stream, decoded-frame, and MediaInfo range are all missing, assume TV limited range for supported YUV pixel formats; preserve known range and infer full range for yuvj422p/yuvj444p. Apply the resolved range tag to both AV1 encode and seek-heal remux. Conflicting or unrecognized ranges are held. This is a conventional assumption, not recovered metadata; it does not affect HDR/Dolby Vision.'
flow['description']+='\nPartial SDR metadata: a recognized BT.709, BT.601/SMPTE 170M, or BT.470 BG matrix can classify a source as SDR when transfer/primaries are absent and there are no HDR/Dolby Vision signals. Missing fields remain unspecified; a conflicting or unrecognized matrix is held. These inputs receive a full CPU frame scan and are rejected if frames signal PQ, HLG, or BT.2020.'
flow['description']+='\nV14 audio policy: retain eng, jpn, spa, ita, and und audio; allow zho only when no Japanese track exists; stream-copy retained tracks; full-decode retained source audio before encoding and validate candidate audio before replacement.\nSafety correction (2026-11-03): source field-order tags no longer trigger an output-only interlace check after a full frame scan. Non-progressive-tagged sources still receive the full decoded-frame scan, actual interlaced frames remain held, and output field order remains guarded. Reservation V3 records are scoped to worker host/PID namespace, heartbeat during engine work, and identify only their own scratch directory; dead or expired leases are reclaimed on the next admission. User cancellation can bypass downstream Tdarr cleanup and notification nodes.'
out=root/'flow.json'
fd=os.open(out,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
with os.fdopen(fd,'w') as f: json.dump(flow,f,ensure_ascii=False,indent=2);f.write('\n')
os.chmod(out,0o600)
print(f'Built {out}, {len(flow["flowPlugins"])} plugins')
