#!/usr/bin/env python3
"""Build an importable copy of the supplied flow without printing credentials."""
import json, os, pathlib, re
root = pathlib.Path(__file__).resolve().parent
src = pathlib.Path('/Users/mfattoru/.codex/attachments/d9fab074-a62b-49e5-b8fd-583ed0e1f902/Pasted text.txt')
flow = json.loads(src.read_text())
plugins = {p['id']: p for p in flow['flowPlugins']}
engine = plugins['arc_av1_monolithic']['inputsDB']['code']
helpers = (root / 'safety.js').read_text().replace('module.exports = { safeFreeSpaceMB, makeJobDir, validateOutput };', '')

def replace_once(old, new):
    global engine
    if engine.count(old) != 1: raise RuntimeError(f'Expected one occurrence: {old[:90]!r}, found {engine.count(old)}')
    engine = engine.replace(old, new, 1)

start = engine.index('const getFreeSpaceMB = (dirPath) => {')
end = engine.index('\nconst formatPipelineMode', start)
engine = engine[:start] + helpers + '\nconst getFreeSpaceMB = safeFreeSpaceMB;\n' + engine[end:]
replace_once('  if (!args.variables.user) args.variables.user = {};', '  if (!args.variables.user) args.variables.user = {};\n  delete args.variables.user.safety_temp_dir;\n  delete args.variables.user.safety_temp_output;')
replace_once('  const ffmpegBin = args.ffmpegPath || "ffmpeg";', '''  const ffmpegBin = args.ffmpegPath || "ffmpeg";
  const ffprobeBin = process.env.TDARR_FFPROBE_PATH || "ffprobe";
  const gpuDevice = process.env.TDARR_ARC_DEVICE || args.userVariables?.library?.arc_device || args.userVariables?.global?.arc_device || "/dev/dri/renderD129";''')
replace_once('"-init_hw_device", "vaapi=va:/dev/dri/renderD129",', '"-init_hw_device", `vaapi=va:${gpuDevice}`,')
replace_once('      } else {\n        if (!selectedDir) selectedDir = cand;\n      }\n    }\n\n    if (!selectedDir)', '      } else {\n        log(`[Cache Route Guard] Cannot determine available space for ${cand}; refusing it.`);\n      }\n    }\n\n    if (!selectedDir)')
replace_once('  const targetDir = selectedDir;\n  const outputPath = (targetDir !== parsed.dir)\n    ? path.join(targetDir, `${cleanBase}.mkv`)\n    : path.join(targetDir, `${cleanBase}_singlepass.mkv`);\n  if (fs.existsSync(outputPath) && outputPath !== inputPath) {\n    try { fs.unlinkSync(outputPath); } catch (e) {}\n  }', '''  // A per-job directory prevents collisions for identical basenames.
  const targetDir = makeJobDir(selectedDir);
  const outputPath = path.join(targetDir, `${cleanBase}.mkv`);''')
replace_once('  const outputPath = path.join(targetDir, `${cleanBase}.mkv`);', \
    '  const outputPath = path.join(targetDir, `${cleanBase}.mkv`);\n  args.variables.user.safety_temp_dir = targetDir;\n  args.variables.user.safety_temp_output = outputPath;')
replace_once('  let pipelineMode = "";', \
    '  if (!isAlreadyAV1) {\n    try { fs.accessSync(gpuDevice, fs.constants.R_OK | fs.constants.W_OK); }\n    catch (err) { log(`[Arc GPU] Device not accessible: ${gpuDevice}: ${err.message || err}`); return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables }; }\n  }\n\n  let pipelineMode = "";')
start = engine.index('  // Clamp QVBR targetBitrate')
end = engine.index('  const isOversizedAV1', start)
engine = engine[:start] + '  // Quality-based encoding is used; no bitrate clamp is applied.\n' + engine[end:]
replace_once('  const finalStat = fs.statSync(outputPath);', '''  // Validate the final output, including stream-copy fallbacks, before replacing anything.
  try {
    const expectedCodec = (isAlreadyAV1 || isBloat) ? vCodec : "av1";
    const result = validateOutput(ffprobeBin, inputPath, outputPath, {
      audio: finalAudioStreams.length, subtitle: finalSubStreams.length, codec: expectedCodec,
      audioCodecs: finalAudioStreams.map(s => (parseInt(s.channels || 0, 10) > 2 && ((s.codec_name || "").toLowerCase() !== "eac3" || parseInt(s.channels || 0, 10) > 6)) ? "eac3" : s.codec_name),
      subtitleCodecs: finalSubStreams.map(s => (toSrtCodecs.includes((s.codec_name || "").toLowerCase()) || toSrtCodecIDs.includes((s.codec_tag_string || s.codec_id || "").toLowerCase())) ? "subrip" : s.codec_name)
    });
    log(`[Output validation] Duration ${result.sourceDuration}s -> ${result.outputDuration}s; expected streams and codec found.`);
    const originalPath = args.originalLibraryFile?._id;
    if (!originalPath || !fs.existsSync(originalPath)) throw new Error("Original library file is not accessible from this node");
    const destinationPath = path.join(path.dirname(originalPath), path.basename(outputPath));
    if (destinationPath !== originalPath && fs.existsSync(destinationPath)) throw new Error(`Replacement destination already exists: ${destinationPath}`);
  } catch (err) {
    log(`[Safety check failed] ${err.message || err}. Original will not be replaced.`);
    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
  }

  const finalStat = fs.statSync(outputPath);''')
replace_once('    await sendWebhookWithRetry(webhookUrl, isoPayload, "Discord ISO Deleted", 3);\n    try { fs.unlinkSync(inputPath); } catch (e) {}\n    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };', '''    // Rescan only after deletion succeeds, regardless of Discord delivery.
    try {
      const originalIso = args.originalLibraryFile?._id || inputPath;
      if (originalIso !== inputPath) throw new Error("ISO working path differs from original library path; refusing to delete an uncertain file");
      fs.unlinkSync(originalIso);
      log(`[ISO Guard] Deleted original disc image: ${originalIso}`);
    } catch (e) {
      log(`[ISO Guard] Deletion failed: ${e.message || e}`);
      return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
    }
    try { await sendWebhookWithRetry(webhookUrl, isoPayload, "Discord ISO Deleted", 3); }
    catch (e) { log(`[ISO Guard] Discord notification failed: ${e.message || e}`); }
    return { outputFileObj: args.inputFileObj, outputNumber: 3, variables: args.variables };''')
plugins['arc_av1_monolithic']['inputsDB']['code'] = engine
success = plugins['discord_success']['inputsDB']['code']
success = success.replace('`ICQ ${qualVal} Near-Lossless` : "Near-Lossless"', '`QSV quality ${qualVal}` : "QSV quality mode"')
plugins['discord_success']['inputsDB']['code'] = success
cleanup_code = r'''module.exports = async (args) => {
  const fs = require("fs");
  const path = require("path");
  const tempDir = args.variables?.user?.safety_temp_dir;
  const output = args.variables?.user?.safety_temp_output;
  const log = msg => { if (typeof args.jobLog === "function") args.jobLog(msg); else console.log(msg); };
  try {
    if (typeof tempDir === "string" && path.isAbsolute(tempDir) && /^tdarr-av1-[a-zA-Z0-9]+$/.test(path.basename(tempDir))) {
      if (typeof output === "string" && path.dirname(output) === tempDir && fs.existsSync(output)) fs.unlinkSync(output);
      fs.rmdirSync(tempDir);
    }
  } catch (e) { log(`[Cache cleanup] Could not remove job cache: ${e.message || e}`); }
  if (args.variables?.user) { delete args.variables.user.safety_temp_dir; delete args.variables.user.safety_temp_output; }
  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};'''
# Reuse the existing content-aware notifier on the successful ISO deletion path.
iso_notifier = json.loads(json.dumps(plugins['notify_arr']))
iso_notifier.update({'id': 'notify_arr_iso', 'name': 'Notify Arr after ISO deletion', 'position': {'x': 1100, 'y': 650}})
flow['flowPlugins'].append(iso_notifier)
for node_id, label, pos in [('cleanup_success', 'Clean successful job cache', {'x': 1480, 'y': 300}), ('cleanup_failure', 'Clean failed job cache', {'x': 1100, 'y': 480})]:
    flow['flowPlugins'].append({'name': label, 'sourceRepo': 'Community', 'pluginName': 'customFunction', 'version': '1.0.0', 'inputsDB': {'code': cleanup_code}, 'fpEnabled': True, 'id': node_id, 'position': pos})
for edge in flow['flowEdges']:
    if edge['source'] == 'replace_original' and edge['target'] == 'notify_arr': edge['target'] = 'cleanup_success'
    if edge['source'] == 'arc_av1_monolithic' and edge['target'] == 'fail_flow': edge['target'] = 'cleanup_failure'
flow['flowEdges'].extend([
    {'source': 'arc_av1_monolithic', 'sourceHandle': '3', 'target': 'notify_arr_iso', 'targetHandle': None, 'id': 'edge_iso_to_arr'},
    {'source': 'notify_arr_iso', 'sourceHandle': '1', 'target': 'fail_flow', 'targetHandle': None, 'id': 'edge_iso_arr_to_fail'},
    {'source': 'cleanup_success', 'sourceHandle': '1', 'target': 'notify_arr', 'targetHandle': None, 'id': 'edge_cleanup_success_arr'},
    {'source': 'cleanup_failure', 'sourceHandle': '1', 'target': 'fail_flow', 'targetHandle': None, 'id': 'edge_cleanup_failure_fail'},
])
# The original remains importable and the new flow has a distinct ID.
flow['_id'] = 'ArcAV1_SinglePass_SafetyReview'
flow['name'] = flow['name'] + ' [Safety Review]'
flow['description'] = (flow.get('description') or '') + '\nSafety review copy: probes final output before replacing the original.'
out = root / 'ArcAV1-safety-review.json'
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f: json.dump(flow, f, ensure_ascii=False, indent=2); f.write('\n')
os.chmod(out, 0o600)
print(f'Built {out} with {len(flow["flowPlugins"])} plugins')
