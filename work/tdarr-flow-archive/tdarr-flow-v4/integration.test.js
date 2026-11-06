const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const flow=JSON.parse(fs.readFileSync(path.join(__dirname,'flow.json')));
const code=flow.flowPlugins.find(p=>p.id==='arc_av1_monolithic').inputsDB.code.replace(/https:\/\/discord\.com\/api\/webhooks\/[^"\s]+/g,'YOUR_WEBHOOK');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tdarr-v4-integration-'));
process.env.TDARR_CAPACITY_LOCK_DIR=dir;
process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));
const source=path.join(dir,'source.mkv'),candidate=path.join(dir,'candidate.mkv');
child.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libsvtav1','-preset','12','-crf','10','-svtav1-params','lp=1:log-level=0','-c:a','aac','-metadata','encoded_by=ArcAV1_QSV','-y',source],{stdio:'ignore'});
child.execFileSync('ffmpeg',['-v','error','-i',source,'-c:v','libsvtav1','-preset','12','-crf','40','-svtav1-params','lp=1:log-level=0','-c:a','copy','-metadata','encoded_by=ArcAV1_QSV_V4','-y',candidate],{stdio:'ignore'});
assert.ok(fs.statSync(candidate).size < fs.statSync(source).size);
function argsFor(file) { const f={_id:file,container:'mkv',file_size:fs.statSync(file).size/1024/1024}; return {inputFileObj:{...f},originalLibraryFile:{...f},workDir:dir,variables:{user:{min_cache_free_mb:1}},ffmpegPath:'ffmpeg',librarySettings:{folder:dir},jobLog:()=>{}}; }
function load({alwaysLarge=false,failEncoding=false,mediainfo=true,hdr=false,extraVideo=false}={}) {
  const calls=[]; let initialProbe=true;
  const fakeFs=new Proxy(fs,{get(t,p){if(p==='accessSync')return (name,...args)=>name==='/dev/dri/renderD129'?undefined:t.accessSync(name,...args);return t[p]}});
  const fakeChild={...child,
    execFileSync(cmd,args,opts){
      if(cmd==='mediainfo') {if(!mediainfo) throw Error('no mediainfo');return JSON.stringify({media:{track:[{'@type':'Video',...(hdr?{HDR_Format:'SMPTE ST 2086',HDR_Format_Compatibility:'HDR10'}:{transfer_characteristics:'BT.709'})}]}});}
      const result=child.execFileSync(cmd,args,opts);
      if(cmd==='ffprobe' && initialProbe && args.includes('-show_format') && args[args.length-1]===source) {
        initialProbe=false;
        const probe=JSON.parse(result);probe.streams.find(s=>s.codec_type==='video').width=1920;probe.streams.find(s=>s.codec_type==='video').height=1080;if(hdr)Object.assign(probe.streams.find(s=>s.codec_type==='video'),{color_transfer:'smpte2084',color_primaries:'bt2020',color_space:'bt2020nc'});if(extraVideo)probe.streams.push({index:999,codec_type:'video',codec_name:'mjpeg',disposition:{attached_pic:0,timed_thumbnails:0}});return JSON.stringify(probe);
      }
      return result;
    },
    spawnSync(cmd,args,opts){
      if(cmd==='ffmpeg' && args.includes('av1_qsv')) {
        const q=Number(args[args.indexOf('-global_quality')+1]); calls.push(q);
        if(failEncoding)return {status:1,stderr:'simulated failure'};
        fs.copyFileSync(alwaysLarge || q===19 ? source : candidate,args[args.length-1]);
        return {status:0,stderr:''};
      }
      return child.spawnSync(cmd,args,opts);
    }
  };
  const m={exports:{}}; const req=n=>n==='fs'?fakeFs:n==='child_process'?fakeChild:require(n);
  new Function('require','module','exports',code+'\nmodule.exports.releaseForTest=releaseCapacityLock;')(req,m,m.exports);
  return {fn:m.exports,calls};
}
async function run(x,args) {try{return await x.fn(args);}finally{x.fn.releaseForTest(args.variables,()=>{});}}

test('old AV1 is encoded and retries until a smaller valid output',async()=>{
 const x=load(),args=argsFor(source),r=await run(x,args);
 assert.deepEqual(x.calls,[19,23]);assert.equal(r.outputNumber,1);
 assert.ok(fs.statSync(r.outputFileObj._id).size < fs.statSync(source).size);
});

test('never replaces the original when the quality floor is reached',async()=>{
 const x=load({alwaysLarge:true}),args=argsFor(source),before=fs.statSync(source).size,r=await run(x,args);
 assert.deepEqual(x.calls,[19,23]);assert.equal(r.outputNumber,2);assert.equal(fs.statSync(source).size,before);
});

test('an encoder error stops retries and keeps the original',async()=>{
 const x=load({failEncoding:true}),args=argsFor(source),r=await run(x,args);
 assert.deepEqual(x.calls,[19,19]);assert.equal(r.outputNumber,2);assert.ok(fs.existsSync(source));
});

test('failure to inspect HDR metadata never replaces the source',async()=>{
 const x=load({mediainfo:false}),args=argsFor(source),r=await run(x,args);
 assert.deepEqual(x.calls,[]);assert.equal(r.outputNumber,2);assert.ok(fs.existsSync(source));
});

test('current V4 output is recognized by a fresh file probe',async()=>{
 const x=load(),args=argsFor(candidate),r=await run(x,args);
 assert.deepEqual(x.calls,[]);assert.equal(r.outputNumber,4);
});


test('a different working file is not encoded as the original',async()=>{
 const other=path.join(dir,'different-original.mkv');fs.copyFileSync(source,other);
 const x=load(),args=argsFor(source);args.originalLibraryFile._id=other;
 const r=await run(x,args);assert.equal(r.outputNumber,2);assert.deepEqual(x.calls,[]);
});


test('HDR is held until dynamic metadata detection is verified',async()=>{
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
