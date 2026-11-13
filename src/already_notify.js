// The webhook comes from the Tdarr node environment; never embed credentials in flow code.
module.exports = async (args) => {
  if (!args.variables) args.variables = {};
  if (!args.variables.user) args.variables.user = {};
  const log = message => { try { if (typeof args.jobLog === 'function') args.jobLog(message); } catch (_) {} };
  try {
    const {sendDiscordWebhook: sendWebhook} = typeof sendDiscordWebhook === 'function'
      ? {sendDiscordWebhook}
      : require('./discord_webhook');
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
    const delivery = await sendWebhook(process.env.TDARR_DISCORD_WEBHOOK, body, {
      tag: 'Already processed notification',
      maxRetries: 1,
      timeoutMs: 10000,
      log
    });
    if (!delivery.ok) {
      log('[Already processed notification] Delivery failed; see notification configuration and connectivity.');
    }
  } catch (_) {
    log('[Already processed notification] Delivery failed; see notification configuration and connectivity.');
  }
  return {outputFileObj:args.inputFileObj,outputNumber:1,variables:args.variables};
};
