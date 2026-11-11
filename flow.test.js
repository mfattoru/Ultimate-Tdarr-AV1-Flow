const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const flow=JSON.parse(fs.readFileSync(path.join(__dirname,'flow.json')));
const engine=flow.flowPlugins.find(p=>p.id==='arc_av1_monolithic').inputsDB.code;
const originalRecheck=flow.flowPlugins.find(p=>p.id==='original_recheck').inputsDB.code;

test('V15 export has its own identity and contains no embedded webhook credential',()=>{
 assert.equal(flow._id,'ArcAV1_SinglePass_UnattendedV15');
 assert.match(flow.name,/V15/);
 assert.ok(engine.includes('encoded_by=ArcAV1_QSV_V15'));
 assert.ok(engine.includes('process.env.TDARR_DISCORD_WEBHOOK'));
 assert.equal(engine.includes('https://discord.com/api/webhooks/'),false);
});

test('exported failure notifier explains an oversized audio DTS repair without claiming corruption',()=>{
 const notifier=flow.flowPlugins.find(p=>p.id==='notify_failure').inputsDB.code;
 assert.ok(notifier.includes('audio_timestamp_limit'));
 assert.ok(notifier.includes('does not confirm audio corruption'));
 assert.ok(notifier.includes('AV1 encoding did not start'));
});

test('V15 Arr plugin has no embedded production URLs or API keys',()=>{
 const action=flow.flowPlugins.find(p=>p.id==='notify_arr_iso').inputsDB.code;
 for(const name of ['TDARR_ARR_RADARR_URL','TDARR_ARR_RADARR_API_KEY','TDARR_ARR_SONARR_TV_URL','TDARR_ARR_SONARR_TV_API_KEY','TDARR_ARR_SONARR_ANIME_URL','TDARR_ARR_SONARR_ANIME_API_KEY']) {
  assert.ok(action.includes(name),`Arr target must be configurable through ${name}`);
 }
 assert.equal(action.includes('192.168.50.217'),false,'production Arr host must not be embedded');
 assert.equal(/apiKey\s*:\s*['"][^'"]{8,}['"]/.test(action),false,'Arr API keys must not be embedded');
});

test('all Arr flow nodes use environment configuration and retain the intended success rescan route',()=>{
 const codes=flow.flowPlugins.map(p=>String(p.inputsDB?.code||''));
 assert.equal(codes.some(code=>code.includes('192.168.50.217')),false,'no production Arr host may be embedded in any node');
 assert.equal(codes.some(code=>/apiKey\s*:\s*['"][^'"]{8,}['"]/.test(code)),false,'no Arr API key may be embedded in any node');
 const successArr=flow.flowPlugins.find(p=>p.id==='notify_arr').inputsDB.code;
 for(const name of ['TDARR_ARR_RADARR_URL','TDARR_ARR_RADARR_API_KEY','TDARR_ARR_SONARR_TV_URL','TDARR_ARR_SONARR_TV_API_KEY','TDARR_ARR_SONARR_ANIME_URL','TDARR_ARR_SONARR_ANIME_API_KEY']) {
  assert.ok(successArr.includes(name),`success rescan must use ${name}`);
 }
 assert.ok(flow.flowEdges.some(e=>e.source==='cleanup_success'&&e.target==='notify_arr'));
 assert.ok(flow.flowEdges.some(e=>e.source==='notify_arr'&&e.target==='discord_success'));
});

test('V15 engine performs full source and output scans without sampling branches',()=>{
 assert.equal(engine.includes('canUseSamplePrecheck'),false);
 assert.equal(engine.includes('sampleWindows'),false);
 assert.match(engine,/compareVideoTimestamps\(expected\.sourceFrameScan,\s*outputFrameScan\)/);
});

test('known Intel QSV HDR mastering clamp retries SVT only after strict QSV validation',()=>{
 assert.ok(engine.includes('const qsvHdrClampRetryEligible = isHdr && isQsvHdrMasteringClampRisk(hdrSource)'), 'the known source mastering range should gate only the narrow retry');
 assert.ok(engine.includes('let softwareHdrFallback = quarantinedCandidate?.kind === "svt_av1_encode"'), 'ordinary eligible files should start on the Arc QSV path');
 assert.ok(engine.includes('validateQsvWithSvtHdrClampFallback({'), 'the candidate must pass strict validation before fallback is considered');
 assert.ok(engine.includes('source:qsvHdrClampRetryEligible && !softwareHdrFallback ? hdrSource : null'), 'only the known source mastering range may qualify for the retry');
 assert.ok(engine.includes('identified Intel QSV AV1 green-y clamp'), 'the retry must require the exact validator diagnosis');
 assert.ok(engine.includes('"libsvtav1"'), 'the fallback must use the verified software AV1 encoder');
 assert.ok(engine.includes('"-preset", "8", "-crf", "28"'), 'the fallback quality settings must match the test-container sample');
 assert.ok(engine.includes('ArcAV1_SVTAV1_HDRFallback_V15'), 'software output needs a distinct idempotence marker');
 assert.ok(engine.includes('isKnownQsvHdrMasteringClamp'), 'strict validation should retain a narrow diagnostic for the known QSV clamp');
});

test('sparse subtitle streams cannot hold the mux queue without a time bound',()=>{
 assert.ok(engine.includes('"-max_interleave_delta", "10000000"'), 'use FFmpeg’s documented ten-second interleave bound');
 assert.ok(!engine.includes('"-max_interleave_delta", "0"'), 'zero would wait indefinitely for packets from every selected subtitle stream');
});

test('the shared decoder thread setting covers CPU decode work across the flow',()=>{
 assert.match(engine,/getDecodeThreadCount/);
 assert.ok((engine.match(/threads:getDecodeThreadCount\(\)/g)||[]).length>=2,'source and candidate frame scans must share the setting');
 for(const fragment of [
  'const audioDecode=withDecoderThreads(',
  'const args=withDecoderThreads([\'-v\',\'error\',\'-xerror\',\'-i\',source',
  'const decodeArgs=withDecoderThreads(',
  'withDecoderThreads([\n          "-v","error","-xerror"',
  'if ((useHybrid || useSoftwareFallback) && !forceStreamCopy) cmdArgs.push("-threads", String(getDecodeThreadCount()))',
  "'-threads',String(getDecodeThreadCount()),'-select_streams'",
  '"-threads",String(getDecodeThreadCount()),"-select_streams"'
 ]) assert.ok(engine.includes(fragment),`CPU decode path must use the shared decoder setting: ${fragment}`);
 const strictStart=engine.indexOf('async function verifyVideoTimeline');
 const strictEnd=engine.indexOf('const validateOutput',strictStart);
 const strictDecode=engine.slice(strictStart,strictEnd);
 assert.ok(strictDecode.includes("'-hwaccel','qsv'"),'strict candidate video decode must stay on Arc QSV');
 assert.ok(strictDecode.includes('withDecoderThreads('),'candidate audio and source fallback decodes must use CPU decoder threads');
 const packetTimeline=engine.slice(engine.indexOf('async function measureStreamTimeline'),engine.indexOf('const compareVideoTimestamps'));
 assert.equal(packetTimeline.includes('withDecoderThreads('),false,'packet-only timeline scans are demux work, not decoder work');
});

test('Mover identity changes require exact source-content verification before replacement',()=>{
 assert.ok(engine.includes('originalGuardFd=fs.openSync(originalPath,"r")'),'engine must retain a read-only original handle during processing');
 assert.ok(engine.includes('compareOpenFileToPath(originalGuardFd,originalPath)'),'engine must compare the retained source with the current path after identity drift');
 assert.ok(engine.includes('byte-for-byte identical'),'engine should classify only an exact content match as a Mover relocation');
 assert.ok(engine.includes('changed fields: ${changed.join'), 'changed source identity must remain explicit in diagnostics');
 assert.ok(engine.includes('finally {')&&engine.includes('closeSync(originalGuardFd)'),'the retained handle must close on every engine exit');
 assert.ok(originalRecheck.includes('hashFilePath(original)'),'pre-replacement recheck must verify a later relocation against the exact verified hash');
 assert.ok(originalRecheck.includes('byte comparison failed'),'a changed file at the same size and mtime must remain rejected');
});

test('strict candidate video decode uses configurable Arc QSV while audio stays on CPU',()=>{
 const begin=engine.indexOf('async function verifyVideoTimeline');
 const end=engine.indexOf('const validateOutput',begin);
 assert.ok(begin>=0&&end>begin,'strict timeline verifier is missing');
 const verifier=engine.slice(begin,end);
 for(const value of ['process.env.TDARR_ARC_DEVICE','/dev/dri/renderD129','-init_hw_device','qsv=hw@va','-hwaccel','qsv','-hwaccel_output_format','qsv']) {
  assert.ok(verifier.includes(value),`Arc strict video decode missing ${value}`);
 }
 assert.match(verifier,/const audioDecode\s*=\s*withDecoderThreads\(\['-v','error','-xerror'(?:,\s*'[^']*')*,\s*'-i',output/);
 assert.equal(verifier.includes('decode.push(\'-map\',`0:${dstIndex}`)'),false,'audio must not be merged into the QSV video decode');
});

test('PGS validation compares segments rather than container packet counts',()=>{
 assert.ok(engine.includes('verifyPgsSegments'),'missing PGS validation');
 assert.ok(engine.includes('hdmv_pgs_subtitle'),'missing PGS codec routing');
});

test('copied ASS/SSA packets use timestamp repair and bounded payload validation',()=>{
 const subtitleStart=engine.indexOf('if (c === "hdmv_pgs_subtitle"');
 const subtitleEnd=engine.indexOf('        }\n      }',subtitleStart);
 const subtitleCode=engine.slice(subtitleStart,subtitleEnd);
 assert.ok(engine.includes("['ass','ssa'].includes(c)"),'copied ASS/SSA streams must use monotonic timestamp repair');
 assert.equal(subtitleCode.includes('PREV_OUTPTS+1'),false,'timestamp normalization must preserve legal equal subtitle PTS instead of adding cumulative 1 ms drift');
 assert.equal(subtitleCode.includes('PREV_OUTDTS+1'),false,'timestamp normalization must preserve legal equal subtitle DTS instead of adding cumulative 1 ms drift');
 assert.ok(subtitleCode.includes('PREV_OUTPTS)'),'PTS clamp should only raise timestamps that go backward');
 assert.ok(subtitleCode.includes('PREV_OUTDTS)'),'DTS clamp should only raise timestamps that go backward');
 assert.ok(engine.includes('readSubtitlePackets'),'copied ASS/SSA output must be checked packet by packet');
 assert.ok(engine.includes('validateCopiedSubtitlePackets'),'missing bounded ASS/SSA timeline validation');
 assert.ok(engine.includes('maxRepairSeconds = 0.5'),'ASS/SSA timestamp repair limit must be 0.5 seconds');
 assert.ok(engine.includes('verifyPgsSegments'),'the existing PGS-specific validator must remain');
});

test('source audio DTS regressions get bounded strict repair while tie-only streams are passed through',()=>{
 assert.ok(engine.includes('MAX_AUDIO_TIMESTAMP_REPAIR_SECONDS'));
 assert.ok(engine.includes('analyzeAudioDtsTimeline'));
 assert.ok(engine.includes('audioTimestampRepairBsf'));
 assert.ok(engine.includes('Source audio timestamp repair'));
 assert.ok(engine.includes('timing.backwardSteps===0'));
 assert.ok(engine.includes('equal DTS transition(s) at time base'));
 assert.ok(engine.includes('these are preserved without repair'));
 assert.ok(engine.includes('outputDtsNonIncreasingCount'));
 assert.ok(engine.includes('candidate DTS is strictly increasing'));
 assert.ok(engine.includes('audio packet count differs'));
});

test('hybrid DV 8.1 and HDR10+ route strips both dynamic formats and validates HDR10',()=>{
 assert.ok(engine.includes('dovi81_hdr10plus_hdr10'));
 assert.ok(engine.includes('removeHdr10Plus:hdrClass==="hdr10plus_hdr10" || hdrClass==="dovi81_hdr10plus_hdr10"'));
 assert.ok(engine.includes('hdr10: hdrClass === "hdr10"') && engine.includes('hdrClass === "dovi81_hdr10plus_hdr10"'));
 assert.ok(engine.includes('Hybrid Dolby Vision 8.1 and HDR10+ to verified HDR10'));
});

test('whole-job lock is replaced by owned concurrent capacity reservations',()=>{
 assert.equal(engine.includes('await acquireCapacityLock('),false,'global job lock still present');
 assert.ok(engine.includes('await reserveCapacity('),'missing capacity reservation');
 for(const id of ['cleanup_success','cleanup_failure','cleanup_on_error']) {
  const code=flow.flowPlugins.find(p=>p.id===id).inputsDB.code;
  assert.ok(code.includes('await releaseCapacity('),`missing reservation release: ${id}`);
 }
});

test('source and output timelines are fully scanned with source and output interlace guards',()=>{
 assert.equal(engine.includes('canUseSamplePrecheck'),false,'sampled precheck must be removed');
 assert.equal(engine.includes('sampleWindows'),false,'sample window branches must be removed');
 const sourceScan=engine.indexOf('frameScan=await inspectVideoFrames(ffprobeBin,inputPath,mainVideo.index');
 const encode=engine.indexOf('runSingleQuality(');
 assert.ok(sourceScan>=0&&encode>sourceScan,'every eligible source must be fully scanned before encoding');
 const sourceAspectValidation=engine.search(/validateAspect\(mainVideo,\s*mainVideo,\s*false\)/);
 assert.ok(sourceAspectValidation>=0&&sourceAspectValidation<sourceScan,'source aspect metadata must be validated before the full frame scan');
 assert.ok(engine.includes('if (frameScan.interlaced) throw Error("Interlaced video frames are unsupported")'),'decoded interlaced source frames must remain held');
 assert.ok(engine.includes('if (order && ![\'progressive\',\'unknown\'].includes(order)) throw Error(\'Output has interlaced field order\')'),'encoded output field-order guard must remain');
});

test('canceled workers leave reclaimable reservations with job-owned scratch paths',()=>{
 assert.ok(engine.includes('heartbeatCapacityReservation'),'active reservations need a lease heartbeat');
 assert.ok(engine.includes('registerReservationWorkspace'),'the lease must identify only its own scratch directory');
 assert.ok(engine.includes('const staleHeartbeat=expired || missingLease;'),'a dead plugin PID alone must not reclaim a candidate used by downstream nodes');
 assert.ok(engine.includes('if (!staleHeartbeat || (sameHost && workerAlive)) continue;'),'same-host reclamation must require both an expired heartbeat and an exited worker');
 assert.ok(engine.includes('reservationStaleAfterMs'),'orphan cleanup needs a bounded lease');
 assert.ok(engine.includes('trackReservationChild'),'nested FFmpeg/FFprobe processes must be tracked');
 assert.ok(engine.includes('detached:true'),'process groups must be killable when Tdarr cancels the worker');
 for(const id of ['cleanup_success','cleanup_failure','cleanup_on_error']) assert.ok(flow.flowPlugins.find(p=>p.id===id).inputsDB.code.includes('await releaseCapacity('));
});

test('controlled and unexpected failures both pass through deduplicated alerts',()=>{
 const has=(a,b)=>flow.flowEdges.some(e=>e.source===a&&e.target===b);
 assert.ok(has('cleanup_failure','notify_arr_iso'));
 assert.ok(has('notify_arr_iso','notify_failure'));
 assert.ok(has('notify_failure','fail_flow'));
 assert.ok(has('cleanup_on_error','notify_failure_on_error'));
 assert.equal(flow.flowEdges.some(e=>e.source==='notify_failure_on_error'&&e.target==='fail_flow'),false);
});

test('ISO deletion uses the central notifier after the Arr scan without marking a delivery prematurely',()=>{
 assert.ok(flow.flowEdges.some(e=>e.source==='notify_arr_iso'&&e.target==='notify_failure'));
 assert.equal(engine.includes('failure_notified=true; // ISO deletion'),false);
});

test('RAM-backed caches are not admitted using only tmpfs free-space estimates',()=>{
 assert.equal(engine.includes('TDARR_USE_RAM_CACHE'),false);
 assert.ok(engine.includes('16914836n'),'missing tmpfs filesystem check');
});

test('frame timestamp comparison supplies the count check without a second full frame decode',()=>{
 const validation=engine.slice(engine.indexOf('const validateOutput'),engine.indexOf('const getFreeSpaceMB'));
 assert.ok(engine.includes('compareVideoTimestamps(expected.sourceFrameScan,outputFrameScan)'));
 assert.ok(engine.includes('a.length!==b.length'),'timestamp comparison must reject frame-count changes');
 assert.ok(validation.includes('if (!expected.sourceFrameScan) {'),'fallback count must run only when no source frame scan exists');
 assert.ok(validation.includes('const countFrames = (file, index)'),'missing fallback frame count');
});

test('failure plugin uses a processing category instead of its testing defaults',()=>{
 const node=flow.flowPlugins.find(p=>p.id==='fail_flow');
 assert.equal(node.inputsDB.failureCategory,'custom');
 assert.equal(node.inputsDB.customCategoryName,'transcode');
 assert.equal(node.inputsDB.analyzeVariables,false);
});
