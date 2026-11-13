const fs=require('fs'),path=require('path'),cp=require('child_process');
const code=Buffer.from('__PGS_BASE64__','base64').toString();const m={exports:{}};new Function('require','module','exports',code)(require,m,m.exports);
const src='/path/to/source-video.mkv';
const dir=fs.mkdtempSync('/transcode_cache/tdarr-v6-pgs-'),out=path.join(dir,'out.mkv');
(async()=>{try{
 cp.execFileSync('ffmpeg',['-v','error','-i',src,'-map','0:0','-map','0:6','-c','copy','-avoid_negative_ts','make_zero','-y',out],{timeout:240000,stdio:'ignore'});
 const first=(file,index)=>{const raw=cp.execFileSync('ffprobe',['-v','error','-select_streams',String(index),'-show_packets','-show_entries','packet=pts_time','-of','csv=p=0',file],{encoding:'utf8',maxBuffer:20*1024*1024,timeout:120000});const a=raw.trim().split(/\r?\n/).map(Number).filter(Number.isFinite);return a.reduce((x,y)=>Math.min(x,y),Infinity);};
 const shift=first(out,0)-first(src,0);console.log('VIDEO_SHIFT',shift);
 const a=await m.exports.extractPgsSegments('ffmpeg',src,6),b=await m.exports.extractPgsSegments('ffmpeg',out,1);m.exports.comparePgsSegments(a,b,shift);console.log('PGS_FULL_CHECK',JSON.stringify({sourceSegments:a.length,outputSegments:b.length,match:true}));
 }catch(e){console.error('PGS_FULL_CHECK_ERROR',e.message);process.exitCode=1;}finally{fs.rmSync(dir,{recursive:true,force:true});}})();
