const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const flow=JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flow.json')));
const code=flow.flowPlugins.find(p=>p.id==='discord_success').inputsDB.code.replace(/https:\/\/discord\.com\/api\/webhooks\/[^"\s]+/g,'https://default.invalid/hook');
function harness({status = 204, webhook = 'https://override.invalid/flow', failure, fastTimers = false} = {}) {
 const calls=[], logs=[];
 const https={request(target,options,callback){const r=new EventEmitter();let body='';r.write=s=>body+=s;r.setTimeout=(_ms,fn)=>{r._onTimeout=fn;};r.end=chunk=>{if(chunk)body+=chunk;calls.push({target:String(target),hostname:target.hostname,path:target.pathname+target.search,options,body:JSON.parse(body)});if(failure==='network'){const e=new Error('network failed');e.code='EHOSTUNREACH';r.emit('error',e);return;}if(failure==='stall'){return;}const res=new EventEmitter();res.statusCode=status;res.resume=()=>{};callback(res);if(failure==='res_error'){const e=new Error('stream reset');e.code='ECONNRESET';res.emit('error',e);}else{res.emit('end');}};r.destroy=()=>{};return r;}};
 const timerSet=(fn,ms)=>setTimeout(fn,fastTimers?Math.min(ms,5):ms);
 const context={module:{exports:{}},require:n=>{assert.equal(n,'https');return https;},process:{env:{TDARR_DISCORD_WEBHOOK:webhook}},URL,Buffer,Date,setTimeout:timerSet,clearTimeout,console:{log(){},warn(){},error(){}}};vm.runInNewContext(code,context);
 const now=Date.now();const args={originalLibraryFile:{_id:'/test/Episode.mkv',file_size:100},inputFileObj:{_id:'/test/Episode.mkv',file_size:40},jobLog:m=>logs.push(m),variables:{user:{workflow_start_epoch:now-61000,transcode_start_ts:now-60000,transcode_end_ts:now,orig_video_kbps:4000,new_video_kbps:1400,quality_value:20,qsv_mode:'Hybrid (CPU Decode + Arc QSV AV1 Encode)',transcode_medium:'Disk',hdr_conversion:'Dolby Vision 8.1 to HDR10; dynamic metadata removed'}}};
 return {run:context.module.exports,calls,logs,args};
}
test('success retains the rich embed and uses the same configured webhook as failures',async()=>{
 const h=harness();await h.run(h.args);assert.equal(h.calls.length,1);const x=h.calls[0];
 assert.equal(x.hostname,'override.invalid');assert.equal(x.path,'/flow');
 assert.ok(Array.isArray(x.body.embeds));const embed=x.body.embeds[0];
 assert.match(embed.title,/Episode/);assert.match(embed.description,/100\.0 MB/);assert.match(embed.description,/40\.0 MB/);
 assert.match(embed.description,/4\.00 Mbps/);assert.match(embed.description,/ICQ 20/);assert.match(embed.description,/Processing time/);assert.match(embed.description,/Dolby Vision/);
 const styled=harness();styled.args.variables.user.ass_subtitle_preserved_count=2;await styled.run(styled.args);
 assert.match(styled.calls[0].body.embeds[0].description,/2 styled ASS\/SSA tracks preserved/);
 assert.deepEqual(x.body.allowed_mentions.parse,[]);
});
test('success uses measured sizes when Tdarr file metadata is stale',async()=>{
 const h=harness();h.args.originalLibraryFile.file_size=40;h.args.inputFileObj.file_size=100;
 h.args.variables.user.original_size_mb=100;h.args.variables.user.final_size_mb=40;
 await h.run(h.args);const desc=h.calls[0].body.embeds[0].description;
 assert.match(desc,/100\.0 MB.*40\.0 MB/);assert.match(desc,/60\.0%/);
});

test('larger validated remux success reports seek-heal and original video preservation',async()=>{
 const h=harness();h.args.variables.user.is_bloat_fallback=true;h.args.variables.user.qsv_mode='Size Bloat Fallback (Original Video Stream-Copy + Seek Healed)';
 delete h.args.variables.user.transcode_start_ts;delete h.args.variables.user.transcode_end_ts;
 h.args.variables.user.original_size_mb=100;h.args.variables.user.final_size_mb=105;
 await h.run(h.args);const embed=h.calls[0].body.embeds[0];
 assert.match(embed.description,/\+5\.0% • 5\.0 MB added/);
 assert.match(embed.description,/validated seek-heal remux kept the original video stream/i);
 assert.match(embed.footer.text,/Seek-heal remux validated • Source video preserved/);
});

test('success notification never fails the flow when webhook is missing, invalid, offline, or response errors',async()=>{
 for(const opts of [{webhook:''},{webhook:'http://insecure.invalid/hook'},{status:500,fastTimers:true},{failure:'network',fastTimers:true},{failure:'res_error',fastTimers:true},{failure:'stall',fastTimers:true}]) {
  const h=harness(opts);
  const res=await h.run(h.args);
  assert.equal(res.outputNumber,1);
  assert.equal(res.outputFileObj,h.args.inputFileObj);
  assert.ok(h.logs.some(m=>/Delivery failed/i.test(m)),`expected jobLog entry for ${JSON.stringify(opts)}, got ${JSON.stringify(h.logs)}`);
 }
});
