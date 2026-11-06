// Embedded in the custom function when building the flow.
const timelineSpawn = require('child_process').spawn;
const timelineReadline = require('readline');

function runTimelineProcess(bin, argv, onLine) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = timelineSpawn(bin, argv, {stdio:['ignore','pipe','pipe']}); }
    catch (e) { reject(e); return; }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, 4 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    const lines = timelineReadline.createInterface({input:proc.stdout, crlfDelay:Infinity});
    lines.on('line', line => { if (onLine) onLine(line); });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', (status, signal) => {
      clearTimeout(timer);
      if (status !== 0) reject(new Error(`${bin} ${timedOut?'timed out':`failed (${status ?? signal})`}: ${stderr.trim().slice(-400)}`));
      else resolve();
    });
  });
}

async function measureStreamTimeline(ffprobe, file, streamIndex, type) {
  let first=Infinity, last=-Infinity, count=0, invalid=0;
  await runTimelineProcess(ffprobe, ['-v','error','-select_streams',String(streamIndex),'-show_packets','-show_entries','packet=pts_time,duration_time','-of','compact=p=0:nk=0',file], line => {
    const ptsMatch=line.match(/(?:^|\|)pts_time=([^|]+)/), durMatch=line.match(/(?:^|\|)duration_time=([^|]+)/);
    if (!ptsMatch) return;
    if (ptsMatch[1] === 'N/A' || !Number.isFinite(Number(ptsMatch[1]))) { invalid++; return; }
    const pts=Number(ptsMatch[1]);
    const duration=durMatch && durMatch[1] !== 'N/A' ? Number(durMatch[1]) : 0;
    first=Math.min(first,pts);
    last=Math.max(last,pts+(Number.isFinite(duration)&&duration>0?duration:0));
    count++;
  });
  if (invalid) throw new Error(`${type} timeline has ${invalid} packets with missing timestamps`);
  if (count===0 && type==='subtitle') return {empty:true};
  if (count===0 || !Number.isFinite(first) || !Number.isFinite(last) || (type==='video' && (count<2 || !(last>first)))) throw new Error(`${type} timeline is unavailable or too short to verify`);
  return {first,last,duration:last-first,packets:count,empty:false};
}

async function verifyVideoTimeline(ffprobe, ffmpeg, source, output, sourceIndex, outputIndex, tracks) {
  const a=await measureStreamTimeline(ffprobe,source,sourceIndex,'video');
  const b=await measureStreamTimeline(ffprobe,output,outputIndex,'video');
  const tolerance=Math.max(0.5,a.duration*0.005);
  if (Math.abs(a.duration-b.duration)>tolerance) throw new Error(`Output video duration ${b.duration.toFixed(3)}s differs from source video ${a.duration.toFixed(3)}s (tolerance ${tolerance.toFixed(3)}s)`);
  const shift=b.first-a.first;
  for (const type of ['audio','subtitle']) {
    for (const [srcIndex,dstIndex] of tracks[type]) {
      const s=await measureStreamTimeline(ffprobe,source,srcIndex,type);
      const d=await measureStreamTimeline(ffprobe,output,dstIndex,type);
      if (s.empty && d.empty) continue;
      if (type === 'subtitle' && !s.empty && !d.empty && d.packets < s.packets) throw new Error(`Output subtitle packet count ${d.packets} is less than source ${s.packets} for stream ${srcIndex}`);
      if (s.empty || d.empty || Math.abs((d.first-s.first)-shift)>tolerance || Math.abs((d.last-s.last)-shift)>tolerance) throw new Error(`Output ${type} timeline differs from source for stream ${srcIndex}`);
    }
  }
  const decode=['-v','error','-xerror','-i',output,'-map',`0:${outputIndex}`];
  for (const [,dstIndex] of tracks.audio) decode.push('-map',`0:${dstIndex}`);
  decode.push('-f','null','-');
  await runTimelineProcess(ffmpeg,decode);
  return {sourceDuration:a.duration,outputDuration:b.duration};
}
