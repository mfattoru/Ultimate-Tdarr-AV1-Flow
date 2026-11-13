const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const {runFlowCode} = require('./flow_test_runtime');
const flow=JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flow.json')));
const code=flow.flowPlugins.find(p=>p.id==='arc_av1_monolithic').inputsDB.code.replace(/https:\/\/discord\.com\/api\/webhooks\/[^"\s]+/g,'YOUR_WEBHOOK');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tdarr-v4-integration-'));
process.env.TDARR_RESERVATION_ROOT=dir;
process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));
const source=path.join(dir,'source.mkv'),candidate=path.join(dir,'candidate.mkv');
child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libsvtav1','-preset','12','-crf','10','-svtav1-params','lp=1:log-level=0','-c:a','aac','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-bsf:v','av1_metadata=color_primaries=1:transfer_characteristics=1:matrix_coefficients=1','-metadata','encoded_by=ArcAV1_QSV','-y',source],{stdio:'ignore'});
child.execFileSync('ffmpeg',['-v','error','-i',source,'-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-c:a','copy','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-bsf:v','av1_metadata=color_primaries=1:transfer_characteristics=1:matrix_coefficients=1','-metadata','encoded_by=ArcAV1_QSV_V15','-y',candidate],{stdio:'ignore'});
assert.ok(fs.statSync(candidate).size < fs.statSync(source).size);
const multiAudioSource=path.join(dir,'two-audio-source.mkv'),multiAudioCandidate=path.join(dir,'two-audio-candidate.mkv');
child.execFileSync('ffmpeg',['-v','error','-i',source,'-map','0:0','-map','0:1','-map','0:1','-c','copy','-metadata:s:a:0','language=eng','-metadata:s:a:1','language=jpn','-y',multiAudioSource],{stdio:'ignore'});
child.execFileSync('ffmpeg',['-v','error','-i',multiAudioSource,'-map','0','-c:v','libsvtav1','-preset','12','-crf','45','-svtav1-params','lp=1:log-level=0','-c:a','copy','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',multiAudioCandidate],{stdio:'ignore'});
assert.ok(fs.statSync(multiAudioCandidate).size < fs.statSync(multiAudioSource).size);
function argsFor(file,logs=[]) { const f={_id:file,container:'mkv',file_size:fs.statSync(file).size/1024/1024}; return {inputFileObj:{...f},originalLibraryFile:{...f},workDir:dir,variables:{user:{min_cache_free_mb:1}},ffmpegPath:'ffmpeg',librarySettings:{folder:dir},jobLog:m=>logs.push(String(m))}; }
function load({sourceDiagnosticChunks,qsvValidationFailure=false,qsvTimestampFailure=false,cpuValidationFailure=false,dropCandidateAudio=false,alwaysLarge=false,failEncoding=false,failRemux=false,remuxBloat=false,missingPrlimit=false,limitOnFirst=false,uhd=false,mediainfo=true,missingSourceSar=false,mediaInfoPixelAspectRatio,hdr=false,extraVideo=false,extraVideoFrames=1,denyIso=false,sourceCorruption=false,sourceCorruptionDiagnostic='[Source media corruption] [h264] Invalid NAL unit size (999 > 8)',forceSourceAudioBatchFailure=false,corruptSourceAudioStream='0:2',moveDuringSourceScan=false,changeMovedContent=false,subtitleDtsRegression=false,inputPath=source,smallerOutput=candidate}={}) {
  const calls=[],commands=[],logs=[],audioDecodeCommands=[]; let initialProbe=true,moverSimulated=false;
  const fakeFs=new Proxy(fs,{get(t,p){if(p==='unlinkSync' && denyIso)return name=>{if(String(name).endsWith('.iso'))throw Error('simulated ISO permission error');return t.unlinkSync(name)};if(p==='accessSync')return (name,...args)=>name==='/dev/dri/renderD129'?undefined:t.accessSync(name,...args);return t[p]}});
  const fakeChild={...child,
    spawn(cmd,args,opts){
      if(subtitleDtsRegression&&cmd==='ffprobe'&&args.includes('-show_packets')&&args.includes('-select_streams')&&args[args.indexOf('-select_streams')+1]==='s'&&args.includes(inputPath)){
        const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
        const process=new EventEmitter();process.stdout=new PassThrough();process.stderr=new PassThrough();process.kill=()=>{};
        queueMicrotask(()=>{process.stdout.end([0,2.5,5,1.86].map(v=>`stream_index=2|pts_time=${v}|dts_time=${v}`).join('\n')+'\n');process.stderr.end();process.emit('close',0,null);});
        return process;
      }
      const candidateVideoDecode=cmd==='ffmpeg'&&args.includes('-f')&&args[args.indexOf('-f')+1]==='null'&&args.includes('-progress')&&args[args.indexOf('-i')+1]!==inputPath&&args[args.indexOf('-map')+1]==='0:0';
      if(candidateVideoDecode&&(((qsvValidationFailure||qsvTimestampFailure)&&args.includes('-hwaccel'))||(cpuValidationFailure&&!args.includes('-hwaccel')))){
        const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
        const process=new EventEmitter();process.stdout=new PassThrough();process.stderr=new PassThrough();process.kill=()=>{};
        queueMicrotask(()=>{process.stdout.end();process.stderr.end(args.includes('-hwaccel')?(qsvTimestampFailure?'[null @ 0x1234] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 5 >= 5':'Device creation failed: unavailable Arc device'):'Cannot allocate memory');process.emit('close',1,null);});
        return process;
      }
      if(cmd==='ffmpeg'&&args.includes('-frames:v')&&extraVideo){
        const mapIndex=args.indexOf('-map'),map=mapIndex>=0?args[mapIndex+1]:'';
        if(map==='0:999'){
          const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
          const process=new EventEmitter();process.stdout=new PassThrough();process.stderr=new PassThrough();process.kill=()=>{};
          queueMicrotask(()=>{process.stdout.end(`frame=${extraVideoFrames}\nfps=0.00\nprogress=end\n`);process.stderr.end();process.emit('close',0,null);});
          return process;
        }
      }
      if(cmd==='ffprobe'&&moveDuringSourceScan&&args.includes('-show_frames')&&args.includes(inputPath)){
        const process=child.spawn(cmd,args,opts);
        process.once('close',()=>{
          if(moverSimulated)return;
          moverSimulated=true;
          const movedCopy=`${inputPath}.mover-copy`;
          child.execFileSync('cp',['-p',inputPath,movedCopy]);
          if(changeMovedContent){const bytes=fs.readFileSync(movedCopy);bytes[bytes.length-1]^=1;fs.writeFileSync(movedCopy,bytes);child.execFileSync('touch',['-r',inputPath,movedCopy]);}
          fs.renameSync(movedCopy,inputPath);
        });
        return process;
      }
      if(cmd==='ffmpeg'&&args.includes('-f')&&args[args.indexOf('-f')+1]==='null'&&!args.includes('-hwaccel')&&!args.includes('-frames:v')){
        const input=args[args.indexOf('-i')+1],maps=[];
        for(let i=0;i<args.length-1;i++)if(args[i]==='-map'&&String(args[i+1]).startsWith('0:'))maps.push(args[i+1]);
        audioDecodeCommands.push({input,maps,hasProgress:args.includes('-progress'),args:[...args]});
        if(forceSourceAudioBatchFailure&&input===inputPath&&args.includes('-progress')){
          const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
          const process=new EventEmitter();process.stdout=new PassThrough();process.stderr=new PassThrough();process.kill=()=>{};
          const fail=maps.length>1||maps.includes(corruptSourceAudioStream);
          queueMicrotask(()=>{process.stdout.end();process.stderr.end(fail?'[aac] Error while decoding stream: Invalid data found when processing input':'');process.emit('close',fail?1:0,null);});
          return process;
        }
      }
      if(cmd==='ffprobe'&&sourceCorruption){
        const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
        const process=new EventEmitter();process.stdout=new PassThrough();process.stderr=new PassThrough();process.kill=()=>{};
        queueMicrotask(()=>{process.stdout.end('frame|best_effort_timestamp_time=0|interlaced_frame=0\n');for(const chunk of sourceDiagnosticChunks || [sourceCorruptionDiagnostic+'\n'])process.stderr.write(chunk);process.stderr.end();process.emit('close',0,null);});
        return process;
      }
      // The local runner has no Arc device. Exercise validation wiring here;
      // the existing Unraid test container verifies the actual QSV decode.
      if(cmd==='ffmpeg'&&args.includes('-hwaccel')&&args[args.indexOf('-hwaccel')+1]==='qsv'){
        const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
        const process=new EventEmitter();process.stdout=new PassThrough();process.stderr=new PassThrough();process.kill=()=>{};
        queueMicrotask(()=>{process.stdout.end('out_time_us=2000000\nfps=24\nprogress=continue\nout_time_us=4000000\nfps=24\nprogress=end\n');process.stderr.end();process.emit('close',0,null);});
        return process;
      }
      if(cmd!=='prlimit')return child.spawn(cmd,args,opts);
      const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
      const process=new EventEmitter();process.stdout=new PassThrough();process.stderr=new PassThrough();process.kill=()=>{};
      commands.push({cmd,args});
      queueMicrotask(()=>{
        if(missingPrlimit){process.emit('error',Error('spawn prlimit ENOENT'));process.emit('close',null,null);return;}
        const av=args.slice(args.indexOf('--')+2),qi=av.indexOf('-global_quality'),q=Number(av[qi+1]);if(qi>=0)calls.push(q);
        if(qi<0){
          if(failRemux){process.stderr.write('Metadata: subtitle details\nPress [q] to stop, [?] for help\n');process.emit('close',1,null);return;}
          const output=av[av.length-1],remuxArgs=['-v','error','-i',inputPath,'-map','0','-c','copy','-metadata:g','encoded_by=ArcAV1_SeekHeal_V15'];
          if(remuxBloat)remuxArgs.push('-metadata:g',`comment=${'x'.repeat(2048)}`);
          remuxArgs.push('-y',output);child.execFileSync('ffmpeg',remuxArgs,{stdio:'ignore'});
          const limitArg=args.find(x=>String(x).startsWith('--fsize=')),limit=limitArg?Number(String(limitArg).split('=')[1].split(':')[0]):Number.MAX_SAFE_INTEGER;
          if(fs.statSync(output).size>limit){process.emit('close',null,'SIGXFSZ');return;}
          process.stdout.write('out_time_us=2000000\nfps=24\nprogress=continue\n');process.emit('close',0,null);return;
        }
        process.stdout.write('out_time_us=2000000\nfps=24\nprogress=continue\n');
        if(limitOnFirst&&q===22){fs.copyFileSync(source,av[av.length-1]);process.emit('close',null,'SIGXFSZ');return;}
        if(failEncoding){process.stderr.write('simulated failure');process.emit('close',1,null);return;}
        if(dropCandidateAudio)child.execFileSync('ffmpeg',['-v','error','-i',smallerOutput,'-map','0:0','-c','copy','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',av[av.length-1]],{stdio:'ignore'});
        else fs.copyFileSync(alwaysLarge||q===20?inputPath:smallerOutput,av[av.length-1]);process.emit('close',0,null);
      });
      return process;
    },
    execFileSync(cmd,args,opts){
      if(cmd==='mediainfo') {
        if(!mediainfo) throw Error('no mediainfo');
   const video={'@type':'Video',StreamOrder:'0',...(mediaInfoPixelAspectRatio===undefined?{}:{PixelAspectRatio:mediaInfoPixelAspectRatio}),...(hdr?{HDR_Format:'SMPTE ST 2086',HDR_Format_Compatibility:'HDR10'}:{transfer_characteristics:'BT.709'})};
        const tracks=[video];if(extraVideo)tracks.push({'@type':'Video',StreamOrder:'999',Format:'AV1'});
        return JSON.stringify({media:{track:tracks}});
      }
      const result=child.execFileSync(cmd,args,opts);
      if(cmd==='ffprobe') {
        const probe=JSON.parse(result);
   if(missingSourceSar && args[args.length-1]===inputPath) for(const stream of probe.streams||[]) if(stream.codec_type==='video') delete stream.sample_aspect_ratio;
        for(const stream of probe.streams||[])if(stream.codec_type==='video')Object.assign(stream,hdr?{color_transfer:'smpte2084',color_primaries:'bt2020',color_space:'bt2020nc',color_range:'tv'}:{color_transfer:'bt709',color_primaries:'bt709',color_space:'bt709',color_range:'tv'});
        if(initialProbe && args.includes('-show_format') && args[args.length-1]===inputPath) {
          initialProbe=false;
          const video=probe.streams.find(s=>s.codec_type==='video');video.width=uhd?3840:1920;video.height=uhd?2160:1080;
          if(extraVideo)probe.streams.push({index:999,codec_type:'video',codec_name:'av1',disposition:{attached_pic:0,timed_thumbnails:0}});
        }
        return JSON.stringify(probe);
      }
      return result;
    },
    spawnSync(cmd,args,opts){
      if(cmd==='prlimit' && args.includes('--')) { commands.push({cmd,args}); if(missingPrlimit)return {status:null,error:Error('spawn prlimit ENOENT')}; args=args.slice(args.indexOf('--')+2);cmd='ffmpeg'; }
      if(cmd==='ffmpeg' && args.includes('av1_qsv')) {
        const qi=args.indexOf('-global_quality'),q=Number(args[qi+1]);if(qi>=0)calls.push(q);
        if(limitOnFirst && q===19) {fs.copyFileSync(inputPath,args[args.length-1]);return {status:null,signal:'SIGXFSZ',stderr:''};}
        if(failEncoding)return {status:1,stderr:'simulated failure'};
        fs.copyFileSync(alwaysLarge || q===19 ? inputPath : smallerOutput,args[args.length-1]);
        return {status:0,stderr:''};
      }
      return child.spawnSync(cmd,args,opts);
    }
  };
  const m={exports:{}}; const req=n=>n==='fs'?fakeFs:n==='child_process'?fakeChild:require(n);
  runFlowCode(['require','module','exports'],code,[req,m,m.exports]);
  return {fn:m.exports,calls,commands,logs,audioDecodeCommands,moverSimulated:()=>moverSimulated};
}
async function run(x,args) {try{return await x.fn(args);}finally{const h=args.variables?.user?.cache_reservation;if(h){await x.fn.releaseForTest(h);delete args.variables.user.cache_reservation;}}}

test('quarantined retries reuse full video and retained-audio prechecks while repeating candidate validation',async()=>{
 const library=path.join(dir,'precheck-cache-library');fs.mkdirSync(library,{recursive:true});
 const input=path.join(library,'cached-source.mkv');fs.copyFileSync(source,input);
 const first=load({inputPath:input,qsvValidationFailure:true,cpuValidationFailure:true});
 const firstArgs=argsFor(input,first.logs);firstArgs.librarySettings.folder=library;
 const firstResult=await run(first,firstArgs);
 assert.equal(firstResult.outputNumber,2);
 assert.ok(firstArgs.variables.user.quarantine_entry,'complete candidate must be quarantined');
 assert.ok(fs.existsSync(`${firstArgs.variables.user.quarantine_entry.candidatePath}.prechecks.gz`),'complete source evidence must be cached');
 const second=load({inputPath:input,qsvValidationFailure:true,cpuValidationFailure:true});
 const secondArgs=argsFor(input,second.logs);secondArgs.librarySettings.folder=library;
 const secondResult=await run(second,secondArgs);
 assert.equal(secondResult.outputNumber,2);
 assert.ok(second.logs.some(line=>line.includes('[Source precheck] Reused')));
 assert.ok(second.logs.some(line=>line.includes('[Audio precheck] Reused')));
 assert.ok(second.logs.some(line=>line.includes('[Validation stage] video_decode:')),'candidate validation must still run');
 assert.equal(second.audioDecodeCommands.some(command=>command.input===input),false,'source audio must not be decoded again');
 const cachePath=`${firstArgs.variables.user.quarantine_entry.candidatePath}.prechecks.gz`;
 const envelope=JSON.parse(require('zlib').gunzipSync(fs.readFileSync(cachePath)));
 const cached=JSON.parse(envelope.payload);
 cached.data.audio.streams[0].timeBase='1/999';
 assert.equal(require('../src/precheck_cache').savePrecheckCache(firstArgs.variables.user.quarantine_entry,cached.signature,cached.data),true);
 const changedAudio=load({inputPath:input,qsvValidationFailure:true,cpuValidationFailure:true});
 const changedAudioArgs=argsFor(input,changedAudio.logs);changedAudioArgs.librarySettings.folder=library;
 assert.equal((await run(changedAudio,changedAudioArgs)).outputNumber,2);
 assert.ok(changedAudio.logs.some(line=>line.includes('[Source precheck] Reused')));
 assert.ok(changedAudio.audioDecodeCommands.some(command=>command.input===input),'a changed audio selection must be checked again');
 fs.writeFileSync(`${firstArgs.variables.user.quarantine_entry.candidatePath}.prechecks.gz`,'damaged cache');
 const third=load({inputPath:input,qsvValidationFailure:true,cpuValidationFailure:true});
 const thirdArgs=argsFor(input,third.logs);thirdArgs.librarySettings.folder=library;
 assert.equal((await run(third,thirdArgs)).outputNumber,2);
 assert.equal(third.logs.some(line=>line.includes('[Source precheck] Reused')),false);
 assert.ok(third.audioDecodeCommands.some(command=>command.input===input),'damaged evidence requires a new source-audio decode');
});

test('missing FFprobe source SAR accepts MediaInfo square pixels and validates the output',async()=>{
 const x=load({missingSourceSar:true,mediaInfoPixelAspectRatio:'1.000'}),args=argsFor(source,x.logs),result=await run(x,args);
 assert.equal(result.outputNumber,1,args.variables.user.failure_reason);
 assert.equal(args.variables.user.validation_report.stage,'complete');
});

test('missing FFprobe source SAR with non-square MediaInfo pixels stops before encoding',async()=>{
 const x=load({missingSourceSar:true,mediaInfoPixelAspectRatio:'1.333'}),args=argsFor(source,x.logs),result=await run(x,args);
 assert.equal(result.outputNumber,2);
 assert.match(args.variables.user.failure_reason,/aspect ratio/i);
 assert.equal(x.commands.some(c=>c.args.includes('av1_qsv')),false);
});

test('missing source SAR without MediaInfo pixel aspect ratio stops before encoding',async()=>{
 const x=load({missingSourceSar:true}),args=argsFor(source,x.logs),result=await run(x,args);
 assert.equal(result.outputNumber,2);
 assert.match(args.variables.user.failure_reason,/aspect ratio/i);
 assert.equal(x.commands.some(c=>c.args.includes('av1_qsv')),false);
});

test('unavailable QSV verification recovers using real full candidate CPU decode',async()=>{
 const x=load({qsvValidationFailure:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1);
 assert.equal(args.variables.user.validation_report.outcome,'recovered');
 assert.equal(args.variables.user.validation_report.stage,'complete');
 for(const stage of ['frames','video_decode','audio_decode','timelines']) assert.ok(x.logs.some(line=>line.includes(`[Validation stage] ${stage}: passed in `)),`missing ${stage} timing`);
 assert.ok(x.logs.some(line=>line.includes('[Validation decode] qsv failed')));
 assert.ok(x.logs.some(line=>line.includes('[Validation decode] software completed')));
 assert.ok(x.logs.some(line=>line.includes('[Validation frames]')&&line.includes('frames')));
 assert.ok(x.audioDecodeCommands.some(c=>c.input!==source&&c.maps.length===1&&c.maps[0]==='0:0'),'the complete candidate video must be decoded in software');
 assert.equal(args.variables.user.arr_corruption_search_status,undefined);
});
test('a null-mux timestamp diagnostic retries with isolated timestamps after clean timeline checks',async()=>{
 const x=load({qsvTimestampFailure:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1);
 assert.equal(args.variables.user.validation_report.outcome,'recovered');
 assert.equal(args.variables.user.validation_report.recoveries[0].code,'timestamp_isolated_decode');
 assert.ok(x.audioDecodeCommands.some(c=>c.input!==source&&c.args.includes('settb=expr=1/1000000,setpts=N')));
});
test('ASS subtitle fonts are mapped and missing candidate attachments prevent replacement',async()=>{
 const sub=path.join(dir,'attachment-test.ass'),font=path.join(dir,'attachment-test.ttf');
 const input=path.join(dir,'attachment-source.mkv'),valid=path.join(dir,'attachment-valid.mkv'),missing=path.join(dir,'attachment-missing.mkv');
 fs.writeFileSync(font,'example embedded font payload');
 fs.writeFileSync(sub,'[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.10,0:00:01.00,Default,,0,0,0,,Test\n');
 const make=(video,out,attach)=>child.execFileSync('ffmpeg',['-v','error','-i',video,'-i',sub,'-map','0','-map','1','-c','copy',...(attach?['-attach',font,'-metadata:s:t:0','mimetype=font/ttf']:[]),'-y',out],{stdio:'ignore'});
 make(source,input,true);make(candidate,valid,true);make(candidate,missing,false);
 const x=load({inputPath:input,smallerOutput:valid}),args=argsFor(input,x.logs),result=await run(x,args);
 assert.equal(result.outputNumber,1);
 const encode=x.commands.find(c=>c.args.includes('av1_qsv'));
 const attachment=JSON.parse(child.execFileSync('ffprobe',['-v','error','-select_streams','t','-show_entries','stream=index','-of','json',input],{encoding:'utf8'})).streams[0];
 assert.ok(encode.args.some((value,index)=>value==='-map'&&encode.args[index+1]===`0:${attachment.index}`),'encode must map the source font attachment');
 const y=load({inputPath:input,smallerOutput:missing}),badArgs=argsFor(input,y.logs),bad=await run(y,badArgs);
 assert.equal(bad.outputNumber,2);
 assert.equal(badArgs.variables.user.validation_report.failure.code,'attachment_count_mismatch');
 const z=load({inputPath:input,smallerOutput:valid,subtitleDtsRegression:true}),guardArgs=argsFor(input,z.logs);
 const held=await run(z,guardArgs);
 assert.equal(held.outputNumber,2);
 assert.match(guardArgs.variables.user.failure_reason,/subtitle guard.*3\.140/i);
 assert.equal(z.commands.some(command=>command.args.includes('av1_qsv')),false,'unsafe subtitle timing should stop before encoding');
});

test('verification process failure is inconclusive and retains the original',async()=>{
 const x=load({qsvValidationFailure:true,cpuValidationFailure:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,2);assert.equal(r.outputFileObj._id,source);
 assert.equal(args.variables.user.validation_report.outcome,'inconclusive');
 assert.equal(args.variables.user.validation_report.failure.stage,'video_decode');
 assert.match(args.variables.user.failure_reason,/\[Validation inconclusive\]/);
 assert.doesNotMatch(args.variables.user.failure_reason,/Source media corruption/);
});

test('missing retained audio remains a hard candidate rejection',async()=>{
 const x=load({dropCandidateAudio:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,2);assert.equal(r.outputFileObj._id,source);
 assert.equal(args.variables.user.validation_report.outcome,'rejected');
 assert.equal(args.variables.user.validation_report.failure.stage,'streams');
 assert.match(args.variables.user.failure_reason,/audio count 0/);
});

test('source precheck and candidate validation batch retained audio tracks into one pass',async()=>{
 const x=load({inputPath:multiAudioSource,smallerOutput:multiAudioCandidate}),args=argsFor(multiAudioSource,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1);
 const source=x.audioDecodeCommands.filter(c=>c.input===multiAudioSource&&c.hasProgress);
 assert.equal(source.length,1,'source audio precheck should launch one FFmpeg pass for all retained tracks');
 assert.deepEqual(source[0].maps,['0:1','0:2']);
 assert.equal(source[0].args.indexOf('-threads'),source[0].args.indexOf('-i')-2,'source audio decode should set decoder threads before the input');
 assert.equal(source[0].args[source[0].args.indexOf('-threads')+1],'4');
 const candidate=x.audioDecodeCommands.filter(c=>c.input!==multiAudioSource);
 assert.equal(candidate.length,1,'candidate audio validation should launch one FFmpeg pass for all retained tracks');
 assert.deepEqual(candidate[0].maps,['0:1','0:2']);
 assert.equal(candidate[0].hasProgress,true,'candidate audio validation should report progress');
 assert.equal(candidate[0].args.indexOf('-threads'),candidate[0].args.indexOf('-i')-2,'candidate audio decode should set decoder threads before the input');
 assert.equal(candidate[0].args[candidate[0].args.indexOf('-threads')+1],'4');
});

test('byte-identical cache-to-array move during source scan does not fail the engine guard',async()=>{
 const x=load({moveDuringSourceScan:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(x.moverSimulated(),true,'test hook should replace the source path after its source scan');
 assert.equal(r.outputNumber,1);
 assert.match(args.variables.user.original_snapshot.contentHash,/^[a-f0-9]{64}$/);
 assert.ok(x.logs.some(line=>line.includes('byte-for-byte identical')&&line.includes('Mover relocation')));
});

test('same-size and same-mtime replacement during source scan remains rejected',async()=>{
 const x=load({moveDuringSourceScan:true,changeMovedContent:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(x.moverSimulated(),true);
 assert.equal(r.outputNumber,2);
 assert.equal(x.calls.length,0,'a mismatched source must be rejected before encoding');
 assert.match(args.variables.user.failure_reason,/relocation verification failed: byte comparison found different contents/);
});

test('batched source audio failure isolates streams before classifying corruption',async()=>{
 const x=load({inputPath:multiAudioSource,smallerOutput:multiAudioCandidate,forceSourceAudioBatchFailure:true}),args=argsFor(multiAudioSource,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,2,'recognized source corruption should retain the original as a handled failure');
 const source=x.audioDecodeCommands.filter(c=>c.input===multiAudioSource&&c.hasProgress);
 assert.deepEqual(source.map(c=>c.maps),[['0:1','0:2'],['0:1'],['0:2']]);
 assert.match(args.variables.user.failure_reason,/\[Source media corruption\] Audio source stream 0:2 \(jpn\).*Invalid data found/i);
 assert.deepEqual(x.calls,[],'a corrupt source audio track must stop before the Arc encoder');
});

test('source corruption failure reason has a single category prefix',async()=>{
 const x=load({sourceCorruption:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,2);
 const reason=args.variables.user.failure_reason;
 assert.match(reason,/^\[Source media corruption\] \[h264\] Invalid NAL unit size/);
 assert.equal((reason.match(/\[Source media corruption\]/g)||[]).length,1);
 assert.deepEqual(x.calls,[],'confirmed source corruption should stop before the AV1 encoder');
});

test('source scanner memory errors stop before encoding without claiming source corruption',async()=>{
 const x=load({sourceCorruption:true,sourceCorruptionDiagnostic:'[av1] Error while decoding stream #0:0: Cannot allocate memory'}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,2);assert.deepEqual(x.calls,[]);
 assert.match(args.variables.user.failure_reason,/Frame scanner could not complete/);
 assert.doesNotMatch(args.variables.user.failure_reason,/\[Source media corruption\]/);
});

test('split diagnostic chunks cannot turn a scanner resource failure into source corruption',async()=>{
 const x=load({sourceCorruption:true,sourceDiagnosticChunks:['[av1] Error while decoding stream #0:0:',' Cannot allocate memory\n']}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,2);assert.deepEqual(x.calls,[]);
 assert.doesNotMatch(args.variables.user.failure_reason,/\[Source media corruption\]/);
 assert.match(args.variables.user.failure_reason,/could not complete/);
});

test('zero-frame extra video is ignored so AV1 source corruption reaches the precheck before encoding',async()=>{
 const diagnostic='[libdav1d] Invalid repeated frame header OBU. Invalid data found when processing input.';
 const x=load({extraVideo:true,extraVideoFrames:0,sourceCorruption:true,sourceCorruptionDiagnostic:diagnostic}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,2);
 assert.match(args.variables.user.failure_reason,/^\[Source media corruption\].*Invalid data found when processing input/i);
 assert.ok(x.logs.some(line=>/Video stream 999 produced zero decoded frames; ignoring this empty stream/i.test(line)));
 assert.deepEqual(x.calls,[],'recognized AV1 source corruption must stop before the Arc encoder');
});

test('old AV1 is encoded once at the global ICQ and accepts a smaller output',async()=>{
 const x=load(),args=argsFor(source),r=await run(x,args);
 assert.deepEqual(x.calls,[22]);assert.equal(r.outputNumber,1);
 assert.ok(fs.statSync(r.outputFileObj._id).size < fs.statSync(source).size);
 assert.equal(args.variables.user.original_size_mb,fs.statSync(source).size/(1024*1024));
 assert.equal(args.variables.user.final_size_mb,fs.statSync(r.outputFileObj._id).size/(1024*1024));
});

test('ASS and SSA subtitles are stream-copied through the Arc encode instead of converted to SRT',async()=>{
 for(const [extension,scriptType] of [['ass','v4.00+'],['ssa','v4.00']]){
  const input=path.join(dir,`${extension}-track-source.mkv`),output=path.join(dir,`${extension}-track-candidate.mkv`),sub=path.join(dir,`styled-track.${extension}`);
  fs.writeFileSync(sub,`[Script Info]\nScriptType: ${scriptType}\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,1,2,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.500,0:00:02.000,Default,,0,0,0,,Styled sign \u5b57\n`);
  child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-i',sub,'-map','0:v:0','-map','1:a:0','-map','2:s:0','-c:v','libsvtav1','-preset','12','-crf','10','-svtav1-params','lp=1:log-level=0','-c:a','aac','-c:s','copy','-metadata:s:s:0','language=eng','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-y',input],{stdio:'ignore'});
  child.execFileSync('ffmpeg',['-v','error','-i',input,'-map','0','-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-c:a','copy','-c:s','copy','-metadata:g','encoded_by=ArcAV1_QSV_V15','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-y',output],{stdio:'ignore'});
  const x=load({inputPath:input,smallerOutput:output}),args=argsFor(input,x.logs),r=await run(x,args);
  const encode=x.commands.find(c=>c.args.includes('av1_qsv'));
  assert.ok(encode,`expected one Arc QSV AV1 encode for ${extension}`);
  const ffArgs=encode.args.slice(encode.args.indexOf('--')+2),subMap=ffArgs.findIndex((v,i)=>v==='-map'&&ffArgs[i+1]==='0:2'),subCodec=ffArgs.indexOf('-c:s:0');
  assert.ok(subMap>=0,`${extension} source stream should be mapped`);
  assert.equal(ffArgs[subCodec+1],'copy',`${extension} stream must not pass through the SRT encoder`);
  const subtitleBsf=ffArgs.indexOf('-bsf:s:0');
  assert.ok(subtitleBsf>=0,`${extension} stream must get timestamp normalization`);
  assert.match(ffArgs[subtitleBsf+1],/^setts=pts=/,`${extension} stream must repair both presentation and decode timestamps`);
  assert.equal(x.commands.filter(c=>c.args.includes('av1_qsv')).length,1,'the video should be encoded once');
  assert.equal(r.outputNumber,1);
 }
});

test('4:2:2 input is downsampled with CPU decode while AV1 stays on Arc QSV',async()=>{
 const input=path.join(dir,'source-422.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-vf','format=yuv422p10le','-c:v','ffv1','-pix_fmt','yuv422p10le','-c:a','aac','-y',input],{stdio:'ignore'});
 const x=load(),args=argsFor(input,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1);
 const transcode=x.commands.find(c=>c.args.includes('av1_qsv'));
 assert.ok(transcode,'expected Arc QSV AV1 encode');
 const ffArgs=transcode.args.slice(transcode.args.indexOf('--')+2);
 assert.equal(ffArgs.includes('-hwaccel'),false,'4:2:2 source must use software decode');
 const vf=ffArgs.indexOf('-vf');
 assert.equal(ffArgs[vf+1],'format=p010le','4:2:2 source must convert to 10-bit 4:2:0 before Arc encode');
});

test('4:4:4 input is downsampled with CPU decode while AV1 stays on Arc QSV',async()=>{
 const input=path.join(dir,'source-444.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-vf','format=yuv444p10le','-c:v','ffv1','-pix_fmt','yuv444p10le','-c:a','aac','-y',input],{stdio:'ignore'});
 const x=load(),args=argsFor(input,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1);
 const transcode=x.commands.find(c=>c.args.includes('av1_qsv'));
 assert.ok(transcode,'expected Arc QSV AV1 encode');
 const ffArgs=transcode.args.slice(transcode.args.indexOf('--')+2);
 assert.equal(ffArgs.includes('-hwaccel'),false,'4:4:4 source must use software decode');
 const vf=ffArgs.indexOf('-vf');
 assert.equal(ffArgs[vf+1],'format=p010le','4:4:4 source must convert to 10-bit 4:2:0 before Arc encode');
});

test('verified SDR 12-bit input uses error-diffused CPU conversion before Arc QSV encode',async()=>{
 const input=path.join(dir,'source-12bit-sdr.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-vf','format=yuv420p12le','-c:v','libx265','-preset','ultrafast','-crf','10','-x265-params','log-level=error:pools=1','-pix_fmt','yuv420p12le','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-c:a','aac','-y',input],{stdio:'ignore'});
 const x=load(),args=argsFor(input,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1);
 const transcode=x.commands.find(c=>c.args.includes('av1_qsv'));
 assert.ok(transcode,'12-bit SDR source should still use Arc QSV encoding');
 const ffArgs=transcode.args.slice(transcode.args.indexOf('--')+2);
 assert.equal(ffArgs.includes('-hwaccel'),false,'12-bit source must use CPU decode');
 assert.equal(ffArgs[ffArgs.indexOf('-vf')+1],'format=p010le');
 assert.ok(ffArgs.includes('-sws_dither') && ffArgs[ffArgs.indexOf('-sws_dither')+1]==='ed','12-to-10-bit conversion must use error-diffusion dithering');
});

test('12-bit HDR remains held pending a verified Arc HDR conversion path',async()=>{
 const input=path.join(dir,'source-12bit-hdr.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-vf','format=yuv420p12le','-c:v','libx265','-preset','ultrafast','-crf','32','-x265-params','log-level=error:pools=1','-pix_fmt','yuv420p12le','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc','-color_range','tv','-c:a','aac','-y',input],{stdio:'ignore'});
 const x=load({hdr:true}),args=argsFor(input,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,2,'12-bit HDR must retain its original');
 assert.match(args.variables.user.failure_reason,/12-bit.*only verified for tagged SDR/i);
 assert.equal(x.commands.some(c=>c.args.includes('av1_qsv')),false,'held HDR source must not be encoded');
});

test('software-only MPEG-2 input uses CPU decode but still selects Arc QSV AV1',async()=>{
 const input=path.join(dir,'source-mpeg2.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','mpeg2video','-q:v','2','-pix_fmt','yuv420p','-c:a','aac','-y',input],{stdio:'ignore'});
 const x=load(),args=argsFor(input,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1);
 const transcode=x.commands.find(c=>c.args.includes('av1_qsv'));
 assert.ok(transcode,'software decode must not drop Arc QSV encoding');
 const ffArgs=transcode.args.slice(transcode.args.indexOf('--')+2);
 assert.equal(ffArgs.includes('-hwaccel'),false,'software-only source codec must not request QSV decode');
 assert.equal(ffArgs.indexOf('-threads'),ffArgs.indexOf('-i')-2,'CPU-decoded AV1 encode should use the shared decoder thread setting');
 assert.equal(ffArgs[ffArgs.indexOf('-threads')+1],'4');
 assert.equal(ffArgs[ffArgs.indexOf('-vf')+1],'format=p010le');
});

test('larger AV1 result falls back to a validated remux that may exceed source size',async()=>{
 const x=load({alwaysLarge:true}),args=argsFor(source),before=fs.statSync(source).size,r=await run(x,args);
 assert.deepEqual(x.calls,[22]);assert.equal(r.outputNumber,1);assert.equal(fs.statSync(source).size,before);
 assert.equal(args.variables.user.is_bloat_fallback,true);
 assert.ok(fs.statSync(r.outputFileObj._id).size>before);
 assert.match(args.variables.user.qsv_mode,/Size Bloat Fallback/);
});

test('reports remux exit status when stderr contains only ordinary metadata',async()=>{
 const x=load({alwaysLarge:true,failRemux:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,2);
 assert.ok(x.logs.some(line=>/Seek-healing remux failed \(FFmpeg exit 1;/.test(line)));
 assert.match(args.variables.user.failure_reason,/FFmpeg exit 1/);
});

test('allows a larger seek-heal remux without a source-relative FFmpeg size cap',async()=>{
 const x=load({alwaysLarge:true,remuxBloat:true}),args=argsFor(source,x.logs),sourceBytes=fs.statSync(source).size,r=await run(x,args);
 const remux=x.commands.find(c=>{const i=c.args.indexOf('-c:v');return i>=0&&c.args[i+1]==='copy';});
 assert.ok(remux,'expected source-video stream-copy remux');
 const fsize=remux.args.find(v=>String(v).startsWith('--fsize='));
 const [actualLimit,hardLimit]=String(fsize).split('=')[1].split(':');
 const reserved=((BigInt(sourceBytes)*5n+3n)/4n)+64n*1024n*1024n;
 assert.equal(BigInt(actualLimit),reserved);
 assert.equal(hardLimit,'unlimited','the process soft limit can be raised only after reservation growth');
 assert.ok(BigInt(actualLimit)>BigInt(sourceBytes));
 assert.equal(remux.args.includes('-fs'),false,'remux capacity is enforced by the growable file-size limit');
 assert.equal(r.outputNumber,1);
 assert.ok(fs.statSync(r.outputFileObj._id).size>sourceBytes);
 assert.ok(x.logs.some(line=>/larger than source.*preserved/i.test(line)));
 assert.equal(fs.statSync(source).size,sourceBytes);
});

test('an encoder clipped at source size triggers the reserved-capacity remux',async()=>{
 const x=load({limitOnFirst:true,uhd:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.deepEqual(x.calls,[22]);assert.equal(r.outputNumber,1);
 assert.equal(x.commands.length,2);
 assert.ok(x.commands[0].args.includes(`--fsize=${fs.statSync(source).size}:unlimited`));
 assert.ok(!x.commands[1].args.includes(`--fsize=${fs.statSync(source).size}:unlimited`));
 const noSmaller=x.logs.filter(line=>/No smaller output at ICQ 22/i.test(line));
 assert.equal(noSmaller.length,1,'the size-guard transition should log the quality-floor result once');
 assert.match(noSmaller[0],/trying a source-video stream-copy remux/i);
 assert.ok(x.logs.some(line=>/ICQ 22 encode hit the source-size cap/i.test(line)));
});

test('reports live encode progress through the Tdarr worker callback',async()=>{
 const x=load(),args=argsFor(source),updates=[];args.updateWorker=u=>updates.push(u);
 const r=await run(x,args);assert.equal(r.outputNumber,1);
 assert.ok(updates.some(u=>u.percentage>0&&u.percentage<100));
 assert.ok(updates.some(u=>u.fps===24));
});

test('precheck begins at 100 percent current and estimated size and worker status names each major phase',async()=>{
 const x=load(),args=argsFor(source),updates=[];args.updateWorker=u=>updates.push(u);
 const r=await run(x,args);assert.equal(r.outputNumber,1);
 const sourceSizeGiB=fs.statSync(source).size/(1024*1024*1024);
 const precheck=updates.find(u=>u.status==='Precheck: full source video scan');
 assert.ok(precheck,'source frame scan should publish its phase in Tdarr worker status');
 assert.equal(precheck.originalFileSizeInGbytes,sourceSizeGiB);
 assert.equal(precheck.outputFileSizeInGbytes,sourceSizeGiB);
 assert.equal(precheck.estSize,sourceSizeGiB);
 for(const status of ['Precheck: classify source color and HDR','Precheck: retained audio decode','Preparing: reserve cache and build output','Encoding: Arc QSV AV1 at ICQ 22','Validation: output streams and metadata','Validation: strict output video decode']){
  assert.ok(updates.some(u=>u.status===status),`expected worker status ${status}`);
 }
});

test('reports the remux failure after the quality floor is reached',async()=>{
 const x=load({alwaysLarge:true,failRemux:true}),args=argsFor(source),r=await run(x,args);
 assert.equal(r.outputNumber,2);assert.match(args.variables.user.failure_reason,/quality.floor|no smaller/i);
 assert.match(args.variables.user.failure_reason,/FFmpeg exit 1/i);
});

test('missing prlimit fails closed and identifies the missing dependency',async()=>{
 const x=load({missingPrlimit:true}),args=argsFor(source),r=await run(x,args);
 assert.equal(r.outputNumber,2);assert.equal(x.commands.length,1);assert.deepEqual(x.calls,[]);
 assert.match(args.variables.user.failure_reason,/prlimit.*ENOENT/i);
});

test('an encoder error stops retries and keeps the original',async()=>{
 const x=load({failEncoding:true}),args=argsFor(source),r=await run(x,args);
 assert.deepEqual(x.calls,[22]);assert.equal(r.outputNumber,2);assert.ok(fs.existsSync(source));
});

test('failure to inspect HDR metadata never replaces the source',async()=>{
 const x=load({mediainfo:false}),args=argsFor(source),r=await run(x,args);
 assert.deepEqual(x.calls,[]);assert.equal(r.outputNumber,2);assert.ok(fs.existsSync(source));
});

test('verified HDR10 without static mastering or light metadata can be encoded without invented metadata',async()=>{
 const input=path.join(dir,'hdr10-no-static-source.mkv'),output=path.join(dir,'hdr10-no-static-candidate.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-map','0:v:0','-map','1:a:0','-c:v','libsvtav1','-preset','12','-crf','10','-svtav1-params','lp=1:log-level=0','-c:a','aac','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc','-color_range','tv','-bsf:v','av1_metadata=color_primaries=9:transfer_characteristics=16:matrix_coefficients=9','-y',input],{stdio:'ignore'});
 child.execFileSync('ffmpeg',['-v','error','-i',input,'-map','0','-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-c:a','copy','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc','-color_range','tv','-bsf:v','av1_metadata=color_primaries=9:transfer_characteristics=16:matrix_coefficients=9','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',output],{stdio:'ignore'});
 const x=load({hdr:true,inputPath:input,smallerOutput:output}),args=argsFor(input,x.logs),r=await run(x,args);
 assert.deepEqual(x.calls,[22]);assert.equal(r.outputNumber,1);
 const probe=JSON.parse(child.execFileSync('ffprobe',['-v','error','-show_streams','-of','json',r.outputFileObj._id],{encoding:'utf8'}));
 const video=probe.streams.find(s=>s.codec_type==='video');
 assert.equal(video.color_transfer,'smpte2084');assert.equal(video.color_primaries,'bt2020');assert.equal(video.color_space,'bt2020nc');
 assert.equal((video.side_data_list||[]).some(s=>/mastering display|content light/i.test(s.side_data_type||'')),false);
});

test('current V13 output is recognized by a fresh file probe',async()=>{
 const x=load(),args=argsFor(candidate),r=await run(x,args);
 assert.deepEqual(x.calls,[]);assert.equal(r.outputNumber,4);
});


test('a different working file is not encoded as the original',async()=>{
 const other=path.join(dir,'different-original.mkv');fs.copyFileSync(source,other);
 const x=load(),args=argsFor(source);args.originalLibraryFile._id=other;
 const r=await run(x,args);assert.equal(r.outputNumber,2);assert.deepEqual(x.calls,[]);
});


test('HDR with missing mastering information is held',async()=>{
 const x=load({hdr:true}),args=argsFor(source),r=await run(x,args);
 assert.equal(r.outputNumber,2);assert.deepEqual(x.calls,[]);assert.ok(fs.existsSync(source));
});


test('an additional non-attached video stream with decoded frames remains fail-closed',async()=>{
 const x=load({extraVideo:true,extraVideoFrames:1}),args=argsFor(source),r=await run(x,args);
 assert.equal(r.outputNumber,2);assert.deepEqual(x.calls,[]);
 assert.match(args.variables.user.failure_reason,/Additional video stream 999 decoded at least one frame/i);
});

test('a confirmed zero-frame extra video stream is ignored before the primary full source scan',async()=>{
 const x=load({extraVideo:true,extraVideoFrames:0}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1);assert.deepEqual(x.calls,[22]);
 assert.ok(x.logs.some(line=>/Video stream 999 produced zero decoded frames; ignoring this empty stream/i.test(line)));
});

test('ISO deletion still routes to the Arr scan branch',async()=>{
 const iso=path.join(dir,'sample.iso');fs.writeFileSync(iso,'discardable test');
 const x=load(),args=argsFor(iso);args.inputFileObj.container='iso';
 const r=await run(x,args);assert.equal(r.outputNumber,3);assert.equal(fs.existsSync(iso),false);
 assert.ok(flow.flowEdges.some(e=>e.source==='arc_av1_monolithic'&&e.sourceHandle==='3'&&e.target==='notify_arr_iso'));
});

test('encoder and quality-floor failures carry a useful reason to the notifier',async()=>{
 const failed=load({failEncoding:true}),failedArgs=argsFor(source),a=await run(failed,failedArgs);
 assert.equal(a.outputNumber,2);assert.match(a.variables.user.failure_reason,/simulated failure|transcode execution failed/i);
 const larger=load({alwaysLarge:true,failRemux:true}),largerArgs=argsFor(source),b=await run(larger,largerArgs);
 assert.equal(b.outputNumber,2);assert.match(b.variables.user.failure_reason,/quality.floor|no smaller/i);
});

test('pre-replacement guard records the original-change failure reason',async()=>{
 const guard=flow.flowPlugins.find(p=>p.id==='original_recheck'),m={exports:{}};
 runFlowCode(['require','module','exports'],guard.inputsDB.code,[require,m,m.exports]);
 const original=path.join(dir,'recheck-original.mkv');fs.copyFileSync(source,original);
 const stat=fs.statSync(original,{bigint:true}),saved={path:original,realPath:fs.realpathSync(original),dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)};
 fs.appendFileSync(original,Buffer.from([0]));
 const args={inputFileObj:{_id:candidate},originalLibraryFile:{_id:original},variables:{user:{original_snapshot:saved}},jobLog:()=>{}};
 const result=await m.exports(args);assert.equal(result.outputNumber,2);assert.match(args.variables.user.failure_reason,/original changed/i);
});


test('ISO deletion failure records the actual reason for the failure alert',async()=>{
 const iso=path.join(dir,'blocked.iso');fs.writeFileSync(iso,'test');
 const x=load({denyIso:true}),args=argsFor(iso);args.inputFileObj.container='iso';
 const r=await run(x,args);assert.equal(r.outputNumber,2);assert.match(r.variables.user.failure_reason,/simulated ISO permission error/);assert.ok(fs.existsSync(iso));
});

test('controlled failure notifies once and error-hook cleanup releases the reservation',async()=>{
 const {EventEmitter}=require('node:events');
 const x=load({failEncoding:true}),args=argsFor(source),result=await x.fn(args);
 assert.equal(result.outputNumber,2);assert.ok(args.variables.user.cache_reservation);
 const loadPlugin=(id,req=require)=>{const node=flow.flowPlugins.find(p=>p.id===id),m={exports:{}};runFlowCode(['require','module','exports'],node.inputsDB.code,[req,m,m.exports]);return m.exports;};
 await loadPlugin('cleanup_failure')({...args,inputFileObj:result.outputFileObj});
 assert.equal(args.variables.user.cache_reservation,undefined);
 const sent=[];const https={request(_url,_opts,callback){const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};req.end=body=>{sent.push(JSON.parse(body));const res=new EventEmitter();res.statusCode=204;res.resume=()=>{};callback(res);res.emit('end');};return req;}};
 const mockRequire=n=>n==='https'?https:require(n);
 const previousWebhook=process.env.TDARR_DISCORD_WEBHOOK;process.env.TDARR_DISCORD_WEBHOOK='https://discord.invalid/test';
 await loadPlugin('notify_failure',mockRequire)(args);
 await loadPlugin('cleanup_on_error')(args);
 await loadPlugin('notify_failure_on_error',mockRequire)(args);
 if(previousWebhook===undefined)delete process.env.TDARR_DISCORD_WEBHOOK;else process.env.TDARR_DISCORD_WEBHOOK=previousWebhook;
 assert.equal(sent.length,1);assert.match(sent[0].embeds[0].description,/simulated failure/i);
});
