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
function load({sourceDiagnosticChunks,qsvValidationFailure=false,qsvTimestampFailure=false,qsvTimestampExitZero=false,qsvLongTimestampLines=false,matchedVideoDtsTies=false,matchedSubFramePtsTie=false,sourceFieldOrder=null,candidateFieldOrder=null,cpuValidationFailure=false,dropCandidateAudio=false,alwaysLarge=false,failEncoding=false,failRemux=false,remuxBloat=false,missingPrlimit=false,limitOnFirst=false,uhd=false,mediainfo=true,missingSourceSar=false,candidateMissingSar=false,mediaInfoPixelAspectRatio,candidateMediaInfoPixelAspectRatio,hdr=false,dovi5Test=false,colorOverride=null,mediaInfoOverride=null,candidateSideData=null,extraVideo=false,extraVideoFrames=1,denyIso=false,sourceCorruption=false,sourceCorruptionDiagnostic='[Source media corruption] [h264] Invalid NAL unit size (999 > 8)',forceSourceAudioBatchFailure=false,corruptSourceAudioStream='0:2',moveDuringSourceScan=false,changeMovedContent=false,unlinkHardlinkDuringSourceScan=null,subtitleDtsRegression=false,inputPath=source,smallerOutput=candidate,codeOverride=null}={}) {
  const calls=[],commands=[],logs=[],audioDecodeCommands=[]; let initialProbe=true,moverSimulated=false,doviExtractCalls=0;
  const fakeFs=new Proxy(fs,{get(t,p){if(p==='unlinkSync' && denyIso)return name=>{if(String(name).endsWith('.iso'))throw Error('simulated ISO permission error');return t.unlinkSync(name)};if(p==='accessSync')return (name,...args)=>(name==='/dev/dri/renderD129'||(dovi5Test&&name==='/usr/share/vulkan/icd.d/intel_icd.json'))?undefined:t.accessSync(name,...args);return t[p]}});
  const fakeChild={...child,
    spawn(cmd,args,opts){
      if(dovi5Test&&cmd==='ffmpeg'&&args.includes('hevc')&&args.includes('-')){
        doviExtractCalls++;
        const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
        const proc=new EventEmitter();proc.stdout=new PassThrough();proc.stderr=new PassThrough();proc.stdio=[null,proc.stdout,proc.stderr,new PassThrough()];proc.kill=()=>{};
        queueMicrotask(()=>{
          proc.stdio[3].write('frame=48\nout_time_us=2000000\nfps=96.0\nprogress=continue\n');
          proc.stdio[3].end('frame=96\nout_time_us=4000000\nfps=96.0\nprogress=end\n');
          proc.stdout.end(Buffer.from('FAKE_HEVC_ANNEXB'));proc.stderr.end();proc.emit('close',0,null);
        });
        return proc;
      }
      if(dovi5Test&&cmd==='dovi_tool'){
        const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
        const proc=new EventEmitter();proc.stdin=new PassThrough();proc.stdout=new PassThrough();proc.stderr=new PassThrough();proc.kill=()=>{};
        const sub=args[0];
        if(sub==='extract-rpu'){
          const out=args[args.indexOf('-o')+1];
          proc.stdin.resume();
          proc.stdin.on('end',()=>{fs.writeFileSync(out,'FAKE_RPU');proc.stderr.end();proc.emit('close',0,null);});
        } else if(sub==='export'){
          const spec=args[args.indexOf('--levels')+1];
          const parts=Object.fromEntries(spec.split(',').map(kv=>kv.split('=')));
          const rows6=['frame,max_display_mastering_luminance,min_display_mastering_luminance,max_content_light_level,max_frame_average_light_level'];
          const rows9=['frame,length,source_primary_index'];
          for(let i=0;i<96;i++){rows6.push(`${i},1000,1,1000,250`);rows9.push(`${i},1,0`);}
          queueMicrotask(()=>{fs.writeFileSync(parts.level6,rows6.join('\n')+'\n');if(parts.level9)fs.writeFileSync(parts.level9,rows9.join('\n')+'\n');proc.stderr.end();proc.emit('close',0,null);});
        }
        return proc;
      }
      if(dovi5Test&&cmd==='ffprobe'&&args.includes('-show_frames')&&args.includes(inputPath)){
        const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
        const proc=new EventEmitter();proc.stdout=new PassThrough();proc.stderr=new PassThrough();proc.kill=()=>{};
        const lines=[];
        for(let i=0;i<96;i++){
          lines.push(`frame|best_effort_timestamp_time=${(i/24).toFixed(6)}|pkt_pos=${1024+i*512}|interlaced_frame=0|pix_fmt=yuv420p10le|color_range=pc|side_datum/dolby_vision_rpu_data:side_data_type=Dolby Vision RPU Data`);
        }
        queueMicrotask(()=>{proc.stdout.end(lines.join('\n')+'\n');proc.stderr.end();proc.emit('close',0,null);});
        return proc;
      }
      if(matchedSubFramePtsTie&&cmd==='ffprobe'&&args.includes('-show_frames')&&args.includes('compact=p=1:nk=0')){
        const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
        const process=new EventEmitter();process.stdout=new PassThrough();process.stderr=new PassThrough();process.kill=()=>{};
        const target=args[args.length-1],isSrc=target===inputPath;
        const lines=[];
        for(let i=0;i<96;i++){
          let pts=(i/24).toFixed(6);
          if(i===20)pts=(isSrc?19/24+0.001:19/24).toFixed(6);
          lines.push(`frame|best_effort_timestamp_time=${pts}|pkt_pos=${1024+i*512}|interlaced_frame=0|color_range=tv|color_space=bt709|color_primaries=bt709|color_transfer=bt709`);
        }
        queueMicrotask(()=>{process.stdout.end(lines.join('\n')+'\n');process.stderr.end();process.emit('close',0,null);});
        return process;
      }
      if(matchedVideoDtsTies&&cmd==='ffprobe'&&args.includes('-show_packets')&&args.includes('packet=pts_time,dts_time,duration_time,pos')&&args.includes('-select_streams')&&args[args.indexOf('-select_streams')+1]==='0'){
        const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
        const process=new EventEmitter();process.stdout=new PassThrough();process.stderr=new PassThrough();process.kill=()=>{};
        const lines=[];
        for(let i=0;i<96;i++){
          const pts=(i/24).toFixed(6),dts=((i===11?10:i)/24).toFixed(6);
          lines.push(`pts_time=${pts}|dts_time=${dts}|duration_time=0.041667|pos=${1024+i*512}`);
        }
        queueMicrotask(()=>{process.stdout.end(lines.join('\n')+'\n');process.stderr.end();process.emit('close',0,null);});
        return process;
      }
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
        const longTimestampStderr=`libva info: VA-API version 1.24.0\n${Array.from({length:180},(_,i)=>`[null @ 0x55a55b5d9200] Application provided invalid, non monotonically increasing dts to muxer in stream 0: ${(i+1)*100} >= ${(i+1)*100}`).join('\n')}\n`;
        const qsvStderr=qsvTimestampFailure
          ?(qsvLongTimestampLines?longTimestampStderr:qsvTimestampExitZero?'libva info: VA-API version 1.22.0\n[null @ 0x55cac3600580] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 5 >= 5\n':'[null @ 0x1234] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 5 >= 5')
          :'Device creation failed: unavailable Arc device';
        queueMicrotask(()=>{process.stdout.end();process.stderr.end(args.includes('-hwaccel')?qsvStderr:'Cannot allocate memory');process.emit('close',(qsvTimestampExitZero&&args.includes('-hwaccel'))?0:1,null);});
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
      if(cmd==='ffprobe'&&(moveDuringSourceScan||unlinkHardlinkDuringSourceScan)&&args.includes('-show_frames')&&args.includes(inputPath)){
        const process=child.spawn(cmd,args,opts);
        process.once('close',()=>{
          if(moverSimulated)return;
          moverSimulated=true;
          if(unlinkHardlinkDuringSourceScan){
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);
            fs.unlinkSync(unlinkHardlinkDuringSourceScan);
            return;
          }
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
        const av=args.slice(args.indexOf('--')+2),qi=av.indexOf('-global_quality'),crfIdx=av.includes('libsvtav1')?av.indexOf('-crf'):-1,q=qi>=0?Number(av[qi+1]):crfIdx>=0?Number(av[crfIdx+1]):NaN;if(qi>=0||crfIdx>=0)calls.push(q);
        if(qi<0 && crfIdx<0){
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
      if(dovi5Test&&cmd==='ffmpeg'&&args.includes('-filters'))return 'T.C libplacebo ...';
      if(dovi5Test&&cmd==='ffprobe'&&args.includes('%+1')&&args.includes(inputPath)){
        return JSON.stringify({frames:[{side_data_list:[{side_data_type:'Dolby Vision RPU Data'},{side_data_type:'Dolby Vision Metadata',vdr_rpu_profile:0,bl_video_full_range_flag:1}]}]});
      }
      if(cmd==='mediainfo') {
        if(!mediainfo) throw Error('no mediainfo');
   const isInputTarget=args[args.length-1]===inputPath;
   const par=isInputTarget?mediaInfoPixelAspectRatio:(candidateMediaInfoPixelAspectRatio===undefined?mediaInfoPixelAspectRatio:candidateMediaInfoPixelAspectRatio);
   const video={'@type':'Video',StreamOrder:'0',...(par===undefined?{}:{PixelAspectRatio:par}),...(mediaInfoOverride?mediaInfoOverride:hdr?{HDR_Format:'SMPTE ST 2086',HDR_Format_Compatibility:'HDR10'}:{transfer_characteristics:'BT.709'})};
        const tracks=[video];if(extraVideo)tracks.push({'@type':'Video',StreamOrder:'999',Format:'AV1'});
        return JSON.stringify({media:{track:tracks}});
      }
      const result=child.execFileSync(cmd,args,opts);
      if(cmd==='ffprobe') {
        const probe=JSON.parse(result);
   if((missingSourceSar && args[args.length-1]===inputPath) || (candidateMissingSar && args[args.length-1]!==inputPath)) for(const stream of probe.streams||[]) if(stream.codec_type==='video') delete stream.sample_aspect_ratio;
        for(const stream of probe.streams||[])if(stream.codec_type==='video'){
          if(dovi5Test&&args[args.length-1]===inputPath){
            delete stream.color_transfer;delete stream.color_primaries;delete stream.color_space;
            Object.assign(stream,{codec_name:'hevc',pix_fmt:'yuv420p10le',color_range:'pc',side_data_list:[{side_data_type:'DOVI configuration record',dv_profile:5,dv_level:6,rpu_present_flag:1,el_present_flag:0,bl_present_flag:1,dv_bl_signal_compatibility_id:0}]});
          } else Object.assign(stream,colorOverride?colorOverride:hdr?{color_transfer:'smpte2084',color_primaries:'bt2020',color_space:'bt2020nc',color_range:'tv'}:{color_transfer:'bt709',color_primaries:'bt709',color_space:'bt709',color_range:'tv'});
          if(sourceFieldOrder&&args[args.length-1]===inputPath)stream.field_order=sourceFieldOrder;
          if(candidateFieldOrder&&args[args.length-1]!==inputPath)stream.field_order=candidateFieldOrder;
          if(Array.isArray(candidateSideData)&&args[args.length-1]!==inputPath){
            const existing=stream.side_data_list||[];
            const missing=candidateSideData.filter(item=>!existing.some(e=>e.side_data_type===item.side_data_type));
            if(missing.length)stream.side_data_list=[...existing,...missing];
          }
        }
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
  runFlowCode(['require','module','exports'],codeOverride || code,[req,m,m.exports]);
  return {fn:m.exports,calls,commands,logs,audioDecodeCommands,moverSimulated:()=>moverSimulated,doviExtractCalls:()=>doviExtractCalls};
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
 const cachePath=require('../src/precheck_cache').sourcePrecheckPathFor(firstArgs.variables.user.quarantine_entry);
 assert.ok(fs.existsSync(cachePath),'complete source evidence must be cached');
 const second=load({inputPath:input,qsvValidationFailure:true,cpuValidationFailure:true});
 const secondArgs=argsFor(input,second.logs);secondArgs.librarySettings.folder=library;
 const secondResult=await run(second,secondArgs);
 assert.equal(secondResult.outputNumber,2);
 assert.ok(second.logs.some(line=>line.includes('[Source precheck] Reused')));
 assert.ok(second.logs.some(line=>line.includes('[Audio precheck] Reused')));
 assert.ok(second.logs.some(line=>line.includes('[Validation stage] video_decode:')),'candidate validation must still run');
 assert.equal(second.audioDecodeCommands.some(command=>command.input===input),false,'source audio must not be decoded again');
 const envelope=JSON.parse(require('zlib').gunzipSync(fs.readFileSync(cachePath)));
 const cached=JSON.parse(envelope.payload);
 cached.data.audio.streams[0].timeBase='1/999';
 assert.equal(require('../src/precheck_cache').saveSourcePrecheck(firstArgs.variables.user.quarantine_entry,{videoSignature:cached.videoSignature,audioSignature:cached.audioSignature},cached.data),true);
 const changedAudio=load({inputPath:input,qsvValidationFailure:true,cpuValidationFailure:true});
 const changedAudioArgs=argsFor(input,changedAudio.logs);changedAudioArgs.librarySettings.folder=library;
 assert.equal((await run(changedAudio,changedAudioArgs)).outputNumber,2);
 assert.ok(changedAudio.logs.some(line=>line.includes('[Source precheck] Reused')));
 assert.ok(changedAudio.audioDecodeCommands.some(command=>command.input===input),'a changed audio selection must be checked again');
 fs.writeFileSync(cachePath,'damaged cache');
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
test('matched source/candidate DTS ties with verified frame PTS recover via timestamp-isolated decode',async()=>{
 const x=load({qsvTimestampFailure:true,qsvTimestampExitZero:true,matchedVideoDtsTies:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1);
 assert.equal(args.variables.user.validation_report.outcome,'recovered');
 assert.equal(args.variables.user.validation_report.recoveries[0].code,'timestamp_isolated_decode');
 assert.ok(x.logs.some(line=>line.includes('Non-increasing DTS transitions: source 1, candidate 1; missing DTS: source 0, candidate 0.')));
 assert.ok(x.audioDecodeCommands.some(c=>c.input!==source&&c.args.includes('settb=expr=1/1000000,setpts=N')));
});
test('long truncated QSV null-mux DTS diagnostics still recover via timestamp-isolated decode',async()=>{
 const x=load({qsvTimestampFailure:true,qsvTimestampExitZero:true,qsvLongTimestampLines:true,matchedVideoDtsTies:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason);
 assert.equal(args.variables.user.validation_report.outcome,'recovered');
 assert.equal(args.variables.user.validation_report.recoveries[0].code,'timestamp_isolated_decode');
 assert.ok(x.audioDecodeCommands.some(c=>c.input!==source&&c.args.includes('settb=expr=1/1000000,setpts=N')));
});
test('missing FFprobe source SAR with square MediaInfo PAR emits container -aspect on seek-heal remux and validates un-tagged stream-copy candidates',async()=>{
 const x=load({missingSourceSar:true,candidateMissingSar:true,mediaInfoPixelAspectRatio:'1.000',alwaysLarge:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason);
 const remux=x.commands.find(c=>c.args.includes('copy')&&!c.args.includes('-crf')&&!c.args.includes('-global_quality'));
 assert.ok(remux,'expected seek-heal remux command');
 const aspectIdx=remux.args.indexOf('-aspect:v:0');
 assert.ok(aspectIdx>=0&&remux.args[aspectIdx+1]==='1920:1080',`expected -aspect:v:0 1920:1080 in remux args: ${remux.args.join(' ')}`);
 const bad=load({missingSourceSar:true,candidateMissingSar:true,mediaInfoPixelAspectRatio:'1.000',candidateMediaInfoPixelAspectRatio:'1.333',alwaysLarge:true}),badArgs=argsFor(source,bad.logs),badRes=await run(bad,badArgs);
 assert.equal(badRes.outputNumber,2);
 assert.match(badArgs.variables.user.failure_reason,/aspect ratio/i);
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

test('hardlink unlink causing ctime-only change during source scan does not fail the engine guard',async()=>{
 const hardlinked=path.join(dir,'hardlink-source.mkv'),sibling=path.join(dir,'hardlink-seed.mkv');
 fs.copyFileSync(source,hardlinked);
 fs.linkSync(hardlinked,sibling);
 const before=fs.statSync(hardlinked,{bigint:true});
 const x=load({inputPath:hardlinked,unlinkHardlinkDuringSourceScan:sibling}),args=argsFor(hardlinked,x.logs),r=await run(x,args);
 const after=fs.statSync(hardlinked,{bigint:true});
 assert.equal(x.moverSimulated(),true);
 assert.equal(after.ino,before.ino);
 assert.notEqual(after.ctimeNs,before.ctimeNs);
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason);
 assert.equal(args.variables.user.original_snapshot.ctimeNs,String(after.ctimeNs));
 assert.ok(x.logs.some(line=>/ctime only/i.test(line)));
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
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason||x.logs.slice(-8).join('\n'));
 const transcode=x.commands.find(c=>c.args.includes('av1_qsv'));
 assert.ok(transcode,'expected Arc QSV AV1 encode');
 const ffArgs=transcode.args.slice(transcode.args.indexOf('--')+2);
 assert.equal(ffArgs.includes('-hwaccel'),false,'4:2:2 source must use software decode');
 const vf=ffArgs.indexOf('-vf');
 assert.equal(ffArgs[vf+1],'format=p010le','4:2:2 source must convert to 10-bit 4:2:0 before Arc encode');
});

test('4:4:4 input is downsampled with CPU decode while AV1 stays on Arc QSV',async()=>{
 const input=path.join(dir,'source-444.mkv'),output=path.join(dir,'candidate-444.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-vf','format=yuv444p10le','-c:v','ffv1','-pix_fmt','yuv444p10le','-c:a','aac','-y',input],{stdio:'ignore'});
 child.execFileSync('ffmpeg',['-v','error','-i',input,'-map','0','-vf','format=yuv420p10le','-c:v','libsvtav1','-preset','12','-crf','20','-svtav1-params','lp=1:log-level=0','-c:a','copy','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-bsf:v','av1_metadata=color_primaries=1:transfer_characteristics=1:matrix_coefficients=1','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',output],{stdio:'ignore'});
 const x=load({inputPath:input,smallerOutput:output}),args=argsFor(input,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason||x.logs.slice(-8).join('\n'));
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
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason||x.logs.slice(-8).join('\n'));
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
 assert.equal(args.variables.flowFailed,true);
 await loadPlugin('cleanup_on_error')(args);
 await loadPlugin('notify_failure_on_error',mockRequire)(args);
 if(previousWebhook===undefined)delete process.env.TDARR_DISCORD_WEBHOOK;else process.env.TDARR_DISCORD_WEBHOOK=previousWebhook;
 assert.equal(sent.length,1);assert.match(sent[0].embeds[0].description,/simulated failure/i);
});

test('BT.2020 bt2020-10 wide-gamut SDR source encodes without forcing PQ transfer and passes color validation',async()=>{
 const wcgInput=path.join(dir,'wcg-sdr-source.mkv'),wcgOutput=path.join(dir,'wcg-sdr-candidate.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-map','0:v:0','-map','1:a:0','-c:v','libsvtav1','-preset','12','-crf','10','-svtav1-params','lp=1:log-level=0','-c:a','aac','-color_primaries','bt2020','-color_trc','bt2020-10','-colorspace','bt2020nc','-color_range','tv','-bsf:v','av1_metadata=color_primaries=9:transfer_characteristics=14:matrix_coefficients=9','-y',wcgInput],{stdio:'ignore'});
 child.execFileSync('ffmpeg',['-v','error','-i',wcgInput,'-map','0','-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-c:a','copy','-color_primaries','bt2020','-color_trc','bt2020-10','-colorspace','bt2020nc','-color_range','tv','-bsf:v','av1_metadata=color_primaries=9:transfer_characteristics=14:matrix_coefficients=9','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',wcgOutput],{stdio:'ignore'});
 const x=load({
  inputPath:wcgInput,
  smallerOutput:wcgOutput,
  colorOverride:{color_transfer:'bt2020-10',color_primaries:'bt2020',color_space:'bt2020nc',color_range:'tv'},
  mediaInfoOverride:{colour_range:'Limited',colour_primaries:'BT.2020',transfer_characteristics:'BT.2020 (10-bit)',matrix_coefficients:'BT.2020 non-constant'}
 });
 const args=argsFor(wcgInput,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1);
 const encode=x.commands.find(c=>c.args.includes('av1_qsv'));
 assert.ok(encode,'WCG-SDR source should encode with av1_qsv');
 const ffArgs=encode.args.slice(encode.args.indexOf('--')+2);
 assert.equal(ffArgs[ffArgs.indexOf('-color_trc')+1],'bt2020-10');
 assert.equal(ffArgs[ffArgs.indexOf('-color_primaries')+1],'bt2020');
 assert.equal(ffArgs[ffArgs.indexOf('-colorspace')+1],'bt2020nc');
 assert.equal(ffArgs.includes('smpte2084'),false,'WCG-SDR encode must never inject PQ transfer');
});

test('HDR source with QSV green-y clamp mastering routes proactively to SVT-AV1 CRF 28 without an initial QSV encode',async()=>{
 const clampInput=path.join(dir,'hdr-clamp-source.mkv'),clampOutput=path.join(dir,'hdr-clamp-candidate.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-map','0:v:0','-map','1:a:0','-c:v','libx265','-preset','ultrafast','-crf','10','-x265-params','log-level=error:pools=1:master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1):max-cll=992,518','-pix_fmt','yuv420p10le','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc','-color_range','tv','-c:a','aac','-y',clampInput],{stdio:'ignore'});
 child.execFileSync('ffmpeg',['-v','error','-i',clampInput,'-map','0','-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0:mastering-display=G(0.17,0.797)B(0.131,0.046)R(0.708,0.292)WP(0.3127,0.329)L(1000,0.0001):content-light=992,518','-c:a','copy','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc','-color_range','tv','-metadata:g','encoded_by=ArcAV1_SVTAV1_HDRFallback_V15','-y',clampOutput],{stdio:'ignore'});
 const x=load({hdr:true,inputPath:clampInput,smallerOutput:clampOutput,candidateSideData:[{side_data_type:'Mastering display metadata',red_x:'177/250',red_y:'73/250',green_x:'17/100',green_y:'797/1000',blue_x:'131/1000',blue_y:'23/500',white_point_x:'3127/10000',white_point_y:'329/1000',min_luminance:'1/10000',max_luminance:'1000/1'},{side_data_type:'Content light level metadata',max_content:992,max_average:518}]});
 const args=argsFor(clampInput,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason||x.logs.slice(-8).join('\n'));
 assert.equal(x.commands.some(c=>c.args.includes('av1_qsv')),false,'proactive clamp route must not run av1_qsv first');
 const svt=x.commands.find(c=>c.args.includes('libsvtav1'));
 assert.ok(svt,'expected proactive libsvtav1 encode');
 assert.deepEqual(x.calls,[28]);
 assert.ok(x.logs.some(line=>/proactive.*clamp|green-y/i.test(line)));
});

test('matched non-zero DTS ties with compareVideoTimestamps-valid frame PTS ties recover via timestamp-isolated decode',async()=>{
 const x=load({qsvTimestampFailure:true,qsvTimestampExitZero:true,qsvLongTimestampLines:true,matchedVideoDtsTies:true,matchedSubFramePtsTie:true}),args=argsFor(source,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason);
 assert.equal(args.variables.user.validation_report.outcome,'recovered');
 assert.equal(args.variables.user.validation_report.recoveries[0].code,'timestamp_isolated_decode');
 assert.ok(x.audioDecodeCommands.some(c=>c.input!==source&&c.args.includes('settb=expr=1/1000000,setpts=N')));
});

test('progressive MBAFF-tagged source normalizes field order in Hybrid CPU filter mode and retires interlaced quarantined candidates',async()=>{
 const library=path.join(dir,'mbaff-library');fs.mkdirSync(library,{recursive:true});
 const mbaffSource=path.join(library,'stick-man-mbaff.mkv');fs.copyFileSync(source,mbaffSource);
 // Simulate an older quarantined candidate that previously failed with Output has interlaced field order
 const first=load({inputPath:mbaffSource,sourceFieldOrder:'tt',candidateFieldOrder:'tt'});
 const firstArgs=argsFor(mbaffSource,first.logs);firstArgs.librarySettings.folder=library;
 const stale=await run(first,firstArgs);
 assert.equal(stale.outputNumber,2);
 assert.ok(firstArgs.variables.user.quarantine_entry,'test setup expects a stored quarantined candidate');
 const retry=load({inputPath:mbaffSource,sourceFieldOrder:'tt'});
 const retryArgs=argsFor(mbaffSource,retry.logs);retryArgs.librarySettings.folder=library;
 const approved=await run(retry,retryArgs);
 assert.equal(approved.outputNumber,1,retryArgs.variables.user.failure_reason);
 assert.ok(retry.logs.some(line=>/\[Quarantine\] Retired stored candidate with interlaced field order/i.test(line)),'stale interlaced-tagged quarantined candidate must be retired');
 const encode=retry.commands.find(c=>c.args.includes('av1_qsv'));
 assert.ok(encode,'MBAFF progressive source must still encode with Arc QSV');
 const ffArgs=encode.args.slice(encode.args.indexOf('--')+2);
 assert.equal(ffArgs.includes('-hwaccel'),false,'MBAFF progressive source must route through Hybrid CPU decode');
 assert.equal(ffArgs[ffArgs.indexOf('-vf')+1],'setfield=mode=prog,format=p010le');
 assert.equal(ffArgs[ffArgs.indexOf('-field_order')+1],'progressive');
});

test('stage_signatures module computes isolated per-stage hashes and rejects unmapped symbols',()=>{
 const out=child.execFileSync('python3',['scripts/stage_signatures.py','--check-isolation'],{encoding:'utf8'});
 const parsed=JSON.parse(out);
 assert.deepEqual(Object.keys(parsed.hashes).sort(),['candidate_frames','decode','encode','precheck_audio','precheck_video']);
 assert.equal(parsed.isolation.decodeEditChangedOnlyDecode,true);
 assert.equal(parsed.isolation.audioTimingEditChangedOnlyPrecheckAudio,true);
 assert.equal(parsed.isolation.encodeEditChangedOnlyEncode,true);
 assert.equal(parsed.isolation.frameScanEditLeftEncodeAndAudioUntouched,true);
});

test('post-check-only rebuild reuses source precheck, candidate mkv, and candidate frames while encode rebuild retires only candidate',async()=>{
 const manifestRaw=flow.flowPlugins.find(p=>p.id==='arc_av1_monolithic').inputsDB.code.match(/STAGE_CODE_HASHES=(\{[^}]+\})/);
 assert.ok(manifestRaw,'assembled code must embed STAGE_CODE_HASHES');
 const baseHashes=JSON.parse(manifestRaw[1].replace(/'/g,'"'));
 const replaceStageHash=(stage,newHash)=>code.replace(manifestRaw[0],`STAGE_CODE_HASHES=${JSON.stringify({...baseHashes,[stage]:newHash})}`);

 const library=path.join(dir,'stage-cache-library');fs.mkdirSync(library,{recursive:true});
 const input=path.join(library,'staged-source.mkv');fs.copyFileSync(source,input);

 // 1. Initial failing run stores candidate + source precheck + candidate frames
 const first=load({inputPath:input,qsvValidationFailure:true,cpuValidationFailure:true});
 const firstArgs=argsFor(input,first.logs);firstArgs.librarySettings.folder=library;
 assert.equal((await run(first,firstArgs)).outputNumber,2);
 const entry=firstArgs.variables.user.quarantine_entry;
 assert.ok(entry?.stageSignatures?.encode && entry?.stageSignatures?.candidateFrames && entry?.stageSignatures?.decode);
 const sourcePrecheckFile=require('../src/precheck_cache').sourcePrecheckPathFor(entry);
 assert.ok(fs.existsSync(sourcePrecheckFile),'source-scoped precheck must be persisted');
 assert.ok(fs.existsSync(`${entry.candidatePath}.frames.gz`),'candidate frame scan must be cached alongside quarantined mkv');

 // 2. Decode-only change: reuses source precheck, candidate mkv, and candidate .frames.gz while running video_decode live
 const decodeChanged=load({inputPath:input,qsvValidationFailure:true,cpuValidationFailure:true,codeOverride:replaceStageHash('decode','d'.repeat(64))});
 const decodeArgs=argsFor(input,decodeChanged.logs);decodeArgs.librarySettings.folder=library;
 assert.equal((await run(decodeChanged,decodeArgs)).outputNumber,2);
 assert.ok(decodeChanged.logs.some(line=>line.includes('[Source precheck] Reused')));
 assert.ok(decodeChanged.logs.some(line=>line.includes('[Audio precheck] Reused')));
 assert.ok(decodeChanged.logs.some(line=>line.includes('[Validation frames] Reused')));
 assert.ok(decodeChanged.logs.some(line=>line.includes('[Validation stage] video_decode:')));
 assert.equal(decodeChanged.commands.some(c=>c.args.includes('av1_qsv')),false,'decode-only change must not re-encode');
 assert.equal(decodeChanged.audioDecodeCommands.some(c=>c.input===input),false,'decode-only change must not re-run source audio');

 // 3. Candidate-frames-only change: reuses source precheck and candidate mkv, refreshes candidate .frames.gz
 const framesChanged=load({inputPath:input,qsvValidationFailure:true,cpuValidationFailure:true,codeOverride:replaceStageHash('candidate_frames','c'.repeat(64))});
 const framesArgs=argsFor(input,framesChanged.logs);framesArgs.librarySettings.folder=library;
 assert.equal((await run(framesChanged,framesArgs)).outputNumber,2);
 assert.ok(framesChanged.logs.some(line=>line.includes('[Source precheck] Reused')));
 assert.equal(framesChanged.logs.some(line=>line.includes('[Validation frames] Reused')),false,'candidateFrames hash change must re-run candidate frame scan');
 assert.equal(framesChanged.commands.some(c=>c.args.includes('av1_qsv')),false,'candidateFrames-only change must not re-encode');

 // 4. Encode-only change: retires old candidate (.mkv/.json/.frames.gz), keeps & reuses source precheck, runs fresh encode
 const encodeChanged=load({inputPath:input,codeOverride:replaceStageHash('encode','e'.repeat(64))});
 const encodeArgs=argsFor(input,encodeChanged.logs);encodeArgs.librarySettings.folder=library;
 assert.equal((await run(encodeChanged,encodeArgs)).outputNumber,1,encodeArgs.variables.user.failure_reason);
 assert.equal(fs.existsSync(entry.manifestPath),false,'old candidate manifest must be retired on encode signature mismatch');
 assert.equal(fs.existsSync(`${entry.candidatePath}.frames.gz`),false,'old candidate frames cache must be retired');
 assert.equal(fs.existsSync(sourcePrecheckFile),true,'source precheck must survive encode-driven candidate retirement');
 assert.ok(encodeChanged.logs.some(line=>line.includes('[Quarantine] Retiring stale candidate')));
 assert.ok(encodeChanged.logs.some(line=>line.includes('[Source precheck] Reused')),'source precheck must be reused after retiring stale candidate');
 assert.ok(encodeChanged.logs.some(line=>line.includes('[Audio precheck] Reused')));
 assert.ok(encodeChanged.commands.some(c=>c.args.includes('av1_qsv')),'encode change must run a fresh encode');
 assert.ok(encodeArgs.variables.user.source_precheck_entry,'retired encode path must retain cleanup reference for source precheck');
 const cleanupPlugin=flow.flowPlugins.find(p=>p.id==='cleanup_success');
 const cleanupLogs=[];
 const cleanupMod={exports:{}};
 runFlowCode(['require','module','exports'],cleanupPlugin.inputsDB.code,[require,cleanupMod,cleanupMod.exports]);
 await cleanupMod.exports({...encodeArgs,jobLog:m=>cleanupLogs.push(String(m))});
 assert.equal(fs.existsSync(sourcePrecheckFile),false,'cleanup_success must remove source precheck after replacement succeeds');
});

test('Category A: PAL BT.470 System B/G source with BT.470 System B/G MediaInfo labels encodes cleanly as SDR',async()=>{
 const input=path.join(dir,'cat-a-pal-bt470bg-source.mkv'),output=path.join(dir,'cat-a-pal-bt470bg-candidate.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=25:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx264','-preset','ultrafast','-crf','18','-pix_fmt','yuv420p','-colorspace','bt470bg','-color_range','tv','-c:a','aac','-y',input],{stdio:'ignore'});
 child.execFileSync('ffmpeg',['-v','error','-i',input,'-map','0','-c:v','libsvtav1','-preset','12','-crf','42','-svtav1-params','lp=1:log-level=0','-c:a','copy','-colorspace','bt470bg','-color_range','tv','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',output],{stdio:'ignore'});
 const x=load({
  inputPath:input,
  smallerOutput:output,
  colorOverride:{color_space:'bt470bg',color_transfer:'unknown',color_primaries:'unknown',color_range:'tv'},
  mediaInfoOverride:{HDR_Format:'',HDR_Format_Compatibility:'',matrix_coefficients:'BT.470 System B/G',colour_range:'Limited'}
 });
 const args=argsFor(input,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason);
 assert.deepEqual(x.calls,[22]);
});

test('Category B: native HLG source without HDR_Format routes via MediaInfo transfer_characteristics and preserves HLG',async()=>{
 const input=path.join(dir,'cat-b-hlg-source.mkv'),output=path.join(dir,'cat-b-hlg-candidate.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libsvtav1','-preset','12','-crf','10','-svtav1-params','lp=1:log-level=0','-c:a','aac','-color_primaries','bt2020','-color_trc','arib-std-b67','-colorspace','bt2020nc','-color_range','tv','-bsf:v','av1_metadata=color_primaries=9:transfer_characteristics=18:matrix_coefficients=9','-y',input],{stdio:'ignore'});
 child.execFileSync('ffmpeg',['-v','error','-i',input,'-map','0','-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-c:a','copy','-color_primaries','bt2020','-color_trc','arib-std-b67','-colorspace','bt2020nc','-color_range','tv','-bsf:v','av1_metadata=color_primaries=9:transfer_characteristics=18:matrix_coefficients=9','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',output],{stdio:'ignore'});
 const x=load({
  inputPath:input,
  smallerOutput:output,
  colorOverride:{color_primaries:'bt2020',color_transfer:'arib-std-b67',color_space:'bt2020nc',color_range:'tv'},
  mediaInfoOverride:{HDR_Format:'',HDR_Format_Compatibility:'',transfer_characteristics:'HLG',colour_primaries:'BT.2020',matrix_coefficients:'BT.2020 non-constant',colour_range:'Limited'}
 });
 const args=argsFor(input,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason);
 assert.deepEqual(x.calls,[22]);
});

test('Category C: full-range pc HDR10 source passes verified range checks and emits -color_range pc',async()=>{
 const input=path.join(dir,'cat-c-pc-hdr10-source.mkv'),output=path.join(dir,'cat-c-pc-hdr10-candidate.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx265','-preset','ultrafast','-crf','12','-x265-params','log-level=error:pools=1','-pix_fmt','yuv420p10le','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc','-color_range','pc','-c:a','aac','-y',input],{stdio:'ignore'});
 child.execFileSync('ffmpeg',['-v','error','-i',input,'-map','0','-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-c:a','copy','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc','-color_range','pc','-bsf:v','av1_metadata=color_primaries=9:transfer_characteristics=16:matrix_coefficients=9','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',output],{stdio:'ignore'});
 const x=load({
  hdr:true,
  inputPath:input,
  smallerOutput:output,
  colorOverride:{color_primaries:'bt2020',color_transfer:'smpte2084',color_space:'bt2020nc',color_range:'pc'},
  mediaInfoOverride:{HDR_Format:'SMPTE ST 2086',HDR_Format_Compatibility:'HDR10',transfer_characteristics:'PQ',colour_primaries:'BT.2020',matrix_coefficients:'BT.2020 non-constant',colour_range:'Full'}
 });
 const args=argsFor(input,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason);
 const encode=x.commands.find(c=>c.args.includes('av1_qsv'));
 assert.ok(encode,'expected av1_qsv encode');
 const idx=encode.args.indexOf('-color_range');
 assert.ok(idx>=0 && encode.args[idx+1]==='pc',`expected -color_range pc in encode args: ${encode.args.join(' ')}`);
});

test('Category D2: explicit BT.709 SDR source with orphan ST 2086 metadata encodes cleanly as SDR and strips static HDR side data',async()=>{
 const input=path.join(dir,'cat-d2-orphan-st2086-source.mkv'),output=path.join(dir,'cat-d2-orphan-st2086-candidate.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx265','-preset','ultrafast','-crf','12','-x265-params','log-level=error:pools=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=992,523','-pix_fmt','yuv420p10le','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-c:a','aac','-y',input],{stdio:'ignore'});
 child.execFileSync('ffmpeg',['-v','error','-i',input,'-map','0','-vf','sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL','-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-c:a','copy','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',output],{stdio:'ignore'});
 const x=load({
  inputPath:input,
  smallerOutput:output,
  colorOverride:{color_primaries:'bt709',color_transfer:'bt709',color_space:'bt709',color_range:'tv'},
  mediaInfoOverride:{HDR_Format:'SMPTE ST 2086',HDR_Format_Compatibility:'HDR10',transfer_characteristics:'BT.709',colour_primaries:'BT.709',matrix_coefficients:'BT.709',colour_range:'Limited'}
 });
 const args=argsFor(input,x.logs),r=await run(x,args);
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason);
 const encode=x.commands.find(c=>c.args.includes('av1_qsv'));
 assert.ok(encode,'expected av1_qsv encode');
 const vf=encode.args[encode.args.indexOf('-vf')+1];
 assert.match(vf,/sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA/);
 assert.match(vf,/sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL/);
 // Output retains no static HDR metadata even if candidate had it: reject bad candidate retaining static HDR
 const badOut=path.join(dir,'cat-d2-bad-candidate.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0:mastering-display=G(0.265,0.69)B(0.15,0.06)R(0.68,0.32)WP(0.3127,0.329)L(1000,0.0001):content-light=992,523','-c:a','aac','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',badOut],{stdio:'ignore'});
 const bad=load({
  inputPath:input,
  smallerOutput:badOut,
  colorOverride:{color_primaries:'bt709',color_transfer:'bt709',color_space:'bt709',color_range:'tv'},
  mediaInfoOverride:{HDR_Format:'SMPTE ST 2086',HDR_Format_Compatibility:'HDR10',transfer_characteristics:'BT.709',colour_primaries:'BT.709',matrix_coefficients:'BT.709',colour_range:'Limited'}
 });
 const badRes=await run(bad,argsFor(input,bad.logs));
 assert.equal(badRes.outputNumber,2,'candidate retaining static HDR on BT.709 SDR must be rejected');
});

test('half-frame delayed H.264 Matroska encodes with -enc_time_base:v 1:1000 pass timestamp comparison without quantization ties',async()=>{
 const offsetSrc=path.join(dir,'half-frame-offset-src.mkv');
 const rawH264=path.join(dir,'half-frame-raw-v.mkv');
 const rawAac=path.join(dir,'half-frame-raw-a.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24000/1001','-frames:v','48','-c:v','libx264','-preset','ultrafast','-x264-params','bframes=5:b_pyramid=2:ref=4','-y',rawH264],{stdio:'ignore'});
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2.1','-c:a','aac','-y',rawAac],{stdio:'ignore'});
 child.execFileSync('ffmpeg',['-v','error','-itsoffset','0.021','-i',rawH264,'-i',rawAac,'-map','0:v','-map','1:a','-c','copy','-y',offsetSrc],{stdio:'ignore'});

 // Verify real FFmpeg encode with -fps_mode:v passthrough -enc_time_base:v 1:1000 preserves timestamps on +21ms source
 const realOut=path.join(dir,'half-frame-offset-out.mkv');
 child.execFileSync('ffmpeg',['-v','error','-xerror','-fflags','+genpts','-i',offsetSrc,'-map','0:0','-fps_mode:v','passthrough','-enc_time_base:v','1:1000','-vf','format=yuv420p10le','-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-map','0:1','-c:a','copy','-max_interleave_delta','10000000','-avoid_negative_ts','make_zero','-max_muxing_queue_size','2048','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',realOut],{stdio:'ignore'});
 const x=load({inputPath:offsetSrc,smallerOutput:realOut});
 const args=argsFor(offsetSrc,x.logs);
 const res=await run(x,args);
 assert.equal(res.outputNumber,1,args.variables.user.failure_reason);
 const enc=x.commands.find(c=>c.args.includes('av1_qsv'));
 assert.ok(enc,'expected av1_qsv encode');
 const av=enc.args.slice(enc.args.indexOf('--')+2);
 assert.equal(av[av.indexOf('-fps_mode:v')+1],'passthrough');
 const etbIdx=av.indexOf('-enc_time_base:v');
 assert.ok(etbIdx>=0,'non-copy encode must emit -enc_time_base:v');
 assert.equal(av[etbIdx+1],'1:1000');
 assert.equal(av.includes('vpp_qsv'),false,'QSV encode must not use vpp_qsv');
 assert.ok(av[av.indexOf('-vf')+1].includes('scale_vaapi=format=p010'),'8-bit QSV encode must convert to p010 via scale_vaapi');

 const readTs=file=>child.execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','compact=p=1:nk=0',file],{encoding:'utf8'}).split(/\r?\n/).map(l=>l.match(/best_effort_timestamp_time=([^|]+)/)).filter(Boolean).map(m=>Number(m[1]));
 const srcTs=readTs(offsetSrc),outTs=readTs(realOut);
 assert.equal(outTs.length,srcTs.length);
 for(let i=1;i<outTs.length;i++) if(srcTs[i]>srcTs[i-1]) assert.ok(outTs[i]>outTs[i-1],`expected strictly increasing output PTS at frame ${i}: ${outTs[i-1]} -> ${outTs[i]}`);
});

test('MP4 mov_text converted to MKV subrip passes timeline validation despite empty 2-byte clear packets while real cue drops still reject',async()=>{
 const srtFile=path.join(dir,'movtext-cues.srt');
 fs.writeFileSync(srtFile,'1\n00:00:01,000 --> 00:00:02,000\nFirst spoken line\n\n2\n00:00:02,500 --> 00:00:03,200\nSecond spoken line\n');
 const mp4Src=path.join(dir,'movtext-source.mp4');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-i',srtFile,'-map','0:v','-map','1:a','-map','2:s','-c:v','libx265','-preset','ultrafast','-crf','12','-x265-params','log-level=error:pools=1','-c:a','aac','-c:s','mov_text','-metadata:s:s:0','language=eng','-y',mp4Src],{stdio:'ignore'});
 const mkvOut=path.join(dir,'movtext-candidate.mkv');
 child.execFileSync('ffmpeg',['-v','error','-i',mp4Src,'-map','0:v','-map','0:a','-map','0:s','-c:v','libsvtav1','-preset','12','-crf','42','-svtav1-params','lp=1:log-level=0','-c:a','copy','-c:s','srt','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',mkvOut],{stdio:'ignore'});

 const x=load({inputPath:mp4Src,smallerOutput:mkvOut});
 const args=argsFor(mp4Src,x.logs);
 args.inputFileObj.container='mp4';
 args.originalLibraryFile.container='mp4';
 const res=await run(x,args);
 assert.equal(res.outputNumber,1,args.variables.user.failure_reason);

 // Dropping one real dialogue cue in the SRT output must still be rejected
 const droppedSrtFile=path.join(dir,'movtext-dropped.srt');
 fs.writeFileSync(droppedSrtFile,'1\n00:00:01,000 --> 00:00:02,000\nFirst spoken line\n');
 const badOut=path.join(dir,'movtext-dropped-candidate.mkv');
 child.execFileSync('ffmpeg',['-v','error','-i',mkvOut,'-i',droppedSrtFile,'-map','0:v','-map','0:a','-map','1:0','-c:v','copy','-c:a','copy','-c:s','srt','-metadata:g','encoded_by=ArcAV1_QSV_V15','-y',badOut],{stdio:'ignore'});
 const bad=load({inputPath:mp4Src,smallerOutput:badOut});
 const badArgs=argsFor(mp4Src,bad.logs);
 badArgs.inputFileObj.container='mp4';
 badArgs.originalLibraryFile.container='mp4';
 const badRes=await run(bad,badArgs);
 assert.equal(badRes.outputNumber,2,'dropping an actual dialogue cue must still fail validation');
 assert.match(badArgs.variables.user.failure_reason,/Output subtitle packet count 1 is less than source 2/);
});

test('timestamp-isolated fallback emits Validation worker progress updates from decoded frames',async()=>{
 const progressUpdates=[];
 const x=load({qsvTimestampFailure:true,qsvTimestampExitZero:true,qsvLongTimestampLines:true,matchedVideoDtsTies:true,matchedSubFramePtsTie:true});
 const args=argsFor(source,x.logs);
 args.updateWorker=payload=>progressUpdates.push(payload);
 const r=await run(x,args);
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason);
 const isolated=progressUpdates.filter(p=>p?.status==='Validation: timestamp-isolated software decode');
 assert.ok(isolated.length>=2 && Number(isolated.at(-1).percentage)>Number(isolated[0].percentage),`expected advancing frame-driven progress during timestamp-isolated decode, got ${JSON.stringify(isolated)}`);
});

test('QSV encode allocates proportional progress across source scan, encode, and candidate validation monotonically',async()=>{
 const progressUpdates=[];
 const x=load();
 const args=argsFor(source,x.logs);
 args.updateWorker=payload=>progressUpdates.push(payload);
 const r=await run(x,args);
 assert.equal(r.outputNumber,1,args.variables.user.failure_reason);
 const percentages=progressUpdates.map(p=>Number(p.percentage)).filter(Number.isFinite);
 assert.ok(percentages.length>=5,'expected multi-phase worker progress updates');
 for(let i=1;i<percentages.length;i++) assert.ok(percentages[i]>=percentages[i-1],`progress went backwards at index ${i}: ${percentages[i-1]} -> ${percentages[i]}`);
 const srcMax=Math.max(...progressUpdates.filter(p=>p.status==='Precheck: full source video scan').map(p=>Number(p.percentage)));
 const encMax=Math.max(...progressUpdates.filter(p=>/Encoding: Arc QSV AV1/.test(String(p.status||''))).map(p=>Number(p.percentage)));
 assert.ok(srcMax>15,`expected source video scan budget >15% on QSV route, got ${srcMax}`);
 assert.ok(encMax<65,`expected QSV encode end <65% leaving room for candidate scan & decode, got ${encMax}`);
});

test('Dolby Vision Profile 5 emits live extraction progress on first pass and reuses cached Level 6/9 preflight on quarantined retry',async()=>{
 const library=path.join(dir,'dovi5-cache-library');fs.mkdirSync(library,{recursive:true});
 const dvInput=path.join(library,'dovi5-source.mp4');fs.copyFileSync(source,dvInput);
 const dvOut=path.join(dir,'dovi5-hdr10-candidate.mkv');
 child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-map','0:v:0','-map','1:a:0','-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-c:a','aac','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc','-color_range','tv','-bsf:v','av1_metadata=color_primaries=9:transfer_characteristics=16:matrix_coefficients=9','-metadata:g','encoded_by=ArcAV1_SVTAV1_HDRFallback_V15','-y',dvOut],{stdio:'ignore'});
 const dvInfo={HDR_Format:'Dolby Vision',HDR_Format_Profile:'dvhe.05.06',HDR_Format_Compatibility:'IPT-PQ-c2',colour_range:'Full'};

 const firstUpdates=[];
 const first=load({inputPath:dvInput,smallerOutput:dvOut,dovi5Test:true,mediaInfoOverride:dvInfo,qsvValidationFailure:true,cpuValidationFailure:true});
 const firstArgs=argsFor(dvInput,first.logs);firstArgs.librarySettings.folder=library;
 firstArgs.updateWorker=u=>firstUpdates.push(u);
 const r1=await run(first,firstArgs);
 assert.equal(r1.outputNumber,2);
 assert.equal(first.doviExtractCalls(),1);
 const dvProgress=firstUpdates.filter(u=>u?.status==='Precheck: Dolby Vision metadata').map(u=>Number(u.percentage));
 assert.ok(dvProgress.length>=2&&dvProgress.at(-1)>dvProgress[0],`expected Dolby Vision extraction progress updates, got ${JSON.stringify(dvProgress)}`);
 assert.ok(firstArgs.variables.user.quarantine_entry,'complete candidate should be quarantined for retry');

 const secondUpdates=[];
 const second=load({inputPath:dvInput,smallerOutput:dvOut,dovi5Test:true,mediaInfoOverride:dvInfo,qsvValidationFailure:true,cpuValidationFailure:true});
 const secondArgs=argsFor(dvInput,second.logs);secondArgs.librarySettings.folder=library;
 secondArgs.updateWorker=u=>secondUpdates.push(u);
 const r2=await run(second,secondArgs);
 assert.equal(r2.outputNumber,2);
 assert.equal(second.doviExtractCalls(),0,'quarantined retry must reuse cached Level 6/9 metadata instead of re-extracting');
 assert.ok(second.logs.some(line=>line.includes('[HDR preflight] Reused cached Dolby Vision Profile 5 Level 6/9 metadata (96 frames).')));
});
