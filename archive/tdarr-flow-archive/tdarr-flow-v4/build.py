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
one('  const tracks = {};\n  for (const type of ["audio", "subtitle"]) {', '''  if (!expected.hdr10) validateSdrColor(sourceVideo, video[0]);
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
one('  const vCodec = (mainVideo.codec_name || "").toLowerCase();', '''  try { guardSourceVideo(mainVideo); validateAspect(mainVideo, mainVideo); } catch (err) {
    log(`[Video guard] ${err.message || err}; original retained.`);
    return {outputFileObj:args.inputFileObj,outputNumber:2,variables:args.variables};
  }
  const vCodec = (mainVideo.codec_name || "").toLowerCase();''')
one('  // 2. Audio & Subtitle stream count & codec checks', '''  if (expected.requireMarker && !isCompletedEncode(video[0].codec_name, dst.format?.tags || {})) throw new Error("Output completion marker missing");
  if (expected.hdr10) {
    const srcVideo = (src.streams || []).find(s => s.index === expected.sourceVideoIndex);
    if (!srcVideo) throw new Error("HDR10 source video missing");
    validateHdr10(srcVideo, video[0]);
  }

  // 2. Audio & Subtitle stream count & codec checks''')
one('  const isEncodedByUs = Boolean(encodedByKey && String(formatTags[encodedByKey]).includes("ArcAV1_QSV"));','''  if (isCompletedEncode(vCodec, formatTags)) {
    log("[Arc AV1] This V4 AV1 output has already completed; ending without another generation.");
    return { outputFileObj: args.inputFileObj, outputNumber: 4, variables: args.variables };
  }
  const isEncodedByUs = false;
  let hdrClass;
  try {
    const info = JSON.parse(execFileSync("mediainfo", ["--Output=JSON", inputPath], {encoding:"utf8", timeout:120000, maxBuffer:16*1024*1024}));
    const infoVideos = (info.media?.track || []).filter(t => String(t["@type"] || "").toLowerCase() === "video");
    if (infoVideos.length !== 1) throw new Error("MediaInfo did not identify exactly one video stream");
    hdrClass = classifyVideo(mainVideo, infoVideos[0]);
    if (hdrClass !== "sdr") throw new Error("HDR and ambiguous color metadata are held until dynamic HDR detection is verified");
    if (isHdr !== (hdrClass === "hdr10")) throw new Error("HDR color metadata is inconsistent");
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
one('        "-look_ahead", "1",\n        "-look_ahead_depth", "40",\n','')
one('encoded_by=ArcAV1_QSV','encoded_by=ArcAV1_QSV_V4')
one('      codec: expectedVideoCodec,\n', '      codec: expectedVideoCodec,\n      requireMarker: true,\n      hdr10: hdrClass === "hdr10",\n')
a=e.index('  log(`[Arc AV1 Single-Pass] Processing:')
b=e.index('\n  // Cleanup temporary clamped chapters file',a)
e=e[:a]+'''  log(`[Arc AV1] Processing ${inputPath} using ICQ attempts ${qualityAttempts.join(", ")}; ${pipelineMode}`);
  const sourceBytes = Number(originalSnapshot.size);
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 1) throw new Error("Original size is invalid");
  const attempt = runQualityAttempts(qualityAttempts, sourceBytes, (q) => {
    quality = q;
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    let result = runFfmpeg(needsProactiveHybrid, false);
    if (result.status !== 0 && !needsProactiveHybrid) {
      log(`[Arc AV1] Full GPU decode failed at ICQ ${q}: ${extractFfmpegError(result.stderr)}. Trying CPU decode with Arc encode.`);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      result = runFfmpeg(true, false);
      pipelineMode = `Hybrid (CPU Decode + Arc QSV AV1 Encode)`;
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
    res = {status:1, stderr:`No smaller valid output at ICQ ${attempt.quality}: ${attempt.reason}`};
  }
'''+e[b:]
a=e.index('  // Bloat Protection (> maxRatioPct for tier)')
b=e.index('\n  // 10. Persist Pipeline Metadata',a)
e=e[:a]+'  cleanupChapters();\n'+e[b:]
one('  const isBloat = !isAlreadyAV1 && (ratioPct > maxRatioPct);','  const isBloat = false;')
plugin['inputsDB']['code']=e
flow['flowPlugins'].append({'name':'Already completed - end','sourceRepo':'Community','pluginName':'customFunction','version':'1.0.0','inputsDB':{'code':'module.exports = async args => ({outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables});'},'fpEnabled':True,'id':'already_completed','position':{'x':1040,'y':850}})
flow['flowEdges'].append({'source':'arc_av1_monolithic','sourceHandle':'4','target':'already_completed','targetHandle':None,'id':'edge_already_completed'})
flow['_id']='ArcAV1_SinglePass_UnattendedV4'
flow['name']='AV1 Intel Arc QSV [Unattended V4 - REVIEW]'
flow['description']=(flow.get('description') or '')+'\nV4: bounded ICQ retries and strict size reduction; current-version completion marker.'
out=root/'flow.json'
fd=os.open(out,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
with os.fdopen(fd,'w') as f: json.dump(flow,f,ensure_ascii=False,indent=2);f.write('\n')
os.chmod(out,0o600)
print(f'Built {out}, {len(flow["flowPlugins"])} plugins')
