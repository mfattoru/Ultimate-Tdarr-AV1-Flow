function subtitleMeasurementUnavailable(message) {
  return Object.assign(new Error(message),{validation:{outcome:'inconclusive',stage:'timelines',code:'subtitle_measurement_unavailable',message}});
}
function parseSubtitlePacketLine(line) {
  const fields = {};
  for (const entry of String(line || '').split('|')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    fields[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  if (!('pts_time' in fields) && !('dts_time' in fields) && !('data_hash' in fields)) return null;
  const numberOrNull = value => {
    if (value === undefined || value === '' || value === 'N/A') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  return {
    pts: numberOrNull(fields.pts_time),
    dts: numberOrNull(fields.dts_time),
    duration: numberOrNull(fields.duration_time),
    position: numberOrNull(fields.pos),
    payloadHash: fields.data_hash || ''
  };
}

async function readSubtitlePackets(ffprobe, file, streamIndex, onProgress, durationHint) {
  const packets = [];
  let fileBytes=0,lastPosition=0,lastRatio=0,lastReported=-1,lastReportAt=0,hasPacketPosition=false;
  try { fileBytes=require('fs').statSync(file).size; } catch (_) {}
  const emitProgress=packet=>{
    if(typeof onProgress!=='function')return;
    if(Number.isFinite(packet.position)&&packet.position>=0){lastPosition=Math.max(lastPosition,packet.position);hasPacketPosition=true;}
    let ratio=fileBytes>0&&hasPacketPosition?lastPosition/fileBytes:(Number.isFinite(packet.pts)&&durationHint>0?packet.pts/durationHint:0);
    ratio=Math.max(lastRatio,Math.max(0,Math.min(1,Number.isFinite(ratio)?ratio:0)));
    lastRatio=ratio;
    const now=Date.now();
    if(ratio-lastReported>=0.002||now-lastReportAt>=1000||ratio>=1){lastReported=ratio;lastReportAt=now;try{onProgress(ratio);}catch(_){}}
  };
  const argv = [
    '-v', 'error', '-select_streams', String(streamIndex), '-show_packets',
    '-show_data_hash', 'sha256', '-show_entries',
    'packet=pts_time,dts_time,duration_time,data_hash,pos',
    '-of', 'compact=p=0:nk=0', file
  ];
  await runTimelineProcess(ffprobe, argv, line => {
    const packet = parseSubtitlePacketLine(line);
    if (packet) { packets.push(packet); emitProgress(packet); }
  });
  if(typeof onProgress==='function')try{onProgress(1);}catch(_){}
  return packets;
}

function validateCopiedSubtitlePackets(sourcePackets, outputPackets, globalShiftSeconds, maxRepairSeconds = 0.5) {
  if (!Array.isArray(sourcePackets) || !Array.isArray(outputPackets)) throw subtitleMeasurementUnavailable('ASS/SSA subtitle packet scan is unavailable');
  if (sourcePackets.length !== outputPackets.length) throw new Error(`ASS/SSA subtitle packet count changed (${sourcePackets.length} source, ${outputPackets.length} output)`);
  if (!Number.isFinite(globalShiftSeconds) || !Number.isFinite(maxRepairSeconds) || maxRepairSeconds < 0) throw subtitleMeasurementUnavailable('Invalid ASS/SSA subtitle timestamp comparison');
  if (sourcePackets.length === 0) return {packetCount:0,adjustedPackets:0,maxAdjustmentSeconds:0};

  let previousOutputPts = -Infinity;
  let previousOutputDts = -Infinity;
  let sourceFirst = Infinity, sourceLast = -Infinity;
  let outputFirst = Infinity, outputLast = -Infinity;
  let adjustedPackets = 0, maxAdjustmentSeconds = 0;

  for (let index = 0; index < sourcePackets.length; index++) {
    const source = sourcePackets[index], output = outputPackets[index];
    if (!Number.isFinite(source.pts)) throw subtitleMeasurementUnavailable(`ASS/SSA source subtitle packet ${index} has missing or invalid PTS`);
    if (!Number.isFinite(output.pts)) throw new Error(`ASS/SSA subtitle packet ${index} has missing or invalid PTS newly in candidate`);
    if (!source.payloadHash || !output.payloadHash) throw subtitleMeasurementUnavailable(`ASS/SSA subtitle packet ${index} is missing its payload hash`);
    if (source.payloadHash !== output.payloadHash) throw new Error(`ASS/SSA subtitle packet ${index} payload changed`);
    if (output.pts < previousOutputPts) throw new Error(`ASS/SSA subtitle output PTS is not monotonic at packet ${index}`);
    previousOutputPts = output.pts;

    const sourceEnd = source.pts + (Number.isFinite(source.duration) && source.duration > 0 ? source.duration : 0);
    const outputEnd = output.pts + (Number.isFinite(output.duration) && output.duration > 0 ? output.duration : 0);
    sourceFirst = Math.min(sourceFirst, source.pts);
    sourceLast = Math.max(sourceLast, sourceEnd);
    outputFirst = Math.min(outputFirst, output.pts);
    outputLast = Math.max(outputLast, outputEnd);

    let packetAdjustment = Math.abs(output.pts - (source.pts + globalShiftSeconds));
    if (source.dts !== null) {
      if (!Number.isFinite(source.dts)) throw subtitleMeasurementUnavailable(`ASS/SSA source subtitle packet ${index} has missing or invalid DTS`);
      if (!Number.isFinite(output.dts)) throw new Error(`ASS/SSA subtitle packet ${index} has missing or invalid DTS newly in candidate`);
      if (output.dts < previousOutputDts) throw new Error(`ASS/SSA subtitle output DTS is not monotonic at packet ${index}`);
      previousOutputDts = output.dts;
      packetAdjustment = Math.max(packetAdjustment, Math.abs(output.dts - (source.dts + globalShiftSeconds)));
    } else if (Number.isFinite(output.dts)) {
      if (output.dts < previousOutputDts) throw new Error(`ASS/SSA subtitle output DTS is not monotonic at packet ${index}`);
      previousOutputDts = output.dts;
    }

    maxAdjustmentSeconds = Math.max(maxAdjustmentSeconds, packetAdjustment);
    if (packetAdjustment > 0.001) adjustedPackets++;
    if (packetAdjustment > maxRepairSeconds + 1e-6) {
      throw new Error(`ASS/SSA subtitle timestamp repair ${packetAdjustment.toFixed(3)}s exceeds the ${maxRepairSeconds.toFixed(1)}s repair limit at packet ${index}`);
    }
  }

  if (Math.abs((outputFirst - sourceFirst) - globalShiftSeconds) > maxRepairSeconds + 1e-6 || Math.abs((outputLast - sourceLast) - globalShiftSeconds) > maxRepairSeconds + 1e-6) {
    throw new Error('ASS/SSA subtitle timeline differs from source');
  }
  return {
    packetCount: sourcePackets.length,
    adjustedPackets,
    maxAdjustmentSeconds: Math.round(maxAdjustmentSeconds * 1e6) / 1e6
  };
}

if (typeof module !== 'undefined') module.exports = {parseSubtitlePacketLine,readSubtitlePackets,validateCopiedSubtitlePackets};
