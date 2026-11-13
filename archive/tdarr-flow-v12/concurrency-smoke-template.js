const fs=require('fs'),path=require('path'),cp=require('child_process');
const engine=Buffer.from('__ENGINE_BASE64__','base64').toString();
const dir=fs.mkdtempSync('/transcode_cache/tdarr-v6-concurrent-');
const script=path.join(dir,'worker.js'),a=path.join(dir,'a.mkv'),b=path.join(dir,'b.mkv');
const worker=`const fs=require('fs');const code=Buffer.from(process.env.TEST_ENGINE,'base64').toString();const m={exports:{}};new Function('require','module','exports',code+'\\nmodule.exports.releaseForTest=releaseCapacity;')(require,m,m.exports);
(async()=>{const p=process.argv[2],dir=process.env.TEST_ROOT;process.env.TDARR_RESERVATION_ROOT=dir;const f={_id:p,container:'mkv',file_size:fs.statSync(p).size/1048576};const args={inputFileObj:{...f},originalLibraryFile:{...f},workDir:dir,variables:{user:{min_cache_free_mb:1}},ffmpegPath:'/usr/local/bin/ffmpeg',librarySettings:{folder:dir},jobLog:()=>{}};try{const result=await m.exports(args);console.log('RESULT',result.outputNumber);if(result.outputNumber!==1)process.exitCode=1;}catch(e){console.error('ERROR',e.message);process.exitCode=1;}finally{if(args.variables.user.cache_reservation)await m.exports.releaseForTest(args.variables.user.cache_reservation);const temp=args.variables.user.safety_temp_dir;if(temp&&temp.startsWith(dir+'/tdarr-av1-'))fs.rmSync(temp,{recursive:true,force:true});}})();`;
(async()=>{try{
 cp.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=24:duration=4','-f','lavfi','-i','sine=duration=4','-c:v','libx264','-preset','ultrafast','-crf','0','-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709','-c:a','aac','-y',a],{stdio:'ignore',timeout:120000});
 fs.copyFileSync(a,b);fs.writeFileSync(script,worker,{mode:0o600});
 const env={...process.env,TEST_ROOT:dir,TEST_ENGINE:Buffer.from(engine).toString('base64')};
 const run=p=>new Promise((resolve,reject)=>{const w=cp.spawn(process.execPath,[script,p],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';w.stdout.on('data',x=>stdout+=x.toString().slice(-20000));w.stderr.on('data',x=>stderr+=x.toString().slice(-2000));w.on('error',reject);w.on('close',status=>resolve({status,success:stdout.includes('RESULT 1'),stderr:stderr.slice(-200)}));});
 let peak=0;const poll=setInterval(()=>{try{peak=Math.max(peak,fs.readdirSync(path.join(dir,'.tdarr-av1-reservations')).filter(n=>n.endsWith('.json')).length);}catch(_){}},25);
 const results=await Promise.all([run(a),run(b)]);clearInterval(poll);
 console.log('CONCURRENCY_CHECK',JSON.stringify({peakReservations:peak,results}));if(peak<2||results.some(x=>x.status!==0||!x.success))process.exitCode=1;
 }catch(e){console.error('CONCURRENCY_ERROR',e.message);process.exitCode=1;}finally{fs.rmSync(dir,{recursive:true,force:true});}})();
