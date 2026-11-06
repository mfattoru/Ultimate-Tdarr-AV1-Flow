#!/usr/bin/env python3
"""Build from the user's updated export without printing its credentials."""
import json, os, pathlib
root=pathlib.Path(__file__).resolve().parent
source=pathlib.Path('/Users/mfattoru/.codex/attachments/557112c8-8ea2-4873-a139-014362a5f2fb/Pasted text.txt')
flow=json.loads(source.read_text())
plugins={p['id']:p for p in flow['flowPlugins']}
engine=plugins['arc_av1_monolithic']['inputsDB']['code']

def one(old,new):
 global engine
 n=engine.count(old)
 if n!=1: raise RuntimeError(f'Expected one match, found {n}: {old[:100]}')
 engine=engine.replace(old,new,1)

# Keep distinct tracks; metadata and zero-duration tags alone are not proof of duplicates.
a=engine.index('  // Ghost & Duplicate Stream Pruner:')
b=engine.index('  const formatTags =',a)
engine=engine[:a]+'  // Keep ambiguous audio and subtitle tracks; metadata alone does not prove duplication.\n\n'+engine[b:]

# Full video timeline check plus complete output decode.
engine = (root/'capacity_lock.js').read_text() + '\n' + engine
timeline=(root/'timeline.js').read_text()
anchor='const validateOutput = (ffprobeBin, sourcePath, outputPath, expected) => {'
one(anchor,timeline+'\nconst validateOutput = async (ffprobeBin, sourcePath, outputPath, expected) => {')
a=engine.index('  // 3. Multi-tier duration validation')
b=engine.index('\n};\n\nconst getFreeSpaceMB',a)
engine=engine[:a]+'''  const sourceVideo = (src.streams || []).find(s => s.index === expected.sourceVideoIndex)
    || (src.streams || []).find(s => s.codec_type === "video" && !s.disposition?.attached_pic && !s.disposition?.timed_thumbnails);
  if (!sourceVideo) throw new Error("Source video stream unavailable for validation");
  const tracks = {};
  for (const type of ["audio", "subtitle"]) {
    const from = expected[type + "Indices"] || (src.streams || []).filter(s => s.codec_type === type).map(s => s.index);
    const to = (dst.streams || []).filter(s => s.codec_type === type).map(s => s.index);
    if (from.length !== to.length) throw new Error(`Expected ${type} mapping count does not match output`);
    tracks[type] = from.map((index, i) => [index, to[i]]);
  }
  return await verifyVideoTimeline(ffprobeBin, expected.ffmpegBin || "ffmpeg", sourcePath, outputPath, sourceVideo.index, video[0].index, tracks);'''+engine[b:]
one('const valResult = validateOutput(ffprobeBin, inputPath, outputPath, {','const valResult = await validateOutput(ffprobeBin, inputPath, outputPath, {')
one('      codec: expectedVideoCodec,\n      audio: finalAudioStreams.length,','      codec: expectedVideoCodec,\n      sourceVideoIndex: mainVideo.index,\n      ffmpegBin,\n      audioIndices: finalAudioStreams.map(s => s.index),\n      subtitleIndices: finalSubStreams.map(s => s.index),\n      audio: finalAudioStreams.length,')

# Accurate bounded free-space fallback and fail closed on unknown.
a=engine.index('const getFreeSpaceMB = (dirPath) => {')
b=engine.index('\nconst formatPipelineMode',a)
engine=engine[:a]+'''const getFreeSpaceMB = (dirPath) => {
  try {
    const s = fs.statfsSync(dirPath, { bigint: true });
    if (s.bavail < 0n || s.bsize <= 0n) return null;
    return Number((s.bavail * s.bsize) / (1024n * 1024n));
  } catch (_) {
    try {
      const out = execFileSync("df", ["-Pk", dirPath], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
      const lines = out.trim().split(/\\r?\\n/);
      const match = lines[lines.length - 1].match(/^.*?\\s+\\d+\\s+\\d+\\s+(\\d+)\\s+\\d+%\\s+/);
      return match ? Math.floor(Number(match[1]) / 1024) : null;
    } catch (_) { return null; }
  }
};
''' +engine[b:]
one('const requiredDiskMB = Math.max(minFloorMB, Math.round(rawSizeMB * 1.25));', 'const requiredDiskMB = requiredDiskSpaceMB(rawSizeMB, minFloorMB);')
one('''      } else {
        if (!selectedDir) selectedDir = cand;
      }
    }

    if (!selectedDir)''','''      } else {
        log(`[Cache Route Guard] Cannot determine free space for '${cand}'; skipping it.`);
      }
    }

    if (!selectedDir)''')

# Capture the actual original once before probing/encoding; no persistent backup.
one('  // 2. Stream Probing','''  // Record the original identity before processing. ISO deletion is handled above.
  const originalPath = args.originalLibraryFile?._id;
  let originalSnapshot;
  try {
    if (!originalPath || !path.isAbsolute(originalPath)) throw new Error("Original library path is unavailable");
    const s = fs.statSync(originalPath, { bigint: true });
    if (!s.isFile()) throw new Error("Original is not a regular file");
    originalSnapshot = { realPath: fs.realpathSync(originalPath), dev: s.dev, ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs };
    args.variables.user.original_snapshot = { path: originalPath, realPath: originalSnapshot.realPath, dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) };
  } catch (e) {
    log(`[Original guard] Cannot access original: ${e.message || e}`);
    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
  }

  // 2. Stream Probing''')
one('''    const originalPath = args.originalLibraryFile?._id || inputPath;
    if (originalPath && fs.existsSync(originalPath)) {
      const destinationPath = path.join(path.dirname(originalPath), path.basename(outputPath));
      if (destinationPath !== originalPath && fs.existsSync(destinationPath)) {
        throw new Error(`Replacement destination already exists: ${destinationPath}`);
      }
    }''','''    const current = fs.statSync(originalPath, { bigint: true });
    if (fs.realpathSync(originalPath) !== originalSnapshot.realPath || current.dev !== originalSnapshot.dev || current.ino !== originalSnapshot.ino || current.size !== originalSnapshot.size || current.mtimeNs !== originalSnapshot.mtimeNs || current.ctimeNs !== originalSnapshot.ctimeNs) {
      throw new Error("Original library file changed during processing");
    }
    const destinationPath = path.join(path.dirname(originalPath), path.basename(outputPath));
    if (destinationPath !== originalPath && fs.existsSync(destinationPath)) throw new Error(`Replacement destination already exists: ${destinationPath}`);''')

one('  // 6b. Transcode Cache Path Routing & Hard Free-Space Requirement Guard (Section 53)', \
    '''  // Serialize these AV1 jobs across the configured shared cache mount.
  try {
    const lockRoot = process.env.TDARR_CAPACITY_LOCK_DIR || "/transcode_cache";
    await acquireCapacityLock(lockRoot, args.variables, log);
  } catch (e) {
    log(`[Cache capacity] Cannot acquire shared capacity lock: ${e.message || e}`);
    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
  }

  // 6b. Transcode Cache Path Routing & Hard Free-Space Requirement Guard (Section 53)''')
one('  // 6b. Transcode Cache Path Routing & Hard Free-Space Requirement Guard (Section 53)', '  try {\n  // 6b. Transcode Cache Path Routing & Hard Free-Space Requirement Guard (Section 53)')
one('''  return {
    outputFileObj: outputObj,
    outputNumber: 1,
    variables: args.variables
  };
};''','''  return {
    outputFileObj: outputObj,
    outputNumber: 1,
    variables: args.variables
  };
  } catch (e) {
    log(`[Arc AV1] Job failed: ${e.message || e}`);
    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
  }
};''')
one('    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}\n    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };', '    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };')
plugins['arc_av1_monolithic']['inputsDB']['code']=engine
# Replacement plugin has only output 1. An On Flow Error node runs for thrown errors.
flow['flowEdges']=[e for e in flow['flowEdges'] if not(e['source']=='replace_original' and e['sourceHandle']=='2')]
flow['flowPlugins'].append({'name':'On Flow Error','sourceRepo':'Community','pluginName':'onFlowError','version':'1.0.0','inputsDB':{},'fpEnabled':True,'id':'on_flow_error','position':{'x':1260,'y':700}})
flow['flowPlugins'].append({'name':'Clean cache after flow error','sourceRepo':'Community','pluginName':'customFunction','version':'1.0.0','inputsDB':{'code':(root/'error_cleanup.js').read_text()},'fpEnabled':True,'id':'cleanup_on_error','position':{'x':1460,'y':700}})
flow['flowEdges'].append({'source':'on_flow_error','sourceHandle':'1','target':'cleanup_on_error','targetHandle':None,'id':'edge_onerror_to_cleanup'})
# Each terminal cleanup releases only the capacity lock owned by this job.
for plugin in flow['flowPlugins']:
 if plugin['id'] in ('cleanup_success','cleanup_failure','cleanup_on_error'):
  body=(root/'error_cleanup.js').read_text() if plugin['id']=='cleanup_failure' else plugin['inputsDB']['code']
  ret='return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };' if plugin['id'] == 'cleanup_success' else 'return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};'
  assert body.count(ret)==1
  body=body.replace(ret, 'releaseCapacityLock(args.variables, log);\n  '+ret)
  plugin['inputsDB']['code']=(root/'capacity_lock.js').read_text()+'\n'+body
flow['flowPlugins'].append({'name':'Recheck original before replacement','sourceRepo':'Community','pluginName':'customFunction','version':'1.0.0','inputsDB':{'code':(root/'original_recheck.js').read_text()},'fpEnabled':True,'id':'original_recheck','position':{'x':1100,'y':300}})
for edge in flow['flowEdges']:
 if edge['source']=='arc_av1_monolithic' and edge['sourceHandle']=='1' and edge['target']=='replace_original': edge['target']='original_recheck'
flow['flowEdges'].extend([
 {'source':'original_recheck','sourceHandle':'1','target':'replace_original','targetHandle':None,'id':'edge_recheck_replace'},
 {'source':'original_recheck','sourceHandle':'2','target':'cleanup_failure','targetHandle':None,'id':'edge_recheck_failure'},
])
flow['_id']='ArcAV1_SinglePass_SafetyV3'
flow['name']=flow.get('name','Arc AV1')+' [Safety V3]'
flow['description']=(flow.get('description') or '')+'\nV3: video timeline/decode checks, track preservation, storage and original guards.'
out=root/'flow.json';fd=os.open(out,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
with os.fdopen(fd,'w') as f:json.dump(flow,f,ensure_ascii=False,indent=2);f.write('\n')
os.chmod(out,0o600)
print('Built separate Tdarr flow:',out,'plugins:',len(flow['flowPlugins']))
