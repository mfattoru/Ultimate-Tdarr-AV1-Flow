const MAX_AUDIO_TIMESTAMP_REPAIR_SECONDS = 0.1;

const timeBaseToSeconds = value => {
  const match = String(value || '').trim().match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  const numerator = Number(match[1]), denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) return null;
  return numerator / denominator;
};

const createAudioDtsAnalyzer = tickSeconds => {
  if (!Number.isFinite(tickSeconds) || tickSeconds <= 0) throw new Error('Audio DTS time base is invalid');
  let packetCount = 0, missingDts = 0, backwardSteps = 0, nonIncreasingSteps = 0, adjustedPackets = 0;
  let maxBackwardStepSeconds = 0, maxRepairSeconds = 0;
  let previousRawDts = null, previousOutputDts = null;
  return {
    push(value) {
      packetCount++;
      const timestamp = value === null || value === undefined || value === '' ? NaN : Number(value);
      if (!Number.isFinite(timestamp)) {
        missingDts++;
        previousRawDts = null;
        previousOutputDts = null;
        return;
      }
      const dts = Math.round(timestamp / tickSeconds);
      if (previousRawDts !== null && dts < previousRawDts) {
        backwardSteps++;
        maxBackwardStepSeconds = Math.max(maxBackwardStepSeconds, (previousRawDts - dts) * tickSeconds);
      }
      if (previousRawDts !== null && dts <= previousRawDts) nonIncreasingSteps++;
      // Simulate strict repair for tracks with a true regression. A tie-only
      // stream may have a coarse time base (e.g. TrueHD in Matroska at 1 ms)
      // and is passed through unchanged.
      const outputDts = previousOutputDts === null ? dts : Math.max(dts, previousOutputDts + 1);
      const repairTicks = Math.max(0, outputDts - dts);
      if (repairTicks > 0) adjustedPackets++;
      maxRepairSeconds = Math.max(maxRepairSeconds, repairTicks * tickSeconds);
      previousRawDts = dts;
      previousOutputDts = outputDts;
    },
    finish() {
      const requiresRepair = backwardSteps > 0;
      const reportedAdjustedPackets = requiresRepair ? adjustedPackets : 0;
      const reportedMaxRepairSeconds = requiresRepair ? maxRepairSeconds : 0;
      return {
        packetCount,
        missingDts,
        backwardSteps,
        nonIncreasingSteps,
        adjustedPackets: reportedAdjustedPackets,
        maxBackwardStepSeconds,
        maxRepairSeconds: reportedMaxRepairSeconds,
        withinLimit: reportedMaxRepairSeconds <= MAX_AUDIO_TIMESTAMP_REPAIR_SECONDS,
        repairable: missingDts === 0
      };
    }
  };
};

const analyzeAudioDtsTimeline = (values, tickSeconds) => {
  const analyzer = createAudioDtsAnalyzer(tickSeconds);
  for (const value of values || []) analyzer.push(value);
  return analyzer.finish();
};

const parseAudioDtsLine = line => {
  const text = String(line || '');
  if (!/(?:^|\|)(?:pts_time|dts_time)=/.test(text)) return null;
  const match = text.match(/(?:^|\|)dts_time=([^|]*)/);
  return match ? (match[1].trim() === 'N/A' ? null : match[1].trim()) : null;
};

const audioTimestampRepairBsf = () =>
  'setts=pts=if(eq(PTS\\,NOPTS)\\,NOPTS\\,PTS+if(eq(PREV_OUTDTS\\,NOPTS)\\,0\\,max(0\\,PREV_OUTDTS+1-DTS))):dts=if(eq(DTS\\,NOPTS)\\,NOPTS\\,if(eq(PREV_OUTDTS\\,NOPTS)\\,DTS\\,max(DTS\\,PREV_OUTDTS+1)))';

const scanAudioDtsPackets = async (ffprobe, file, streamIndex, timeBase, runProcess, onProgress, fileSizeHint=0) => {
  const tickSeconds = timeBaseToSeconds(timeBase);
  // A coarse fallback can still identify an order regression. It must never
  // authorize a repair because the packet's exact mux tick is unknown.
  const analyzer = createAudioDtsAnalyzer(tickSeconds || 0.000001);
  let lastRatio=0, lastReportedRatio=-1, lastReportAt=0;
  await runProcess(ffprobe, ['-v','error','-select_streams',String(streamIndex),'-show_packets','-show_entries','packet=pts_time,dts_time,pos','-of','compact=p=0:nk=0',file], line => {
    const dts = parseAudioDtsLine(line);
    if (dts !== null || /(?:^|\|)dts_time=/.test(String(line || ''))) analyzer.push(dts);
    if (typeof onProgress==='function' && Number(fileSizeHint)>0) {
      const match=String(line || '').match(/(?:^|\|)pos=([^|]+)/);
      const position=match && match[1]!=='N/A'?Number(match[1]):NaN;
      if (Number.isFinite(position) && position>=0) {
        lastRatio=Math.max(lastRatio,Math.max(0,Math.min(1,position/Number(fileSizeHint))));
        const now=Date.now();
        if (lastRatio-lastReportedRatio>=0.0005 || now-lastReportAt>=500) {
          lastReportedRatio=lastRatio;
          lastReportAt=now;
          try { onProgress(lastRatio); } catch (_) {}
        }
      }
    }
  });
  if (typeof onProgress==='function' && lastRatio<1) try { onProgress(1); } catch (_) {}
  const result=analyzer.finish();
  return tickSeconds ? {...result,timeBaseKnown:true} : {...result,timeBaseKnown:false,withinLimit:false,repairable:false};
};

/** Scan DTS order across one or more retained audio streams in a single container pass. */
const scanAudioDtsPacketsBatch = async (ffprobe, file, streams, runProcess, onProgress, fileSizeHint=0) => {
  if (!Array.isArray(streams) || streams.length === 0) return new Map();
  const entries = new Map();
  for (const stream of streams) {
    const idx = Number(stream?.index);
    if (!Number.isSafeInteger(idx) || idx < 0) throw new Error('Audio DTS stream index is invalid');
    const tickSeconds = timeBaseToSeconds(stream?.timeBase);
    entries.set(idx, {
      index: idx,
      tickSeconds,
      analyzer: createAudioDtsAnalyzer(tickSeconds || 0.000001)
    });
  }
  const readCompactField = (text, key) => {
    const token = `${key}=`;
    let pos = 0;
    while (true) {
      const found = text.indexOf(token, pos);
      if (found < 0) return undefined;
      if (found === 0 || text.charCodeAt(found - 1) === 124) {
        const valStart = found + token.length;
        const bar = text.indexOf('|', valStart);
        return bar < 0 ? text.slice(valStart) : text.slice(valStart, bar);
      }
      pos = found + 1;
    }
  };
  const singleStream = streams.length === 1 ? entries.values().next().value : null;
  const argv = singleStream
    ? ['-v','error','-select_streams',String(singleStream.index),'-show_packets','-show_entries','packet=pts_time,dts_time,pos','-of','compact=p=0:nk=0',file]
    : ['-v','error','-select_streams','a','-show_packets','-show_entries','packet=stream_index,dts_time,pos','-of','compact=p=0:nk=0',file];
  let lastRatio=0, lastReportedRatio=-1, lastReportAt=0;
  const fileSize = Number(fileSizeHint) > 0 ? Number(fileSizeHint) : 0;
  await runProcess(ffprobe, argv, line => {
    const text = String(line || '');
    let targetEntry = singleStream;
    if (!targetEntry) {
      const rawIdx = readCompactField(text, 'stream_index');
      if (rawIdx !== undefined && rawIdx.trim() !== '') {
        const idx = Number(rawIdx);
        if (Number.isSafeInteger(idx)) targetEntry = entries.get(idx);
      }
    }
    if (targetEntry) {
      const dtsRaw = readCompactField(text, 'dts_time');
      if (dtsRaw !== undefined) {
        const trimmed = dtsRaw.trim();
        targetEntry.analyzer.push(trimmed === '' || trimmed === 'N/A' ? null : trimmed);
      }
    }
    if (typeof onProgress === 'function' && fileSize > 0) {
      const posRaw = readCompactField(text, 'pos');
      if (posRaw !== undefined && posRaw !== 'N/A') {
        const position = Number(posRaw);
        if (Number.isFinite(position) && position >= 0) {
          lastRatio = Math.max(lastRatio, Math.min(1, position / fileSize));
          const now = Date.now();
          if (lastRatio - lastReportedRatio >= 0.0005 || now - lastReportAt >= 500) {
            lastReportedRatio = lastRatio;
            lastReportAt = now;
            try { onProgress(lastRatio); } catch (_) {}
          }
        }
      }
    }
  });
  if (typeof onProgress === 'function' && lastRatio < 1) try { onProgress(1); } catch (_) {}
  const results = new Map();
  for (const [idx, entry] of entries) {
    const result = entry.analyzer.finish();
    results.set(idx, entry.tickSeconds ? {...result, timeBaseKnown:true} : {...result, timeBaseKnown:false, withinLimit:false, repairable:false});
  }
  return results;
};

if (typeof module !== 'undefined') Object.assign(module.exports, {
  MAX_AUDIO_TIMESTAMP_REPAIR_SECONDS,
  timeBaseToSeconds,
  createAudioDtsAnalyzer,
  analyzeAudioDtsTimeline,
  parseAudioDtsLine,
  audioTimestampRepairBsf,
  scanAudioDtsPackets,
  scanAudioDtsPacketsBatch
});
