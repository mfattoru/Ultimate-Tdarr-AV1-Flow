const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const flowPath=path.join(__dirname,'flow.json');
const flow=JSON.parse(fs.readFileSync(flowPath));
const code=flow.flowPlugins.find(p=>p.id==='arc_av1_monolithic').inputsDB.code.replace(/https:\/\/discord\.com\/api\/webhooks\/[^"\s]+/g,'YOUR_WEBHOOK');
function engine(overrides={}) {
  const m={exports:{}};
  const r=name=>name==='fs'&&overrides.fs ? overrides.fs : name==='child_process'&&overrides.child ? overrides.child : require(name);
  new Function('require','module','exports',code+'\nmodule.exports.testValidate = validateOutput; module.exports.testFreeSpace = getFreeSpaceMB; module.exports.testRequiredCache = typeof requiredDiskSpaceMB === \"function\" ? requiredDiskSpaceMB : null; module.exports.testAcquire = typeof acquireCapacityLock === \"function\" ? acquireCapacityLock : null; module.exports.testRelease = typeof releaseCapacityLock === \"function\" ? releaseCapacityLock : null;')(r,m,m.exports);
  return m.exports;
}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tdarr-regress-'));
process.env.TDARR_CAPACITY_LOCK_DIR=dir;
async function runEngine(fn,args){try{return await fn(args);}finally{if(fn.testRelease)fn.testRelease(args.variables,()=>{});}}
process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));
function createVideo(file, videoSeconds, options={}) {
  let a=['-hide_banner','-loglevel','error','-f','lavfi','-i',`testsrc2=size=640x360:rate=24:duration=${videoSeconds}`,'-f','lavfi','-i',`sine=frequency=440:duration=${options.audioSeconds || 10}`];
  if(options.twoAudio) a.push('-f','lavfi','-i','sine=frequency=880:duration=10','-map','0:v','-map','1:a','-map','2:a');
  if(options.av1) a.push('-c:v','libsvtav1','-preset','12','-svtav1-params','lp=1:log-level=0'); else a.push('-c:v','libx264');
  a.push('-c:a',options.twoAudio?'ac3':'aac'); if(options.twoAudio) a.push('-b:a','192k');
  a.push('-y',file);child.execFileSync('ffmpeg',a,{stdio:'ignore'});
}
function probe(file){return JSON.parse(child.execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));}
const full=path.join(dir,'full.mkv'),short=path.join(dir,'short.mkv'),shortAudio=path.join(dir,'short-audio.mkv'),av1=path.join(dir,'audio.mkv');
createVideo(full,10);createVideo(short,2);createVideo(shortAudio,10,{audioSeconds:2});createVideo(av1,10,{av1:true,twoAudio:true});
function argsFor(file){const d=probe(file),f={_id:file,file,container:'mkv',file_size:fs.statSync(file).size/1024/1024,fileNameWithoutExtension:path.parse(file).name,ffProbeData:d};return {inputFileObj:f,originalLibraryFile:{...f},workDir:dir,variables:{user:{min_cache_free_mb:1}},ffmpegPath:'ffmpeg',librarySettings:{folder:dir},jobLog:()=>{}};}

test('rejects a short video even when output audio keeps container duration unchanged',async()=>{
  const validate=engine().testValidate;
  await assert.rejects(()=>Promise.resolve().then(()=>validate('ffprobe',full,short,{codec:'h264',audio:1,subtitle:0,audioCodecs:['aac'],subtitleCodecs:[],sourceVideoIndex:0})),/video.*(duration|timeline|short)|duration.*video/i);
});

test('retains different audio tracks sharing metadata and bitrate',async()=>{
  const r=await runEngine(engine(),argsFor(av1));
  assert.equal(r.outputNumber,1);
  assert.equal(probe(r.outputFileObj._id).streams.filter(s=>s.codec_type==='audio').length,2);
});

test('rejects cache candidates when free space is unknown',async()=>{
  const fakeFs=new Proxy(fs,{get(t,p){if(p==='statfsSync') return ()=>{throw Error('unavailable')};if(p==='existsSync')return x=>x==='/dev/shm'?false:t.existsSync(x);return t[p]}});
  const fakeChild={...child,execFileSync:(cmd,...a)=>{if(cmd==='df')throw Error('unavailable');return child.execFileSync(cmd,...a)}};
  let failed=false;try{const r=await runEngine(engine({fs:fakeFs,child:fakeChild}),argsFor(av1));failed=r.outputNumber===2;}catch(e){failed=/space/i.test(e.message)}
  assert.ok(failed,'must not start a job when cache space cannot be determined');
});

test('does not replace when original changes during encoding',async()=>{
  const original=path.join(dir,'changed.mkv');fs.copyFileSync(av1,original);
  const fakeChild={...child,spawnSync:(cmd,argv,opts)=>{const result=child.spawnSync(cmd,argv,opts);if(argv.includes('-i'))fs.appendFileSync(original,Buffer.from([0]));return result;}};
  const r=await runEngine(engine({child:fakeChild}),argsFor(original));
  assert.equal(r.outputNumber,2);
});

test('flow has real error handler and no nonexistent replacement output',()=>{
  assert.equal(flow.flowEdges.some(e=>e.source==='replace_original'&&e.sourceHandle==='2'),false);
  const onError=flow.flowPlugins.find(p=>p.pluginName==='onFlowError');
  assert.ok(onError,'missing On Flow Error');
  assert.ok(flow.flowEdges.some(e=>e.source===onError.id&&/cleanup/.test(e.target)));
});

test('failed full video decode prevents validation',async()=>{
  const validate=engine().testValidate;
  await assert.rejects(()=>Promise.resolve().then(()=>validate('ffprobe',full,full,{codec:'h264',audio:1,subtitle:0,audioCodecs:['aac'],subtitleCodecs:[],sourceVideoIndex:0,ffmpegBin:'/usr/bin/false'})),/failed/i);
});

test('flow rechecks the original immediately before replacement',async()=>{
  const guard=flow.flowPlugins.find(p=>p.id==='original_recheck');
  assert.ok(guard,'missing pre-replacement original check');
  assert.ok(flow.flowEdges.some(e=>e.source==='arc_av1_monolithic'&&e.sourceHandle==='1'&&e.target===guard.id));
  assert.ok(flow.flowEdges.some(e=>e.source===guard.id&&e.sourceHandle==='1'&&e.target==='replace_original'));
});

test('error-handler cleanup does not loop through Fail Flow',()=>{
  const e=flow.flowEdges.find(x=>x.source==='on_flow_error');
  assert.ok(e);
  assert.equal(flow.flowEdges.some(x=>x.source===e.target&&x.target==='fail_flow'),false);
});


test('cache jobs acquire a shared lock instead of checking capacity concurrently', async()=>{
  const e=engine();
  assert.equal(typeof e.testAcquire,'function','missing shared capacity coordination');
  const root=fs.mkdtempSync(path.join(dir,'locks-'));
  const a={user:{}}, b={user:{}};
  await e.testAcquire(root,a,()=>{});
  let acquired=false;
  const second=e.testAcquire(root,b,()=>{},5000,10).then(()=>{acquired=true;});
  await new Promise(r=>setTimeout(r,50));
  assert.equal(acquired,false);
  e.testRelease(a,()=>{});
  await second;
  assert.equal(acquired,true);
  e.testRelease(b,()=>{});
});


test('pre-replacement guard catches a changed original',async()=>{
  const original=path.join(dir,'guard.mkv');fs.copyFileSync(av1,original);
  const args=argsFor(original), result=await runEngine(engine(),args);
  assert.equal(result.outputNumber,1);
  const guardCode=flow.flowPlugins.find(p=>p.id==='original_recheck').inputsDB.code;
  const m={exports:{}};new Function('require','module','exports',guardCode)(require,m,m.exports);
  const guardArgs={inputFileObj:result.outputFileObj,originalLibraryFile:args.originalLibraryFile,variables:result.variables,jobLog:()=>{}};
  assert.equal((await m.exports(guardArgs)).outputNumber,1);
  fs.appendFileSync(original,Buffer.from([0]));
  assert.equal((await m.exports(guardArgs)).outputNumber,2);
});

test('pre-replacement guard refuses a different existing destination',async()=>{
  const original=path.join(dir,'collision.mp4');fs.copyFileSync(full,original);
  const s=fs.statSync(original,{bigint:true});
  const snapshot={path:original,realPath:fs.realpathSync(original),dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs)};
  const occupied=path.join(dir,'collision.mkv');fs.writeFileSync(occupied,'other file');
  const guardCode=flow.flowPlugins.find(p=>p.id==='original_recheck').inputsDB.code;
  const m={exports:{}};new Function('require','module','exports',guardCode)(require,m,m.exports);
  const r=await m.exports({inputFileObj:{_id:path.join(dir,'elsewhere','collision.mkv')},originalLibraryFile:{_id:original},variables:{user:{original_snapshot:snapshot}},jobLog:()=>{}});
  assert.equal(r.outputNumber,2);assert.equal(fs.readFileSync(occupied,'utf8'),'other file');
});

test('successful ISO deletion selects the Arr scan path',async()=>{
  const iso=path.join(dir,'fixture.iso');fs.writeFileSync(iso,'fixture');
  const args=argsFor(av1);args.inputFileObj={_id:iso,container:'iso'};args.originalLibraryFile={_id:iso,file_size:1};
  const r=await engine()(args);assert.equal(r.outputNumber,3);assert.equal(fs.existsSync(iso),false);
  assert.ok(flow.flowEdges.some(e=>e.source==='arc_av1_monolithic'&&e.sourceHandle==='3'&&e.target==='notify_arr_iso'));
});

test('normal cleanup releases its owned capacity lock',async()=>{
  const e=engine(), root=fs.mkdtempSync(path.join(dir,'release-')), variables={user:{}};
  await e.testAcquire(root,variables,()=>{});
  const node=flow.flowPlugins.find(p=>p.id==='cleanup_success'), m={exports:{}};
  new Function('require','module','exports',node.inputsDB.code)(require,m,m.exports);
  await m.exports({inputFileObj:{_id:full},originalLibraryFile:{_id:full},variables,jobLog:()=>{}});
  assert.equal(fs.existsSync(path.join(root,'.tdarr-av1-capacity.lock')),false);
});

test('error cleanup retains cache if original is missing and releases the lock',async()=>{
  const e=engine(),root=fs.mkdtempSync(path.join(dir,'error-')),variables={user:{}};
  await e.testAcquire(root,variables,()=>{});
  const job=fs.mkdtempSync(path.join(dir,'tdarr-av1-')),output=path.join(job,'output.mkv');fs.writeFileSync(output,'cache');
  variables.user.safety_temp_dir=job;variables.user.safety_temp_output=output;
  const node=flow.flowPlugins.find(p=>p.id==='cleanup_on_error'),m={exports:{}};
  new Function('require','module','exports',node.inputsDB.code)(require,m,m.exports);
  await m.exports({inputFileObj:{_id:output},originalLibraryFile:{_id:path.join(dir,'not-there.mkv')},variables,jobLog:()=>{}});
  assert.equal(fs.existsSync(output),true);
  assert.equal(fs.existsSync(path.join(root,'.tdarr-av1-capacity.lock')),false);
});


test('df fallback reads available blocks despite leading whitespace',()=>{
  const fakeFs=new Proxy(fs,{get(t,p){if(p==='statfsSync')return ()=>{throw Error('unsupported')};return t[p]}});
  const fakeChild={...child,execFileSync:(cmd,...args)=>cmd==='df'?'Filesystem 1024-blocks Used Available Capacity Mounted on\n  /dev/test 100000 90000 10000 90% /cache\n':child.execFileSync(cmd,...args)};
  assert.equal(engine({fs:fakeFs,child:fakeChild}).testFreeSpace('/cache'),9);
});

test('lock cleanup cannot release another job owner',async()=>{
  const e=engine(),root=fs.mkdtempSync(path.join(dir,'owner-')),a={user:{}};
  await e.testAcquire(root,a,()=>{});
  const b={user:{capacity_lock:{...a.user.capacity_lock,token:'different'}}};
  e.testRelease(b,()=>{});
  assert.equal(fs.existsSync(path.join(root,'.tdarr-av1-capacity.lock')),true);
  e.testRelease(a,()=>{});
});


test('rejects truncated audio even when the video and container are full length',async()=>{
  const validate=engine().testValidate;
  await assert.rejects(()=>Promise.resolve().then(()=>validate('ffprobe',full,shortAudio,{codec:'h264',audio:1,subtitle:0,audioCodecs:['aac'],subtitleCodecs:[],sourceVideoIndex:0,audioIndices:[1],subtitleIndices:[]})),/audio.*(duration|timeline|end)/i);
});

test('failure cleanup retains validated output if the original has vanished',async()=>{
  const e=engine(),root=fs.mkdtempSync(path.join(dir,'gone-')),variables={user:{}};
  await e.testAcquire(root,variables,()=>{});
  const job=fs.mkdtempSync(path.join(dir,'tdarr-av1-')),output=path.join(job,'output.mkv');fs.writeFileSync(output,'cache');
  variables.user.safety_temp_dir=job;variables.user.safety_temp_output=output;
  const node=flow.flowPlugins.find(p=>p.id==='cleanup_failure'),m={exports:{}};
  new Function('require','module','exports',node.inputsDB.code)(require,m,m.exports);
  await m.exports({inputFileObj:{_id:output},originalLibraryFile:{_id:path.join(dir,'not-there.mkv')},variables,jobLog:()=>{}});
  assert.equal(fs.existsSync(output),true);
  assert.equal(fs.existsSync(path.join(root,'.tdarr-av1-capacity.lock')),false);
});

test('cache admission leaves the configured free-space floor after its output estimate',()=>{
  const required=engine().testRequiredCache;
  assert.equal(typeof required,'function','missing reserved-floor calculation');
  assert.equal(required(12000,20000),35000);
});

test('subtitle timeline validation detects a missing final subtitle event',async()=>{
  const completeSrt=path.join(dir,'complete.srt'),partialSrt=path.join(dir,'partial.srt');
  const first='1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n', second='2\n00:00:07,000 --> 00:00:08,000\nSecond\n\n';
  fs.writeFileSync(completeSrt,first+second);fs.writeFileSync(partialSrt,first);
  const source=path.join(dir,'sub-source.mkv'),out=path.join(dir,'sub-short.mkv');
  for (const [sub,dest] of [[completeSrt,source],[partialSrt,out]]) child.execFileSync('ffmpeg',['-v','error','-i',full,'-f','srt','-i',sub,'-map','0','-map','1','-c','copy','-c:s','srt','-y',dest],{stdio:'ignore'});
  const validate=engine().testValidate;
  const expected={codec:'h264',audio:1,subtitle:1,audioCodecs:['aac'],subtitleCodecs:['subrip'],sourceVideoIndex:0,audioIndices:[1],subtitleIndices:[2]};
  await assert.doesNotReject(()=>validate('ffprobe',source,source,expected));
  await assert.rejects(()=>validate('ffprobe',source,out,expected),/subtitle.*(timeline|packet)/i);
});

test('cache setup exceptions take the cleanup route with lock ownership',async()=>{
  const fakeFs=new Proxy(fs,{get(t,p){if(p==='mkdtempSync')return ()=>{throw Error('cannot create cache')};return t[p]}});
  const fn=engine({fs:fakeFs}),args=argsFor(av1);
  const result=await runEngine(fn,args);
  assert.equal(result.outputNumber,2);
});

test('subtitle validation detects an omitted middle subtitle event',async()=>{
  const sourceSrt=path.join(dir,'three.srt'),outSrt=path.join(dir,'two.srt');
  const first='1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n',middle='2\n00:00:04,000 --> 00:00:05,000\nMiddle\n\n',last='3\n00:00:07,000 --> 00:00:08,000\nLast\n\n';
  fs.writeFileSync(sourceSrt,first+middle+last);fs.writeFileSync(outSrt,first+last);
  const source=path.join(dir,'sub-three.mkv'),out=path.join(dir,'sub-two.mkv');
  for(const [sub,dest] of [[sourceSrt,source],[outSrt,out]])child.execFileSync('ffmpeg',['-v','error','-i',full,'-f','srt','-i',sub,'-map','0','-map','1','-c','copy','-c:s','srt','-y',dest],{stdio:'ignore'});
  const expected={codec:'h264',audio:1,subtitle:1,audioCodecs:['aac'],subtitleCodecs:['subrip'],sourceVideoIndex:0,audioIndices:[1],subtitleIndices:[2]};
  await assert.rejects(()=>engine().testValidate('ffprobe',source,out,expected),/subtitle.*(packet|event|timeline)/i);
});

test('ISO deletion failure does not trigger an Arr rescan',async()=>{
  const iso=path.join(dir,'bad.iso');fs.writeFileSync(iso,'fixture');
  const args=argsFor(av1);args.inputFileObj={_id:iso,container:'iso'};args.originalLibraryFile={_id:path.join(dir,'different.iso'),file_size:1};
  const r=await engine()(args);assert.equal(r.outputNumber,2);assert.equal(fs.existsSync(iso),true);
});

test('ISO notifier selects Radarr, Sonarr TV, and Sonarr Anime correctly',async()=>{
  const {EventEmitter}=require('node:events');
  const notifierCode=flow.flowPlugins.find(p=>p.id==='notify_arr_iso').inputsDB.code;
  for(const [category,port,list,command,key] of [['movies',7878,'/api/v3/movie','RescanMovie','movieId'],['tv',8989,'/api/v3/series','RescanSeries','seriesId'],['anime',8990,'/api/v3/series','RescanSeries','seriesId']]){
    const requests=[];
    const http={request(options,callback){const req=new EventEmitter();let body='';req.write=x=>body+=x;req.setTimeout=()=>{};req.destroy=()=>{};req.end=()=>process.nextTick(()=>{requests.push({port:Number(options.port),path:options.path,method:options.method,body});const res=new EventEmitter();res.statusCode=200;callback(res);res.emit('data',options.method==='GET'?JSON.stringify([{id:42,path:`/mnt/media/${category}/Title`,title:'Title'}]):'{}');res.emit('end');});return req;}};
    const m={exports:{}},fakeRequire=name=>(name==='http'||name==='https')?http:require(name);
    new Function('require','module','exports',notifierCode)(fakeRequire,m,m.exports);
    const iso=`/mnt/media/${category}/Title/disc.iso`;
    await m.exports({inputFileObj:{_id:iso},originalLibraryFile:{_id:iso},variables:{user:{}},jobLog:()=>{}});
    assert.equal(requests.length,2);assert.equal(requests[0].port,port);assert.equal(requests[0].path,list);assert.equal(requests[1].path,'/api/v3/command');assert.deepEqual(JSON.parse(requests[1].body),{name:command,[key]:42});
  }
});

test('existing surround-to-EAC3 conversion still passes validation',async()=>{
  const source=path.join(dir,'surround.mkv');
  child.execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=5','-f','lavfi','-i','anullsrc=channel_layout=5.1:sample_rate=48000','-t','5','-c:v','libsvtav1','-preset','12','-svtav1-params','lp=1:log-level=0','-c:a','flac','-y',source],{stdio:'ignore'});
  const r=await runEngine(engine(),argsFor(source));assert.equal(r.outputNumber,1);
  assert.equal(probe(r.outputFileObj._id).streams.find(s=>s.codec_type==='audio').codec_name,'eac3');
});

test('existing ASS-to-SRT normalization still passes validation',async()=>{
  const subtitle=path.join(dir,'sample.ass'),source=path.join(dir,'ass.mkv');
  fs.writeFileSync(subtitle,`[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,First\nDialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,Second\n`);
  child.execFileSync('ffmpeg',['-v','error','-i',av1,'-f','ass','-i',subtitle,'-map','0','-map','1','-c','copy','-c:s','ass','-metadata:s:s:0','language=eng','-y',source],{stdio:'ignore'});
  const r=await runEngine(engine(),argsFor(source));assert.equal(r.outputNumber,1);
  assert.equal(probe(r.outputFileObj._id).streams.find(s=>s.codec_type==='subtitle').codec_name,'subrip');
});

test('rejects a cache with known insufficient free space',async()=>{
  const fakeFs=new Proxy(fs,{get(t,p){if(p==='statfsSync')return ()=>({bavail:1n,bsize:1024n});if(p==='existsSync')return x=>x==='/dev/shm'?false:t.existsSync(x);return t[p]}});
  const result=await runEngine(engine({fs:fakeFs}),argsFor(av1));
  assert.equal(result.outputNumber,2);
});
