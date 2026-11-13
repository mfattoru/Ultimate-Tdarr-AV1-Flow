const test = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {parseSubtitlePacketLine,readSubtitlePackets,validateCopiedSubtitlePackets} = require('./subtitle_timing');

const packet=(pts,dts,duration,payloadHash)=>({pts,dts,duration,payloadHash});
test('source subtitle precheck predicts the bounded timestamp repair without modifying cues',()=>{
 const {createSubtitleTimingPrecheck}=require('./subtitle_timing');
 const check=createSubtitleTimingPrecheck();
 for(const pts of [0,2.5,5,1.86])check.push({pts,dts:pts});
 const result=check.finish();
 assert.equal(result.packetCount,4);
 assert.equal(result.maxAdjustmentSeconds,3.14);
 assert.equal(result.firstOverLimitPacket,3);
 const safe=createSubtitleTimingPrecheck();
 for(const pts of [0,1,0.6,2])safe.push({pts,dts:pts});
 assert.equal(safe.finish().firstOverLimitPacket,null);
});

test('parses FFprobe ASS packet timestamps, duration and SHA-256 hash',()=>{
 assert.deepEqual(
  parseSubtitlePacketLine('pts_time=2.450000|dts_time=2.450000|duration_time=0.310000|data_hash=SHA256:abc123'),
  {pts:2.45,dts:2.45,duration:0.31,position:null,payloadHash:'SHA256:abc123'}
 );
});

test('clamps an out-of-order ASS packet without adding an artificial 1 ms shift to equal timestamps',()=>{
 const source=[packet(2.450,2.450,0.2,'a'),packet(2.140,2.140,0.4,'b'),packet(3.100,3.100,0.5,'c')];
 const output=[packet(2.517,2.517,0.2,'a'),packet(2.517,2.517,0.4,'b'),packet(3.167,3.167,0.5,'c')];
 const result=validateCopiedSubtitlePackets(source,output,0.067);
 assert.deepEqual(result,{packetCount:3,adjustedPackets:1,maxAdjustmentSeconds:0.31});
});

test('keeps clean ASS timestamps unchanged apart from the common video shift',()=>{
 const source=[packet(1,1,0.5,'a'),packet(2,2,0.5,'b')];
 const output=[packet(1.067,1.067,0.5,'a'),packet(2.067,2.067,0.5,'b')];
 assert.deepEqual(validateCopiedSubtitlePackets(source,output,0.067),{packetCount:2,adjustedPackets:0,maxAdjustmentSeconds:0});
});

test('rejects timestamp movement larger than the 0.5 second limit',()=>{
 const source=[packet(2.45,2.45,0.2,'a'),packet(1.8,1.8,0.2,'b')];
 const output=[packet(2.45,2.45,0.2,'a'),packet(2.451,2.451,0.2,'b')];
 assert.throws(()=>validateCopiedSubtitlePackets(source,output,0),/exceeds the 0.5s repair limit/);
});

test('rejects changed packet counts or payloads',()=>{
 const source=[packet(1,1,0.2,'same'),packet(2,2,0.2,'second')];
 assert.throws(()=>validateCopiedSubtitlePackets(source,source.slice(0,1),0),/packet count changed/);
 assert.throws(()=>validateCopiedSubtitlePackets(source,[source[0],packet(2,2,0.2,'changed')],0),/payload changed/);
});

test('rejects missing PTS and non-monotonic repaired output',()=>{
 assert.throws(()=>validateCopiedSubtitlePackets([packet(null,1,0.2,'a')],[packet(1,1,0.2,'a')],0),/missing or invalid PTS/);
 assert.throws(()=>validateCopiedSubtitlePackets([packet(1,1,0.2,'a'),packet(2,2,0.2,'b')],[packet(1,1,0.2,'a'),packet(0.9,0.9,0.2,'b')],0),/output PTS is not monotonic/);
});
test('unavailable source subtitle measurements stay inconclusive while newly lost candidate PTS rejects',async()=>{
 const {newValidationReport,validationStage}=require('./validation');
 const {validateCopiedSubtitlePackets}=require('./subtitle_timing');
 const packet={pts:1,dts:1,duration:1,payloadHash:'same'};
 for(const source of [{...packet,pts:null},{...packet,payloadHash:''}]){
  const report=newValidationReport();
  await assert.rejects(validationStage(report,'timelines',()=>validateCopiedSubtitlePackets([source],[packet],0),'rejected'),e=>e.validation?.outcome==='inconclusive');
 }
 const report=newValidationReport();
 await assert.rejects(validationStage(report,'timelines',()=>validateCopiedSubtitlePackets([packet],[{...packet,pts:null}],0),'rejected'),e=>e.validation?.outcome==='rejected');
});

test('packet parser preserves valid negative DTS and maps unavailable numeric fields to null',()=>{
 assert.deepEqual(parseSubtitlePacketLine('pts_time=N/A|dts_time=-0.125|duration_time=bad|pos=|data_hash=sha256:abc'),{
  pts:null,dts:-0.125,duration:null,position:null,payloadHash:'sha256:abc'
 });
 assert.deepEqual(parseSubtitlePacketLine('data_hash=sha256:empty'),{
  pts:null,dts:null,duration:null,position:null,payloadHash:'sha256:empty'
 });
 assert.equal(parseSubtitlePacketLine('codec_type=subtitle|flags=K_'),null);
});

test('reader streams packet rows and monotonic byte-based progress from ffprobe',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tdarr-subtitle-packets-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const file=path.join(directory,'source.mkv');fs.writeFileSync(file,Buffer.alloc(100));
 const previous=global.runTimelineProcess,progress=[];
 global.runTimelineProcess=async(command,args,onLine)=>{
  assert.equal(command,'ffprobe');
  assert.ok(args.includes('-show_packets'));
  for(const line of [
   'pts_time=0.250|dts_time=0.250|duration_time=0.100|data_hash=sha256:first|pos=10',
   'codec_type=subtitle|flags=K_',
   'pts_time=1.250|dts_time=1.250|duration_time=0.100|data_hash=sha256:second|pos=50',
   'pts_time=3.000|dts_time=3.000|duration_time=N/A|data_hash=sha256:last|pos=100'
  ]) onLine(line);
 };
 try {
  const packets=await readSubtitlePackets('ffprobe',file,3,ratio=>progress.push(ratio),4);
  assert.deepEqual(packets,[
   {pts:0.25,dts:0.25,duration:0.1,position:10,payloadHash:'sha256:first'},
   {pts:1.25,dts:1.25,duration:0.1,position:50,payloadHash:'sha256:second'},
   {pts:3,dts:3,duration:null,position:100,payloadHash:'sha256:last'}
  ]);
  assert.deepEqual(progress,[0.1,0.5,1,1]);
 } finally {
  if(previous===undefined)delete global.runTimelineProcess;else global.runTimelineProcess=previous;
 }
});

test('reader falls back to timestamp progress when packet byte positions are absent',async()=>{
 const previous=global.runTimelineProcess,progress=[];
 global.runTimelineProcess=async(_command,_args,onLine)=>{
  onLine('pts_time=1|dts_time=N/A|duration_time=0.5|data_hash=sha256:first');
  onLine('pts_time=3.5|dts_time=N/A|duration_time=0.5|data_hash=sha256:last');
 };
 try {
  const packets=await readSubtitlePackets('ffprobe','/file/not/present.mkv',0,ratio=>progress.push(ratio),4);
  assert.equal(packets.length,2);
  assert.deepEqual(progress,[0.25,0.875,1]);
 } finally {
  if(previous===undefined)delete global.runTimelineProcess;else global.runTimelineProcess=previous;
 }
});

test('empty subtitle timelines and invalid comparisons fail with the intended result',()=>{
 assert.deepEqual(validateCopiedSubtitlePackets([],[],0),{packetCount:0,adjustedPackets:0,maxAdjustmentSeconds:0});
 assert.throws(()=>validateCopiedSubtitlePackets(null,[],0),error=>error.validation?.outcome==='inconclusive');
 assert.throws(()=>validateCopiedSubtitlePackets([],[],NaN),error=>error.validation?.outcome==='inconclusive');
 assert.throws(()=>validateCopiedSubtitlePackets([],[],-1,-1),error=>error.validation?.outcome==='inconclusive');
});

test('missing source hashes and invalid source DTS remain inconclusive',()=>{
 const valid=packet(1,1,0.25,'a');
 assert.throws(()=>validateCopiedSubtitlePackets([packet(1,1,0.25,'')],[valid],0),error=>error.validation?.outcome==='inconclusive');
 assert.throws(()=>validateCopiedSubtitlePackets([valid],[packet(1,1,0.25,'')],0),error=>error.validation?.outcome==='inconclusive');
 assert.throws(()=>validateCopiedSubtitlePackets([packet(1,NaN,0.25,'a')],[valid],0),error=>error.validation?.outcome==='inconclusive');
});

test('subtitle DTS regressions and changed presentation extent reject the candidate',()=>{
 const source=[packet(1,null,1,'a'),packet(2,null,1,'b')];
 const outOfOrderDts=[packet(1,2,1,'a'),packet(2,1,1,'b')];
 assert.throws(()=>validateCopiedSubtitlePackets(source,outOfOrderDts,0),/output DTS is not monotonic/);
 const dtsSource=[packet(1,1,1,'a')],missingDts=[packet(1,null,1,'a')];
 assert.throws(()=>validateCopiedSubtitlePackets(dtsSource,missingDts,0),/missing or invalid DTS newly in candidate/);
 assert.throws(()=>validateCopiedSubtitlePackets([packet(1,1,2,'a')],[packet(1,1,0.2,'a')],0),/timeline differs from source/);
});

test('subtitle repair accepts an adjustment exactly at the configured boundary',()=>{
 const result=validateCopiedSubtitlePackets([packet(1,1,0.5,'a')],[packet(1.5,1.5,0.5,'a')],0,0.5);
 assert.deepEqual(result,{packetCount:1,adjustedPackets:1,maxAdjustmentSeconds:0.5});
});

test('validates chronologically reordered ASS packets when source has out-of-order cues > 0.5s (Overlord S01E08 pattern)',()=>{
 const source=[
  packet(0.500,0.500,1.000,'SHA256:first'),
  packet(2.500,2.500,1.500,'SHA256:second'),
  packet(5.000,5.000,3.000,'SHA256:sign_at_5s'),
  packet(1.860,1.860,1.640,'SHA256:dialogue_at_1_86s')
 ];
 const chronologicallySortedOutput=[
  packet(0.500,0.500,1.000,'SHA256:first'),
  packet(1.860,1.860,1.640,'SHA256:dialogue_at_1_86s'),
  packet(2.500,2.500,1.500,'SHA256:second'),
  packet(5.000,5.000,3.000,'SHA256:sign_at_5s')
 ];
 const result=validateCopiedSubtitlePackets(source,chronologicallySortedOutput,0,0.5);
 assert.equal(result.packetCount,4);
 assert.equal(result.reorderedPackets,3);
 assert.equal(result.maxAdjustmentSeconds,0);
});
test('ASS reconstruction never reads hex-like ASCII columns as packet data',()=>{
 const {reconstructAssSubtitleFile}=require('./subtitle_timing');
 const dump=text=>{
  const bytes=Buffer.from(text,'utf8');let result='';
  for(let i=0;i<bytes.length;i+=16){
   const chunk=bytes.subarray(i,i+16);
   const pairs=[];for(let n=0;n<chunk.length;n+=2)pairs.push(chunk.subarray(n,n+2).toString('hex'));
   const ascii=Array.from(chunk,b=>b>=32&&b<127?String.fromCharCode(b):'.').join('');
   result+=`${i.toString(16).padStart(8,'0')}: ${pairs.join(' ').padEnd(39,' ')}  ${ascii}\n`;
  }
  return result;
 };
 const payload='0,0,Default,,0,0,0,,'.padEnd(32,'x')+'150 150{\\r\\clip(629,30,690,44)}';
 const header='[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
 const result=reconstructAssSubtitleFile({streams:[{extradata:dump(header)}],packets:[{pts_time:'1.86',duration_time:'1.64',data:dump(payload)}]});
 assert.ok(result.includes(payload.substring(payload.indexOf(',')+3)),'all cue bytes must survive without ASCII-column bytes being appended');
 assert.equal(result.includes('\x15'),false);
 assert.throws(()=>reconstructAssSubtitleFile({streams:[{extradata:dump(header)}],packets:[{pts_time:'1.86',duration_time:'1.64',data:dump(payload),data_hash:'SHA256:'+'0'.repeat(64)}]}),/hash/i,'a dump that disagrees with FFprobe’s packet hash must be rejected');
});

test('reconstructAssSubtitleFile builds a chronologically muxable ASS script from out-of-order ffprobe packet dumps',async t=>{
 const {reconstructAssSubtitleFile}=require('./subtitle_timing');
 assert.equal(typeof reconstructAssSubtitleFile,'function');
 const cp=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tdarr-ass-reconstruct-'));
 t.after(()=>fs.rmSync(directory=dir,{recursive:true,force:true}));
 const assInput=path.join(dir,'source.ass');
 fs.writeFileSync(assInput,`[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,First line\nDialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,Sign at 5s\nDialogue: 0,0:00:01.86,0:00:03.50,Default,,0,0,0,,Line at 1.86s\n`);
 const probed=JSON.parse(cp.execFileSync('ffprobe',['-v','error','-select_streams','s:0','-show_streams','-show_packets','-show_data','-of','json',assInput],{encoding:'utf8'}));
 const outOfOrderProbe={
  streams:probed.streams,
  packets:[probed.packets[0],probed.packets[2],probed.packets[1]]
 };
 const normalizedAssPath=path.join(dir,'normalized.ass');
 fs.writeFileSync(normalizedAssPath,reconstructAssSubtitleFile(outOfOrderProbe));
 const fontPath=path.join(dir,'Dominica.ttf');
 fs.writeFileSync(fontPath,Buffer.from('00010000000a008000030020', 'hex'));
 const srcMkv=path.join(dir,'src.mkv');
 cp.execFileSync('ffmpeg',[
  '-v','error',
  '-f','lavfi','-i','color=c=black:s=64x64:d=10',
  '-i',assInput,
  '-map','0:0','-map','1:0',
  '-c:v','libx264','-c:s:0','copy',
  '-metadata:s:s:0','language=eng',
  '-metadata:s:s:0','title=Signs & Songs',
  '-attach',fontPath,
  '-metadata:s:t:0','filename=Dominica.ttf',
  '-metadata:s:t:0','mimetype=font/ttf',
  srcMkv
 ]);
 const outMkv=path.join(dir,'out.mkv');
 cp.execFileSync('ffmpeg',[
  '-v','error',
  '-i',srcMkv,
  '-i',normalizedAssPath,
  '-map','0:0',
  '-map','1:0','-c:s:0','copy',
  '-metadata:s:s:0','language=eng',
  '-metadata:s:s:0','title=Signs & Songs',
  '-disposition:s:0','default',
  '-map','0:2','-c:t','copy',
  '-c:v','copy',
  outMkv
 ]);
 const srcStreams=JSON.parse(cp.execFileSync('ffprobe',['-v','error','-show_streams','-show_data_hash','sha256','-of','json',srcMkv],{encoding:'utf8'})).streams;
 const dstStreams=JSON.parse(cp.execFileSync('ffprobe',['-v','error','-show_streams','-show_data_hash','sha256','-of','json',outMkv],{encoding:'utf8'})).streams;
 const dstSub=dstStreams.find(s=>s.codec_type==='subtitle');
 assert.equal(dstSub.tags?.language,'eng');
 assert.equal(dstSub.tags?.title,'Signs & Songs');
 const dstAtt=dstStreams.find(s=>s.codec_type==='attachment');
 assert.equal(dstAtt.tags?.filename,'Dominica.ttf');
 assert.equal(dstAtt.tags?.mimetype,'font/ttf');
 assert.equal(dstAtt.extradata_hash,srcStreams.find(s=>s.codec_type==='attachment').extradata_hash);
 const lines=cp.execFileSync('ffprobe',['-v','error','-select_streams','s:0','-show_packets','-show_data_hash','sha256','-show_entries','packet=pts_time,dts_time,duration_time,data_hash','-of','compact=p=0:nk=0',outMkv],{encoding:'utf8'}).trim().split(/\r?\n/);
 const outputPackets=lines.map(parseSubtitlePacketLine);
 assert.equal(outputPackets.length,3);
 assert.deepEqual(outputPackets.map(p=>p.pts),[0.5,1.86,5]);
 const sourcePackets=[outputPackets[0],outputPackets[2],outputPackets[1]];
 const validation=validateCopiedSubtitlePackets(sourcePackets,outputPackets,0,0.5);
 assert.equal(validation.packetCount,3);
 assert.equal(validation.maxAdjustmentSeconds,0);
});

test('readSubtitlePackets and validateCopiedSubtitlePackets accept reconstructed ASS tracks when FFmpeg renumbers ReadOrder and tie-breaks equal-PTS cues (Overlord S01E08 live failure)',async t=>{
 const {reconstructAssSubtitleFile}=require('./subtitle_timing');
 const cp=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tdarr-ass-overlord-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const makeHex=str=>'00000000: '+Buffer.from(str,'utf8').toString('hex').replace(/(..)/g,'$1 ')+'\n';
 const header='[Script Info]\r\nScriptType: v4.00+\r\n\r\n[V4+ Styles]\r\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\r\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1\r\n\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n';
 // Source MKV has out-of-order packets (3.140s backward step at packet 4 to 0.000s)
 // and non-sequential/duplicate ReadOrder prefixes from merged fansub events/comments.
 const sourceProbe={
  streams:[{extradata:makeHex(header)}],
  packets:[
   {pts_time:'0.000000',dts_time:'0.000000',duration_time:'3.140000',data:makeHex('0,0,Default,Sign,0000,0000,0000,,{\\pos(320,240)}Episode Title')},
   {pts_time:'1.500000',dts_time:'1.500000',duration_time:'1.640000',data:makeHex('5,0,Default,Ainz,0000,0000,0000,,Dialogue after 4 comment lines | with pipe')},
   {pts_time:'3.140000',dts_time:'3.140000',duration_time:'1.860000',data:makeHex('6,0,Default,Albedo,0000,0000,0000,,Lord Ainz-sama!')},
   {pts_time:'0.000000',dts_time:'0.000000',duration_time:'3.140000',data:makeHex('0,1,Default,Sign,0010,0010,0010,,{\\fad(100,100)}Merged Honorific Sign at 0s')}
  ]
 };
 const normAssPath=path.join(dir,'normalized.ass');
 fs.writeFileSync(normAssPath,reconstructAssSubtitleFile(sourceProbe));
 const outMkv=path.join(dir,'out.mkv');
 cp.execFileSync('ffmpeg',[
  '-v','error',
  '-f','lavfi','-i','color=c=black:s=64x64:d=6',
  '-i',normAssPath,
  '-map','0:0','-map','1:0',
  '-c:v','libx264','-c:s:0','copy',
  outMkv
 ]);
 const prevRun=global.runTimelineProcess;
 global.runTimelineProcess=(cmd,args,onLine)=>new Promise((resolve,reject)=>{
  try{
   const stdout=cp.execFileSync(cmd,args,{encoding:'utf8'});
   for(const line of stdout.split(/\r?\n/))if(line.trim())onLine(line);
   resolve('');
  }catch(err){reject(err);}
 });
 try{
  const outputPackets=await readSubtitlePackets('ffprobe',outMkv,1);
  // Build source packets as readSubtitlePackets would parse them from the source MKV
  const sourcePackets=sourceProbe.packets.map((pkt,idx)=>{
   const rawBytes=Buffer.from(pkt.data.replace(/^[0-9a-f]{8}:\s+/i,'').trim().replace(/\s+/g,''),'hex');
   const sha='SHA256:'+require('node:crypto').createHash('sha256').update(rawBytes).digest('hex');
   const compactData='\\n00000000: '+rawBytes.toString('hex').replace(/(..)/g,'$1 ')+'  text\\n';
   return parseSubtitlePacketLine(`pts_time=${pkt.pts_time}|dts_time=${pkt.dts_time}|duration_time=${pkt.duration_time}|pos=${idx*100}|data=${compactData}|data_hash=${sha}`);
  });
  const result=validateCopiedSubtitlePackets(sourcePackets,outputPackets,0,0.5);
  assert.equal(result.packetCount,4);
  assert.ok(result.reorderedPackets>0);
  assert.equal(result.maxAdjustmentSeconds,0);
 }finally{
  if(prevRun===undefined)delete global.runTimelineProcess;else global.runTimelineProcess=prevRun;
 }
});
