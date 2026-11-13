const fs=require('fs'),path=require('path'),cp=require('child_process');
const code=Buffer.from('__ENGINE_BASE64__','base64').toString();
const root='/transcode_cache/tdarr-hdr-fixtures-ra3t35zx';
const mod={exports:{}};new Function('require','module','exports',code+'\nmodule.exports.releaseTest=releaseCapacityLock;')(require,mod,mod.exports);
(async()=>{
 for(const kind of ['p81','hlg','p5','p84']) {
  const dir=fs.mkdtempSync('/transcode_cache/tdarr-v5-smoke-'),file=path.join(dir,'source.mkv');
  process.env.TDARR_CAPACITY_LOCK_DIR=dir; process.env.TDARR_DEDICATED_CACHE=dir;
  let args; const messages=[];
  try {
   if(kind==='hlg') fs.copyFileSync(root+'/hlg-source.mkv',file);
   else cp.execFileSync('ffmpeg',['-v','error','-i',root+'/'+kind+'.mp4','-t','6','-map','0:v:0','-c','copy','-y',file],{stdio:'ignore',timeout:120000});
   const f={_id:file,container:'mkv',file_size:fs.statSync(file).size/1048576};
   args={inputFileObj:{...f},originalLibraryFile:{...f},workDir:dir,variables:{user:{min_cache_free_mb:1}},ffmpegPath:'/usr/local/bin/ffmpeg',librarySettings:{folder:dir},jobLog:msg=>messages.push(msg)};
   const result=await mod.exports(args), expected=kind==='p81'||kind==='hlg'?1:2;
   const ok=result.outputNumber===expected && fs.existsSync(file) && (expected!==1 || fs.statSync(result.outputFileObj._id).size<fs.statSync(file).size);
   console.log('HDR_SMOKE',JSON.stringify({kind,output:result.outputNumber,expected,ok,reason:messages.find(x=>x.includes('[HDR guard]'))||null,quality:result.variables.user.quality_value||null}));
   if(!ok) process.exitCode=1;
  } catch(e) {console.error('HDR_SMOKE_ERROR',kind,e.message);process.exitCode=1;}
  finally {if(args){mod.exports.releaseTest(args.variables,()=>{});const tmp=args.variables.user.safety_temp_dir;if(tmp && /^\/dev\/shm\/tdarr-av1-/.test(tmp))fs.rmSync(tmp,{recursive:true,force:true});}fs.rmSync(dir,{recursive:true,force:true});}
 }
})();
