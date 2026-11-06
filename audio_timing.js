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
  let lastRatio=0;
  await runProcess(ffprobe, ['-v','error','-select_streams',String(streamIndex),'-show_packets','-show_entries','packet=pts_time,dts_time,pos','-of','compact=p=0:nk=0',file], line => {
    const dts = parseAudioDtsLine(line);
    if (dts !== null || /(?:^|\|)dts_time=/.test(String(line || ''))) analyzer.push(dts);
    if (typeof onProgress==='function' && Number(fileSizeHint)>0) {
      const match=String(line || '').match(/(?:^|\|)pos=([^|]+)/);
      const position=match && match[1]!=='N/A'?Number(match[1]):NaN;
      if (Number.isFinite(position) && position>=0) {
        lastRatio=Math.max(lastRatio,Math.max(0,Math.min(1,position/Number(fileSizeHint))));
        try { onProgress(lastRatio); } catch (_) {}
      }
    }
  });
  if (typeof onProgress==='function' && lastRatio<1) try { onProgress(1); } catch (_) {}
  const result=analyzer.finish();
  return tickSeconds ? {...result,timeBaseKnown:true} : {...result,timeBaseKnown:false,withinLimit:false,repairable:false};
};

if (typeof module !== 'undefined') Object.assign(module.exports, {
  MAX_AUDIO_TIMESTAMP_REPAIR_SECONDS,
  timeBaseToSeconds,
  createAudioDtsAnalyzer,
  analyzeAudioDtsTimeline,
  parseAudioDtsLine,
  audioTimestampRepairBsf,
  scanAudioDtsPackets
});
