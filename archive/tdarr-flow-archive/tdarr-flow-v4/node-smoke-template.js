const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const code=Buffer.from('__ENGINE_BASE64__','base64').toString();
const dir=fs.mkdtempSync('/transcode_cache/tdarr-v4-smoke-');
process.env.TDARR_CAPACITY_LOCK_DIR=dir;
process.env.TDARR_DEDICATED_CACHE=dir;
const file=path.join(dir,'source.mkv');
const mod={exports:{}};new Function('require','module','exports',code+'\nmodule.exports.releaseTest=releaseCapacityLock;')(require,mod,mod.exports);
(async()=>{
  let args;
  try {
    cp.execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=24:duration=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','libx264','-preset','ultrafast','-crf','0','-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709','-c:a','aac','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-y',file],{stdio:'ignore',timeout:120000});
    const f={_id:file,container:'mkv',file_size:fs.statSync(file).size/1048576};
    args={inputFileObj:{...f},originalLibraryFile:{...f},workDir:dir,variables:{user:{min_cache_free_mb:1}},ffmpegPath:'/usr/local/bin/ffmpeg',librarySettings:{folder:dir},jobLog:()=>{}};
    const result=await mod.exports(args);
    console.log('SMOKE_RESULT',JSON.stringify({output:result.outputNumber,sourceBytes:fs.statSync(file).size,encodedBytes:result.outputNumber===1?fs.statSync(result.outputFileObj._id).size:null,quality:result.variables.user.quality_value}));
    if(result.outputNumber!==1)process.exitCode=1;
  } catch(e){console.error('SMOKE_ERROR',e.message);process.exitCode=1;}
  finally {if(args){mod.exports.releaseTest(args.variables,()=>{});const tmp=args.variables.user.safety_temp_dir;if(tmp && /^\/dev\/shm\/tdarr-av1-/.test(tmp))fs.rmSync(tmp,{recursive:true,force:true});}fs.rmSync(dir,{recursive:true,force:true});}
})();
