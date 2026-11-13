const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const flow=JSON.parse(fs.readFileSync(path.join(__dirname,'flow.json')));
const code=flow.flowPlugins.find(p=>p.id==='arc_av1_monolithic').inputsDB.code.replace(/https:\/\/discord\.com\/api\/webhooks\/[^"\s]+/g,'YOUR_WEBHOOK');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tdarr-v4-integration-'));
process.env.TDARR_RESERVATION_ROOT=dir;
process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));
const source=path.join(dir,'source.mkv'),candidate=path.join(dir,'candidate.mkv');
child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libsvtav1','-preset','12','-crf','10','-svtav1-params','lp=1:log-level=0','-c:a','aac','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-bsf:v','av1_metadata=color_primaries=1:transfer_characteristics=1:matrix_coefficients=1','-metadata','encoded_by=ArcAV1_QSV','-y',source],{stdio:'ignore'});
child.execFileSync('ffmpeg',['-v','error','-i',source,'-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-c:a','copy','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-bsf:v','av1_metadata=color_primaries=1:transfer_characteristics=1:matrix_coefficients=1','-metadata','encoded_by=ArcAV1_QSV_V13','-y',candidate],{stdio:'ignore'});
assert.ok(fs.statSync(candidate).size < fs.statSync(source).size);
function argsFor(file,logs=[]) { const f={_id:file,container:'mkv',file_size:fs.statSync(file).size/1024/1024}; return {inputFileObj:{...f},originalLibraryFile:{...f},workDir:dir,variables:{user:{min_cache_free_mb:1}},ffmpegPath:'ffmpeg',librarySettings:{folder:dir},jobLog:m=>logs.push(String(m))}; }
function load({alwaysLarge=false,failEncoding=false,failRemux=false,remuxBloat=false,missingPrlimit=false,limitOnFirst=false,uhd=false,mediainfo=true,hdr=false,extraVideo=false,denyIso=false,inputPath=source,smallerOutput=candidate}={}) {
  const calls=[],commands=[],logs=[]; let initialProbe=true;
  const fakeFs=new Proxy(fs,{get(t,p){if(p==='unlinkSync' && denyIso)return name=>{if(String(name).endsWith('.iso'))throw Error('simulated ISO permission error');return t.unlinkSync(name)};if(p==='accessSync')return (name,...args)=>name==='/dev/dri/renderD129'?undefined:t.accessSync(name,...args);return t[p]}});
  const fakeChild={...child,
    spawn(cmd,args,opts){
      if(cmd!=='prlimit')return child.spawn(cmd,args,opts);
      const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
      const process=new EventEmitter();process.stdout=new PassThrough();process.stderr=new PassThrough();process.kill=()=>{};
      commands.push({cmd,args});
      queueMicrotask(()=>{
        if(missingPrlimit){process.emit('error',Error('spawn prlimit ENOENT'));process.emit('close',null,null);return;}
        const av=args.slice(args.indexOf('--')+2),qi=av.indexOf('-global_quality'),q=Number(av[qi+1]);if(qi>=0)calls.push(q);
        if(qi<0){
          if(failRemux){process.stderr.write('Metadata: subtitle details\nPress [q] to stop, [?] for help\n');process.emit('close',1,null);return;}
          const output=av[av.length-1],remuxArgs=['-v','error','-i',inputPath,'-map','0','-c','copy','-metadata:g','encoded_by=ArcAV1_SeekHeal_V13'];
          if(remuxBloat)remuxArgs.push('-metadata:g',`comment=${'x'.repeat(2048)}`);
          remuxArgs.push('-y',output);child.execFileSync('ffmpeg',remuxArgs,{stdio:'ignore'});
          const limitArg=args.find(x=>String(x).startsWith('--fsize=')),limit=limitArg?Number(String(limitArg).split('=')[1].split(':')[0]):Number.MAX_SAFE_INTEGER;
          if(fs.statSync(output).size>limit){process.emit('close',null,'SIGXFSZ');return;}
          process.stdout.write('out_time_us=2000000\nfps=24\nprogress=continue\n');process.emit('close',0,null);return;
        }
        process.stdout.write('out_time_us=2000000\nfps=24\nprogress=continue\n');
        if(limitOnFirst&&q===22){fs.copyFileSync(source,av[av.length-1]);process.emit('close',null,'SIGXFSZ');return;}
        if(failEncoding){process.stderr.write('simulated failure');process.emit('close',1,null);return;}
        fs.copyFileSync(alwaysLarge||q===20?inputPath:smallerOutput,av[av.length-1]);process.emit('close',0,null);
      });
      return process;
    },
    execFileSync(cmd,args,opts){
      if(cmd==='mediainfo') {if(!mediainfo) throw Error('no mediainfo');return JSON.stringify({media:{track:[{'@type':'Video',...(hdr?{HDR_Format:'SMPTE ST 2086',HDR_Format_Compatibility:'HDR10'}:{transfer_characteristics:'BT.709'})}]}});}
      const result=child.execFileSync(cmd,args,opts);
      if(cmd==='ffprobe') {
        const probe=JSON.parse(result);
        for(const stream of probe.streams||[])if(stream.codec_type==='video')Object.assign(stream,hdr?{color_transfer:'smpte2084',color_primaries:'bt2020',color_space:'bt2020nc',color_range:'tv'}:{color_transfer:'bt709',color_primaries:'bt709',color_space:'bt709',color_range:'tv'});
        if(initialProbe && args.includes('-show_format') && args[args.length-1]===inputPath) {
          initialProbe=false;
          const video=probe.streams.find(s=>s.codec_type==='video');video.width=uhd?3840:1920;video.height=uhd?2160:1080;
          if(extraVideo)probe.streams.push({index:999,codec_type:'video',codec_name:'mjpeg',disposition:{attached_pic:0,timed_thumbnails:0}});
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
  new Function('require','module','exports',code+'\nmodule.exports.releaseForTest=releaseCapacity;')(req,m,m.exports);
  return {fn:m.exports,calls,commands,logs};
}
async function run(x,args) {try{return await x.fn(args);}finally{const h=args.variables?.user?.cache_reservation;if(h){await x.fn.releaseForTest(h);delete args.variables.user.cache_reservation;}}}

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
  child.execFileSync('ffmpeg',['-v','error','-i',input,'-map','0','-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-c:a','copy','-c:s','copy','-metadata:g','encoded_by=ArcAV1_QSV_V13','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-y',output],{stdio:'ignore'});
  const x=load({inputPath:input,smallerOutput:output}),args=argsFor(input,x.logs),r=await run(x,args);
  const encode=x.commands.find(c=>c.args.includes('av1_qsv'));
  assert.ok(encode,`expected one Arc QSV AV1 encode for ${extension}`);
  const ffArgs=encode.args.slice(encode.args.indexOf('--')+2),subMap=ffArgs.findIndex((v,i)=>v==='-map'&&ffArgs[i+1]==='0:2'),subCodec=ffArgs.indexOf('-c:s:0');
  assert.ok(subMap>=0,`${extension} source stream should be mapped`);
  assert.equal(ffArgs[subCodec+1],'copy',`${extension} stream must not pass through the SRT encoder`);
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
 child.execFileSync('ffmpeg',['-v','error','-i',input,'-map','0','-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-c:a','copy','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc','-color_range','tv','-bsf:v','av1_metadata=color_primaries=9:transfer_characteristics=16:matrix_coefficients=9','-metadata:g','encoded_by=ArcAV1_QSV_V13','-y',output],{stdio:'ignore'});
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


test('an additional non-attached video stream is never discarded',async()=>{
 const x=load({extraVideo:true}),r=await run(x,argsFor(source));
 assert.equal(r.outputNumber,2);assert.deepEqual(x.calls,[]);
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
 new Function('require','module','exports',guard.inputsDB.code)(require,m,m.exports);
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
 const loadPlugin=(id,req=require)=>{const node=flow.flowPlugins.find(p=>p.id===id),m={exports:{}};new Function('require','module','exports',node.inputsDB.code)(req,m,m.exports);return m.exports;};
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
