#!/usr/bin/env python3
import json, os, pathlib
root=pathlib.Path(__file__).resolve().parent
flow=json.loads((root.parent/'tdarr-flow-v3/flow.json').read_text())
plugin=next(p for p in flow['flowPlugins'] if p['id']=='arc_av1_monolithic')
e=plugin['inputsDB']['code']
def one(old,new):
 global e
 n=e.count(old)
 if n!=1: raise RuntimeError(f'Expected 1 match, got {n}: {old[:80]}')
 e=e.replace(old,new,1)
e=(root/'policy.js').read_text()+'\n'+e
one('if (status !== 0) reject(new Error(', 'if (status !== 0 || stderr.trim()) reject(new Error(')
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
  const countFrames = (file, index) => {
    const raw = execFileSync(ffprobeBin, ["-v","error","-select_streams",String(index),"-count_frames","-show_entries","stream=nb_read_frames","-of","json",file], {encoding:"utf8",timeout:4*60*60*1000,maxBuffer:1024*1024});
    const count = Number(JSON.parse(raw).streams?.[0]?.nb_read_frames);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Video frame count unavailable");
    return count;
  };
  const sourceFrames=countFrames(sourcePath,sourceVideo.index), outputFrames=countFrames(outputPath,video[0].index);
  if (sourceFrames !== outputFrames) throw new Error(`Video frame count differs: ${sourceFrames} -> ${outputFrames}`);
  const tracks = {};
  for (const type of ["audio", "subtitle"]) {''')
one('  const vCodec = (mainVideo.codec_name || "").toLowerCase();', '''  const markerKey = Object.keys(args.inputFileObj?.ffProbeData?.format?.tags || {}).find(k => k.toLowerCase() === "encoded_by");
  if (isCompletedEncode(String(mainVideo.codec_name || "").toLowerCase(), markerKey ? {[markerKey]:args.inputFileObj.ffProbeData.format.tags[markerKey]} : {})) {
    log("[Arc AV1] Previously completed AV1 output; no additional generation.");
    return {outputFileObj:args.inputFileObj,outputNumber:4,variables:args.variables};
  }
  let frameScan;
  try {
    frameScan = await inspectVideoFrames(ffprobeBin, inputPath, mainVideo.index, {staticMetadata:true,timestamps:true,expectedColor:mainVideo});
    if (frameScan.interlaced) throw Error("Interlaced video frames are unsupported");
    if (frameScan.colorInfo.conflict) throw Error("Source frame color signaling conflicts with the stream");
    guardSourceVideo({...mainVideo,field_order:"progressive"});
    validateAspect(mainVideo, mainVideo);
  } catch (err) {
    log(`[Video guard] ${err.message || err}; original retained.`);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
  const vCodec = (mainVideo.codec_name || "").toLowerCase();''')
one('  // 2. Audio & Subtitle stream count & codec checks', '''  if (expected.requireMarker && (video[0].codec_name !== "av1" || !Object.entries(dst.format?.tags || {}).some(([k,v]) => k.toLowerCase() === "encoded_by" && String(v) === "ArcAV1_QSV_V11"))) throw new Error("Output completion marker missing");
  let outputFrameScan;
  if (expected.sourceFrameScan || expected.hdr10) {
    outputFrameScan = await inspectVideoFrames(ffprobeBin,outputPath,video[0].index,{staticMetadata:!!expected.hdr10 || !!expected.hlg || !!expected.untagged,timestamps:!!expected.sourceFrameScan,expectedColor:video[0]});
    if (outputFrameScan.colorInfo.conflict) throw Error("Output frame color signaling conflicts with the stream");
    if (expected.sourceFrameScan) compareVideoTimestamps(expected.sourceFrameScan,outputFrameScan);
  }
  if (expected.hdr10) {
    if (!expected.sourceHdr) throw new Error("HDR10 source metadata missing");
    validateHdr10(expected.sourceHdr, video[0]);
    if (outputFrameScan.interlaced || outputFrameScan.dovi || outputFrameScan.hdr10plus || outputFrameScan.otherDynamic) throw new Error("HDR10 output contains unexpected dynamic metadata or interlacing");
    checkHdrFrameStatic(expected.sourceHdr,outputFrameScan);
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
    const info = JSON.parse(execFileSync("mediainfo", ["--Output=JSON", inputPath], {encoding:"utf8", timeout:120000, maxBuffer:16*1024*1024}));
    const infoVideos = (info.media?.track || []).filter(t => String(t["@type"] || "").toLowerCase() === "video");
    if (infoVideos.length !== 1) throw new Error("MediaInfo did not identify exactly one video stream");
    const basic = classifyVideo(mainVideo, infoVideos[0]);
    if (isVerifiedSdr(basic,frameScan)) {
      validateEffectiveSdrTransfer(mainVideo,infoVideos[0],frameScan);
      sdrSource = effectiveSdrSource(mainVideo,infoVideos[0],frameScan);
      hdrClass = "sdr";
    } else if (isUntaggedVideo(mainVideo,infoVideos[0],frameScan)) {
      hdrClass = "untagged";
      sdrSource = {...mainVideo};
      if (isUnknownColorValue(sdrSource.color_range) && frameScan.colorInfo?.observed?.color_range) sdrSource.color_range=frameScan.colorInfo.observed.color_range;
      log("[Color] Input color metadata is unspecified; preserving unspecified signaling.");
    } else {
      hdrClass = determineHdrRoute(mainVideo,infoVideos[0],frameScan);
      if (hdrClass === "hlg" || hdrClass === "dovi84_hlg") {
        if (frameScan.staticInfo.mastering || frameScan.staticInfo.light || frameScan.staticInfo.conflict) throw Error("HLG source has additional static HDR metadata that is not verified");
        hdrSource = hdrClass === "dovi84_hlg" ? {...mainVideo,side_data_list:(mainVideo.side_data_list || []).filter(s=>!/dolby|dovi/i.test(String(s.side_data_type || "")))} : mainVideo;
        validateHlg(hdrSource,hdrSource);
      } else {
        const canUseDolbyLevel6 = hdrClass === "dovi81_hdr10" || hdrClass === "dovi7_hdr10";
        hdrSource = mergeHdrMetadata(mainVideo,readHdrFrames(ffprobeBin,inputPath,mainVideo.index),{allowMissingLight:canUseDolbyLevel6});
        checkHdrFrameStatic(hdrSource,frameScan,!canUseDolbyLevel6);
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
  const qualityAttempts = selectQualityAttempts({width, height, isHdr});
'''+e[b:]
one('  const rawSizeMB = (args.originalLibraryFile?.file_size || args.inputFileObj?.file_size || (fs.statSync(inputPath).size / (1024 * 1024)));','  const rawSizeMB = fs.statSync(inputPath).size / (1024 * 1024);')
one('Math.abs((d.first-s.first)-shift)>tolerance || Math.abs((d.last-s.last)-shift)>tolerance', 'Math.abs((d.first-s.first)-shift)>0.1 || Math.abs((d.last-s.last)-shift)>0.1')
one('        "-look_ahead", "1",\n        "-look_ahead_depth", "40",\n','')
one('  const needsProactiveHybrid = isH26410bit || isVC1 || isNon420Chroma;', '  const needsProactiveHybrid = isHdr || isH26410bit || isVC1 || isNon420Chroma;')
one('    cmdArgs.push("-i", inputPath);', '    if (hdrLightOverride) cmdArgs.push("-content_light", hdrLightOverride);\n    cmdArgs.push("-i", inputPath);')
one('        cmdArgs.push("-vf", "format=p010le");', '        cmdArgs.push("-vf", hdrClass === "hdr10plus_hdr10" ? "sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,format=p010le" : "format=p010le");')
one('    const cmdArgs = ["-y", "-fflags", "+genpts+igndts"];', '    const cmdArgs = ["-y", "-xerror", "-fflags", "+genpts+igndts"];')
one('encoded_by=ArcAV1_QSV','encoded_by=ArcAV1_QSV_V11')
one('      codec: expectedVideoCodec,\n', '      codec: expectedVideoCodec,\n      requireMarker: true,\n      hdr10: hdrClass === "hdr10" || hdrClass === "dovi81_hdr10" || hdrClass === "dovi7_hdr10" || hdrClass === "hdr10plus_hdr10",\n      hlg: hdrClass === "hlg" || hdrClass === "dovi84_hlg",\n      untagged: hdrClass === "untagged",\n      sourceHdr: hdrSource,\n      sdrSource,\n      sourceFrameScan: frameScan,\n')
a=e.index('  log(`[Arc AV1 Single-Pass] Processing:')
b=e.index('\n  // Cleanup temporary clamped chapters file',a)
e=e[:a]+'''  log(`[Arc AV1] Processing ${inputPath} using ICQ attempts ${qualityAttempts.join(", ")}; ${pipelineMode}`);
  const sourceBytes = Number(originalSnapshot.size);
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 1) throw new Error("Original size is invalid");
  const attempt = await runQualityAttemptsAsync(qualityAttempts, sourceBytes, async (q) => {
    quality = q;
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    let result = await runFfmpeg(needsProactiveHybrid, false);
    if (result.error) return {ok:false, ffmpeg:result};
    const reachedLimit = r => fs.existsSync(outputPath) && fs.statSync(outputPath).size >= sourceBytes && (r.signal === 'SIGXFSZ' || /file too large/i.test(String(r.stderr || '')));
    if (reachedLimit(result)) { log(`[Size guard] ICQ ${q} reached the source size; trying the next quality if available.`); return {ok:true,size:sourceBytes,ffmpeg:result}; }
    if (result.status !== 0 && !needsProactiveHybrid) {
      log(`[Arc AV1] Full GPU decode failed at ICQ ${q}: ${extractFfmpegError(result.stderr)}. Trying CPU decode with Arc encode.`);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      result = await runFfmpeg(true, false);
      pipelineMode = `Hybrid (CPU Decode + Arc QSV AV1 Encode)`;
      if (reachedLimit(result)) { log(`[Size guard] ICQ ${q} reached the source size; trying the next quality if available.`); return {ok:true,size:sourceBytes,ffmpeg:result}; }
    }
    if (result.status !== 0 || !fs.existsSync(outputPath)) return {ok:false, ffmpeg:result};
    const size = fs.statSync(outputPath).size;
    log(`[Arc AV1] ICQ ${q} produced ${size} bytes; source ${sourceBytes} bytes.`);
    return {ok:true, size, ffmpeg:result};
  });
  let res = attempt.result?.ffmpeg || {status: 1, stderr: `No smaller output at ICQ ${attempt.quality} (quality floor reached)`};
  if (!attempt.ok && attempt.reason !== "encoder") {
    log(`[Arc AV1] No acceptable smaller file: ${attempt.reason} at ICQ ${attempt.quality}. Keeping original.`);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res = {status:1, qualityFloor:true, stderr:`No smaller output at ICQ ${attempt.quality}: ${attempt.reason}`};
  }
'''+e[b:]
a=e.index('  // Bloat Protection (> maxRatioPct for tier)')
b=e.index('\n  // 10. Persist Pipeline Metadata',a)
e=e[:a]+'  cleanupChapters();\n'+e[b:]
one('  const isBloat = !isAlreadyAV1 && (ratioPct > maxRatioPct);','  const isBloat = false;')
exec((root/'build_additions.py').read_text())
one('    return spawnSync(ffmpegBin, cmdArgs, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });', '    return runLimitedFfmpeg({command:"prlimit",argv:[`--fsize=${sourceBytes}:${sourceBytes}`, "--", ffmpegBin, ...cmdArgs],durationSec,updateWorker:args.updateWorker});')
one('    const cmdArgs = ["-y", "-xerror", "-fflags", "+genpts+igndts"];', '    const cmdArgs = ["-y", "-xerror", "-progress", "pipe:1", "-nostats", "-fflags", "+genpts+igndts"];')
one('    const errReason = errTail\n      ? `FFmpeg exit ${res.status}: ${errTail}`', '    const errReason = res.error\n      ? `Unable to start the size-limited encoder: ${res.error.message || res.error}`\n      : errTail\n      ? `FFmpeg exit ${res.status}: ${errTail}`')
one('  if (res.status !== 0 || !fs.existsSync(outputPath)) {', '''  if (res.qualityFloor) {
    cleanupChapters();
    log(`[Size guard] No smaller output at ICQ ${attempt.quality}; quality floor reached. Original retained.`);
    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
  }
  if (res.status !== 0 || !fs.existsSync(outputPath)) {''')
e=(root/'progress.js').read_text()+'\n'+e
plugin['inputsDB']['code']=e
flow['flowPlugins'].append({'name':'Already completed - end','sourceRepo':'Community','pluginName':'customFunction','version':'1.0.0','inputsDB':{'code':'module.exports = async args => ({outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables});'},'fpEnabled':True,'id':'already_completed','position':{'x':1040,'y':850}})
flow['flowEdges'].append({'source':'arc_av1_monolithic','sourceHandle':'4','target':'already_completed','targetHandle':None,'id':'edge_already_completed'})
notify=next(p for p in flow['flowPlugins'] if p['id']=='discord_success')
notify_code=notify['inputsDB']['code']
notify_anchor='  const payload = JSON.stringify({'
assert notify_code.count(notify_anchor)==1
notify['inputsDB']['code']=notify_code.replace(notify_anchor, '  if (args.variables?.user?.hdr_conversion) descLines.push(`🌈 **HDR:** ${args.variables.user.hdr_conversion}`);\n\n'+notify_anchor)
# Notify both controlled and unexpected failures. Reuse the configured webhook without printing it.
import re
matches=re.findall(r'const webhookUrl\s*=\s*"([^"\n]+)"',e)
if len(matches)!=1: raise RuntimeError('Expected exactly one inherited Discord webhook')
template=(root/'failure_notify.js').read_text()
if template.count('__TDARR_DISCORD_WEBHOOK__')!=1: raise RuntimeError('Unexpected notifier template')
notifier=template.replace('__TDARR_DISCORD_WEBHOOK__',json.dumps(matches[0]))
for plugin_id,name,y in [('notify_failure','Notify processing failure',600),('notify_failure_on_error','Notify unexpected error',780)]:
 flow['flowPlugins'].append({'name':name,'sourceRepo':'Community','pluginName':'customFunction','version':'1.0.0','inputsDB':{'code':notifier},'fpEnabled':True,'id':plugin_id,'position':{'x':1800,'y':y}})
for edge in flow['flowEdges']:
 if edge['source'] in ('cleanup_failure','notify_arr_iso') and edge['target']=='fail_flow': edge['target']='notify_failure'
flow['flowEdges'].extend([
 {'source':'notify_failure','sourceHandle':'1','target':'fail_flow','targetHandle':None,'id':'edge_failure_notify_fail'},
 {'source':'cleanup_on_error','sourceHandle':'1','target':'notify_failure_on_error','targetHandle':None,'id':'edge_error_cleanup_notify'},
])
guard=next(p for p in flow['flowPlugins'] if p['id']=='original_recheck')
old_guard='    log(`[Original guard] ${e.message || e}. Original will not be replaced.`);'
new_guard='    if (!args.variables) args.variables={}; if (!args.variables.user) args.variables.user={};\n    args.variables.user.failure_reason=`[Original guard] ${e.message || e}. Original will not be replaced.`;\n    log(args.variables.user.failure_reason);'
if guard['inputsDB']['code'].count(old_guard)!=1: raise RuntimeError('Unexpected original guard')
guard['inputsDB']['code']=guard['inputsDB']['code'].replace(old_guard,new_guard)
fail=next(p for p in flow['flowPlugins'] if p['id']=='fail_flow')
fail.setdefault('inputsDB',{}).update({'customErrorMessage':'{{{args.variables.user.failure_reason}}}', 'failureCategory':'custom', 'customCategoryName':'transcode', 'includeDiagnostics':False, 'showPerformanceMetrics':False, 'analyzeVariables':False})
flow['_id']='ArcAV1_SinglePass_UnattendedV11'
flow['name']='AV1 Intel Arc QSV [Concurrent HDR V11 - REVIEW]'
flow['description']=(flow.get('description') or '')+'\nV11: Profile 7 Level 6 fallback, live encode progress, and concurrent reservations.'
out=root/'flow.json'
fd=os.open(out,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
with os.fdopen(fd,'w') as f: json.dump(flow,f,ensure_ascii=False,indent=2);f.write('\n')
os.chmod(out,0o600)
print(f'Built {out}, {len(flow["flowPlugins"])} plugins')
