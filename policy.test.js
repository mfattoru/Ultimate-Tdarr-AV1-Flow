const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const flow = JSON.parse(fs.readFileSync(path.join(__dirname, 'flow.json')));
const engine = flow.flowPlugins.find(p => p.id === 'arc_av1_monolithic').inputsDB.code;
const mod = {exports:{}};
new Function('require','module','exports',engine + '\nmodule.exports.testPolicy = typeof selectQualityValue === "function" ? selectQualityValue : null; module.exports.testRun = typeof runSingleQuality === "function" ? runSingleQuality : null; module.exports.testDone = typeof isCompletedEncode === "function" ? isCompletedEncode : null; module.exports.testClassify = typeof classifyVideo === "function" ? classifyVideo : null; module.exports.testHdr = typeof validateHdr10 === "function" ? validateHdr10 : null; module.exports.testColor = typeof validateSdrColor === "function" ? validateSdrColor : null; module.exports.testVideoGuard = typeof guardSourceVideo === "function" ? guardSourceVideo : null; module.exports.testQsvDecode = typeof useQsvDecode === "function" ? useQsvDecode : null; module.exports.testAspect = typeof validateAspect === "function" ? validateAspect : null; module.exports.testHdrRoute = typeof determineHdrRoute === "function" ? determineHdrRoute : null; module.exports.testHybridPreflight = typeof preflightHybridHdr === "function" ? preflightHybridHdr : null; module.exports.testMergeHdr = typeof mergeHdrMetadata === "function" ? mergeHdrMetadata : null; module.exports.testRecordFrame = typeof recordHdrFrame === "function" ? recordHdrFrame : null; module.exports.testScanFrames = typeof inspectVideoFrames === "function" ? inspectVideoFrames : null; module.exports.testDecodeThreads = typeof getDecodeThreadCount === "function" ? getDecodeThreadCount : null; module.exports.testFrameScanArgs = typeof buildFrameScanArguments === "function" ? buildFrameScanArguments : null; module.exports.testWithDecoderThreads = typeof withDecoderThreads === "function" ? withDecoderThreads : null; module.exports.testL6 = typeof parseDolbyLevel6 === "function" ? parseDolbyLevel6 : null; module.exports.testCompareTimes = typeof compareVideoTimestamps === "function" ? compareVideoTimestamps : null; module.exports.testHlg = typeof validateHlg === "function" ? validateHlg : null; module.exports.testProcess = typeof runTimelineProcess === "function" ? runTimelineProcess : null; module.exports.testSdrSignal = typeof isVerifiedSdr === "function" ? isVerifiedSdr : null; module.exports.testL6Rows = typeof summarizeLevel6Rows === "function" ? summarizeLevel6Rows : null; module.exports.testResolveLight = typeof resolveHdrLight === "function" ? resolveHdrLight : null; module.exports.testHdrFrameRequirements = typeof hdrFrameMetadataRequirements === "function" ? hdrFrameMetadataRequirements : null; module.exports.testHdrStatic = typeof checkHdrFrameStatic === "function" ? checkHdrFrameStatic : null; module.exports.testVideoFilter = typeof composeVideoFilterChain === "function" ? composeVideoFilterChain : null; module.exports.testSdrTransfer = typeof validateEffectiveSdrTransfer === "function" ? validateEffectiveSdrTransfer : null; module.exports.testSdrSource = typeof effectiveSdrSource === "function" ? effectiveSdrSource : null; module.exports.testUntagged = typeof isUntaggedVideo === "function" ? isUntaggedVideo : null; module.exports.testUntaggedOutput = typeof validateUntaggedOutput === "function" ? validateUntaggedOutput : null; module.exports.testUntaggedRange = typeof inferUntaggedColorRange === "function" ? inferUntaggedColorRange : null; module.exports.testUntaggedRangeArgs = typeof untaggedColorRangeArgs === "function" ? untaggedColorRangeArgs : null; module.exports.testFreeSpace = typeof getFreeSpaceMB === "function" ? getFreeSpaceMB : null;')(require,mod,mod.exports);
const p=mod.exports;

test('decoder thread setting defaults to four, prefers the shared setting, and accepts the legacy alias',()=>{
  assert.equal(typeof p.testDecodeThreads,'function','decoder thread policy is missing');
  const previousDecode=process.env.TDARR_DECODE_THREADS,previousPrecheck=process.env.TDARR_PRECHECK_THREADS;
  try {
    delete process.env.TDARR_DECODE_THREADS;delete process.env.TDARR_PRECHECK_THREADS;
    assert.equal(p.testDecodeThreads(),4);
    process.env.TDARR_PRECHECK_THREADS='2';assert.equal(p.testDecodeThreads(),2);
    process.env.TDARR_DECODE_THREADS='4';assert.equal(p.testDecodeThreads(),4);
    process.env.TDARR_DECODE_THREADS='16';assert.equal(p.testDecodeThreads(),16);
    for(const invalid of ['0','17','2.5','auto','']) {
      process.env.TDARR_DECODE_THREADS=invalid;
      assert.throws(()=>p.testDecodeThreads(),/integer from 1 to 16/);
    }
  } finally {
    if(previousDecode===undefined)delete process.env.TDARR_DECODE_THREADS;else process.env.TDARR_DECODE_THREADS=previousDecode;
    if(previousPrecheck===undefined)delete process.env.TDARR_PRECHECK_THREADS;else process.env.TDARR_PRECHECK_THREADS=previousPrecheck;
  }
});

test('every frame scan defaults to the configured decoder thread count',()=>{
  assert.equal(typeof p.testFrameScanArgs,'function','frame scan argument builder is missing');
  const previous=process.env.TDARR_DECODE_THREADS,previousLegacy=process.env.TDARR_PRECHECK_THREADS;
  try {
    delete process.env.TDARR_DECODE_THREADS;delete process.env.TDARR_PRECHECK_THREADS;
    const argv=p.testFrameScanArgs('/media/example.mkv',0);
    assert.deepEqual(argv.slice(0,7),['-v','error','-threads','4','-select_streams','0','-show_frames']);
    const explicit=p.testFrameScanArgs('/media/example.mkv',0,2);
    assert.deepEqual(explicit.slice(0,7),['-v','error','-threads','2','-select_streams','0','-show_frames']);
    assert.equal(argv.at(-1),'/media/example.mkv');
  } finally {
    if(previous===undefined)delete process.env.TDARR_DECODE_THREADS;else process.env.TDARR_DECODE_THREADS=previous;
    if(previousLegacy===undefined)delete process.env.TDARR_PRECHECK_THREADS;else process.env.TDARR_PRECHECK_THREADS=previousLegacy;
  }
});

test('FFmpeg decoder threads are inserted before the input and preserve other options',()=>{
  assert.equal(typeof p.testWithDecoderThreads,'function','FFmpeg decoder argument helper is missing');
  const args=['-v','error','-progress','pipe:1','-i','/media/example.mkv','-map','0:1','-f','null','-'];
  assert.deepEqual(p.testWithDecoderThreads(args,4),['-v','error','-progress','pipe:1','-threads','4','-i','/media/example.mkv','-map','0:1','-f','null','-']);
  assert.throws(()=>p.testWithDecoderThreads(['-v','error'],4),/input argument/);
  assert.throws(()=>p.testWithDecoderThreads(['-v','error','-threads','-i','/media/example.mkv'],4),/missing its value/);
  assert.throws(()=>p.testWithDecoderThreads(args,0),/integer from 1 to 16/);
});

test('default FFmpeg decode arguments use four threads before the input',()=>{
  const previous=process.env.TDARR_DECODE_THREADS,previousLegacy=process.env.TDARR_PRECHECK_THREADS;
  try {
    delete process.env.TDARR_DECODE_THREADS;delete process.env.TDARR_PRECHECK_THREADS;
    const args=p.testWithDecoderThreads(['-v','error','-i','/media/example.mkv']);
    assert.deepEqual(args,['-v','error','-threads','4','-i','/media/example.mkv']);
  } finally {
    if(previous===undefined)delete process.env.TDARR_DECODE_THREADS;else process.env.TDARR_DECODE_THREADS=previous;
    if(previousLegacy===undefined)delete process.env.TDARR_PRECHECK_THREADS;else process.env.TDARR_PRECHECK_THREADS=previousLegacy;
  }
});

test('uses one global ICQ for every resolution and color class',()=>{
  assert.equal(typeof p.testPolicy,'function','quality policy is missing');
  assert.equal(p.testPolicy(),22);
  assert.equal(p.testPolicy({width:720,height:480,isHdr:false}),22);
  assert.equal(p.testPolicy({width:3840,height:2160,isHdr:true}),22);
});

test('runs one encode at the selected quality and accepts a smaller result',async()=>{
  assert.equal(typeof p.testRun,'function','bounded retry policy is missing');
  const called=[];
  const result=await p.testRun(22,100,q=>{called.push(q);return {ok:true,size:99};});
  assert.deepEqual(called,[22]);assert.equal(result.quality,22);assert.equal(result.ok,true);
});

test('a non-shrinking output returns to the caller after one encode',async()=>{
  assert.equal(typeof p.testRun,'function','bounded retry policy is missing');
  const calls=[];
  const tooLarge=await p.testRun(22,100,q=>{calls.push(q);return {ok:true,size:101};});
  assert.equal(tooLarge.ok,false);assert.equal(tooLarge.reason,'quality_floor');assert.deepEqual(calls,[22]);
  const error=await p.testRun(22,100,q=>{calls.push(q);return {ok:false};});
  assert.equal(error.ok,false);assert.deepEqual(calls,[22,22]);
});

test('quality may be configured for the whole worker, never per resolution',()=>{
  const previous=process.env.TDARR_QSV_ICQ;
  try {
    process.env.TDARR_QSV_ICQ='24';assert.equal(p.testPolicy(),24);
    process.env.TDARR_QSV_ICQ='24x';assert.throws(()=>p.testPolicy(),/integer from 1 to 51/);
  } finally { if(previous===undefined)delete process.env.TDARR_QSV_ICQ;else process.env.TDARR_QSV_ICQ=previous; }
});

test('only current-version AV1 output bypasses a new encode',()=>{
  assert.equal(typeof p.testDone,'function','completion marker policy is missing');
  assert.equal(p.testDone('av1',{'ENCODED_BY':'ArcAV1_QSV_V9'}),true);
  assert.equal(p.testDone('av1',{'ENCODED_BY':'ArcAV1_QSV_V8'}),true);
  assert.equal(p.testDone('av1',{'ENCODED_BY':'ArcAV1_QSV_V7'}),true);
  assert.equal(p.testDone('av1',{'ENCODED_BY':'ArcAV1_QSV_V4'}),true);
  assert.equal(p.testDone('av1',{'ENCODED_BY':'ArcAV1_QSV'}),false);
  assert.equal(p.testDone('av1',{'ENCODED_BY':'ArcAV1_QSV_V4_extra'}),false);
  assert.equal(p.testDone('hevc',{'ENCODED_BY':'ArcAV1_QSV_V4'}),false);
});



test('HDR classification blocks Dolby Vision and ambiguous color tags',()=>{
  assert.equal(typeof p.testClassify,'function','HDR classifier missing');
  const pq={color_primaries:'bt2020',color_transfer:'smpte2084',color_space:'bt2020nc'};
  assert.equal(p.testClassify(pq,{HDR_Format:'Dolby Vision / SMPTE ST 2086',HDR_Format_Compatibility:'HDR10'}),'unsupported');
  assert.equal(p.testClassify(pq,{}),'unsupported');
  assert.equal(p.testClassify(pq,{HDR_Format:'SMPTE ST 2086',HDR_Format_Compatibility:'HDR10'}),'hdr10');
  assert.equal(p.testClassify({color_transfer:'bt709'},{}),'sdr');
});

test('verified Dolby Vision 8.1 plus HDR10+ uses its compatible HDR10 base layer',()=>{
  assert.equal(typeof p.testHdrRoute,'function');
  const dovi={side_data_type:'DOVI configuration record',dv_profile:8,dv_level:6,
    rpu_present_flag:1,el_present_flag:0,bl_present_flag:1,dv_bl_signal_compatibility_id:1};
  const video={codec_name:'hevc',color_range:'tv',color_primaries:'bt2020',
    color_transfer:'smpte2084',color_space:'bt2020nc',side_data_list:[dovi]};
  const info={HDR_Format:'Dolby Vision / SMPTE ST 2094 App 4',
    HDR_Format_Compatibility:'HDR10 / HDR10+ Profile B',colour_range:'Limited'};
  const scan={frames:1,interlaced:0,dovi:1,hdr10plus:1,otherDynamic:0};
  assert.equal(p.testHybridPreflight(video,info),'dovi81_hdr10plus_candidate');
  assert.equal(p.testHybridPreflight(video,{HDR_Format:'Dolby Vision',HDR_Format_Compatibility:'HDR10'}),'not_hybrid');
  assert.throws(()=>p.testHybridPreflight({...video,side_data_list:[{...dovi,dv_profile:5}]},info),/not verified/);
  assert.throws(()=>p.testHybridPreflight({...video,color_range:'pc'},info),/not verified/);
  assert.equal(p.testHdrRoute(video,info,scan),'dovi81_hdr10plus_hdr10');
  assert.throws(()=>p.testHdrRoute(video,info,{...scan,hdr10plus:0}),/HDR10\+ signaling is not verified/);
  assert.throws(()=>p.testHdrRoute({...video,side_data_list:[{...dovi,dv_profile:5}]},info,scan),/not verified|incomplete/i);
  assert.throws(()=>p.testHdrRoute({...video,color_transfer:'bt709'},info,scan),/color|not verified/i);
});

test('free-text title does not turn a verified Dolby Vision 8.1 and HDR10+ hybrid into unsupported dynamic HDR',()=>{
 const dovi={side_data_type:'DOVI configuration record',dv_profile:8,dv_level:6,
  rpu_present_flag:1,el_present_flag:0,bl_present_flag:1,dv_bl_signal_compatibility_id:1};
 const video={codec_name:'hevc',color_range:'tv',color_primaries:'bt2020',
  color_transfer:'smpte2084',color_space:'bt2020nc',side_data_list:[dovi]};
 const info={HDR_Format:'Dolby Vision / SMPTE ST 2094 App 4',
  HDR_Format_Compatibility:'HDR10 / HDR10+ Profile B',
  Title:'HEVC video / Dolby Vision BL+RPU / HDR10 compatible / SMPTE ST 2094 HDR10+ Profile B'};
 const scan={frames:1,interlaced:0,dovi:1,hdr10plus:1,otherDynamic:0};
 assert.equal(p.testHdrRoute(video,info,scan),'dovi81_hdr10plus_hdr10');
});

test('verified Dolby Vision Profile 7 and HDR10+ can use the HDR10-compatible base layer',()=>{
 const dovi={side_data_type:'DOVI configuration record',dv_profile:7,dv_level:6,
  rpu_present_flag:1,el_present_flag:1,bl_present_flag:1,dv_bl_signal_compatibility_id:6};
 const video={codec_name:'hevc',color_range:'tv',color_primaries:'bt2020',
  color_transfer:'smpte2084',color_space:'bt2020nc',side_data_list:[dovi]};
 const info={HDR_Format:'Dolby Vision / SMPTE ST 2094 App 4',
  HDR_Format_Compatibility:'Blu-ray / HDR10+ Profile B'};
 const scan={frames:1,interlaced:0,dovi:1,hdr10plus:1,otherDynamic:0};
 assert.equal(p.testHybridPreflight(video,info),'dovi7_hdr10plus_candidate');
 assert.equal(p.testHdrRoute(video,info,scan),'dovi7_hdr10plus_hdr10');
 assert.throws(()=>p.testHdrRoute({...video,side_data_list:[{...dovi,dv_bl_signal_compatibility_id:1}]},info,scan),/verified HDR10-compatible base layer/i);
});

test('HDR10 validation requires unchanged PQ colors and static metadata',()=>{
  assert.equal(typeof p.testHdr,'function','HDR10 output validation missing');
  const mastering={side_data_type:'Mastering display metadata',red_x:'17/25',red_y:'8/25',green_x:'53/200',green_y:'69/100',blue_x:'3/20',blue_y:'3/50',white_point_x:'3127/10000',white_point_y:'329/1000',min_luminance:'1/200',max_luminance:'1000/1'};
  const light={side_data_type:'Content light level metadata',max_content:1000,max_average:250};
  const v={color_primaries:'bt2020',color_transfer:'smpte2084',color_space:'bt2020nc',color_range:'tv',side_data_list:[mastering,light]};
  assert.doesNotThrow(()=>p.testHdr(v,v));
  assert.throws(()=>p.testHdr(v,{...v,color_transfer:'bt709'}),/color/i);
  assert.throws(()=>p.testHdr(v,{...v,side_data_list:[mastering]}),/metadata/i);
  assert.throws(()=>p.testHdr(v,{...v,side_data_list:[mastering,{...light,max_content:400}]}),/metadata/i);
});

test('verified HDR10 may omit source static metadata without fabricating output values',()=>{
 const color={color_primaries:'bt2020',color_transfer:'smpte2084',color_space:'bt2020nc',color_range:'tv'};
 const mastering={side_data_type:'Mastering display metadata',red_x:'17/25',red_y:'8/25',green_x:'53/200',green_y:'69/100',blue_x:'3/20',blue_y:'3/50',white_point_x:'3127/10000',white_point_y:'329/1000',min_luminance:'1/200',max_luminance:'1000/1'};
 const light={side_data_type:'Content light level metadata',max_content:1000,max_average:250};
 assert.doesNotThrow(()=>p.testHdr({...color,side_data_list:[]},{...color,side_data_list:[]}));
 assert.doesNotThrow(()=>p.testHdr({...color,side_data_list:[mastering]},{...color,side_data_list:[mastering]}));
 assert.doesNotThrow(()=>p.testHdr({...color,side_data_list:[light]},{...color,side_data_list:[light]}));
 assert.throws(()=>p.testHdr({...color,side_data_list:[mastering]},{...color,side_data_list:[]}),/metadata missing/i);
 assert.throws(()=>p.testHdr({...color,side_data_list:[]},{...color,side_data_list:[light]}),/metadata added/i);
});

test('already-processed output notifies then reaches a non-replacement terminal',()=>{
  const edge=flow.flowEdges.find(e=>e.source==='arc_av1_monolithic' && e.sourceHandle==='4');
  assert.ok(edge,'completion output is unconnected');
  assert.equal(edge.target,'already_completed');
  assert.ok(flow.flowEdges.some(e=>e.source==='already_completed'&&e.target==='handled_end'),'already-processed notice must reach a handled terminal');
  assert.equal(flow.flowEdges.some(e=>e.source==='handled_end'),false,'handled terminal must not continue to replacement');
});

test('successful output validation rejects a missing V6 completion marker',async()=>{
  const child=require('node:child_process'),os=require('node:os');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v4-marker-')), file=path.join(dir,'test.mkv');
  try {
    child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=12:duration=2','-c:v','libsvtav1','-preset','12','-svtav1-params','lp=1:log-level=0','-y',file],{stdio:'ignore'});
    const m={exports:{}}; new Function('require','module','exports',engine+'\nmodule.exports.testValidate = validateOutput;')(require,m,m.exports);
    await assert.rejects(()=>m.exports.testValidate('ffprobe',file,file,{codec:'av1',audio:0,subtitle:0,sourceVideoIndex:0,audioIndices:[],subtitleIndices:[],requireMarker:true}),/marker/i);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('unknown color signaling is not assumed to be SDR',()=>{
  assert.equal(p.testClassify({},{}),'unsupported');
  assert.equal(p.testClassify({color_transfer:'bt709',color_primaries:'bt709',color_space:'bt709'},{}),'sdr');
});

test('validation detects a missing interior video frame',async()=>{
  const child=require('node:child_process'),os=require('node:os');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v4-frames-')), source=path.join(dir,'source.mkv'),out=path.join(dir,'out.mkv');
  try {
    child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=12:duration=2','-c:v','libx264','-y',source],{stdio:'ignore'});
    child.execFileSync('ffmpeg',['-v','error','-i',source,'-vf','select=not(eq(n\\,10))','-fps_mode','vfr','-c:v','libx264','-y',out],{stdio:'ignore'});
    const m={exports:{}};new Function('require','module','exports',engine+'\nmodule.exports.testValidate=validateOutput;')(require,m,m.exports);
    await assert.rejects(()=>m.exports.testValidate('ffprobe',source,out,{codec:'h264',audio:0,subtitle:0,sourceVideoIndex:0,audioIndices:[],subtitleIndices:[]}),/frame count/i);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


test('validation rejects a change to an explicitly signaled SDR transfer',()=>{
  assert.equal(typeof p.testColor,'function');
  const source={color_transfer:'bt709',color_primaries:'bt709',color_space:'bt709',color_range:'tv'};
  assert.doesNotThrow(()=>p.testColor(source,{...source}));
  assert.throws(()=>p.testColor(source,{...source,color_transfer:'smpte2084'}),/color/i);
  assert.throws(()=>p.testColor(source,{...source,color_primaries:undefined}),/color/i);
});

test('source video guard prevents unsupported chroma, depth and interlace loss',()=>{
 assert.equal(typeof p.testVideoGuard,'function');
 assert.doesNotThrow(()=>p.testVideoGuard({pix_fmt:'yuv420p10le',field_order:'progressive'}));
 assert.throws(()=>p.testVideoGuard({pix_fmt:'rgb24',field_order:'progressive'}),/pixel/i);
 assert.doesNotThrow(()=>p.testVideoGuard({pix_fmt:'yuv420p12le',field_order:'progressive'}));
 assert.throws(()=>p.testVideoGuard({pix_fmt:'yuv420p16le',field_order:'progressive'}),/pixel/i);
 assert.throws(()=>p.testVideoGuard({pix_fmt:'yuv420p',field_order:'tt'}),/interlac/i);
});

test('source guard admits supported 8-10-bit 422 and 444 formats for explicit 420 downsampling',()=>{
 const formats=['yuv422p','yuv422p9le','yuv422p10le','yuv444p','yuv444p9le','yuv444p10le','yuvj422p','yuvj444p'];
 for(const pix_fmt of formats) assert.doesNotThrow(()=>p.testVideoGuard({pix_fmt,field_order:'progressive'}),pix_fmt);
 for(const pix_fmt of ['yuv422p16le','yuv444p16le','yuv420p16le','rgb24','gbrp','yuva444p10le']) {
  assert.throws(()=>p.testVideoGuard({pix_fmt,field_order:'progressive'}),/pixel|depth/i,pix_fmt);
 }
});

test('source guard accepts only explicit 12-bit planar YUV inputs for SDR conversion',()=>{
 for(const pix_fmt of ['yuv420p12le','yuv422p12le','yuv444p12le']) assert.doesNotThrow(()=>p.testVideoGuard({pix_fmt,field_order:'progressive'}),pix_fmt);
 for(const pix_fmt of ['yuv420p12be','yuv422p12be','yuv444p12be']) assert.throws(()=>p.testVideoGuard({pix_fmt,field_order:'progressive'}),/pixel/i,pix_fmt);
 assert.throws(()=>p.testVideoGuard({pix_fmt:'yuv420p12le',bits_per_raw_sample:16,field_order:'progressive'}),/depth/i);
});

test('only known Arc QSV decode profiles use hardware decode; other codecs retain Arc encode via CPU decode',()=>{
 assert.equal(typeof p.testQsvDecode,'function');
 for(const video of [
  {codec_name:'h264',pix_fmt:'yuv420p'},
  {codec_name:'hevc',pix_fmt:'yuv420p10le'},
  {codec_name:'av1',pix_fmt:'p010le'}
 ]) assert.equal(p.testQsvDecode(video),true,`${video.codec_name}/${video.pix_fmt}`);
 for(const video of [
  {codec_name:'h264',pix_fmt:'yuv420p10le'},
  {codec_name:'vp9',pix_fmt:'yuv420p'},
  {codec_name:'mpeg2video',pix_fmt:'yuv420p'},
  {codec_name:'prores',pix_fmt:'yuv422p10le'},
  {codec_name:'hevc',pix_fmt:'yuv420p9le'}
 ]) assert.equal(p.testQsvDecode(video),false,`${video.codec_name}/${video.pix_fmt}`);
});

test('output keeps an explicitly signaled sample aspect ratio',()=>{
 assert.equal(typeof p.testAspect,'function');
 assert.doesNotThrow(()=>p.testAspect({sample_aspect_ratio:'4:3'},{sample_aspect_ratio:'8:6'}));
 assert.throws(()=>p.testAspect({sample_aspect_ratio:'4:3'},{sample_aspect_ratio:'1:1'}),/aspect/i);
});

test('missing source SAR uses the FFmpeg 1:1 default only when output geometry is unchanged',()=>{
 assert.doesNotThrow(()=>p.testAspect({width:1920,height:1040},{width:1920,height:1040,sample_aspect_ratio:'1:1'}));
 assert.throws(()=>p.testAspect({width:1920,height:1040},{width:1920,height:1040,sample_aspect_ratio:'4:3'}),/aspect/i);
 assert.throws(()=>p.testAspect({width:1920,height:1040},{width:1280,height:720,sample_aspect_ratio:'1:1'}),/aspect/i);
});

test('source field-order tags are not reused as output metadata after the full source scan',()=>{
 const taggedInterlaced={sample_aspect_ratio:'1:1',field_order:'tb'};
 assert.doesNotThrow(()=>p.testAspect(taggedInterlaced,taggedInterlaced,false));
 assert.throws(()=>p.testAspect(taggedInterlaced,{sample_aspect_ratio:'1:1',field_order:'tb'}),/interlaced/i);
});

test('ambiguous field order and unknown source aspect ratio are held',()=>{
  assert.throws(()=>p.testVideoGuard({codec_name:'h264',pix_fmt:'yuv420p',field_order:'unknown'}),/field order/i);
  assert.doesNotThrow(()=>p.testVideoGuard({codec_name:'av1',pix_fmt:'yuv420p',field_order:'unknown'}));
  assert.throws(()=>p.testAspect({sample_aspect_ratio:'N/A'},{sample_aspect_ratio:'1:1'}),/aspect/i);
});


const pqVideo={codec_name:'hevc',color_transfer:'smpte2084',color_primaries:'bt2020',color_space:'bt2020nc',color_range:'tv'};
const plainInfo={HDR_Format:'SMPTE ST 2086',HDR_Format_Compatibility:'HDR10'};
const pqScan={frames:100,interlaced:0,dovi:0,hdr10plus:0,otherDynamic:0};
const dvConfig={side_data_type:'DOVI configuration record',dv_profile:8,dv_bl_signal_compatibility_id:1,bl_present_flag:1,rpu_present_flag:1,el_present_flag:0};

test('identifies static HDR10 and a compatible Dolby Vision base layer',()=>{
 assert.equal(typeof p.testHdrRoute,'function','HDR and Dolby routing missing');
 assert.equal(p.testHdrRoute(pqVideo,plainInfo,pqScan),'hdr10');
 assert.equal(p.testHdrRoute({...pqVideo,side_data_list:[dvConfig]}, {HDR_Format:'Dolby Vision / SMPTE ST 2086',HDR_Format_Compatibility:'HDR10 / HDR10'}, {...pqScan,dovi:100}),'dovi81_hdr10');
});

test('rejects Dolby profiles or signal conflicts without an HDR10-compatible base',()=>{
 assert.equal(typeof p.testHdrRoute,'function');
 const route=side=>p.testHdrRoute({...pqVideo,side_data_list:[side]}, {HDR_Format:'Dolby Vision'}, {...pqScan,dovi:100});
 assert.throws(()=>route({...dvConfig,dv_profile:5,dv_bl_signal_compatibility_id:0}),/Dolby/i);
 assert.throws(()=>route({...dvConfig,dv_bl_signal_compatibility_id:4}),/Dolby/i);
 assert.throws(()=>route({...dvConfig,el_present_flag:1}),/Dolby/i);
 assert.throws(()=>p.testHdrRoute({...pqVideo,color_transfer:'bt709',side_data_list:[dvConfig]}, {HDR_Format:'Dolby Vision'}, {...pqScan,dovi:100}),/color/i);
});

test('rejects hidden Dolby Vision and interlaced HDR',()=>{
 assert.equal(typeof p.testHdrRoute,'function');
 assert.throws(()=>p.testHdrRoute(pqVideo,plainInfo,{...pqScan,dovi:3}),/Dolby/i);
 assert.equal(p.testHdrRoute(pqVideo,{HDR_Format:'HDR10+ / SMPTE ST 2086'},{...pqScan,hdr10plus:2}),'hdr10plus_hdr10');
 assert.throws(()=>p.testHdrRoute(pqVideo,plainInfo,{...pqScan,interlaced:1}),/interlac/i);
});

test('uses frame-level HDR10 mastering and light metadata when stream metadata is absent',()=>{
 assert.equal(typeof p.testMergeHdr,'function');
 const mastering={side_data_type:'Mastering display metadata',red_x:'17/25'};
 const light={side_data_type:'Content light level metadata',max_content:1000,max_average:250};
 assert.deepEqual(p.testMergeHdr(pqVideo,[{side_data_list:[mastering,light]}]).side_data_list,[mastering,light]);
 assert.throws(()=>p.testMergeHdr(pqVideo,[{side_data_list:[mastering]}]),/metadata/i);
});


test('the frame scanner detects hidden HDR metadata and interlaced frames',()=>{
 assert.equal(typeof p.testRecordFrame,'function');
 const scan={frames:0,interlaced:0,dovi:0,hdr10plus:0,otherDynamic:0};
 p.testRecordFrame('interlaced_frame=0|side_data_type=Dolby Vision RPU Data',scan);
 p.testRecordFrame('interlaced_frame=1|side_data_type=HDR Dynamic Metadata SMPTE2094-40 (HDR10+)',scan);
 assert.deepEqual(scan,{frames:2,interlaced:1,dovi:1,hdr10plus:1,otherDynamic:0});
});

test('frame inspection uses real ffprobe output and counts decoded frames',async()=>{
 assert.equal(typeof p.testScanFrames,'function');
 const child=require('node:child_process'),os=require('node:os');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v5-frames-')),file=path.join(dir,'test.mkv');
 try {
   child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=12:duration=2','-c:v','libx264','-y',file],{stdio:'ignore'});
   assert.deepEqual(await p.testScanFrames('ffprobe',file,0),{frames:24,interlaced:0,dovi:0,hdr10plus:0,otherDynamic:0});
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('frame scanning reports progress when its expected frame count is known',async()=>{
 assert.equal(typeof p.testScanFrames,'function');
 const child=require('node:child_process'),os=require('node:os');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v12-frame-progress-')),file=path.join(dir,'test.mkv');
 try {
  child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=12:duration=2','-c:v','libx264','-y',file],{stdio:'ignore'});
  const updates=[];
  const scan=await p.testScanFrames('ffprobe',file,0,{expectedFrames:24,onProgress:(frames,total,complete,fps)=>updates.push({frames,total,complete,fps})});
  assert.equal(scan.frames,24);
  assert.ok(updates.length>=2,'scan should report during the scan and on completion');
  assert.ok(updates.every(x=>x.total===24&&x.frames<=24));
  assert.equal(updates.at(-1).complete,true);
  assert.equal(updates.at(-1).frames,24);
  assert.ok(Number.isFinite(updates.at(-1).fps)&&updates.at(-1).fps>0,'precheck scan should report measured frames per second');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('full frame scan at non-integer frame rate detects a frame loss near the end',async()=>{
 assert.equal(typeof p.testScanFrames,'function');
 const child=require('node:child_process'),os=require('node:os');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v15-full-timeline-'));
 const file=path.join(dir,'long-gop-source.mkv'),damaged=path.join(dir,'one-frame-missing-near-end.mkv');
 try {
  child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=24000/1001:duration=60','-an','-c:v','libx264','-preset','ultrafast','-g','240','-keyint_min','240','-sc_threshold','0','-y',file],{stdio:'ignore'});
  child.execFileSync('ffmpeg',['-v','error','-i',file,'-vf','select=not(eq(n\\,1000))','-fps_mode','passthrough','-an','-c:v','libx264','-preset','ultrafast','-y',damaged],{stdio:'ignore'});
  const source=await p.testScanFrames('ffprobe',file,0,{timestamps:true,sampleWindows:[{start:0,duration:5},{start:30,duration:5},{start:55,duration:5}]});
  const output=await p.testScanFrames('ffprobe',damaged,0,{timestamps:true});
  assert.equal(source.frames,source.timestamps.length);
  assert.ok(source.frames>1400);
  assert.ok(source.timestamps.at(-1)-source.timestamps[0]>58,'scan must reach the tail beyond sampled windows');
  assert.equal(source.sampleWindows,undefined);
  assert.throws(()=>p.testCompareTimes(source,output),/frame count differs|timestamp/i);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('postcheck decode progress derives FPS from FFmpeg frame deltas when fps is zero',async()=>{
 const script=`console.log('frame=100\\nout_time_us=1000000\\nfps=0\\nprogress=continue');setTimeout(()=>{console.log('frame=140\\nout_time_us=2000000\\nfps=0\\nprogress=continue');process.exit(0)},350)`;
 const updates=[];
 await p.testProcess(process.execPath,['-e',script],null,(timeUs,fps)=>updates.push({timeUs,fps}));
 assert.ok(updates.some(update=>Number.isFinite(update.fps)&&update.fps>0),'postcheck decode should report measured frames per second');
});


test('Dolby Level 6 supplies only actual valid light metadata',()=>{
 assert.equal(typeof p.testL6,'function');
 const block={max_display_mastering_luminance:1000,min_display_mastering_luminance:1,max_content_light_level:992,max_frame_average_light_level:362};
 assert.deepEqual(p.testL6({vdr_dm_data:{cmv29_metadata:{ext_metadata_blocks:[{Level6:block}]}}}),{max_content:992,max_average:362,max_luminance:1000,min_luminance:0.0001});
 assert.deepEqual(p.testL6({vdr_dm_data:{cmv29_metadata:{ext_metadata_blocks:[{Level6:{...block,max_content_light_level:0,max_frame_average_light_level:0}}]}}}),{max_content:0,max_average:0,max_luminance:1000,min_luminance:0.0001});
 assert.throws(()=>p.testL6({vdr_dm_data:{}}),/level 6/i);
 assert.throws(()=>p.testL6({vdr_dm_data:{cmv29_metadata:{ext_metadata_blocks:[{Level6:{...block,max_content_light_level:0}}]}}}),/level 6/i);
});

test('V5 recognizes both its own and the completed V4 output markers',()=>{
 assert.equal(p.testDone('av1',{'ENCODED_BY':'ArcAV1_QSV_V4'}),true);
 assert.equal(p.testDone('av1',{'ENCODED_BY':'ArcAV1_QSV_V5'}),true);
});

test('V15 treats V14 and V15 marked AV1 files as already processed',()=>{
 assert.equal(p.testDone('av1',{ENCODED_BY:'ArcAV1_QSV_V14'}),true);
 assert.equal(p.testDone('av1',{ENCODED_BY:'ArcAV1_QSV_V15'}),true);
 assert.equal(p.testDone('h264',{ENCODED_BY:'ArcAV1_QSV_V14'}),false);
});

test('HDR10 output may not retain a Dolby Vision configuration',()=>{
 const md={side_data_type:'Mastering display metadata',red_x:'17/25',red_y:'8/25',green_x:'53/200',green_y:'69/100',blue_x:'3/20',blue_y:'3/50',white_point_x:'3127/10000',white_point_y:'329/1000',min_luminance:'1/200',max_luminance:'1000/1'};
 const cll={side_data_type:'Content light level metadata',max_content:1000,max_average:250};
 const v={...pqVideo,side_data_list:[md,cll]};
 assert.throws(()=>p.testHdr(v,{...v,side_data_list:[md,cll,dvConfig]}),/Dolby/i);
});

test('frame scanning recognizes HDR Vivid as unsupported dynamic metadata',()=>{
 const scan={frames:0,interlaced:0,dovi:0,hdr10plus:0,otherDynamic:0};
 p.testRecordFrame('interlaced_frame=0|side_data_type=HDR Dynamic Metadata CUVA 005.1 2021 (Vivid)',scan);
 assert.equal(scan.otherDynamic,1);
});

test('frame scanner flags changing mastering metadata across the source',()=>{
 const scan={frames:0,interlaced:0,dovi:0,hdr10plus:0,otherDynamic:0,staticInfo:{mastering:null,light:null,conflict:false}};
 const md=x=>`interlaced_frame=0|side_datum/mastering_display_metadata:side_data_type=Mastering display metadata|side_datum/mastering_display_metadata:red_x=${x}|side_datum/mastering_display_metadata:red_y=8/25|side_datum/mastering_display_metadata:green_x=53/200|side_datum/mastering_display_metadata:green_y=69/100|side_datum/mastering_display_metadata:blue_x=3/20|side_datum/mastering_display_metadata:blue_y=3/50|side_datum/mastering_display_metadata:white_point_x=3127/10000|side_datum/mastering_display_metadata:white_point_y=329/1000|side_datum/mastering_display_metadata:min_luminance=1/200|side_datum/mastering_display_metadata:max_luminance=1000/1`;
 p.testRecordFrame(md('17/25'),scan);p.testRecordFrame(md('16/25'),scan);
 assert.equal(scan.staticInfo.conflict,true);
});

test('HDR10 validation must retain the limited color range',()=>{
 const md={side_data_type:'Mastering display metadata',red_x:'17/25',red_y:'8/25',green_x:'53/200',green_y:'69/100',blue_x:'3/20',blue_y:'3/50',white_point_x:'3127/10000',white_point_y:'329/1000',min_luminance:'1/200',max_luminance:'1000/1'};
 const cll={side_data_type:'Content light level metadata',max_content:1000,max_average:250};
 const source={...pqVideo,color_range:'tv',side_data_list:[md,cll]};
 assert.throws(()=>p.testHdr(source,{...source,color_range:'pc'}),/color/i);
});

test('Dolby Level 6 may supply truly absent content-light metadata',()=>{
 const mastering={side_data_type:'Mastering display metadata',red_x:'17/25'};
 const result=p.testMergeHdr(pqVideo,[{side_data_list:[mastering]}],{allowMissingLight:true});
 assert.equal(result.side_data_list[1].max_content,0);
});


test('video validation detects interior presentation timestamp changes',()=>{
 assert.equal(typeof p.testCompareTimes,'function');
 assert.doesNotThrow(()=>p.testCompareTimes({timestamps:[0,0.04,0.08]},{timestamps:[1,1.04,1.08]}));
 assert.throws(()=>p.testCompareTimes({timestamps:[0,0.04,0.08]},{timestamps:[1,1.15,1.08]}),/timestamp/i);
});

test('selected audio track cannot drift by 300 milliseconds',async()=>{
 const child=require('node:child_process'),os=require('node:os');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v5-skew-')),src=path.join(dir,'src.mkv'),out=path.join(dir,'out.mkv');
 try {
  child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=24:duration=3','-f','lavfi','-i','sine=duration=3','-c:v','libx264','-c:a','aac','-y',src],{stdio:'ignore'});
  child.execFileSync('ffmpeg',['-v','error','-i',src,'-itsoffset','0.3','-i',src,'-map','0:v','-map','1:a','-c','copy','-y',out],{stdio:'ignore'});
  const m={exports:{}};new Function('require','module','exports',engine+'\nmodule.exports.testValidate=validateOutput;')(require,m,m.exports);
  await assert.rejects(()=>m.exports.testValidate('ffprobe',src,out,{codec:'h264',audio:1,subtitle:0,sourceVideoIndex:0,audioIndices:[1],subtitleIndices:[]}),/audio.*timeline/i);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


test('plain HLG HDR remains HLG after encoding',()=>{
 const hlg={...pqVideo,color_transfer:'arib-std-b67'};
 assert.equal(p.testHdrRoute(hlg,{HDR_Format:'HLG'},pqScan),'hlg');
 assert.equal(typeof p.testHlg,'function');
 assert.doesNotThrow(()=>p.testHlg(hlg,{...hlg}));
 assert.throws(()=>p.testHlg(hlg,{...hlg,color_transfer:'smpte2084'}),/color/i);
});


test('timeline process accepts zero exit with benign stderr and returns the diagnostic separately',async()=>{
 assert.equal(typeof p.testProcess,'function');
 let diagnostic='';
 await assert.doesNotReject(()=>p.testProcess(process.execPath,['-e','process.stderr.write("harmless decoder note")'],null,null,value=>diagnostic=value));
 assert.match(diagnostic,/harmless decoder note/);
});

test('timeline process still rejects nonzero exit and timeout statuses',async()=>{
 await assert.rejects(()=>p.testProcess(process.execPath,['-e','process.stderr.write("tool error");process.exit(3)']),/failed \(3\).*tool error/i);
 await assert.rejects(()=>p.testProcess(process.execPath,['-e','setInterval(()=>{},1000)'],null,null,null,30),/timed out/i);
});

test('long media scans use an idle timeout that resets on process output',async()=>{
 await assert.rejects(()=>p.testProcess(process.execPath,['-e','setTimeout(()=>{},700)'],null,null,null,1000,250),/timed out.*no process output/i);
 const script='process.stdout.write("i");let timer=setInterval(()=>process.stdout.write("s"),100);setTimeout(()=>{clearInterval(timer);process.exit(0)},700)';
 await assert.doesNotReject(()=>p.testProcess(process.execPath,['-e',script],null,null,null,1000,250));
});

test('full source scan classifies known H264 NAL corruption despite zero exit',async()=>{
 const os=require('node:os'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'v15-nal-diagnostic-'));
 const ffprobe=path.join(dir,'ffprobe-stub'),media=path.join(dir,'source.mkv');
 try {
  fs.writeFileSync(media,'fixture');
  fs.writeFileSync(ffprobe,'#!/usr/bin/env node\nprocess.stdout.write("frame|best_effort_timestamp_time=0|interlaced_frame=0\\n");\nprocess.stderr.write("[h264] Invalid NAL unit size (999 > 8)\\n");\n');
  fs.chmodSync(ffprobe,0o755);
  await assert.rejects(()=>p.testScanFrames(ffprobe,media,0,{scanRole:'source'}),/Source media corruption.*Invalid NAL unit size/i);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('full source scan accepts benign stderr when frames are valid',async()=>{
 const os=require('node:os'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'v15-benign-diagnostic-'));
 const ffprobe=path.join(dir,'ffprobe-stub'),media=path.join(dir,'source.mkv');
 try {
  fs.writeFileSync(media,'fixture');
  fs.writeFileSync(ffprobe,'#!/usr/bin/env node\nprocess.stdout.write("frame|best_effort_timestamp_time=0|interlaced_frame=0\\n");\nprocess.stderr.write("[matroska] non-fatal metadata note\\n");\n');
  fs.chmodSync(ffprobe,0o755);
  const scan=await p.testScanFrames(ffprobe,media,0);
  assert.equal(scan.frames,1);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


test('SDR stream tags cannot hide HDR mastering data in decoded frames',()=>{
 assert.equal(typeof p.testSdrSignal,'function');
 const scan={frames:2,dovi:0,hdr10plus:0,otherDynamic:0,staticInfo:{mastering:null,light:null,conflict:false}};
 assert.equal(p.testSdrSignal('sdr',scan),true);
 assert.equal(p.testSdrSignal('sdr',{...scan,staticInfo:{...scan.staticInfo,mastering:{side_data_type:'Mastering display metadata'}}}),false);
 assert.equal(p.testSdrSignal('sdr',{...scan,staticInfo:{...scan.staticInfo,conflict:true}}),false);
});

test('HLG does not discard stream-level HDR mastering metadata',()=>{
 const hlg={...pqVideo,color_transfer:'arib-std-b67'};
 const unexpected={side_data_type:'Mastering display metadata'};
 assert.throws(()=>p.testHlg({...hlg,side_data_list:[unexpected]},hlg),/metadata/i);
 assert.throws(()=>p.testHlg(hlg,{...hlg,side_data_list:[unexpected]}),/metadata/i);
});

test('conflicting duplicate mastering blocks cannot overwrite each other',()=>{
 const scan={frames:0,interlaced:0,dovi:0,hdr10plus:0,otherDynamic:0,staticInfo:{mastering:null,light:null,conflict:false}};
 const md='side_datum/mastering_display_metadata:side_data_type=Mastering display metadata|side_datum/mastering_display_metadata:red_x=17/25|side_datum/mastering_display_metadata:red_y=8/25|side_datum/mastering_display_metadata:green_x=53/200|side_datum/mastering_display_metadata:green_y=69/100|side_datum/mastering_display_metadata:blue_x=3/20|side_datum/mastering_display_metadata:blue_y=3/50|side_datum/mastering_display_metadata:white_point_x=3127/10000|side_datum/mastering_display_metadata:white_point_y=329/1000|side_datum/mastering_display_metadata:min_luminance=1/200|side_datum/mastering_display_metadata:max_luminance=1000/1';
 p.testRecordFrame('interlaced_frame=0|'+md+'|'+md.replace('17/25','16/25'),scan);
 assert.equal(scan.staticInfo.conflict,true);
});

test('duplicate static HDR metadata on one stream is rejected',()=>{
 const mastering={side_data_type:'Mastering display metadata',red_x:'17/25'};
 const light={side_data_type:'Content light level metadata',max_content:1000,max_average:250};
 assert.throws(()=>p.testMergeHdr({...pqVideo,side_data_list:[mastering,{...mastering,red_x:'16/25'},light]},[]),/duplicate/i);
});

test('per-frame color signaling cannot conflict with stream signaling',()=>{
 const scan={frames:0,interlaced:0,dovi:0,hdr10plus:0,otherDynamic:0,colorInfo:{expected:pqVideo,conflict:false}};
 p.testRecordFrame('interlaced_frame=0|color_range=tv|color_transfer=smpte2084|color_primaries=bt2020|color_space=bt2020nc',scan);
 assert.equal(scan.colorInfo.conflict,false);
 p.testRecordFrame('interlaced_frame=0|color_range=pc|color_transfer=smpte2084|color_primaries=bt2020|color_space=bt2020nc',scan);
 assert.equal(scan.colorInfo.conflict,true);
});


test('Dolby light-level fallback requires consistent Level 6 values for all exported frames',()=>{
 assert.equal(typeof p.testL6Rows,'function');
 const header='frame,max_display_mastering_luminance,min_display_mastering_luminance,max_content_light_level,max_frame_average_light_level';
 assert.deepEqual(p.testL6Rows([header,'0,1000,1,992,362','1,1000,1,992,362'],2),{max_content:992,max_average:362,max_luminance:1000,min_luminance:0.0001});
 assert.throws(()=>p.testL6Rows([header,'0,1000,1,992,362','1,1000,1,1200,362'],2),/level 6/i);
 assert.throws(()=>p.testL6Rows([header,'0,1000,1,992,362'],2),/level 6/i);
});


test('Dolby Level 6 fallback agrees with the HDR10 mastering data',async()=>{
 const md={side_data_type:'Mastering display metadata',red_x:'17/25',red_y:'8/25',green_x:'53/200',green_y:'69/100',blue_x:'3/20',blue_y:'3/50',white_point_x:'3127/10000',white_point_y:'329/1000',min_luminance:'1/10000',max_luminance:'1000/1'};
 const cll={side_data_type:'Content light level metadata',max_content:0,max_average:0};
 const v={...pqVideo,side_data_list:[md,cll]};
 const l6={max_content:992,max_average:362,max_luminance:1000,min_luminance:0.0001};
 const result=await p.testResolveLight(v,'dovi81_hdr10',async()=>l6);
 assert.equal(result.override,'992,362');
 assert.deepEqual(result.metadata.side_data_list[1],{side_data_type:'Content light level metadata',max_content:992,max_average:362});
 await assert.rejects(()=>p.testResolveLight(v,'dovi81_hdr10',async()=>({...l6,max_luminance:4000})),/conflict/i);
 let level6Calls=0;
 const hdr10MissingStatic=await p.testResolveLight(v,'hdr10',async()=>{level6Calls++;return l6;});
 assert.equal(level6Calls,0,'ordinary HDR10 must not borrow Dolby Level 6 metadata');
 assert.equal(hdr10MissingStatic.metadata.side_data_list.some(x=>x.side_data_type==='Content light level metadata'),false,'missing HDR10 light metadata must stay unspecified');
});

test('Dolby Level 6 zero light values stay unspecified while valid mastering metadata is preserved',async()=>{
 const md={side_data_type:'Mastering display metadata',red_x:'17/25',red_y:'8/25',green_x:'53/200',green_y:'69/100',blue_x:'3/20',blue_y:'3/50',white_point_x:'3127/10000',white_point_y:'329/1000',min_luminance:'1/10000',max_luminance:'1000/1'};
 const cll={side_data_type:'Content light level metadata',max_content:0,max_average:0};
 const source={...pqVideo,side_data_list:[md,cll]};
 const unknown={max_content:0,max_average:0,max_luminance:1000,min_luminance:0.0001};
 const resolved=await p.testResolveLight(source,'dovi7_hdr10',async()=>unknown);
 assert.equal(resolved.override,null);
 assert.deepEqual(resolved.metadata.side_data_list,[md]);
 assert.doesNotThrow(()=>p.testHdr(resolved.metadata,{...resolved.metadata,side_data_list:[md]}));
 assert.throws(()=>p.testHdr(resolved.metadata,{...resolved.metadata,side_data_list:[md,{side_data_type:'Content light level metadata',max_content:500,max_average:200}]}),/added without source data/i);
 await assert.rejects(()=>p.testResolveLight({...source,side_data_list:[md,{...cll,max_content:100}]},'dovi7_hdr10',async()=>unknown),/light metadata is invalid/i);
});

test('Skyfall QSV sample mastering data validates when unknown CLL is removed',()=>{
 const sourceMaster={side_data_type:'Mastering display metadata',red_x:'34000/50000',red_y:'16000/50000',green_x:'13250/50000',green_y:'34500/50000',blue_x:'7500/50000',blue_y:'3000/50000',white_point_x:'15635/50000',white_point_y:'16450/50000',min_luminance:'1/10000',max_luminance:'10000000/10000'};
 const outputMaster={side_data_type:'Mastering display metadata',red_x:'44564/65536',red_y:'20972/65536',green_x:'17367/65536',green_y:'45220/65536',blue_x:'9830/65536',blue_y:'3932/65536',white_point_x:'20493/65536',white_point_y:'21561/65536',min_luminance:'2/16384',max_luminance:'256000/256'};
 const source={...pqVideo,side_data_list:[sourceMaster]};
 const output={...pqVideo,side_data_list:[outputMaster]};
 assert.doesNotThrow(()=>p.testHdr(source,output));
 const requirements=p.testHdrFrameRequirements(source);
 assert.deepEqual(requirements,{requireLight:false,requireMastering:true});
 assert.doesNotThrow(()=>p.testHdrStatic(source,{staticInfo:{mastering:outputMaster,light:null,conflict:false}},requirements.requireLight,requirements.requireMastering));
});

test('Dolby output frame checks require only static metadata present in the verified source',()=>{
 assert.equal(typeof p.testHdrFrameRequirements,'function');
 const md={side_data_type:'Mastering display metadata'};
 const cll={side_data_type:'Content light level metadata'};
 assert.deepEqual(p.testHdrFrameRequirements({side_data_list:[md]}),{requireLight:false,requireMastering:true});
 assert.deepEqual(p.testHdrFrameRequirements({side_data_list:[md,cll]}),{requireLight:true,requireMastering:true});
 assert.deepEqual(p.testHdrFrameRequirements({side_data_list:[]},true),{requireLight:false,requireMastering:false});
});

test('HDR encode removes content-light side data only when the source has no verified value',()=>{
 assert.equal(typeof p.testVideoFilter,'function');
 assert.equal(p.testVideoFilter('vpp_qsv',{removeContentLight:true}),'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,vpp_qsv');
 assert.equal(p.testVideoFilter('format=p010le',{removeHdr10Plus:true,removeContentLight:true}),'sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,format=p010le');
 assert.equal(p.testVideoFilter('vpp_qsv',{removeContentLight:false}),'vpp_qsv');
 const md={side_data_type:'Mastering display metadata',red_x:'17/25',red_y:'8/25',green_x:'53/200',green_y:'69/100',blue_x:'3/20',blue_y:'3/50',white_point_x:'3127/10000',white_point_y:'329/1000',min_luminance:'1/10000',max_luminance:'1000/1'};
 const requirements=p.testHdrFrameRequirements({side_data_list:[md]});
 assert.doesNotThrow(()=>p.testHdrStatic({side_data_list:[md]},{staticInfo:{mastering:md,light:null,conflict:false}},requirements.requireLight,requirements.requireMastering));
 assert.throws(()=>p.testHdrStatic({side_data_list:[md]},{staticInfo:{mastering:md,light:{max_content:1,max_average:1},conflict:false}},requirements.requireLight,requirements.requireMastering),/light metadata conflicts/i);
});


test('HDR10 rejects duplicate output stream mastering metadata',()=>{
 const md={side_data_type:'Mastering display metadata',red_x:'17/25',red_y:'8/25',green_x:'53/200',green_y:'69/100',blue_x:'3/20',blue_y:'3/50',white_point_x:'3127/10000',white_point_y:'329/1000',min_luminance:'1/200',max_luminance:'1000/1'};
 const cll={side_data_type:'Content light level metadata',max_content:1000,max_average:250};
 const v={...pqVideo,side_data_list:[md,cll]};
 assert.throws(()=>p.testHdr(v,{...v,side_data_list:[md,{...md,red_x:'1/3'},cll]}),/duplicate/i);
});

test('SDR fallback cannot hide a frame-level PQ transfer or changing signals',()=>{
 assert.equal(typeof p.testSdrTransfer,'function');
 const scan={frames:0,interlaced:0,dovi:0,hdr10plus:0,otherDynamic:0,colorInfo:{expected:{},observed:{},conflict:false}};
 p.testRecordFrame('interlaced_frame=0|color_transfer=smpte2084',scan);
 assert.throws(()=>p.testSdrTransfer({}, {transfer_characteristics:'BT.709'},scan),/transfer/i);
 p.testRecordFrame('interlaced_frame=0|color_transfer=bt709',scan);
 assert.equal(scan.colorInfo.conflict,true);
});

test('stream-only dynamic HDR metadata cannot be discarded as HDR10 or SDR',()=>{
 const dynamic={side_data_type:'HDR Dynamic Metadata CUVA 005.1 2021 (Vivid)'};
 assert.throws(()=>p.testHdrRoute({...pqVideo,side_data_list:[dynamic]},plainInfo,pqScan),/dynamic/i);
 const sdr={color_transfer:'bt709',side_data_list:[dynamic]};
 assert.equal(p.testClassify(sdr,{}),'unsupported');
});

test('HDR10 and HLG output reject stream-only HDR Vivid metadata',()=>{
 const dynamic={side_data_type:'HDR Dynamic Metadata CUVA 005.1 2021 (Vivid)'};
 const hlg={...pqVideo,color_transfer:'arib-std-b67'};
 assert.throws(()=>p.testHlg(hlg,{...hlg,side_data_list:[dynamic]}),/metadata/i);
});


test('HDR10 Plus requires detected frames and SL-HDR cannot bypass rejection',()=>{
 assert.throws(()=>p.testHdrRoute(pqVideo,{HDR_Format:'HDR10 Plus / SMPTE ST 2086'},pqScan),/dynamic|HDR10/i);
 assert.equal(p.testHdrRoute(pqVideo,{HDR_Format:'HDR10 Plus / SMPTE ST 2086'},{...pqScan,hdr10plus:2}),'hdr10plus_hdr10');
 const scan={frames:0,interlaced:0,dovi:0,hdr10plus:0,otherDynamic:0};
 p.testRecordFrame('interlaced_frame=0|side_data_type=Dynamic HDR SL-HDR metadata',scan);
 assert.equal(scan.otherDynamic,1);
});

test('the effective SDR source transfer and known frame colors must survive output',()=>{
 assert.equal(typeof p.testSdrSource,'function');
 const scan={colorInfo:{observed:{color_primaries:'bt709',color_range:'tv'}}};
 const source=p.testSdrSource({}, {transfer_characteristics:'BT.709'},scan);
 assert.equal(source.color_transfer,'bt709');assert.equal(source.color_primaries,'bt709');assert.equal(source.color_range,'tv');
 assert.throws(()=>p.testColor(source,{color_transfer:'smpte2084',color_primaries:'bt709',color_range:'tv'}),/color/i);
});

test('V6 output markers are recognized without re-encoding V5 outputs',()=>{assert.equal(p.testDone('av1',{ENCODED_BY:'ArcAV1_QSV_V5'}),true);assert.equal(p.testDone('av1',{ENCODED_BY:'ArcAV1_QSV_V6'}),true);});


test('HDR10+ fallback requires a verified base and rejects hybrid or other dynamic HDR',()=>{
 const h={HDR_Format:'SMPTE ST 2094 App 4 / SMPTE ST 2086',HDR_Format_Compatibility:'HDR10+'};
 assert.equal(p.testHdrRoute(pqVideo,h,{...pqScan,hdr10plus:2}),'hdr10plus_hdr10');
 assert.throws(()=>p.testHdrRoute({...pqVideo,color_transfer:'bt709'},h,{...pqScan,hdr10plus:2}),/color|HDR10/i);
 assert.throws(()=>p.testHdrRoute({...pqVideo,side_data_list:[dvConfig]},h,{...pqScan,hdr10plus:2,dovi:2}),/hybrid|Dolby/i);
 assert.throws(()=>p.testHdrRoute(pqVideo,{HDR_Format:'HDR10+ / HDR Vivid'}, {...pqScan,hdr10plus:2,otherDynamic:2}),/dynamic/i);
});


test('untagged video can encode without assigning missing color metadata',()=>{
 assert.equal(typeof p.testUntagged,'function');assert.equal(typeof p.testUntaggedOutput,'function');
 const v={codec_name:'hevc',color_range:'tv'},info={},scan={...pqScan,colorInfo:{observed:{color_range:'tv'}},staticInfo:{mastering:null,light:null,conflict:false}};
 assert.equal(p.testUntagged(v,info,scan),true);
 assert.doesNotThrow(()=>p.testUntaggedOutput(v,{codec_name:'av1',color_range:'tv'},scan));
 assert.throws(()=>p.testUntaggedOutput(v,{codec_name:'av1',color_range:'tv',color_transfer:'bt709'},scan),/color/i);
 assert.throws(()=>p.testUntaggedOutput(v,{codec_name:'av1',color_range:'pc'},scan),/color/i);
});

test('untagged SDR YUV defaults to limited range while preserving known full range',()=>{
 assert.equal(typeof p.testUntaggedRange,'function');
 assert.equal(typeof p.testUntaggedRangeArgs,'function');
 const noRange={colorInfo:{observed:{}}};
 assert.equal(p.testUntaggedRange({pix_fmt:'yuv420p'},{},noRange),'tv');
 assert.equal(p.testUntaggedRange({pix_fmt:'p010le'},{},noRange),'tv');
 assert.equal(p.testUntaggedRange({pix_fmt:'yuvj444p'},{},noRange),'pc');
 assert.equal(p.testUntaggedRange({pix_fmt:'yuv420p',color_range:'pc'},{},noRange),'pc');
 assert.equal(p.testUntaggedRange({pix_fmt:'yuv420p'},{},{colorInfo:{observed:{color_range:'pc'}}}),'pc');
 assert.equal(p.testUntaggedRange({pix_fmt:'yuv420p'}, {colour_range:'Full'},noRange),'pc');
 assert.equal(p.testUntaggedRange({pix_fmt:'yuv420p',color_range:'tv'},{},{colorInfo:{observed:{color_range:'pc'}}}),null);
 assert.equal(p.testUntaggedRange({pix_fmt:'yuv420p',color_range:'mystery'},{},noRange),null);
 assert.equal(p.testUntaggedRange({pix_fmt:'rgb24'},{},noRange),null);
 assert.deepEqual(p.testUntaggedRangeArgs('untagged',{color_range:'tv'}),['-color_range','tv']);
 assert.deepEqual(p.testUntaggedRangeArgs('untagged',{color_range:'pc'}),['-color_range','pc']);
 assert.deepEqual(p.testUntaggedRangeArgs('sdr',{color_range:'tv'}),[]);
 const expected={codec_name:'hevc',pix_fmt:'yuv420p',color_range:p.testUntaggedRange({pix_fmt:'yuv420p'},{},noRange)};
 assert.doesNotThrow(()=>p.testUntaggedOutput(expected,{codec_name:'av1',color_range:'tv'},noRange));
 assert.throws(()=>p.testUntaggedOutput(expected,{codec_name:'av1',color_range:'pc'},noRange),/range/i);
});

test('untagged routing refuses hidden or contradictory HDR and known frame colors',()=>{
 assert.equal(typeof p.testUntagged,'function');
 const v={codec_name:'hevc',color_range:'tv'},scan={...pqScan,colorInfo:{observed:{color_range:'tv'}},staticInfo:{mastering:null,light:null,conflict:false}};
 assert.equal(p.testUntagged(v,{}, {...scan,dovi:1}),false);
 assert.equal(p.testUntagged(v,{}, {...scan,hdr10plus:1}),false);
 assert.equal(p.testUntagged(v,{}, {...scan,staticInfo:{...scan.staticInfo,mastering:{}}}),false);
 assert.equal(p.testUntagged(v,{}, {...scan,colorInfo:{observed:{color_transfer:'smpte2084'}}}),false);
 assert.equal(p.testUntagged(v,{HDR_Format:'Dolby Vision'},scan),false);
});


test('Dolby Vision 8.4 stays held until a genuine HLG-base input is verified',()=>{
 const hlg={...pqVideo,color_transfer:'arib-std-b67',side_data_list:[{...dvConfig,dv_bl_signal_compatibility_id:4}]};
 const info={HDR_Format:'Dolby Vision',HDR_Format_Compatibility:'HLG'};
 assert.throws(()=>p.testHdrRoute(hlg,info,{...pqScan,dovi:100}),/Profile 8\.4.*unverified/i);
});

test('free-space MB conversion uses available blocks and block size exactly once',()=>{
 assert.equal(typeof p.testFreeSpace,'function');
 const previous=fs.statfsSync;let optionsSeen;
 try {
  fs.statfsSync=(dir,options)=>{optionsSeen={dir,options};return {bavail:1024n*1024n,bsize:4096n};};
  assert.equal(p.testFreeSpace('/cache'),4096);
  assert.deepEqual(optionsSeen,{dir:'/cache',options:{bigint:true}});
  fs.statfsSync=()=>({bavail:-1n,bsize:4096n});
  assert.equal(p.testFreeSpace('/path/that/does/not/exist'),null);
 } finally {fs.statfsSync=previous;}
});

test('untagged classification rejects alternate MediaInfo HDR and Dolby fields',()=>{
 const v={codec_name:'hevc',color_range:'tv'},scan={...pqScan,colorInfo:{observed:{color_range:'tv'}},staticInfo:{mastering:null,light:null,conflict:false}};
 assert.equal(p.testUntagged(v,{HDR_Format_String:'Dolby Vision'},scan),false);
 assert.equal(p.testUntagged(v,{HDR_Format_Commercial:'HDR Vivid'},scan),false);
 assert.equal(p.testUntagged(v,{Encoded_Library_Settings:'no-hdr10 / no-dhdr10-opt'},scan),true);
});

test('HDR routing rejects MediaInfo colors that contradict the decoded stream',()=>{
 const scan={...pqScan,hdr10plus:2};
 assert.equal(p.testHdrRoute(pqVideo,{HDR_Format:'HDR10+',transfer_characteristics:'PQ',colour_primaries:'BT.2020',matrix_coefficients:'BT.2020 non-constant',colour_range:'Limited'},scan),'hdr10plus_hdr10');
 assert.throws(()=>p.testHdrRoute(pqVideo,{HDR_Format:'HDR10+',transfer_characteristics:'BT.709'},scan),/color/i);
 assert.throws(()=>p.testHdrRoute(pqVideo,{HDR_Format:'HDR10+',colour_primaries:'BT.709'},scan),/color/i);
 assert.throws(()=>p.testHdrRoute(pqVideo,{HDR_Format:'HDR10+',matrix_coefficients:'BT.709'},scan),/color/i);
 const hlg={...pqVideo,color_transfer:'arib-std-b67',side_data_list:[{...dvConfig,dv_bl_signal_compatibility_id:4}]};
 assert.throws(()=>p.testHdrRoute(hlg,{HDR_Format:'Dolby Vision',transfer_characteristics:'HLG',colour_primaries:'BT.2020',matrix_coefficients:'BT.2020 non-constant',colour_range:'Limited'}, {...pqScan,dovi:100}),/Profile 8\.4.*unverified/i);
 assert.throws(()=>p.testHdrRoute(hlg,{HDR_Format:'Dolby Vision',transfer_characteristics:'PQ'}, {...pqScan,dovi:100}),/color/i);
});

test('untagged output cannot acquire a frame-only color range',()=>{
 const scan={colorInfo:{observed:{color_range:'tv'}}};
 assert.throws(()=>p.testUntaggedOutput({}, {}, scan),/range/i);
 assert.throws(()=>p.testUntaggedOutput({color_range:'tv'},{color_range:'tv'},{colorInfo:{observed:{color_range:'pc'}}}),/range/i);
});

test('Profile 7 Blu-ray with verified HDR10 base can fall back to static HDR10',()=>{
 const v={...pqVideo,side_data_list:[{...dvConfig,dv_profile:7,el_present_flag:1,dv_bl_signal_compatibility_id:6}]};
 const i={HDR_Format:'Dolby Vision / SMPTE ST 2086',HDR_Format_Compatibility:'Blu-ray / HDR10',transfer_characteristics:'PQ',colour_primaries:'BT.2020',matrix_coefficients:'BT.2020 non-constant',colour_range:'Limited'};
 assert.equal(p.testHdrRoute(v,i,{...pqScan,dovi:100}),'dovi7_hdr10');
 assert.throws(()=>p.testHdrRoute(v,{...i,HDR_Format_Compatibility:'Blu-ray'}, {...pqScan,dovi:100}),/HDR10|color/i);
 assert.throws(()=>p.testHdrRoute({...v,color_transfer:'bt709'},i,{...pqScan,dovi:100}),/color/i);
 assert.throws(()=>p.testHdrRoute({...v,side_data_list:[{...v.side_data_list[0],dv_bl_signal_compatibility_id:3}]},i,{...pqScan,dovi:100}),/Dolby|HDR10/i);
 assert.throws(()=>p.testHdrRoute({...v,side_data_list:[{...v.side_data_list[0],el_present_flag:0}]},i,{...pqScan,dovi:100}),/Dolby|HDR10/i);
 assert.throws(()=>p.testHdrRoute(v,i,{...pqScan,dovi:0}),/Dolby/i);
 assert.equal(p.testHdrRoute(v,{...i,HDR_Format:'Dolby Vision / HDR10+'},{...pqScan,dovi:100,hdr10plus:1}),'dovi7_hdr10plus_hdr10');
});

test('rejects the observed QSV mastering green-coordinate clamp',()=>{
 const mastering={side_data_type:'Mastering display metadata',red_x:'35400/50000',red_y:'14600/50000',green_x:'8500/50000',green_y:'39850/50000',blue_x:'6550/50000',blue_y:'2300/50000',white_point_x:'15635/50000',white_point_y:'16450/50000',min_luminance:'20/10000',max_luminance:'10000000/10000'};
 const light={side_data_type:'Content light level metadata',max_content:992,max_average:518};
 const source={...pqVideo,side_data_list:[mastering,light]};
 const output={...source,side_data_list:[{...mastering,green_y:'50000/65536'},light]};
 assert.throws(()=>p.testHdr(source,output),/metadata changed/i);
});

test('Profile 7 may recover missing HDR content-light values from verified Level 6',async()=>{
 const mastering={side_data_type:'Mastering display metadata',red_x:'34000/50000',red_y:'16000/50000',green_x:'13250/50000',green_y:'34500/50000',blue_x:'7500/50000',blue_y:'3000/50000',white_point_x:'15635/50000',white_point_y:'16450/50000',min_luminance:'50/10000',max_luminance:'40000000/10000'};
 const src={...pqVideo,side_data_list:[mastering,{side_data_type:'Content light level metadata',max_content:0,max_average:0}]};
 const l6={max_content:992,max_average:120,max_luminance:4000,min_luminance:0.005};
 const resolved=await p.testResolveLight(src,'dovi7_hdr10',async()=>l6);
 assert.equal(resolved.override,'992,120');assert.equal(resolved.metadata.side_data_list[1].max_content,992);
 await assert.rejects(()=>p.testResolveLight(src,'dovi7_hdr10',async()=>({...l6,max_luminance:1000})),/conflict/i);
});

test('Profile 7 fallback omits unavailable content-light data without comparing unused Level 6 mastering values',async()=>{
 const mastering={side_data_type:'Mastering display metadata',red_x:'34000/50000',red_y:'16000/50000',green_x:'13250/50000',green_y:'34500/50000',blue_x:'7500/50000',blue_y:'3000/50000',white_point_x:'15635/50000',white_point_y:'16450/50000',min_luminance:'1/10000',max_luminance:'10000000/10000'};
 const src={...pqVideo,side_data_list:[mastering,{side_data_type:'Content light level metadata',max_content:0,max_average:0}]};
 const unknown={max_content:0,max_average:0,max_luminance:4000,min_luminance:0.005};
 const resolved=await p.testResolveLight(src,'dovi7_hdr10',async()=>unknown);
 assert.equal(resolved.override,null);
 assert.deepEqual(resolved.metadata.side_data_list,[mastering]);
});
