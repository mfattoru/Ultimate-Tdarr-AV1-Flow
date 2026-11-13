function subtitleMeasurementUnavailable(message) {
  return Object.assign(new Error(message),{validation:{outcome:'inconclusive',stage:'timelines',code:'subtitle_measurement_unavailable',message}});
}
function createSubtitleTimingPrecheck(maxRepairSeconds=0.5) {
  if(!Number.isFinite(maxRepairSeconds)||maxRepairSeconds<0)throw Error('Invalid subtitle repair limit');
  let previousPts=null,previousDts=null,packetCount=0,missingPts=0,maxAdjustmentSeconds=0,firstOverLimitPacket=null;
  return {
    push(packet) {
      const ordinal=packetCount++;
      if(!Number.isFinite(packet?.pts)){missingPts++;return;}
      const pts=packet.pts;
      let adjusted=previousPts===null?pts:Math.max(pts,previousPts);
      let movement=adjusted-pts;
      previousPts=adjusted;
      if(Number.isFinite(packet.dts)){
        adjusted=previousDts===null?packet.dts:Math.max(packet.dts,previousDts);
        movement=Math.max(movement,adjusted-packet.dts);
        previousDts=adjusted;
      }
      maxAdjustmentSeconds=Math.max(maxAdjustmentSeconds,movement);
      if(firstOverLimitPacket===null && movement>maxRepairSeconds+1e-6)firstOverLimitPacket=ordinal;
    },
    finish(){return {packetCount,missingPts,maxAdjustmentSeconds:Math.round(maxAdjustmentSeconds*1e6)/1e6,firstOverLimitPacket};}
  };
}
function decodeFfprobeDataHex(hexDump,expectedHash) {
  const bytes = [];
  for (const line of String(hexDump || '').split(/\r?\n/)) {
    // FFprobe separates its hex bytes and printable preview with at least two
    // spaces. The preview can itself begin with hex-looking text such as 150.
    const match = line.match(/^[0-9a-f]{8}:\s+(.+?)(?:\s{2,}|$)/i);
    if (!match) continue;
    const groups=match[1].trim().split(/\s+/);
    if(groups.some(group=>!/^(?:[0-9a-f]{2}|[0-9a-f]{4})$/i.test(group))) throw Error('Invalid FFprobe hex dump');
    const hex = groups.join('');
    for (let index = 0; index + 1 < hex.length; index += 2) {
      bytes.push(parseInt(hex.slice(index, index + 2), 16));
    }
  }
  const data=Buffer.from(bytes);
  if(expectedHash!==undefined){
    if(!/^SHA256:[0-9a-f]{64}$/i.test(String(expectedHash)) || `sha256:${require('crypto').createHash('sha256').update(data).digest('hex')}`!==String(expectedHash).toLowerCase())
      throw subtitleMeasurementUnavailable('FFprobe subtitle data hash does not match its hex dump');
  }
  return new TextDecoder('utf-8',{fatal:true}).decode(data);
}
function parseSubtitlePacketLine(line) {
  let rawData = null;
  const cleanLine = String(line || '').replace(/(?:^|\|)data=((?:\\n[0-9a-f]{8}:\s+(?:[0-9a-f]{2,4}\s+)+.*?)+\\n)(?=\||$)/i, (_, dump) => {
    rawData = dump.replace(/\\n/g, '\n');
    return '';
  });
  const fields = {};
  for (const entry of cleanLine.split('|')) {
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
  const packet = {
    pts: numberOrNull(fields.pts_time),
    dts: numberOrNull(fields.dts_time),
    duration: numberOrNull(fields.duration_time),
    position: numberOrNull(fields.pos),
    payloadHash: fields.data_hash || ''
  };
  if (rawData) {
    const payload = decodeFfprobeDataHex(rawData,fields.data_hash).replace(/[\r\n\0]+$/, '');
    const firstComma = payload.indexOf(',');
    const readOrder = firstComma >= 0 ? Number(payload.slice(0, firstComma)) : null;
    const cueBody = firstComma >= 0 ? payload.slice(firstComma + 1) : payload;
    const cueHash = 'SHA256:' + require('crypto').createHash('sha256').update(cueBody, 'utf8').digest('hex');
    Object.defineProperty(packet, 'cueHash', {value: cueHash});
    if (Number.isFinite(readOrder)) Object.defineProperty(packet, 'readOrder', {value: readOrder});
  }
  return packet;
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
    '-show_data', '-show_data_hash', 'sha256', '-show_entries',
    'packet=pts_time,dts_time,duration_time,data_hash,pos,data',
    '-of', 'compact=p=0:nk=0', file
  ];
  await runTimelineProcess(ffprobe, argv, line => {
    const packet = parseSubtitlePacketLine(line);
    if (packet) { packets.push(packet); emitProgress(packet); }
  });
  if(typeof onProgress==='function')try{onProgress(1);}catch(_){}
  return packets;
}

function formatAssTimestamp(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds) * 100));
  const cs = centiseconds % 100;
  const totalSeconds = Math.floor(centiseconds / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function reconstructAssSubtitleFile(probed) {
  const stream = probed?.streams?.[0];
  const packets = probed?.packets;
  if (!stream || typeof stream.extradata !== 'string' || !Array.isArray(packets)) {
    throw Error('ASS subtitle stream extradata or packet list is unavailable for normalization');
  }
  const header = decodeFfprobeDataHex(stream.extradata,stream.extradata_hash).replace(/\0+$/, '');
  if (!header.trim()) throw Error('ASS subtitle stream extradata header is empty');
  const events = packets.map((pkt, idx) => {
    const start = Number(pkt?.pts_time);
    const duration = pkt?.duration_time === undefined || pkt?.duration_time === 'N/A' ? 0 : Number(pkt.duration_time);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration < 0) {
      throw Error(`ASS subtitle packet ${idx} has invalid timestamp or duration for normalization`);
    }
    const payload = decodeFfprobeDataHex(pkt?.data,pkt?.data_hash).replace(/[\r\n\0]+$/, '');
    const firstComma = payload.indexOf(',');
    if (firstComma < 0) throw Error(`ASS subtitle packet ${idx} is missing ReadOrder field`);
    const readOrder = Number(payload.slice(0, firstComma));
    const rest = payload.slice(firstComma + 1);
    const secondComma = rest.indexOf(',');
    if (secondComma < 0) throw Error(`ASS subtitle packet ${idx} is missing Layer field`);
    const layer = rest.slice(0, secondComma);
    const afterLayer = rest.slice(secondComma + 1);
    const end = start + duration;
    return {
      readOrder: Number.isFinite(readOrder) ? readOrder : idx,
      idx,
      line: `Dialogue: ${layer},${formatAssTimestamp(start)},${formatAssTimestamp(end)},${afterLayer}`
    };
  });
  events.sort((a, b) => a.readOrder - b.readOrder || a.idx - b.idx);
  const cleanHeader = header.replace(/[\r\n]+$/, '');
  const prefix = /\[Events\]/i.test(cleanHeader)
    ? cleanHeader
    : `${cleanHeader}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
  return `${prefix}\n${events.map(e => e.line).join('\n')}\n`;
}

function validateCopiedSubtitlePackets(sourcePackets, outputPackets, globalShiftSeconds, maxRepairSeconds = 0.5) {
  if (!Array.isArray(sourcePackets) || !Array.isArray(outputPackets)) throw subtitleMeasurementUnavailable('ASS/SSA subtitle packet scan is unavailable');
  if (sourcePackets.length !== outputPackets.length) throw new Error(`ASS/SSA subtitle packet count changed (${sourcePackets.length} source, ${outputPackets.length} output)`);
  if (!Number.isFinite(globalShiftSeconds) || !Number.isFinite(maxRepairSeconds) || maxRepairSeconds < 0) throw subtitleMeasurementUnavailable('Invalid ASS/SSA subtitle timestamp comparison');
  if (sourcePackets.length === 0) return {packetCount:0,adjustedPackets:0,maxAdjustmentSeconds:0};

  let sourceHasBackwardPts = false;
  for (let index = 0; index < sourcePackets.length; index++) {
    const source = sourcePackets[index], output = outputPackets[index];
    if (!Number.isFinite(source.pts)) throw subtitleMeasurementUnavailable(`ASS/SSA source subtitle packet ${index} has missing or invalid PTS`);
    if (!Number.isFinite(output.pts)) throw new Error(`ASS/SSA subtitle packet ${index} has missing or invalid PTS newly in candidate`);
    if (!source.payloadHash || !output.payloadHash) throw subtitleMeasurementUnavailable(`ASS/SSA subtitle packet ${index} is missing its payload hash`);
    if (source.dts !== null && !Number.isFinite(source.dts)) throw subtitleMeasurementUnavailable(`ASS/SSA source subtitle packet ${index} has missing or invalid DTS`);
    if (index > 0 && source.pts < sourcePackets[index - 1].pts) sourceHasBackwardPts = true;
  }

  let effectiveSourcePackets = sourcePackets;
  let reorderedPackets = 0;
  let matchedByCueHash = false;
  const cueKey = pkt => pkt.cueHash || pkt.payloadHash;
  const arrivalHashMismatch = sourcePackets.some((pkt, idx) => pkt.payloadHash !== outputPackets[idx].payloadHash);
  if (sourceHasBackwardPts && arrivalHashMismatch) {
    const buckets = new Map();
    for (let idx = 0; idx < sourcePackets.length; idx++) {
      const pkt = sourcePackets[idx];
      const key = cueKey(pkt);
      let list = buckets.get(key);
      if (!list) { list = []; buckets.set(key, list); }
      list.push({pkt, idx, used: false});
    }
    for (const list of buckets.values()) {
      list.sort((a, b) => (a.pkt.pts - b.pkt.pts) || ((a.pkt.readOrder ?? a.idx) - (b.pkt.readOrder ?? b.idx)) || (a.idx - b.idx));
    }
    const matched = [];
    let allMatched = true;
    for (let outIdx = 0; outIdx < outputPackets.length; outIdx++) {
      const outPkt = outputPackets[outIdx];
      const list = buckets.get(cueKey(outPkt));
      const entry = list && list.find(item => !item.used);
      if (!entry) { allMatched = false; break; }
      entry.used = true;
      matched.push(entry);
    }
    if (allMatched && matched.length === sourcePackets.length) {
      effectiveSourcePackets = matched.map(entry => entry.pkt);
      reorderedPackets = matched.filter((entry, idx) => entry.idx !== idx).length;
      matchedByCueHash = true;
    }
  }

  let previousOutputPts = -Infinity;
  let previousOutputDts = -Infinity;
  let sourceFirst = Infinity, sourceLast = -Infinity;
  let outputFirst = Infinity, outputLast = -Infinity;
  let adjustedPackets = 0, maxAdjustmentSeconds = 0;

  for (let index = 0; index < effectiveSourcePackets.length; index++) {
    const source = effectiveSourcePackets[index], output = outputPackets[index];
    const sourceKey = matchedByCueHash ? cueKey(source) : source.payloadHash;
    const outputKey = matchedByCueHash ? cueKey(output) : output.payloadHash;
    if (sourceKey !== outputKey) throw new Error(`ASS/SSA subtitle packet ${index} payload changed`);
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
  const result = {
    packetCount: effectiveSourcePackets.length,
    adjustedPackets,
    maxAdjustmentSeconds: Math.round(maxAdjustmentSeconds * 1e6) / 1e6
  };
  if (reorderedPackets > 0) result.reorderedPackets = reorderedPackets;
  return result;
}

if (typeof module !== 'undefined') module.exports = {createSubtitleTimingPrecheck,parseSubtitlePacketLine,readSubtitlePackets,reconstructAssSubtitleFile,validateCopiedSubtitlePackets};
