// The webhook comes from the Tdarr node environment; never embed credentials in flow code.
module.exports = async (args) => {
  if (!args.variables) args.variables = {};
  if (!args.variables.user) args.variables.user = {};
  const log = message => { try { if (typeof args.jobLog === 'function') args.jobLog(message); } catch (_) {} };
  try {
    const https = require('https');
    const webhookUrl = process.env.TDARR_DISCORD_WEBHOOK;
    if (!webhookUrl) throw new Error('TDARR_DISCORD_WEBHOOK is not configured');
    const target = new URL(webhookUrl);
    if (target.protocol !== 'https:') throw new Error('Invalid webhook protocol');
    const file = args.originalLibraryFile?._id || args.inputFileObj?._id;
    const name = typeof file === 'string' ? file.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '').slice(0, 220) : 'Unknown file';
    const tags = args.inputFileObj?.ffProbeData?.format?.tags || {};
    const markerKey = Object.keys(tags).find(k => k.toLowerCase() === 'encoded_by');
    const marker = markerKey ? String(tags[markerKey]) : 'completion marker';
    const body = JSON.stringify({
      embeds: [{
        title: `ℹ️ ${name}`,
        description: `This file was already processed by the Tdarr AV1 flow (${marker}). No new encode ran on this pass.`,
        color: 3447003,
        footer: {text: 'Tdarr AV1 Flow • Already processed'},
        timestamp: new Date().toISOString()
      }],
      allowed_mentions: {parse: []}
    });
    await new Promise((resolve, reject) => {
      let timer;
      const finish = (err, code) => { clearTimeout(timer); if (err) reject(err); else resolve(code); };
      const request = https.request(target, {method:'POST',headers:{'Content-Type':'application/json'}}, response => {
        response.on('error', err => finish(err));
        response.on('end', () => response.statusCode >= 200 && response.statusCode < 300 ? finish(null, response.statusCode) : finish(new Error('Notification rejected')));
        response.resume();
      });
      request.on('error', err => finish(err));
      timer = setTimeout(() => { request.destroy(); finish(new Error('Notification timed out')); }, 10000);
      request.setTimeout(10000, () => request.destroy(new Error('Notification timed out')));
      request.end(body);
    });
    log('[Already processed notification] Sent.');
  } catch (_) {
    log('[Already processed notification] Delivery failed; see notification configuration and connectivity.');
  }
  return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
};
