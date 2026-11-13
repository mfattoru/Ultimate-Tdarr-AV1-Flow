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
  return codec === 'av1' && !!key && String(tags[key]) === 'ArcAV1_QSV_V4';
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
const classifyVideo = (video, info) => {
  const fields = Object.entries(info || {}).filter(([key]) => /hdr|dolby|mastering|transfer|primaries|matrix/i.test(key));
  const values = fields.map(([,v]) => String(v)).join(' ').toLowerCase();
  const side = JSON.stringify(video.side_data_list || []).toLowerCase();
  if (/dolby|dovi|2094|hdr10\+|hdr10 plus/.test(values + ' ' + side)) return 'unsupported';
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
  for (const field of ['color_transfer','color_primaries','color_space']) {
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
