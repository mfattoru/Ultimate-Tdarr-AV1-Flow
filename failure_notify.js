const humanizeFailure = reason => {
  const text = String(reason || '').trim().replace(/^(?:\[Safety check failed\]\s*){2,}/i, '[Safety check failed] ');
  const details = text.replace(/```/g, "'").replace(/\s+/g, ' ').trim().slice(0, 1100);
  const retained = /original (?:will not be replaced|retained)|original retained/i.test(text);
  const knownVideoDamage = /\[video guard\].*ffprobe (?:exited 0 but emitted stderr|failed \([^)]*\))/i.test(text)
    && /invalid nal unit(?: size| type)?|error splitting the input into nal units|missing picture in access unit|corrupt decoded frame|error while decoding|invalid data found when processing input|invalid bitstream|corrupt packet|packet corrupt|invalid obu|error parsing obu|invalid frame marker|invalid sync code|could not find ref with poc|concealing \d+.*(?:dc|ac|mv) errors|premature end of file|truncated (?:packet|frame)|unexpected end of file/i.test(text);
  const verifiedSourceDamage = /\[source media corruption\]/i.test(text);
  if (knownVideoDamage || verifiedSourceDamage) {
    const h264Nal = /\[h264(?:\s|@|\])/i.test(text) && /invalid nal unit|error splitting the input into nal units|missing picture in access unit/i.test(text);
    const audioDamage = /audio source stream/i.test(text);
    return {
      category: 'source_media_corruption', severity: 'error',
      summary: h264Nal
        ? 'FFmpeg found malformed H.264 NAL units while scanning the source video. This points to damaged source bitstream or container data, before the AV1 encode starts.'
        : audioDamage
          ? 'A retained source audio track failed a full decode check, confirming source corruption before replacement.'
          : 'FFmpeg found a recognized video bitstream error in the source scan or confirmed source damage during strict decoding.',
      fileState: 'The flow stopped and kept the original file.',
      action: 'Check playback and seeking if needed. The flow requests a targeted Sonarr episode or Radarr movie search after matching the exact media item. The original stays in place; Arr profile and upgrade rules may still reject same-quality replacements.',
      details
    };
  }
  if (/\[video guard\].*additional video stream/i.test(text)) {
    const hasDecodedFrames=/decoded at least one frame/i.test(text);
    return {
      category: 'multiple_video_streams', severity: 'warning',
      summary: hasDecodedFrames
        ? 'The file has an additional video track with decoded frames, so the flow cannot safely select or discard it.'
        : 'The file has an additional video track that could not be safely classified.',
      fileState: 'The original file was kept; no encode or Arr search was performed.',
      action: 'Review the video tracks and confirm which one is intended. This layout check alone does not establish source corruption and does not trigger an Arr search.',
      details
    };
  }
  const audioDtsRepair = text.match(/\[audio guard\].*source audio stream\s+0:(\d+).*needs up to\s+([\d.]+)\s+ms of DTS correction, above the\s+([\d.]+)\s+ms repair limit/i);
  if (audioDtsRepair) {
    const stream=Number(audioDtsRepair[1]),neededMs=Number(audioDtsRepair[2]),limitMs=Number(audioDtsRepair[3]);
    const wholeSeconds=Math.max(0,Math.round(neededMs/1000)),minutes=Math.floor(wholeSeconds/60),seconds=wholeSeconds%60;
    const duration=minutes?`${minutes} min ${seconds} sec`:`${seconds} sec`;
    return {
      category: 'audio_timestamp_limit', severity: 'warning',
      summary: `Audio packet timestamps on retained stream 0:${stream} are out of order. The bounded repair would shift them by up to ${duration} (${neededMs.toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1})} ms), above the ${limitMs.toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1})} ms safety limit.`,
      fileState: 'The original was kept; AV1 encoding did not start.',
      action: 'This check reads packet timing rather than decoding audio samples; it does not confirm audio corruption. The flow did not request an Arr search. Review the audio timeline and playback before considering a replacement.',
      details
    };
  }
  if (/\[audio guard\].*audio source stream/i.test(text)) {
    return {
      category: 'audio_source_check', severity: 'warning',
      summary: 'Tdarr could not complete a clean full-file decode of a retained source audio track.',
      fileState: 'The original was kept; no candidate replaced it.',
      action: 'Review the audio stream and diagnostic detail. The error did not match a confirmed corruption signature, so the flow did not request an Arr search.',
      details
    };
  }
  const subtitle = text.match(/output subtitle packet count\s+(\d+)\s+is less than source\s+(\d+)\s+for stream\s+(\d+)/i);
  if (subtitle) {
    const outputCount = Number(subtitle[1]), sourceCount = Number(subtitle[2]), stream = Number(subtitle[3]);
    const missing = Math.max(0, sourceCount - outputCount);
    return {
      category: 'subtitle_output_loss', severity: 'warning',
      summary: `The new output has ${missing} fewer subtitle packet${missing === 1 ? '' : 's'} on stream ${stream} (${sourceCount.toLocaleString('en-US')} source → ${outputCount.toLocaleString('en-US')} output).`,
      fileState: 'Tdarr rejected the candidate and kept the original.',
      action: 'Inspect the affected subtitle track and nearby cues. This count mismatch alone does not show source corruption; do not delete or request an Arr replacement based on this check alone.',
      details
    };
  }
  if (/\[video guard\].*ffprobe exited 0 but emitted stderr/i.test(text)) {
    return {
      category: 'source_scan_warning', severity: 'warning',
      summary: 'The source video scan logged decoding warnings, so the flow stopped before encoding.',
      fileState: 'The original file was kept.',
      action: 'Review the diagnostic detail and test the same part in a player. Request an Arr replacement only if the source problem is independently reproducible.',
      details
    };
  }
  if (/\[safety check failed\].*(?:video presentation timestamp|video frame count differs)/i.test(text)) {
    return {
      category: 'output_timing', severity: 'warning',
      summary: 'Tdarr could not confirm that every output video frame has usable timing matching the source.',
      fileState: 'The encode candidate was discarded and the original was kept.',
      action: 'Review the source/output frame and timestamp counts below. This check alone does not prove source corruption and does not request an Arr replacement.',
      details
    };
  }
  if (/non[\s-]+monotonically increasing dts/i.test(text)) {
    return {
      category: 'output_timing', severity: 'warning',
      summary: 'FFmpeg reported repeated or out-of-order decode timestamps while checking the generated video.',
      fileState: retained ? 'The candidate was discarded and the original was kept.' : 'Check the Tdarr job record to confirm the file state.',
      action: 'This points to a timestamp or muxing problem in the candidate; it does not by itself prove the source bitstream is damaged. The flow keeps the original and requests an Arr search only when a recognized source corruption is confirmed. Review the source decode details and Tdarr log.',
      details
    };
  }
  if (/subtitle encoding failed|error encoding a frame: buffer too small|buffer too small/i.test(text)) {
    return {
      category: 'subtitle_encoding', severity: 'warning',
      summary: 'FFmpeg could not encode a subtitle event. Large ASS/SSA drawings can exceed the SRT encoder buffer.',
      fileState: retained ? 'The flow stopped and kept the original file.' : 'Check the Tdarr job record to confirm the file state.',
      action: 'Keep styled ASS/SSA tracks as ASS/SSA in MKV. If this is a non-MKV source, inspect the subtitle track and container conversion path before retrying.',
      details
    };
  }
  if (/\[hdr guard\].*(?:ambiguous|conflict|unsupported|unverified|missing|unknown)/i.test(text)) {
    return {
      category: 'hdr_signaling', severity: 'warning',
      summary: 'The source color or HDR signaling is incomplete, conflicting, or outside the verified conversion paths.',
      fileState: retained ? 'The original was kept without changing its HDR metadata.' : 'Check the Tdarr job record to confirm the file state.',
      action: 'Inspect the source tags and playback. Do not relabel or replace it based on this alert alone; update the flow only after a verified conversion path is available.',
      details
    };
  }
  if (/\[cache reservation\]|insufficient available (?:system ram|capacity)|file-size limit/i.test(text)) {
    return {
      category: 'scratch_capacity', severity: 'warning',
      summary: 'The cache could not reserve enough safe space to finish this file.',
      fileState: retained ? 'The partial candidate was removed and the original was kept.' : 'Check the Tdarr job record to confirm the file state.',
      action: 'Check free space on the RAM or disk cache and the configured safety floors. Retry after space is available; the flow did not replace the source.',
      details
    };
  }
  if (/\[safety check failed\]/i.test(text)) {
    return {
      category: 'output_validation', severity: 'warning',
      summary: 'The newly generated output did not pass the flow’s stream, timing, or decode checks.',
      fileState: retained ? 'The candidate was discarded and the original was kept.' : 'Check the Tdarr job record to confirm the file state.',
      action: 'Use the diagnostic detail to identify the failed check. A failed output check alone does not prove the source file is damaged.',
      details
    };
  }
  if (/quality.floor|no smaller output/i.test(text)) {
    return {
      category: 'quality_floor', severity: 'warning',
      summary: 'The AV1 attempt did not produce a smaller valid file at the configured quality floor.',
      fileState: retained ? 'The original was kept.' : 'Check the Tdarr job record to confirm the file state.',
      action: 'No smaller encode was available under the current quality policy; review the size decision before retrying.',
      details
    };
  }
  return {
    category: 'processing_failure', severity: 'error',
    summary: 'The flow could not safely complete this file.',
    fileState: retained ? 'The original was kept.' : 'Check the Tdarr job record to confirm the file state.',
    action: 'Review the technical detail and Tdarr job log before retrying or replacing the source.',
    details
  };
};

// The webhook comes from the Tdarr node environment; never embed credentials in flow code.
module.exports = async (args) => {
  if (!args.variables) args.variables = {};
  if (!args.variables.user) args.variables.user = {};
  const user = args.variables.user;
  const reason = typeof user.failure_reason === 'string' && user.failure_reason.trim()
    ? user.failure_reason.trim() : 'The flow failed; inspect the Tdarr job log for details.';
  const isoRemoved = /disc image removed/i.test(reason);
  const result = {outputFileObj: args.inputFileObj, outputNumber: isoRemoved ? 2 : 1, variables: args.variables};
  if (user.failure_notified === true) return result;
  const log = message => { try { if (typeof args.jobLog === 'function') args.jobLog(message); } catch (_) {} };
  try {
    const https = require('https');
    const webhookUrl = process.env.TDARR_DISCORD_WEBHOOK;
    if (!webhookUrl) {
      log('[Failure notification] Delivery failed: TDARR_DISCORD_WEBHOOK is not configured.');
      return result;
    }
    const target = new URL(webhookUrl);
    if (target.protocol !== 'https:') throw new Error('Invalid webhook protocol');
    const file = args.originalLibraryFile?._id || args.inputFileObj?._id;
    const name = typeof file === 'string' ? file.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '').slice(0, 220) : 'Unknown file';
  const explanation = humanizeFailure(reason);
  const qualityFloor = explanation.category === 'quality_floor';
    const arrStatus = String(user.arr_refetch_status || 'unknown');
    const corruptionSearchStatus = String(user.arr_corruption_search_status || 'unknown');
    const corruptionSearchTarget = String(user.arr_corruption_search_target || 'Arr');
  const icon = isoRemoved || explanation.severity === 'warning' ? '⚠️' : '❌';
    const description = [];
    if (isoRemoved) {
      description.push('⚠️ **Action:** The ISO disc image was deleted from the library.');
      if (arrStatus === 'requested') description.push('📡 **Arr:** A rescan request was accepted so Arr can locate and refetch a non-ISO release when a match is available.');
      else if (arrStatus === 'failed') description.push('📡 **Arr:** The rescan request failed; check the Arr logs and search for a replacement manually if needed.');
      else if (arrStatus === 'not_found') description.push('📡 **Arr:** The series or movie could not be identified, so no rescan request was sent.');
      else if (arrStatus === 'skipped') description.push('📡 **Arr:** This path did not match a configured library, so no rescan request was sent.');
      else description.push('📡 **Arr:** No accepted rescan request was recorded; check the Arr logs.');
    } else {
      description.push(`**What happened:** ${explanation.summary}`);
      description.push(`**File state:** ${explanation.fileState}`);
      description.push(`**What to do:** ${explanation.action}`);
      if (explanation.category === 'source_media_corruption') {
        if (corruptionSearchStatus === 'requested') description.push(`📡 **Arr:** ${corruptionSearchTarget} accepted a targeted search. The original remains in place; a replacement is not guaranteed unless an available release meets your profile and upgrade rules.`);
        else if (corruptionSearchStatus === 'failed') description.push('📡 **Arr:** The targeted search could not be submitted. Check the Arr connection/log and search manually if needed. The original remains in place.');
        else if (corruptionSearchStatus === 'not_found') description.push('📡 **Arr:** The matching series/movie could not be resolved, so no search was submitted. The original remains in place; search manually if needed.');
        else if (corruptionSearchStatus === 'file_unmatched') description.push('📡 **Arr:** The series/movie matched, but the exact file could not be mapped. No search was submitted; the original remains in place.');
        else if (corruptionSearchStatus === 'skipped_path') description.push('📡 **Arr:** The file path did not match a configured Sonarr/Radarr library. No search or file change was made.');
        else description.push('📡 **Arr:** No targeted search was recorded. The original remains in place; check the Tdarr job log and search manually if needed.');
      }
      if (explanation.details) description.push(`🧾 **Diagnostic detail:**\n\`\`\`\n${explanation.details}\n\`\`\``);
    }
    const sizeMB = Number(user.original_size_mb || args.originalLibraryFile?.file_size);
    if (Number.isFinite(sizeMB) && sizeMB > 0) {
      const formatted=sizeMB>=1024 ? `${(sizeMB/1024).toFixed(2)} GB` : `${sizeMB.toFixed(1)} MB`;
      description.push(`📁 **Original size:** \`${formatted}\``);
    }
    const start=Number(user.workflow_start_epoch),elapsed=Date.now()-start;
    if (Number.isFinite(start) && start>0 && elapsed>=0 && elapsed<365*24*60*60*1000) {
      const sec=Math.max(1,Math.round(elapsed/1000)),h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
      const duration=h?`${h}h ${m}m ${s}s`:m?`${m}m ${s}s`:`${s}s`;
      description.push(`⏱️ **Duration:** ${duration}`);
    }
    const body = JSON.stringify({embeds:[{
      title:`${icon} ${name}`,
      description:description.join('\n'),
      color:isoRemoved||explanation.severity==='warning' ? 15105570 : 15158332,
      footer:{text:isoRemoved ? (arrStatus === 'requested' ? 'Tdarr AV1 Flow • ISO deleted • Arr rescan requested' : 'Tdarr AV1 Flow • ISO deleted • Arr rescan needs attention') : qualityFloor ? 'Tdarr AV1 Flow • Quality floor reached' : `Tdarr AV1 Flow • ${explanation.category.replace(/_/g,' ')}`},
      timestamp:new Date().toISOString()
    }], allowed_mentions:{parse:[]}});
    const status = await new Promise((resolve, reject) => {
      let timer;
      const finish = (err, statusCode) => {
        clearTimeout(timer);
        if (err) reject(err); else resolve(statusCode);
      };
      try {
        const request = https.request(target, {method: 'POST', headers: {'Content-Type': 'application/json'}}, response => {
          response.on('error', err => finish(err));
          response.on('end', () => finish(null, response.statusCode));
          response.resume();
        });
        request.on('error', err => finish(err));
        timer = setTimeout(() => {
          request.destroy();
          finish(new Error('Notification timed out'));
        }, 10000);
        request.setTimeout(10000, () => request.destroy(new Error('Notification timed out')));
        request.end(body);
      } catch (err) { finish(err); }
    });
    if (!(status >= 200 && status < 300)) {
      const error = new Error('Notification rejected');
      error.statusCode = status;
      throw error;
    }
    user.failure_notified = true;
    log('[Failure notification] Sent.');
  } catch (err) {
    // Avoid logging the webhook or network exception, which can contain credentials.
    const status=Number(err?.statusCode);
    const code=typeof err?.code === 'string' && /^[A-Z0-9_]+$/.test(err.code) ? err.code : '';
    const detail=Number.isInteger(status) ? `HTTP ${status}` : code || (err?.message === 'Notification timed out' ? 'request timed out' : 'request or URL error');
    log(`[Failure notification] Delivery failed (${detail}); check TDARR_DISCORD_WEBHOOK and node connectivity.`);
  }
  return result;
};
