const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const flow = JSON.parse(fs.readFileSync(path.join(__dirname, 'flow.json')));
const engine = flow.flowPlugins.find(p => p.id === 'arc_av1_monolithic').inputsDB.code;
const mod = {exports:{}};
new Function('require','module','exports',engine + '\nmodule.exports.testPolicy = typeof selectQualityAttempts === "function" ? selectQualityAttempts : null; module.exports.testRun = typeof runQualityAttempts === "function" ? runQualityAttempts : null; module.exports.testDone = typeof isCompletedEncode === "function" ? isCompletedEncode : null; module.exports.testClassify = typeof classifyVideo === "function" ? classifyVideo : null; module.exports.testHdr = typeof validateHdr10 === "function" ? validateHdr10 : null; module.exports.testColor = typeof validateSdrColor === "function" ? validateSdrColor : null; module.exports.testVideoGuard = typeof guardSourceVideo === "function" ? guardSourceVideo : null; module.exports.testAspect = typeof validateAspect === "function" ? validateAspect : null;')(require,mod,mod.exports);
const p=mod.exports;

test('uses the tested SDR initial and quality floors',()=>{
  assert.equal(typeof p.testPolicy,'function','quality policy is missing');
  assert.deepEqual(p.testPolicy({width:1920,height:1080,isHdr:false}),[19,23]);
  assert.deepEqual(p.testPolicy({width:3840,height:2160,isHdr:false}),[19,23,26]);
});

test('retries oversized outputs and accepts only a smaller one',()=>{
  assert.equal(typeof p.testRun,'function','bounded retry policy is missing');
  const called=[];
  const result=p.testRun([19,23,26],100,q=>{called.push(q);return {ok:true,size:q===26?99:100};});
  assert.deepEqual(called,[19,23,26]);assert.equal(result.quality,26);assert.equal(result.ok,true);
});

test('fails at the quality floor and stops on an encoder error',()=>{
  assert.equal(typeof p.testRun,'function','bounded retry policy is missing');
  let calls=[];
  const tooLarge=p.testRun([19,23],100,q=>{calls.push(q);return {ok:true,size:101};});
  assert.equal(tooLarge.ok,false);assert.deepEqual(calls,[19,23]);
  calls=[];
  const error=p.testRun([19,23],100,q=>{calls.push(q);return {ok:false};});
  assert.equal(error.ok,false);assert.deepEqual(calls,[19]);
});

test('only current-version AV1 output bypasses a new encode',()=>{
  assert.equal(typeof p.testDone,'function','completion marker policy is missing');
  assert.equal(p.testDone('av1',{'ENCODED_BY':'ArcAV1_QSV_V4'}),true);
  assert.equal(p.testDone('av1',{'ENCODED_BY':'ArcAV1_QSV'}),false);
  assert.equal(p.testDone('av1',{'ENCODED_BY':'ArcAV1_QSV_V4_extra'}),false);
  assert.equal(p.testDone('hevc',{'ENCODED_BY':'ArcAV1_QSV_V4'}),false);
});


test('uses the approved provisional ceiling for 4K HDR only',()=>{
  assert.deepEqual(p.testPolicy({width:3840,height:2160,isHdr:true}),[18,22]);
  assert.deepEqual(p.testPolicy({width:1920,height:1080,isHdr:true}),[19]);
});


test('HDR classification blocks Dolby Vision and ambiguous color tags',()=>{
  assert.equal(typeof p.testClassify,'function','HDR classifier missing');
  const pq={color_primaries:'bt2020',color_transfer:'smpte2084',color_space:'bt2020nc'};
  assert.equal(p.testClassify(pq,{HDR_Format:'Dolby Vision / SMPTE ST 2086',HDR_Format_Compatibility:'HDR10'}),'unsupported');
  assert.equal(p.testClassify(pq,{}),'unsupported');
  assert.equal(p.testClassify(pq,{HDR_Format:'SMPTE ST 2086',HDR_Format_Compatibility:'HDR10'}),'hdr10');
  assert.equal(p.testClassify({color_transfer:'bt709'},{}),'sdr');
});

test('HDR10 validation requires unchanged PQ colors and static metadata',()=>{
  assert.equal(typeof p.testHdr,'function','HDR10 output validation missing');
  const mastering={side_data_type:'Mastering display metadata',red_x:'17/25',red_y:'8/25',green_x:'53/200',green_y:'69/100',blue_x:'3/20',blue_y:'3/50',white_point_x:'3127/10000',white_point_y:'329/1000',min_luminance:'1/200',max_luminance:'1000/1'};
  const light={side_data_type:'Content light level metadata',max_content:1000,max_average:250};
  const v={color_primaries:'bt2020',color_transfer:'smpte2084',color_space:'bt2020nc',side_data_list:[mastering,light]};
  assert.doesNotThrow(()=>p.testHdr(v,v));
  assert.throws(()=>p.testHdr(v,{...v,color_transfer:'bt709'}),/color/i);
  assert.throws(()=>p.testHdr(v,{...v,side_data_list:[mastering]}),/metadata/i);
  assert.throws(()=>p.testHdr(v,{...v,side_data_list:[mastering,{...light,max_content:400}]}),/metadata/i);
});

test('successful completion output has a dedicated non-replacement terminal',()=>{
  const edge=flow.flowEdges.find(e=>e.source==='arc_av1_monolithic' && e.sourceHandle==='4');
  assert.ok(edge,'completion output is unconnected');
  assert.notEqual(edge.target,'replace_original');
  assert.equal(flow.flowEdges.some(e=>e.source===edge.target),false);
});

test('successful output validation rejects a missing V4 completion marker',async()=>{
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

test('source video guard prevents chroma, depth and interlace loss',()=>{
 assert.equal(typeof p.testVideoGuard,'function');
 assert.doesNotThrow(()=>p.testVideoGuard({pix_fmt:'yuv420p10le',field_order:'progressive'}));
 assert.throws(()=>p.testVideoGuard({pix_fmt:'yuv444p10le'}),/pixel/i);
 assert.throws(()=>p.testVideoGuard({pix_fmt:'yuv420p12le'}),/pixel/i);
 assert.throws(()=>p.testVideoGuard({pix_fmt:'yuv420p',field_order:'tt'}),/interlac/i);
});

test('output keeps an explicitly signaled sample aspect ratio',()=>{
 assert.equal(typeof p.testAspect,'function');
 assert.doesNotThrow(()=>p.testAspect({sample_aspect_ratio:'4:3'},{sample_aspect_ratio:'8:6'}));
 assert.throws(()=>p.testAspect({sample_aspect_ratio:'4:3'},{sample_aspect_ratio:'1:1'}),/aspect/i);
});

test('ambiguous field order and unknown source aspect ratio are held',()=>{
  assert.throws(()=>p.testVideoGuard({codec_name:'h264',pix_fmt:'yuv420p',field_order:'unknown'}),/field order/i);
  assert.doesNotThrow(()=>p.testVideoGuard({codec_name:'av1',pix_fmt:'yuv420p',field_order:'unknown'}));
  assert.throws(()=>p.testAspect({sample_aspect_ratio:'N/A'},{sample_aspect_ratio:'1:1'}),/aspect/i);
});
