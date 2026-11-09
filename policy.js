// QSV ICQ is global across resolution and HDR class; larger values produce lower quality.
const DEFAULT_ICQ = 22;
const VIDEO_BITSTREAM_CORRUPTION_RE = /invalid nal unit(?: size| type)|error splitting the input into nal units|missing picture in access unit|corrupt decoded frame|invalid data found when processing input|invalid bitstream|corrupt packet|packet corrupt|invalid obu|error parsing obu|invalid frame marker|invalid sync code|could not find ref with poc|concealing \d+.*(?:dc|ac|mv) errors|premature end of file|truncated (?:packet|frame)|unexpected end of file/i;
const AUDIO_BITSTREAM_CORRUPTION_RE = /invalid data found when processing input|invalid bitstream|corrupt (?:input )?packet|packet corrupt|crc mismatch|frame crc mismatch|header missing|invalid frame size|invalid packet|input buffer exhausted|premature end of file|truncated (?:packet|frame)|unexpected end of file/i;
const isKnownVideoCorruptionDiagnostic = text => !isVerificationInfrastructureDiagnostic(text) && VIDEO_BITSTREAM_CORRUPTION_RE.test(String(text || ''));
const isKnownAudioCorruptionDiagnostic = text => !isVerificationInfrastructureDiagnostic(text) && AUDIO_BITSTREAM_CORRUPTION_RE.test(String(text || ''));
const selectQualityValue = () => {
  const raw = process.env.TDARR_QSV_ICQ;
  const value = raw === undefined || raw === '' ? DEFAULT_ICQ : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 51) throw new Error('TDARR_QSV_ICQ must be an integer from 1 to 51');
  return value;
};
const isCompletedEncode = (codec, tags) => {
  const key = Object.keys(tags || {}).find(k => k.toLowerCase() === 'encoded_by');
  if (!key) return false;
  const marker=String(tags[key]);
  return ['ArcAV1_SeekHeal_V12','ArcAV1_SeekHeal_V13','ArcAV1_SeekHeal_V14','ArcAV1_SeekHeal_V15'].includes(marker)
    || (codec === 'av1' && ['ArcAV1_QSV_V4','ArcAV1_QSV_V5','ArcAV1_QSV_V6','ArcAV1_QSV_V7','ArcAV1_QSV_V8','ArcAV1_QSV_V9','ArcAV1_QSV_V11','ArcAV1_QSV_V12','ArcAV1_QSV_V13','ArcAV1_QSV_V14','ArcAV1_QSV_V15','ArcAV1_SVTAV1_HDRFallback_V15'].includes(marker));
};

// Only a positively identified HDR10 source with PQ/BT.2020 is eligible for
// the tested static-metadata path. Other HDR and ambiguous inputs fail closed.
const isNonDolbyDynamic = value => /2094|hdr10\+|hdr10[ _-]*plus|hdr.?vivid|cuva|dynamic hdr|hdr dynamic|sl.?hdr/i.test(String(value || ''));
const isDynamicHdrSignal = value => /dolby|dovi/i.test(String(value || '')) || isNonDolbyDynamic(value);
const normalizeSdrMatrix = value => {
  const normalized=String(value || '').toLowerCase().replace(/[\s._-]/g,'');
  const aliases={bt709:'bt709',bt601:'smpte170m',smpte170m:'smpte170m',bt470bg:'bt470bg'};
  return aliases[normalized] || null;
};
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
    if (['bt709','smpte170m','bt470bg','gamma22','gamma28','smpte240m','iec6196621'].includes(transfer)) return 'sdr';
    // Some SDR files carry a recognized matrix but omit transfer and primaries.
    // Accept only common SDR matrices with no HDR/DV hint; keep missing tags missing.
    const streamMatrix=normalizeSdrMatrix(video.color_space);
    if (streamMatrix && isUnknownColorValue(video.color_transfer) && isUnknownColorValue(info?.transfer_characteristics)) {
      const infoMatrix=info?.matrix_coefficients;
      if (!isUnknownColorValue(infoMatrix)) {
        const normalizedInfoMatrix=normalizeSdrMatrix(infoMatrix);
        if (!normalizedInfoMatrix || normalizedInfoMatrix!==streamMatrix) throw Error('MediaInfo color matrix_coefficients conflicts with stream or is unrecognized');
      }
      return 'sdr';
    }
    return 'unsupported';
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
    if (!from && to) throw Error('HDR10 metadata added without source data: '+type);
    if (from && !to) throw Error('HDR10 metadata missing: '+type);
    if (!from && !to) continue;
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
  const supported420 = ['nv12','p010','p010le','yuv420p','yuv420p8','yuv420p9le','yuv420p10le','yuv420p12le'];
  const supported422444 = ['yuv422p','yuv422p9le','yuv422p10le','yuv422p12le','yuv444p','yuv444p9le','yuv444p10le','yuv444p12le','yuvj422p','yuvj444p'];
  if (![...supported420,...supported422444].includes(pix) || (Number.isFinite(depth) && depth > 12)) throw Error(`Unsupported source pixel format/depth ${pix}`);
  const order = String(video.field_order || '').toLowerCase();
  if (order !== 'progressive' && !(String(video.codec_name || '').toLowerCase() === 'av1' && (!order || order === 'unknown'))) throw Error(`Interlaced or unknown source field order ${order || 'missing'} is not verified as progressive`);
};
const useQsvDecode = (video) => {
  const codec=String(video.codec_name || '').toLowerCase();
  const pix=String(video.pix_fmt || '').toLowerCase().split('(')[0].trim();
  const qsv420_8=['nv12','yuv420p','yuv420p8'].includes(pix);
  const qsv420_10=['p010','p010le','yuv420p10le'].includes(pix);
  if (codec==='h264') return qsv420_8;
  if (codec==='hevc' || codec==='av1') return qsv420_8 || qsv420_10;
  return false;
};
const validateAspect = (source, output, checkOutputFieldOrder = true) => {
  const parse = value => {
    const match=String(value || '').match(/^(\d+):(\d+)$/);
    return match && Number(match[1])>0 && Number(match[2])>0 ? Number(match[1])/Number(match[2]) : null;
  };
  const a=parse(source.sample_aspect_ratio), b=parse(output.sample_aspect_ratio);
  const sourceSarMissing=!String(source.sample_aspect_ratio || '').trim() || /^(?:n\/a|unknown|unspecified|0:0|0:1)$/i.test(String(source.sample_aspect_ratio).trim());
  if (b === null) throw Error('Source or output sample aspect ratio is missing or changed');
  if (a === null) {
    const sameGeometry=Number.isSafeInteger(Number(source.width)) && Number(source.width)>0
      && Number.isSafeInteger(Number(source.height)) && Number(source.height)>0
      && Number(source.width)===Number(output.width) && Number(source.height)===Number(output.height);
    if (!sourceSarMissing || !sameGeometry || Math.abs(b-1)>1e-6) throw Error('Source or output sample aspect ratio is missing or changed');
  } else if (Math.abs(a-b)>1e-6) throw Error('Source or output sample aspect ratio is missing or changed');
  if (checkOutputFieldOrder) {
    const order=String(output.field_order || '').toLowerCase();
    if (order && !['progressive','unknown'].includes(order)) throw Error('Output has interlaced field order');
  }
};

// HDR10-compatible Dolby Vision Profile 8.1 carries a plain HDR10 base layer.
// Only an explicitly signaled single-layer source can take this downgrade.
const isHdr10PlusSignal = value => /hdr10(?:\+|[ _-]*plus)|2094(?:[- ]?40|.{0,12}app.?4)/i.test(String(value || ''));
// Free-text titles often repeat HDR labels in abbreviated forms (for example,
// "SMPTE ST 2094 HDR10+ Profile B"). Classify only MediaInfo's structured HDR
// fields; actual dynamic metadata is independently confirmed from decoded frames.
const mediaInfoHdrText = info => Object.entries(info || {})
  .filter(([key]) => /^(?:hdr_format(?:_.*)?|dolby_vision(?:_.*)?)$/i.test(key))
  .map(([key,value]) => `${key}=${String(value || '')}`).join(' ');
const validateMediaInfoHdrColors = (video, info) => {
  const mappings = [
    [['transfer_characteristics'], 'color_transfer', {pq:'smpte2084', smptest2084:'smpte2084', smpte2084:'smpte2084', hlg:'arib-std-b67', aribstdb67:'arib-std-b67', bt709:'bt709'}],
    [['colour_primaries','color_primaries'], 'color_primaries', {bt2020:'bt2020', bt709:'bt709'}],
    [['matrix_coefficients'], 'color_space', {bt2020nonconstant:'bt2020nc', bt2020nonconstantluminance:'bt2020nc', bt2020nc:'bt2020nc', bt2020constant:'bt2020c', bt2020constantluminance:'bt2020c', bt2020c:'bt2020c', bt709:'bt709', bt601:'smpte170m', smpte170m:'smpte170m', bt470bg:'bt470bg'}],
    [['colour_range','color_range'], 'color_range', {limited:'tv', full:'pc', tv:'tv', pc:'pc'}]
  ];
  for (const [keys, field, map] of mappings) for (const key of keys) {
    const value=info?.[key];
    if (isUnknownColorValue(value)) continue;
    for (const part of String(value).split(/\s*\/\s*/)) {
      const normalized=part.toLowerCase().replace(/[\s._-]/g,'');
      if (!map[normalized] || map[normalized] !== video[field]) throw Error(`MediaInfo color ${key} conflicts with stream or is unrecognized`);
    }
  }
};
// Run this inexpensive metadata-only gate before the full frame scan. It lets
// verified DV 8.1 and Profile 7 HDR10+ hybrids continue, while unsupported
// combinations fail before spending hours scanning a large source.
const preflightHybridHdr = (video, info, frameHdr10Plus=false) => {
  const infoText=mediaInfoHdrText(info), side=video.side_data_list || [];
  const hasDovi=/dolby vision|\bdovi\b/i.test(infoText)
    || side.some(item=>/dovi configuration/i.test(String(item.side_data_type || '')));
  const hasHdr10Plus=frameHdr10Plus || isHdr10PlusSignal(infoText)
    || side.some(item=>isHdr10PlusSignal(item.side_data_type));
  if (!hasDovi || !hasHdr10Plus) return 'not_hybrid';
  const config=side.filter(item=>/dovi configuration/i.test(String(item.side_data_type || '')));
  const compatible=/\bhdr10\b(?!\s*\+)/i.test(String(info?.HDR_Format_Compatibility || ''));
  const d=config.length===1 ? config[0] : null;
  if (!d || video.codec_name!=='hevc' || video.color_range!=='tv'
      || video.color_transfer!=='smpte2084' || video.color_primaries!=='bt2020'
      || video.color_space!=='bt2020nc') {
    throw Error('Hybrid Dolby Vision and HDR10+ combination is not verified for automated conversion');
  }
  if (Number(d.dv_profile)===7) {
    if (Number(d.bl_present_flag)!==1 || Number(d.el_present_flag)!==1
        || Number(d.rpu_present_flag)!==1 || Number(d.dv_bl_signal_compatibility_id)!==6) {
      throw Error('Dolby Vision Profile 7 HDR10+ hybrid lacks a verified HDR10-compatible base layer');
    }
    return 'dovi7_hdr10plus_candidate';
  }
  if (Number(d.dv_profile)!==8 || Number(d.bl_present_flag)!==1
      || Number(d.el_present_flag)!==0 || Number(d.rpu_present_flag)!==1
      || Number(d.dv_bl_signal_compatibility_id)!==1 || !compatible) {
    throw Error('Hybrid Dolby Vision and HDR10+ combination is not verified for automated conversion');
  }
  return 'dovi81_hdr10plus_candidate';
};
const preflightDolbyHdrRoute = (video, info, hybrid='not_hybrid') => {
  const side=video?.side_data_list || [];
  const configs=side.filter(item=>/dovi configuration/i.test(String(item.side_data_type || '')));
  const infoText=mediaInfoHdrText(info);
  const doviSignaled=/dolby vision|\bdovi\b/i.test(infoText) || configs.length>0;
  if (!doviSignaled) return null;
  if (configs.length!==1) throw Error('Dolby Vision configuration is missing or ambiguous');
  if (video.codec_name!=='hevc' || video.color_range!=='tv'
      || video.color_transfer!=='smpte2084' || video.color_primaries!=='bt2020'
      || video.color_space!=='bt2020nc') throw Error('Dolby Vision HDR10 base-layer codec or color metadata is not verified');
  const d=configs[0];
  if (hybrid==='dovi7_hdr10plus_candidate' && Number(d.dv_profile)===7
      && Number(d.bl_present_flag)===1 && Number(d.el_present_flag)===1
      && Number(d.rpu_present_flag)===1 && Number(d.dv_bl_signal_compatibility_id)===6) return 'dovi7_hdr10plus_hdr10';
  if (hybrid==='dovi81_hdr10plus_candidate' && Number(d.dv_profile)===8
      && Number(d.bl_present_flag)===1 && Number(d.el_present_flag)===0
      && Number(d.rpu_present_flag)===1 && Number(d.dv_bl_signal_compatibility_id)===1) return 'dovi81_hdr10plus_hdr10';
  if (Number(d.dv_profile)===7) {
    if (Number(d.bl_present_flag)!==1 || Number(d.el_present_flag)!==1
        || Number(d.rpu_present_flag)!==1 || Number(d.dv_bl_signal_compatibility_id)!==6
        || !/\bhdr10\b/i.test(String(info?.HDR_Format_Compatibility || ''))) {
      throw Error('Dolby Vision Profile 7 HDR10 base is not verified');
    }
    return 'dovi7_hdr10';
  }
  if (Number(d.dv_profile)!==8 || Number(d.bl_present_flag)!==1
      || Number(d.el_present_flag)!==0 || Number(d.rpu_present_flag)!==1) {
    throw Error('Dolby Vision profile or base layer is not verified for conversion');
  }
  if (Number(d.dv_bl_signal_compatibility_id)===4) throw Error('Dolby Vision Profile 8.4 HLG-base route is unverified');
  if (Number(d.dv_bl_signal_compatibility_id)!==1) throw Error('Dolby Vision profile or base layer is not verified for HDR10 conversion');
  return 'dovi81_hdr10';
};
const determineHdrRoute = (video, info, scan) => {
  if (!scan || !Number.isSafeInteger(scan.frames) || scan.frames < 1) throw Error('Decoded frame metadata unavailable');
  if (scan.interlaced) throw Error('Interlaced video is not supported');
  validateMediaInfoHdrColors(video, info);
  const infoText=mediaInfoHdrText(info), side=video.side_data_list || [];
  const strippedInfo=infoText.replace(/hdr10(?:\+|[ _-]*plus)|(?:smpte(?:\s*st)?\s*)?2094(?:[- ]?40|.{0,12}app.?4)/gi,'');
  const nonDolbyDynamic=side.filter(s=>isNonDolbyDynamic(s.side_data_type));
  if (scan.otherDynamic || isNonDolbyDynamic(strippedInfo) || nonDolbyDynamic.some(s=>!isHdr10PlusSignal(s.side_data_type))) throw Error('Unsupported dynamic HDR metadata');
  if (video.color_range !== 'tv') throw Error('HDR color range is not verified as limited');
  const config=side.filter(s => /dovi configuration/i.test(String(s.side_data_type || '')));
  const saysDovi = /dolby vision|\bdovi\b/i.test(infoText) || scan.dovi > 0 || config.length > 0;
  const plusSignaled = isHdr10PlusSignal(infoText) || nonDolbyDynamic.some(s=>isHdr10PlusSignal(s.side_data_type));
  if (scan.hdr10plus || plusSignaled) {
    if (saysDovi) {
      const hybrid=preflightHybridHdr(video,info,scan.hdr10plus>0);
      if (!scan.hdr10plus) throw Error('HDR10+ signaling is not verified in decoded frames');
      if (hybrid==='dovi7_hdr10plus_candidate') return 'dovi7_hdr10plus_hdr10';
      if (hybrid!=='dovi81_hdr10plus_candidate') throw Error('Hybrid Dolby Vision and HDR10+ signaling is incomplete or unverified');
      return 'dovi81_hdr10plus_hdr10';
    }
    if (!scan.hdr10plus) throw Error('HDR10+ signaling is not verified in decoded frames');
    if (video.codec_name!=='hevc' || video.color_transfer!=='smpte2084' || video.color_primaries!=='bt2020' || video.color_space!=='bt2020nc') throw Error('HDR10+ base layer color or codec is not verified');
    return 'hdr10plus_hdr10';
  }
  if (saysDovi) {
    if (config.length !== 1 || !scan.dovi) throw Error('Dolby Vision metadata is incomplete or conflicts with stream signaling');
    const d=config[0];
    if (Number(d.dv_profile)===7) {
      if (video.codec_name!=='hevc' || Number(d.bl_present_flag)!==1 || Number(d.el_present_flag)!==1 || Number(d.rpu_present_flag)!==1 || Number(d.dv_bl_signal_compatibility_id)!==6 || !/\bhdr10\b/i.test(String(info?.HDR_Format_Compatibility || ''))) throw Error('Dolby Vision Profile 7 HDR10 base is not verified');
      if (video.color_transfer!=='smpte2084' || video.color_primaries!=='bt2020' || video.color_space!=='bt2020nc') throw Error('Dolby Vision Profile 7 HDR10 base-layer color metadata conflicts');
      return 'dovi7_hdr10';
    }
    if (Number(d.dv_profile)!==8 || Number(d.bl_present_flag)!==1 || Number(d.rpu_present_flag)!==1 || Number(d.el_present_flag)!==0 || video.codec_name!=='hevc') throw Error('Dolby Vision profile or base layer is not verified for conversion');
    if (Number(d.dv_bl_signal_compatibility_id)===4) {
      if (video.color_transfer!=='arib-std-b67' || video.color_primaries!=='bt2020' || video.color_space!=='bt2020nc') throw Error('Dolby Vision HLG base-layer color metadata conflicts');
      throw Error('Dolby Vision Profile 8.4 HLG-base route is unverified pending a genuine source sample');
    }
    if (Number(d.dv_bl_signal_compatibility_id)!==1) throw Error('Dolby Vision profile or base layer is not verified for HDR10 conversion');
    if (video.color_transfer!=='smpte2084' || video.color_primaries!=='bt2020' || video.color_space!=='bt2020nc') throw Error('Dolby Vision HDR10 base-layer color metadata conflicts');
    return 'dovi81_hdr10';
  }
  if (video.color_transfer==='arib-std-b67' && video.color_primaries==='bt2020' && video.color_space==='bt2020nc' && /hlg/i.test(infoText)) return 'hlg';
  if (video.color_transfer==='smpte2084' && video.color_primaries==='bt2020' && video.color_space==='bt2020nc' && /hdr10|2086/i.test(infoText)) return 'hdr10';
  throw Error('HDR color signaling is unsupported or ambiguous');
};

const mergeHdrMetadata = (video, frames, options={}) => {
  for (const item of [video,...frames]) for (const type of ['Mastering display metadata','Content light level metadata']) if ((item.side_data_list || []).filter(s=>s.side_data_type===type).length>1) throw Error(`Duplicate HDR metadata: ${type}`);
  const all=[...(video.side_data_list || []),...frames.flatMap(f=>f.side_data_list || [])];
  const get=type=>all.find(x=>x.side_data_type===type);
  const mastering=get('Mastering display metadata');
  let light=get('Content light level metadata');
  if ((!mastering && !options.allowMissingAll) || (!light && !options.allowMissingLight && !options.allowMissingAll)) throw Error('HDR10 mastering or light metadata is missing');
  if (!light && options.allowMissingLight) light={side_data_type:'Content light level metadata',max_content:0,max_average:0};
  return {...video,side_data_list:[mastering,light].filter(Boolean)};
};
const recordHdrFrame = (line, scan) => {
  const text=String(line);
  const isFrame=/(?:^|\|)frame(?:\||$)/i.test(text)
    || /(?:^|\|)(?:interlaced_frame|best_effort_timestamp_time)=/.test(text);
  if (!isFrame) return;
  scan.frames++;
  const interlaced=text.match(/(?:^|\|)interlaced_frame=([01])(?:\||$)/);
  if (scan.timestamps) {
    const ts=text.match(/(?:^|\|)best_effort_timestamp_time=([^|]+)/);
    const value=ts && ts[1].trim()!=='N/A' ? Number(ts[1].trim()) : NaN;
    scan.timestamps.push(Number.isFinite(value) ? value : NaN);
  }
  if (interlaced?.[1] === '1') scan.interlaced++;
  if (/side_data_type=Dolby Vision (?:RPU Data|Metadata)/i.test(text)) scan.dovi++;
  const sideTypes=Array.from(text.matchAll(/side_data_type=([^|]+)/g),m=>m[1]);
  if (sideTypes.some(x=>/SMPTE\s*2094-40|HDR10(?:\+|[ _-]*plus)/i.test(x))) scan.hdr10plus++;
  if (sideTypes.some(x=>isNonDolbyDynamic(x) && !/SMPTE\s*2094-40|HDR10(?:\+|[ _-]*plus)/i.test(x))) scan.otherDynamic++;
  if (scan.staticInfo) collectHdrFrameStatic(text, scan.staticInfo);
  if (scan.colorInfo) for (const field of ['color_transfer','color_primaries','color_space','color_range']) {
    const wanted=scan.colorInfo.expected?.[field], match=text.match(new RegExp('(?:^|\\|)'+field+'=([^|]+)'));
    const got=match?.[1];
    if (!got || got==='unknown' || got==='unspecified') continue;
    if (!scan.colorInfo.observed) scan.colorInfo.observed={};
    if (scan.colorInfo.observed[field] && scan.colorInfo.observed[field]!==got) scan.colorInfo.conflict=true;
    else scan.colorInfo.observed[field]=got;
    if (wanted && wanted!=='unknown' && wanted!=='unspecified' && got!==wanted) scan.colorInfo.conflict=true;
  }

};
const estimateVideoFrames = (video, fallbackDuration=0) => {
  const exact=Number(video?.nb_frames);
  if (Number.isSafeInteger(exact) && exact>0) return exact;
  const duration=Number(video?.duration || fallbackDuration);
  const [num,den]=String(video?.avg_frame_rate || video?.r_frame_rate || '').split('/').map(Number);
  const rate=Number.isFinite(num) && Number.isFinite(den) && den>0 ? num/den : NaN;
  const estimate=Math.round(duration*rate);
  return Number.isSafeInteger(estimate) && estimate>0 ? estimate : null;
};
const getDecodeThreadCount = () => {
  const raw=process.env.TDARR_DECODE_THREADS ?? process.env.TDARR_PRECHECK_THREADS;
  if(raw===undefined)return 4;
  const value=String(raw).trim();
  const threads=Number(value);
  if(!value||!Number.isSafeInteger(threads)||threads<1||threads>16) throw Error('TDARR_DECODE_THREADS must be an integer from 1 to 16');
  return threads;
};
const withDecoderThreads = (argv,threads=getDecodeThreadCount()) => {
  const value=Number(threads);
  if(!Number.isSafeInteger(value)||value<1||value>16) throw Error('Decoder thread count must be an integer from 1 to 16');
  const args=[...argv],inputIndex=args.indexOf('-i');
  if(inputIndex<0)throw Error('FFmpeg decoder thread helper requires an input argument (-i)');
  const existingIndex=args.lastIndexOf('-threads',inputIndex);
  if(existingIndex>=0) {
    if(existingIndex+1>=inputIndex)throw Error('FFmpeg decoder thread option is missing its value before the input');
    args[existingIndex+1]=String(value);
  }
  else args.splice(inputIndex,0,'-threads',String(value));
  return args;
};
const buildFrameScanArguments = (file,index,threads=getDecodeThreadCount()) => {
  const value=Number(threads);
  if(!Number.isSafeInteger(value)||value<1||value>16) throw Error('Frame scan thread count must be an integer from 1 to 16');
  return ['-v','error','-threads',String(value),'-select_streams',String(index),'-show_frames','-show_entries','frame=best_effort_timestamp_time,pkt_pos,interlaced_frame,color_range,color_space,color_primaries,color_transfer:frame_side_data=side_data_type,red_x,red_y,green_x,green_y,blue_x,blue_y,white_point_x,white_point_y,min_luminance,max_luminance,max_content,max_average','-of','compact=p=1:nk=0',file];
};
const inspectVideoFrames = async (ffprobe, file, index, options={}) => {
  const scan={frames:0,interlaced:0,dovi:0,hdr10plus:0,otherDynamic:0};
  if (options.staticMetadata) scan.staticInfo={mastering:null,light:null,conflict:false};
  if (options.timestamps) scan.timestamps=[];
  if (options.expectedColor) scan.colorInfo={expected:options.expectedColor,conflict:false};
  const expectedFrames=Number(options.expectedFrames),onProgress=options.onProgress;
  const expectedDuration=Number(options.expectedDuration),assertUnchanged=options.assertUnchanged;
  let fileBytes=0,lastPacketPosition=0,hasPacketPosition=false,lastTimestamp=0;
  try { fileBytes=require('fs').statSync(file).size; } catch (_) {}
  const scanStartedAt=Date.now();
  let lastProgressAt=0,lastFpsSampleAt=scanStartedAt,lastFpsSampleFrames=0,lastFps=0;
  const update=(complete=false)=>{
    if(typeof assertUnchanged==='function')assertUnchanged();
    if (typeof onProgress!=='function') return;
    const now=Date.now(),elapsed=(now-lastFpsSampleAt)/1000;
    if(elapsed>=0.25){
      const delta=scan.frames-lastFpsSampleFrames;
      if(delta>0)lastFps=delta/elapsed;
      lastFpsSampleAt=now;
      lastFpsSampleFrames=scan.frames;
    }
    if(complete&&lastFps<=0){
      const totalElapsed=Math.max(0.001,(now-scanStartedAt)/1000);
      lastFps=scan.frames/totalElapsed;
    }
    const hasFrameEstimate=Number.isSafeInteger(expectedFrames)&&expectedFrames>0;
    const positionRatio=hasPacketPosition&&fileBytes>0?lastPacketPosition/fileBytes:NaN;
    const timestampRatio=Number.isFinite(lastTimestamp)&&expectedDuration>0?lastTimestamp/expectedDuration:NaN;
    const progressRatio=complete?1:hasFrameEstimate?scan.frames/expectedFrames:Number.isFinite(positionRatio)?positionRatio:timestampRatio;
    try { const result=onProgress(scan.frames,hasFrameEstimate?expectedFrames:0,complete,Math.round(lastFps*10)/10,progressRatio); if (result && typeof result.catch==='function') result.catch(()=>{}); } catch (_) {}
  };
  const failOnKnownFrameMismatch=()=>{
    if (!options.failFast) return;
    if (scan.interlaced) throw Error('Interlaced video frames are unsupported');
    if (scan.colorInfo?.conflict) throw Error('Video frame color signaling conflicts with the stream');
    if (scan.staticInfo?.conflict) throw Error('Conflicting or changing static HDR metadata in decoded frames');
    if (scan.otherDynamic) throw Error('Unsupported dynamic HDR metadata detected in decoded frames');
    if (options.rejectDolbyVision && scan.dovi) throw Error('Dolby Vision metadata is not allowed in this output');
    if (options.rejectHdr10Plus && scan.hdr10plus) throw Error('HDR10+ metadata is not allowed in this output');
    if (options.sourceBasic==='sdr') validateSdrFrameSignaling(options.sourceBasic,scan);
  };
  update(false);
  const argv=buildFrameScanArguments(file,index,options.threads ?? getDecodeThreadCount());
  let scannerDiagnostics='';
  await runTimelineProcess(ffprobe, argv, line=>{
    recordHdrFrame(line,scan);
    failOnKnownFrameMismatch();
    const text=String(line);
    const positionMatch=text.match(/(?:^|\|)pkt_pos=([^|]+)/);
    const position=positionMatch&&positionMatch[1]!=='N/A'?Number(positionMatch[1]):NaN;
    if(Number.isFinite(position)&&position>=0){lastPacketPosition=Math.max(lastPacketPosition,position);hasPacketPosition=true;}
    const timestampMatch=text.match(/(?:^|\|)best_effort_timestamp_time=([^|]+)/);
    const timestamp=timestampMatch&&timestampMatch[1]!=='N/A'?Number(timestampMatch[1]):NaN;
    if(Number.isFinite(timestamp))lastTimestamp=Math.max(lastTimestamp,timestamp);
    const now=Date.now();
    if (scan.frames===1 || scan.frames%256===0 || now-lastProgressAt>=1000) { update(false); lastProgressAt=now; }
  }, null, (diagnostic,streaming=false)=>{
    scannerDiagnostics=String(diagnostic || '');
    if(streaming && options.failFast && isVerificationInfrastructureDiagnostic(scannerDiagnostics))
      throw validationUnavailable(`Frame scanner could not complete: ${scannerDiagnostics.trim().slice(-800)}`);
    if(streaming && options.failFast && isKnownVideoCorruptionDiagnostic(scannerDiagnostics)) {
      const prefix=options.scanRole==='source'?'[Source media corruption]':'[Candidate validation]';
      throw Error(`${prefix} ${scannerDiagnostics.trim().slice(-800)}`);
    }
  });
  if(isVerificationInfrastructureDiagnostic(scannerDiagnostics))throw validationUnavailable(`Frame scanner could not complete: ${scannerDiagnostics.trim().slice(-800)}`);
  if (isKnownVideoCorruptionDiagnostic(scannerDiagnostics)) {
    const prefix=options.scanRole==='source'?'[Source media corruption]':'[Candidate validation]';
    throw Error(`${prefix} ${scannerDiagnostics.trim().slice(-800)}`);
  }
  if (!scan.frames) throw validationUnavailable('Decoded frame metadata unavailable');
  update(true);
  return scan;
};
const parseDolbyLevel6 = (rpu) => {
  const blocks=[...(rpu?.vdr_dm_data?.cmv29_metadata?.ext_metadata_blocks || []),...(rpu?.vdr_dm_data?.cmv40_metadata?.ext_metadata_blocks || [])];
  const levels=blocks.filter(b=>b && b.Level6).map(b=>b.Level6);
  if (levels.length !== 1) throw Error('Dolby Level 6 mastering metadata unavailable or ambiguous');
  const l=levels[0], max=Number(l.max_content_light_level), avg=Number(l.max_frame_average_light_level), masterMax=Number(l.max_display_mastering_luminance), masterMin=Number(l.min_display_mastering_luminance);
  const unknownLight=max===0 && avg===0;
  const validLight=max>=1 && max<=65535 && avg>=1 && avg<=max;
  if (![max,avg,masterMax,masterMin].every(Number.isInteger) || (!unknownLight && !validLight) || masterMax<1 || masterMax>65535 || masterMin<0 || masterMin>65535) throw Error('Dolby Level 6 light metadata is invalid');
  return {max_content:max,max_average:avg,max_luminance:masterMax,min_luminance:masterMin/10000};
};
const readHdrFrames = (ffprobe, file, index) => {
  const raw=execFileSync(ffprobe,['-v','error','-threads',String(getDecodeThreadCount()),'-select_streams',String(index),'-read_intervals','%+1','-show_frames','-show_entries','frame=side_data_list','-of','json',file],{encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});
  const frames=JSON.parse(raw).frames;
  if (!Array.isArray(frames) || !frames.length) throw Error('HDR source frame metadata unavailable');
  return frames;
};
const summarizeLevel6Rows = (rows, expectedFrames, includeCount=false) => {
  const header='frame,max_display_mastering_luminance,min_display_mastering_luminance,max_content_light_level,max_frame_average_light_level';
  if (!Array.isArray(rows) || rows[0]?.trim() !== header || (expectedFrames!==null && (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1))) throw Error('Dolby Level 6 export is invalid');
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
  if (!first || count<1 || (expectedFrames!==null && count!==expectedFrames)) throw Error(`Dolby Level 6 frame count mismatch (${count} / ${expectedFrames})`);
  return includeCount ? {value:first,frames:count} : first;
};
const extractDolbyLevel6 = async (ffmpeg, file, index, expectedFrames, includeCount=false) => {
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
    const timer=setTimeout(()=>{source.kill('SIGKILL');extract.kill('SIGKILL');},12*60*60*1000);
    if (timer.unref) timer.unref();
    try {
      await Promise.all([closed(source,()=>sourceErr),closed(extract,()=>extractErr),require('stream/promises').pipeline(source.stdout,extract.stdin)]);
    } catch (e) {source.kill('SIGKILL');extract.kill('SIGKILL');throw e;}
    finally {clearTimeout(timer);}
    execFileSync('dovi_tool',['export','-i',rpu,'--levels',`level6=${csv}`,'--levels-format','csv'],{encoding:'utf8',timeout:12*60*60*1000,maxBuffer:1024*1024});
    if (fs.statSync(csv).size>128*1024*1024) throw Error('Dolby Level 6 export exceeds safety limit');
    return summarizeLevel6Rows(fs.readFileSync(csv,'utf8').split(/\r?\n/),expectedFrames,includeCount);
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
    if (route==='hdr10') {
      const unknownPair=light && Number(light.max_content)===0 && Number(light.max_average)===0;
      if (light && !unknownPair) throw Error('HDR10 content-light metadata is invalid');
      return {metadata:{...metadata,side_data_list:(metadata.side_data_list || []).filter(x=>x.side_data_type!=='Content light level metadata')},override:null};
    }
    if (!['dovi81_hdr10','dovi7_hdr10','dovi81_hdr10plus_hdr10','dovi7_hdr10plus_hdr10'].includes(route)) throw Error('HDR10 light metadata is absent or unspecified');
    const l6=await getLevel6();
    const sourceMax=rationalValue(mastering?.max_luminance), sourceMin=rationalValue(mastering?.min_luminance);
    if (l6.max_content===0 && l6.max_average===0) {
      if (light && (Number(light.max_content)!==0 || Number(light.max_average)!==0)) throw Error('Dolby Level 6 light metadata is unavailable and source content-light metadata is invalid');
      if (!Number.isFinite(sourceMax) || !Number.isFinite(sourceMin)) throw Error('HDR10 mastering metadata is missing or invalid');
      return {metadata:{...metadata,side_data_list:(metadata.side_data_list || []).filter(x=>x.side_data_type!=='Content light level metadata')},override:null};
    }
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
const isQsvHdrMasteringClampRisk = source => {
  const mastering=(source?.side_data_list || []).find(item=>item.side_data_type==='Mastering display metadata');
  const greenY=rationalValue(mastering?.green_y),qsvClamp=50000/65536;
  return Number.isFinite(greenY) && greenY>qsvClamp+0.0001 && greenY<0.84;
};
const isKnownQsvHdrMasteringClamp = (source,output,error) => {
  if (String(error?.message || error || '') !== 'HDR mastering metadata conflicts with decoded frames') return false;
  const sourceMastering=(source?.side_data_list || []).find(item=>item.side_data_type==='Mastering display metadata');
  const outputMastering=(output?.side_data_list || []).find(item=>item.side_data_type==='Mastering display metadata');
  if (!sourceMastering || !outputMastering) return false;
  const sourceGreenY=rationalValue(sourceMastering.green_y), outputGreenY=rationalValue(outputMastering.green_y);
  const qsvClamp=50000/65536;
  if (!Number.isFinite(sourceGreenY) || !Number.isFinite(outputGreenY)
      || Math.abs(outputGreenY-qsvClamp)>0.0001
      || sourceGreenY<=qsvClamp+0.0001 || sourceGreenY>=0.84) return false;
  return sameHdrSideData(sourceMastering,outputMastering,hdrMasterFields.filter(field=>field!=='green_y'));
};
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
    // FFmpeg reports 0/0 for both CLL fields when HDR content-light data is
    // unspecified. Do not compare this placeholder against Dolby Level 6 data
    // used to supply the missing HDR10 light metadata.
    if (key==='light' && Number(value.max_content)===0 && Number(value.max_average)===0) continue;
    if (info[key] && !sameHdrSideData(info[key],value,fields)) info.conflict=true;
    else if (!info[key]) info[key]=value;
  }
};
const checkHdrFrameStatic = (metadata, scan, requireLight=true, requireMastering=true) => {
  const current=scan?.staticInfo;
  if (!current || current.conflict || (requireMastering && !current.mastering) || (requireLight && !current.light)) throw Error('HDR static metadata is missing or changes within the video');
  const side=metadata.side_data_list || [];
  const mastering=side.find(s=>s.side_data_type==='Mastering display metadata');
  const light=side.find(s=>s.side_data_type==='Content light level metadata');
  if (current.mastering && (!mastering || !sameHdrSideData(mastering,current.mastering,hdrMasterFields))) {
    const mismatch=Error('HDR mastering metadata conflicts with decoded frames');
    if (isKnownQsvHdrMasteringClamp(metadata,{side_data_list:[current.mastering]},mismatch)) {
      throw Error(`${mismatch.message} (identified Intel QSV AV1 green-y clamp)`);
    }
    throw mismatch;
  }
  if (current.light && (!light || !sameHdrSideData(light,current.light,['max_content','max_average']))) throw Error('HDR light metadata conflicts with decoded frames');
};
const hdrFrameMetadataRequirements = (source, optionalHdrStatic=false) => {
  const side=source?.side_data_list || [];
  return {
    requireLight:!optionalHdrStatic && side.some(x=>x.side_data_type==='Content light level metadata'),
    requireMastering:!optionalHdrStatic && side.some(x=>x.side_data_type==='Mastering display metadata')
  };
};
const composeVideoFilterChain = (baseFilter, options={}) => {
  const filters=[];
  if (options.removeHdr10Plus) filters.push('sidedata=mode=delete:type=DYNAMIC_HDR_PLUS');
  if (options.removeContentLight) filters.push('sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL');
  filters.push(String(baseFilter));
  return filters.join(',');
};
const compareVideoTimestamps = (source, output) => {
  const a=source?.timestamps,b=output?.timestamps;
  const frameCount=(scan,timestamps)=>Number.isSafeInteger(scan?.frames)&&scan.frames>=0?scan.frames:(Array.isArray(timestamps)?timestamps.length:0);
  const sourceFrames=frameCount(source,a),outputFrames=frameCount(output,b);
  const timestampCount=timestamps=>Array.isArray(timestamps)?timestamps.length:'unavailable';
  const summary=`source ${sourceFrames} frames/${timestampCount(a)} timestamps; output ${outputFrames} frames/${timestampCount(b)} timestamps`;
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) throw validationUnavailable(`Video presentation timestamp scan is unavailable (${summary})`);
  if (sourceFrames!==a.length || outputFrames!==b.length) throw validationUnavailable(`Video presentation timestamp scan is incomplete (${summary})`);
  if (sourceFrames!==outputFrames || a.length!==b.length) throw Error(`Video frame count differs (${summary})`);
  const missing=(timestamps)=>timestamps.flatMap((value,index)=>Number.isFinite(value)?[]:[index]).slice(0,5);
  const missingSource=missing(a),missingOutput=missing(b);
  if (missingSource.length || missingOutput.length) {
    const describe=(indices,total)=>indices.length?`${indices.join(', ')}${total>indices.length?', …':''}`:'none';
    const message=`Video presentation timestamps missing or invalid (${summary}; first source frame indexes: ${describe(missingSource,a.filter(x=>!Number.isFinite(x)).length)}; first output frame indexes: ${describe(missingOutput,b.filter(x=>!Number.isFinite(x)).length)})`;
    if(!missingSource.length)throw validationFailure('rejected','frames','video_timestamps_lost',message);
    throw validationUnavailable(message);
  }
  for (let i=0;i<a.length;i++) {
    const delta=Math.abs((a[i]-a[0])-(b[i]-b[0]));
    if (delta>0.05) throw Error(`Video presentation timestamp differs at frame ${i} by ${delta.toFixed(3)}s (tolerance 0.050s)`);
  }
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
  if (actual && !isUnknownColorValue(expected) && norm(actual)!==norm(expected)) throw Error('SDR decoded-frame transfer conflicts with source signaling');
};

const validateSdrFrameSignaling = (basic,scan) => {
  if (basic!=='sdr') return;
  const observed=scan?.colorInfo?.observed || {};
  const transfer=String(observed.color_transfer || '').toLowerCase().replace(/[ ._-]/g,'');
  const primaries=String(observed.color_primaries || '').toLowerCase().replace(/[ ._-]/g,'');
  const matrix=String(observed.color_space || '').toLowerCase().replace(/[ ._-]/g,'');
  if (['smpte2084','aribstdb67'].includes(transfer) || primaries.includes('bt2020') || matrix.includes('bt2020')) {
    throw Error('Decoded-frame HDR color signaling conflicts with SDR stream classification');
  }
};

const effectiveSdrSource = (video,info,scan) => {
  const effective={...video},observed=scan?.colorInfo?.observed || {};
  for (const field of ['color_transfer','color_primaries','color_space','color_range']) if (!effective[field] || ['unknown','unspecified'].includes(effective[field])) if (observed[field]) effective[field]=observed[field];
  if (!effective.color_transfer || ['unknown','unspecified'].includes(effective.color_transfer)) {
    const map={bt709:'bt709',smpte170m:'smpte170m',bt470bg:'bt470bg',gamma22:'gamma22',gamma28:'gamma28',smpte240m:'smpte240m',iec6196621:'iec61966-2-1'};
    const key=String(info?.transfer_characteristics || '').toLowerCase().replace(/[ ._-]/g,'');
    if (map[key]) effective.color_transfer=map[key];
  }
  return effective;
};
const isUnknownColorValue = value => value === undefined || value === null || value === '' || /^(?:unknown|unspecified|n\/?a|none)$/i.test(String(value).trim());
const normalizeColorRange = value => {
  const range=String(value || '').trim().toLowerCase();
  if (['tv','mpeg','limited'].includes(range)) return 'tv';
  if (['pc','jpeg','full'].includes(range)) return 'pc';
  return null;
};
const inferUntaggedColorRange = (video,info,scan) => {
  const values=[video?.color_range,scan?.colorInfo?.observed?.color_range,info?.colour_range,info?.color_range];
  const ranges=[];
  for (const value of values) {
    if (isUnknownColorValue(value)) continue;
    const range=normalizeColorRange(value);
    if (!range) return null;
    ranges.push(range);
  }
  if (ranges.some(range=>range!==ranges[0])) return null;
  if (ranges.length) return ranges[0];
  const pixelFormat=String(video?.pix_fmt || '').toLowerCase().split('(')[0].trim();
  if (['yuvj422p','yuvj444p'].includes(pixelFormat)) return 'pc';
  const limitedYuvFormats=[
    'nv12','p010','p010le','yuv420p','yuv420p8','yuv420p9le','yuv420p10le','yuv420p12le',
    'yuv422p','yuv422p9le','yuv422p10le','yuv422p12le','yuv444p','yuv444p9le','yuv444p10le','yuv444p12le'
  ];
  return limitedYuvFormats.includes(pixelFormat)?'tv':null;
};
const untaggedColorRangeArgs = (hdrClass,source) => {
  if (hdrClass!=='untagged') return [];
  const range=normalizeColorRange(source?.color_range);
  if (!range) throw Error('Untagged SDR color range could not be resolved');
  return ['-color_range',range];
};
const isUntaggedVideo = (video,info,scan) => {
  if (!scan || !scan.frames || scan.interlaced || scan.dovi || scan.hdr10plus || scan.otherDynamic || !scan.staticInfo || scan.staticInfo.mastering || scan.staticInfo.light || scan.staticInfo.conflict || scan.colorInfo?.conflict) return false;
  if ((video.side_data_list || []).some(s=>isDynamicHdrSignal(s.side_data_type) || /mastering display|content light/i.test(String(s.side_data_type || '')))) return false;
  for (const field of ['color_transfer','color_primaries','color_space']) if (!isUnknownColorValue(video[field]) || !isUnknownColorValue(scan.colorInfo?.observed?.[field])) return false;
  for (const [field,value] of Object.entries(info || {})) {
    if (!/_source$/i.test(field) && /hdr|dolby|dovi|colour_primaries|color_primaries|transfer_characteristics|matrix_coefficients/i.test(field) && !isUnknownColorValue(value)) return false;
  }
  return true;
};
const validateUntaggedOutput = (source,output,scan) => {
  for (const field of ['color_transfer','color_primaries','color_space']) if (!isUnknownColorValue(output[field]) || !isUnknownColorValue(scan?.colorInfo?.observed?.[field])) throw Error(`Untagged output assigned color ${field}`);
  const wanted=source.color_range, got=output.color_range;
  if (isUnknownColorValue(wanted) ? !isUnknownColorValue(got) : wanted!==got) throw Error('Untagged output color range changed');
  const observed=scan?.colorInfo?.observed?.color_range;
  if (isUnknownColorValue(wanted) ? !isUnknownColorValue(observed) : !isUnknownColorValue(observed) && observed!==wanted) throw Error('Untagged output frame color range changed');
  if ((output.side_data_list || []).some(s=>isDynamicHdrSignal(s.side_data_type) || /mastering display|content light/i.test(String(s.side_data_type || '')))) throw Error('Untagged output gained HDR metadata');
};
