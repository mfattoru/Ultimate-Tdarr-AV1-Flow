const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const flow=JSON.parse(fs.readFileSync(path.join(__dirname,'flow.json')));
const code=flow.flowPlugins.find(p=>p.id==='discord_success').inputsDB.code.replace(/https:\/\/discord\.com\/api\/webhooks\/[^"\s]+/g,'https://default.invalid/hook');
function harness(){
 const calls=[];const https={request(options,callback){const r=new EventEmitter();let body='';r.write=s=>body+=s;r.setTimeout=()=>{};r.end=()=>{calls.push({options,body:JSON.parse(body)});const res=new EventEmitter();res.statusCode=204;callback(res);res.emit('end');};r.destroy=()=>{};return r;}};
 const context={module:{exports:{}},require:n=>{assert.equal(n,'https');return https;},process:{env:{TDARR_DISCORD_WEBHOOK:'https://override.invalid/flow'}},URL,Buffer,Date,setTimeout,console:{log(){},warn(){},error(){}}};vm.runInNewContext(code,context);
 const now=Date.now();const args={originalLibraryFile:{_id:'/test/Episode.mkv',file_size:100},inputFileObj:{_id:'/test/Episode.mkv',file_size:40},variables:{user:{workflow_start_epoch:now-61000,transcode_start_ts:now-60000,transcode_end_ts:now,orig_video_kbps:4000,new_video_kbps:1400,quality_value:20,qsv_mode:'Hybrid (CPU Decode + Arc QSV AV1 Encode)',transcode_medium:'Disk',hdr_conversion:'Dolby Vision 8.1 to HDR10; dynamic metadata removed'}}};
 return {run:context.module.exports,calls,args};
}
test('success retains the rich embed and uses the same configured webhook as failures',async()=>{
 const h=harness();await h.run(h.args);assert.equal(h.calls.length,1);const x=h.calls[0];
 assert.equal(x.options.hostname,'override.invalid');assert.equal(x.options.path,'/flow');
 assert.ok(Array.isArray(x.body.embeds));const embed=x.body.embeds[0];
 assert.match(embed.title,/Episode/);assert.match(embed.description,/100\.0 MB/);assert.match(embed.description,/40\.0 MB/);
 assert.match(embed.description,/4\.00 Mbps/);assert.match(embed.description,/QSV quality 20/);assert.match(embed.description,/Duration/);assert.match(embed.description,/Dolby Vision/);
 const styled=harness();styled.args.variables.user.ass_subtitle_preserved_count=2;await styled.run(styled.args);
 assert.match(styled.calls[0].body.embeds[0].description,/2 ASS\/SSA tracks preserved/);
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
 assert.match(embed.description,/\+5\.0% • Seek-heal remux/);
 assert.match(embed.description,/Original Video Stream-Copied • Seek-Healed/);
 assert.match(embed.footer.text,/Size Bloat Fallback Success/);
});
