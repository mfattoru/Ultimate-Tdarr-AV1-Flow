// ICQ values are QSV-specific; larger values produce lower quality.
const selectQualityAttempts = ({width, height, isHdr}) => {
  const max = Math.max(width, height), min = Math.min(width, height);
  if (isHdr) return max > 1920 || min > 1080 ? [18, 22] : [max <= 1024 && min <= 576 ? 18 : 19];
  if (max <= 1024 && min <= 576) return [18];
  if (max <= 1280 && min <= 720) return [19];
  if (max <= 1920 && min <= 1080) return [19, 23];
  return [19, 23, 26];
};
const isCompletedEncode = (codec, tags) => {
  const key = Object.keys(tags || {}).find(k => k.toLowerCase() === 'encoded_by');
  return codec === 'av1' && !!key && ['ArcAV1_QSV_V4','ArcAV1_QSV_V5'].includes(String(tags[key]));
};
const runQualityAttempts = (qualities, sourceSize, run) => {
  for (const quality of qualities) {
    const result = run(quality);
    if (!result.ok) return {ok:false, quality, reason:'encoder', result};
    if (!Number.isSafeInteger(result.size) || result.size < 1) return {ok:false, quality, reason:'size', result};
    if (result.size < sourceSize) return {ok:true, quality, result};
  }
  return {ok:false, quality:qualities[qualities.length - 1], reason:'quality_floor'};
};

// Only a positively identified HDR10 source with PQ/BT.2020 is eligible for
// the tested static-metadata path. Other HDR and ambiguous inputs fail closed.
const isNonDolbyDynamic = value => /2094|hdr10\+|hdr10[ _-]*plus|hdr.?vivid|cuva|dynamic hdr|hdr dynamic|sl.?hdr/i.test(String(value || ''));
const isDynamicHdrSignal = value => /dolby|dovi/i.test(String(value || '')) || isNonDolbyDynamic(value);
const classifyVideo = (video, info) => {
  const fields = Object.entries(info || {}).filter(([key]) => /hdr|dolby|mastering|transfer|primaries|matrix/i.test(key));
  const values = fields.map(([,v]) => String(v)).join(' ').toLowerCase();
  const side = JSON.stringify(video.side_data_list || []).toLowerCase();
  if (isDynamicHdrSignal(values + ' ' + side) || /hdr10 plus/.test(values + ' ' + side)) return 'unsupported';
  const hdrHint = /hdr|2086|smpte ?2084|\bpq\b|2020|hlg|2100/.test(values)
    || /smpte2084|arib-std-b67/.test(String(video.color_transfer || ''))
    || /bt2020/.test(String(video.color_space || '') + String(video.color_primaries || ''))
    || /mastering display|content light/.test(side);
  if (!hdrHint) {
    const transfer = String(video.color_transfer || info?.transfer_characteristics || '').toLowerCase().replace(/[ ._-]/g, '');
    return ['bt709','smpte170m','bt470bg','gamma22','gamma28','smpte240m','iec6196621'].includes(transfer) ? 'sdr' : 'unsupported';
  }
  if (String(info.HDR_Format || '').trim() === 'SMPTE ST 2086'
      && String(info.HDR_Format_Compatibility || '').trim() === 'HDR10'
      && video.color_transfer === 'smpte2084' && video.color_primaries === 'bt2020'
      && video.color_space === 'bt2020nc') return 'hdr10';
  return 'unsupported';
};
const validateHdr10 = (source, output) => {
  if ((output.side_data_list || []).some(s => isDynamicHdrSignal(s.side_data_type))) throw Error('HDR10 output retains Dolby Vision or dynamic HDR signaling');
  for (const type of ['Mastering display metadata','Content light level metadata']) if ((output.side_data_list || []).filter(s=>s.side_data_type===type).length>1) throw Error(`Duplicate HDR output metadata: ${type}`);
  for (const field of ['color_transfer','color_primaries','color_space','color_range']) {
    if (!source[field] || source[field] !== output[field]) throw Error(`HDR10 color ${field} changed`);
  }
  const number = (value) => {
    const bits = String(value).split('/');
    const n = Number(bits[0]), d = bits.length === 2 ? Number(bits[1]) : 1;
    return bits.length <= 2 && Number.isFinite(n) && Number.isFinite(d) && d !== 0 ? n / d : NaN;
  };
  const kinds = [
    ['Mastering display metadata',['red_x','red_y','green_x','green_y','blue_x','blue_y','white_point_x','white_point_y','min_luminance','max_luminance']],
    ['Content light level metadata',['max_content','max_average']]
  ];
  for (const [type, fields] of kinds) {
    const from = (source.side_data_list || []).find(x => x.side_data_type === type);
    const to = (output.side_data_list || []).find(x => x.side_data_type === type);
    if (!from || !to) throw Error(`HDR10 metadata missing: ${type}`);
    for (const field of fields) {
      const a = number(from[field]), b = number(to[field]);
      const tolerance = field === 'max_luminance' ? 0.1 : field.startsWith('max_') ? 0 : 0.0001;
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a-b) > tolerance) throw Error(`HDR10 metadata changed: ${type} ${field}`);
    }
  }
};
const validateSdrColor = (source, output) => {
  for (const field of ['color_transfer','color_primaries','color_space','color_range']) {
    const v = source[field];
    if (v && v !== 'unknown' && v !== 'unspecified' && v !== output[field]) throw Error(`SDR color ${field} changed or was lost`);
  }
};
const guardSourceVideo = (video) => {
  const pix = String(video.pix_fmt || '').toLowerCase().split('(')[0].trim();
  const depth = Number(video.bits_per_raw_sample || 0);
  if (!['nv12','p010','p010le','yuv420p','yuv420p8','yuv420p9le','yuv420p10le'].includes(pix) || (Number.isFinite(depth) && depth > 10)) throw Error(`Unsupported source pixel format/depth ${pix}`);
  const order = String(video.field_order || '').toLowerCase();
  if (order !== 'progressive' && !(String(video.codec_name || '').toLowerCase() === 'av1' && (!order || order === 'unknown'))) throw Error(`Interlaced or unknown source field order ${order || 'missing'} is not verified as progressive`);
};
const validateAspect = (source, output) => {
  const parse = value => {
    const match=String(value || '').match(/^(\d+):(\d+)$/);
    return match && Number(match[1])>0 && Number(match[2])>0 ? Number(match[1])/Number(match[2]) : null;
  };
  const a=parse(source.sample_aspect_ratio), b=parse(output.sample_aspect_ratio);
  if (a === null || b === null || Math.abs(a-b)>1e-6) throw Error('Source or output sample aspect ratio is missing or changed');
  const order=String(output.field_order || '').toLowerCase();
  if (order && !['progressive','unknown'].includes(order)) throw Error('Output has interlaced field order');
};

// HDR10-compatible Dolby Vision Profile 8.1 carries a plain HDR10 base layer.
// Only an explicitly signaled single-layer source can take this downgrade.
const determineHdrRoute = (video, info, scan) => {
  if (!scan || !Number.isSafeInteger(scan.frames) || scan.frames < 1) throw Error('Decoded frame metadata unavailable');
  if (scan.interlaced) throw Error('Interlaced video is not supported');
  if (scan.hdr10plus || scan.otherDynamic || isNonDolbyDynamic(JSON.stringify(info || {}))) throw Error('HDR10+ or other dynamic HDR is not verified');
  if (video.color_range !== 'tv') throw Error('HDR color range is not verified as limited');
  if ((video.side_data_list || []).some(s=>isDynamicHdrSignal(s.side_data_type) && !/dolby|dovi/i.test(String(s.side_data_type || '')))) throw Error('Unsupported dynamic HDR stream metadata');
  const config=(video.side_data_list || []).filter(s => /dovi configuration/i.test(String(s.side_data_type || '')));
  const saysDovi = /dolby vision|\bdovi\b/i.test(JSON.stringify(info || {})) || scan.dovi > 0 || config.length > 0;
  if (saysDovi) {
    if (config.length !== 1 || !scan.dovi) throw Error('Dolby Vision metadata is incomplete or conflicts with stream signaling');
    const d=config[0];
    if (Number(d.dv_profile)!==8 || Number(d.dv_bl_signal_compatibility_id)!==1 || Number(d.bl_present_flag)!==1 || Number(d.rpu_present_flag)!==1 || Number(d.el_present_flag)!==0 || video.codec_name!=='hevc') throw Error('Dolby Vision profile or base layer is not verified for HDR10 conversion');
    if (video.color_transfer!=='smpte2084' || video.color_primaries!=='bt2020' || video.color_space!=='bt2020nc') throw Error('Dolby Vision HDR10 base-layer color metadata conflicts');
    return 'dovi81_hdr10';
  }
  if (video.color_transfer==='arib-std-b67' && video.color_primaries==='bt2020' && video.color_space==='bt2020nc' && /hlg/i.test(JSON.stringify(info || {}))) return 'hlg';
  if (video.color_transfer==='smpte2084' && video.color_primaries==='bt2020' && video.color_space==='bt2020nc' && /hdr10|2086/i.test(JSON.stringify(info || {}))) return 'hdr10';
  throw Error('HDR color signaling is unsupported or ambiguous');
};
const mergeHdrMetadata = (video, frames, options={}) => {
  for (const item of [video,...frames]) for (const type of ['Mastering display metadata','Content light level metadata']) if ((item.side_data_list || []).filter(s=>s.side_data_type===type).length>1) throw Error(`Duplicate HDR metadata: ${type}`);
  const all=[...(video.side_data_list || []),...frames.flatMap(f=>f.side_data_list || [])];
  const get=type=>all.find(x=>x.side_data_type===type);
  const mastering=get('Mastering display metadata');
  let light=get('Content light level metadata');
  if (!mastering || (!light && !options.allowMissingLight)) throw Error('HDR10 mastering or light metadata is missing');
  if (!light) light={side_data_type:'Content light level metadata',max_content:0,max_average:0};
  return {...video,side_data_list:[mastering,light]};
};
const recordHdrFrame = (line, scan) => {
  const match=String(line).match(/(?:^|\|)interlaced_frame=([01])(?:\||$)/);
  if (!match) return;
  scan.frames++;
  if (scan.timestamps) { const ts=String(line).match(/(?:^|\|)best_effort_timestamp_time=([^|]+)/); scan.timestamps.push(ts && ts[1]!=='N/A' ? Number(ts[1]) : NaN); }
  if (match[1] === '1') scan.interlaced++;
  if (/side_data_type=Dolby Vision (?:RPU Data|Metadata)/i.test(line)) scan.dovi++;
  const sideTypes=Array.from(String(line).matchAll(/side_data_type=([^|]+)/g),m=>m[1]);
  if (sideTypes.some(x=>/SMPTE\s*2094-40|HDR10(?:\+|[ _-]*plus)/i.test(x))) scan.hdr10plus++;
  if (sideTypes.some(x=>isNonDolbyDynamic(x) && !/SMPTE\s*2094-40|HDR10(?:\+|[ _-]*plus)/i.test(x))) scan.otherDynamic++;
  if (scan.staticInfo) collectHdrFrameStatic(line, scan.staticInfo);
  if (scan.colorInfo) for (const field of ['color_transfer','color_primaries','color_space','color_range']) {
    const wanted=scan.colorInfo.expected?.[field], match=String(line).match(new RegExp('(?:^|\\|)'+field+'=([^|]+)'));
    const got=match?.[1];
    if (!got || got==='unknown' || got==='unspecified') continue;
    if (!scan.colorInfo.observed) scan.colorInfo.observed={};
    if (scan.colorInfo.observed[field] && scan.colorInfo.observed[field]!==got) scan.colorInfo.conflict=true;
    else scan.colorInfo.observed[field]=got;
    if (wanted && wanted!=='unknown' && wanted!=='unspecified' && got!==wanted) scan.colorInfo.conflict=true;
  }

};
const inspectVideoFrames = async (ffprobe, file, index, options={}) => {
  const scan={frames:0,interlaced:0,dovi:0,hdr10plus:0,otherDynamic:0};
  if (options.staticMetadata) scan.staticInfo={mastering:null,light:null,conflict:false};
  if (options.timestamps) scan.timestamps=[];
  if (options.expectedColor) scan.colorInfo={expected:options.expectedColor,conflict:false};
  await runTimelineProcess(ffprobe, ['-v','error','-select_streams',String(index),'-show_frames','-show_entries','frame=best_effort_timestamp_time,interlaced_frame,color_range,color_space,color_primaries,color_transfer:frame_side_data=side_data_type,red_x,red_y,green_x,green_y,blue_x,blue_y,white_point_x,white_point_y,min_luminance,max_luminance,max_content,max_average','-of','compact=p=0:nk=0',file], line=>recordHdrFrame(line,scan));
  if (!scan.frames) throw Error('Decoded frame metadata unavailable');
  return scan;
};
const parseDolbyLevel6 = (rpu) => {
  const blocks=[...(rpu?.vdr_dm_data?.cmv29_metadata?.ext_metadata_blocks || []),...(rpu?.vdr_dm_data?.cmv40_metadata?.ext_metadata_blocks || [])];
  const levels=blocks.filter(b=>b && b.Level6).map(b=>b.Level6);
  if (levels.length !== 1) throw Error('Dolby Level 6 mastering metadata unavailable or ambiguous');
  const l=levels[0], max=Number(l.max_content_light_level), avg=Number(l.max_frame_average_light_level), masterMax=Number(l.max_display_mastering_luminance), masterMin=Number(l.min_display_mastering_luminance);
  if (![max,avg,masterMax,masterMin].every(Number.isInteger) || max<1 || max>65535 || avg<1 || avg>max || masterMax<1 || masterMax>65535 || masterMin<0 || masterMin>65535) throw Error('Dolby Level 6 light metadata is invalid');
  return {max_content:max,max_average:avg,max_luminance:masterMax,min_luminance:masterMin/10000};
};
const readHdrFrames = (ffprobe, file, index) => {
  const raw=execFileSync(ffprobe,['-v','error','-select_streams',String(index),'-read_intervals','%+1','-show_frames','-show_entries','frame=side_data_list','-of','json',file],{encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});
  const frames=JSON.parse(raw).frames;
  if (!Array.isArray(frames) || !frames.length) throw Error('HDR source frame metadata unavailable');
  return frames;
};
const summarizeLevel6Rows = (rows, expectedFrames) => {
  const header='frame,max_display_mastering_luminance,min_display_mastering_luminance,max_content_light_level,max_frame_average_light_level';
  if (!Array.isArray(rows) || rows[0]?.trim() !== header || !Number.isSafeInteger(expectedFrames) || expectedFrames < 1) throw Error('Dolby Level 6 export is invalid');
  let first=null,count=0;
  for (const line of rows.slice(1)) {
    if (!line.trim()) continue;
    const fields=line.trim().split(',');
    if (fields.length!==5 || fields.some(x=>!/^\d+$/.test(x)) || Number(fields[0])!==count) throw Error('Dolby Level 6 export is incomplete');
    const value=parseDolbyLevel6({vdr_dm_data:{cmv29_metadata:{ext_metadata_blocks:[{Level6:{max_display_mastering_luminance:Number(fields[1]),min_display_mastering_luminance:Number(fields[2]),max_content_light_level:Number(fields[3]),max_frame_average_light_level:Number(fields[4])}}]}}});
    if (first && JSON.stringify(first)!==JSON.stringify(value)) throw Error('Dolby Level 6 changes during the source');
    if (!first) first=value;
    count++;
  }
  if (!first || count!==expectedFrames) throw Error(`Dolby Level 6 frame count mismatch (${count} / ${expectedFrames})`);
  return first;
};
const extractDolbyLevel6 = async (ffmpeg, file, index, expectedFrames) => {
  const dir=fs.mkdtempSync(path.join(require('os').tmpdir(),'tdarr-dovi-'));
  try {
    const rpu=path.join(dir,'rpu.bin'), csv=path.join(dir,'level6.csv');
    const source=timelineSpawn(ffmpeg,['-v','error','-xerror','-fflags','+genpts+igndts','-i',file,'-map',`0:${index}`,'-c:v','copy','-bsf:v','hevc_mp4toannexb','-f','hevc','-'],{stdio:['ignore','pipe','pipe']});
    const extract=timelineSpawn('dovi_tool',['extract-rpu','-','-o',rpu],{stdio:['pipe','ignore','pipe']});
    let sourceErr='',extractErr='';
    source.stderr.on('data',x=>sourceErr=(sourceErr+x.toString()).slice(-8192));
    extract.stderr.on('data',x=>extractErr=(extractErr+x.toString()).slice(-8192));
    const closed = (proc,getError) => new Promise((resolve,reject)=>{
      proc.on('error',reject);
      proc.on('close',(status,signal)=>status===0?resolve():reject(Error(`Dolby extraction failed (${status ?? signal}): ${getError().slice(-500)}`)));
    });
    const timer=setTimeout(()=>{source.kill('SIGKILL');extract.kill('SIGKILL');},4*60*60*1000);
    if (timer.unref) timer.unref();
    try {
      await Promise.all([closed(source,()=>sourceErr),closed(extract,()=>extractErr),require('stream/promises').pipeline(source.stdout,extract.stdin)]);
    } catch (e) {source.kill('SIGKILL');extract.kill('SIGKILL');throw e;}
    finally {clearTimeout(timer);}
    execFileSync('dovi_tool',['export','-i',rpu,'--levels',`level6=${csv}`,'--levels-format','csv'],{encoding:'utf8',timeout:4*60*60*1000,maxBuffer:1024*1024});
    if (fs.statSync(csv).size>128*1024*1024) throw Error('Dolby Level 6 export exceeds safety limit');
    return summarizeLevel6Rows(fs.readFileSync(csv,'utf8').split(/\r?\n/),expectedFrames);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
};

const rationalValue = (x) => {
  const parts=String(x).split('/'), n=Number(parts[0]), d=parts.length===2?Number(parts[1]):1;
  return parts.length<=2 && Number.isFinite(n) && Number.isFinite(d) && d!==0 ? n/d : NaN;
};
const resolveHdrLight = async (metadata, route, getLevel6) => {
  const mastering=metadata.side_data_list.find(x=>x.side_data_type==='Mastering display metadata');
  const light=metadata.side_data_list.find(x=>x.side_data_type==='Content light level metadata');
  let max=Number(light?.max_content), avg=Number(light?.max_average), override=null;
  if (!(Number.isInteger(max) && max>0 && max<=65535 && Number.isInteger(avg) && avg>0 && avg<=max)) {
    if (route!=='dovi81_hdr10') throw Error('HDR10 light metadata is absent or unspecified');
    const l6=await getLevel6();
    const sourceMax=rationalValue(mastering?.max_luminance), sourceMin=rationalValue(mastering?.min_luminance);
    if (!Number.isFinite(sourceMax) || !Number.isFinite(sourceMin) || Math.abs(sourceMax-l6.max_luminance)>0.1 || Math.abs(sourceMin-l6.min_luminance)>0.0001) throw Error('Dolby Level 6 and HDR10 mastering luminance conflict');
    max=l6.max_content;avg=l6.max_average;override=`${max},${avg}`;
  }
  const resolved={...metadata,side_data_list:[mastering,{side_data_type:'Content light level metadata',max_content:max,max_average:avg}]};
  validateHdr10(resolved,resolved);
  return {metadata:resolved,override};
};

const hdrMasterFields=['red_x','red_y','green_x','green_y','blue_x','blue_y','white_point_x','white_point_y','min_luminance','max_luminance'];
const sameHdrSideData = (a,b,fields) => fields.every(field => {
  const x=rationalValue(a?.[field]),y=rationalValue(b?.[field]);
  const tolerance=field==='max_luminance'?0.1:field.startsWith('max_')?0:0.0001;
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x-y)<=tolerance;
});
const collectHdrFrameStatic = (line, info) => {
  for (const [prefix,key,type,fields] of [
    ['side_datum/mastering_display_metadata:','mastering','Mastering display metadata',hdrMasterFields],
    ['side_datum/content_light_level_metadata:','light','Content light level metadata',['max_content','max_average']]
  ]) {
    const entries=String(line).split('|').filter(x=>x.startsWith(prefix));
    if (!entries.length) continue;
    const value={side_data_type:type}, seen=new Set();
    for (const part of entries) { const p=part.slice(prefix.length),i=p.indexOf('='); if(i>0) { const k=p.slice(0,i); if(seen.has(k)) info.conflict=true; seen.add(k); value[k]=p.slice(i+1); } }
    if (fields.some(f=>!Number.isFinite(rationalValue(value[f])))) {info.conflict=true;continue;}
    if (info[key] && !sameHdrSideData(info[key],value,fields)) info.conflict=true;
    else if (!info[key]) info[key]=value;
  }
};
const checkHdrFrameStatic = (metadata, scan, requireLight=true) => {
  const current=scan?.staticInfo;
  if (!current || current.conflict || !current.mastering || (requireLight && !current.light)) throw Error('HDR static metadata is missing or changes within the video');
  const side=metadata.side_data_list || [];
  const mastering=side.find(s=>s.side_data_type==='Mastering display metadata');
  const light=side.find(s=>s.side_data_type==='Content light level metadata');
  if (!mastering || !sameHdrSideData(mastering,current.mastering,hdrMasterFields)) throw Error('HDR mastering metadata conflicts with decoded frames');
  if (current.light && (!light || !sameHdrSideData(light,current.light,['max_content','max_average']))) throw Error('HDR light metadata conflicts with decoded frames');
};
const compareVideoTimestamps = (source, output) => {
  const a=source?.timestamps,b=output?.timestamps;
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length!==b.length || a.some(x=>!Number.isFinite(x)) || b.some(x=>!Number.isFinite(x))) throw Error('Video presentation timestamps are unavailable');
  for (let i=0;i<a.length;i++) if (Math.abs((a[i]-a[0])-(b[i]-b[0]))>0.05) throw Error(`Video presentation timestamp differs at frame ${i}`);
};

const validateHlg = (source, output) => {
  for (const field of ['color_transfer','color_primaries','color_space','color_range']) if (!source[field] || source[field] !== output[field]) throw Error(`HLG color ${field} changed`);
  for (const v of [source,output]) if ((v.side_data_list || []).some(s=>isDynamicHdrSignal(s.side_data_type) || /mastering display|content light/i.test(String(s.side_data_type || '')))) throw Error('HLG has unexpected HDR metadata');
};
const isVerifiedSdr = (basic, scan) => basic === 'sdr' && !scan.dovi && !scan.hdr10plus && !scan.otherDynamic && !!scan.staticInfo && !scan.staticInfo.mastering && !scan.staticInfo.light && !scan.staticInfo.conflict;

const validateEffectiveSdrTransfer = (video,info,scan) => {
  const norm=x=>String(x || '').toLowerCase().replace(/[ ._-]/g,'');
  const stream=String(video.color_transfer || '').toLowerCase();
  const expected=stream && stream!=='unknown' && stream!=='unspecified' ? stream : info?.transfer_characteristics;
  const actual=scan?.colorInfo?.observed?.color_transfer;
  if (actual && norm(actual)!==norm(expected)) throw Error('SDR decoded-frame transfer conflicts with source signaling');
};

const effectiveSdrSource = (video,info,scan) => {
  const effective={...video},observed=scan?.colorInfo?.observed || {};
  for (const field of ['color_transfer','color_primaries','color_space','color_range']) if (!effective[field] || ['unknown','unspecified'].includes(effective[field])) if (observed[field]) effective[field]=observed[field];
  if (!effective.color_transfer || ['unknown','unspecified'].includes(effective.color_transfer)) {
    const map={bt709:'bt709',smpte170m:'smpte170m',bt470bg:'bt470bg',gamma22:'gamma22',gamma28:'gamma28',smpte240m:'smpte240m',iec6196621:'iec61966-2-1'};
    const key=String(info?.transfer_characteristics || '').toLowerCase().replace(/[ ._-]/g,'');
    effective.color_transfer=map[key];
    if (!effective.color_transfer) throw Error('Effective SDR transfer is unavailable');
  }
  return effective;
};
