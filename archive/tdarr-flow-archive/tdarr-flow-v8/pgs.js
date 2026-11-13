// PGS packets may be regrouped by Matroska/FFmpeg. Compare the actual SUP
// segment sequence and its timestamps rather than container packet counts.
const pgsCrypto = require('crypto');
const pgsSpawn = require('child_process').spawn;
const PGS_TICKS = 90000;
async function parsePgsSegments(stream) {
  let pending=Buffer.alloc(0);
  const result=[];
  for await (const chunk of stream) {
    pending=Buffer.concat([pending,Buffer.from(chunk)]);
    while (pending.length>=13) {
      if (pending[0]!==0x50 || pending[1]!==0x47) throw Error('Invalid PGS segment header');
      const length=pending.readUInt16BE(11), end=13+length;
      if (pending.length<end) break;
      result.push({pts:pending.readUInt32BE(2),dts:pending.readUInt32BE(6),type:pending[10],hash:pgsCrypto.createHash('sha256').update(pending.subarray(13,end)).digest('hex')});
      if (result.length>1000000) throw Error('PGS segment count exceeds safety limit');
      pending=pending.subarray(end);
    }
  }
  if (pending.length) throw Error('Truncated PGS segment');
  return result;
}
function comparePgsSegments(source,output,shift,tolerance=0.1) {
  if (!Array.isArray(source) || !Array.isArray(output) || source.length!==output.length) throw Error('PGS subtitle segment count changed');
  if (!Number.isFinite(shift) || !Number.isFinite(tolerance) || tolerance<0) throw Error('Invalid PGS timestamp comparison');
  const delta=(a,b)=>(((b-a+0x80000000)>>>0)-0x80000000)/PGS_TICKS;
  for (let i=0;i<source.length;i++) {
    const a=source[i],b=output[i];
    if (a.type!==b.type || a.hash!==b.hash) throw Error(`PGS subtitle segment ${i} changed`);
    if (Math.abs(delta(a.pts,b.pts)-shift)>tolerance) throw Error(`PGS subtitle timestamp differs at segment ${i}`);
    if (a.dts && (!b.dts || Math.abs(delta(a.dts,b.dts)-shift)>tolerance)) throw Error(`PGS subtitle decode timestamp differs at segment ${i}`);
  }
}
async function extractPgsSegments(ffmpeg,file,index) {
  const proc=pgsSpawn(ffmpeg,['-v','error','-copyts','-i',file,'-map',`0:${index}`,'-c:s','copy','-f','sup','pipe:1'],{stdio:['ignore','pipe','pipe']});
  let stderr='',timedOut=false;
  proc.stderr.on('data',x=>stderr=(stderr+x.toString()).slice(-8192));
  const timer=setTimeout(()=>{timedOut=true;proc.kill('SIGKILL');},4*60*60*1000);
  if(timer.unref) timer.unref();
  const closed=new Promise((resolve,reject)=>{proc.on('error',reject);proc.on('close',(code,signal)=>code===0&&!stderr.trim()?resolve():reject(Error(`PGS extraction ${timedOut?'timed out':`failed (${code ?? signal})`}: ${stderr.trim().slice(-400)}`)));});
  try { const [segments]=await Promise.all([parsePgsSegments(proc.stdout),closed]);return segments; }
  catch(e){proc.kill('SIGKILL');throw e;}
  finally {clearTimeout(timer);}
}
async function verifyPgsSegments(ffmpeg,source,output,sourceIndex,outputIndex,shift) {
  const a=await extractPgsSegments(ffmpeg,source,sourceIndex),b=await extractPgsSegments(ffmpeg,output,outputIndex);
  comparePgsSegments(a,b,shift);
}
if(typeof module!=='undefined') module.exports={parsePgsSegments,comparePgsSegments,extractPgsSegments,verifyPgsSegments};
