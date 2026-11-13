// The build substitutes this expression with the inherited webhook as a JSON string.
module.exports = async (args) => {
  if (!args.variables) args.variables = {};
  if (!args.variables.user) args.variables.user = {};
  const user = args.variables.user;
  const result = {outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables};
  if (user.failure_notified === true) return result;
  const log = message => { try { if (typeof args.jobLog === 'function') args.jobLog(message); } catch (_) {} };
  try {
    const https = require('https');
    const configuredWebhook = __TDARR_DISCORD_WEBHOOK__;
    const target = new URL(process.env.TDARR_DISCORD_WEBHOOK || configuredWebhook);
    if (target.protocol !== 'https:') throw new Error('Invalid webhook protocol');
    const reason = typeof user.failure_reason === 'string' && user.failure_reason.trim()
      ? user.failure_reason.trim() : 'The flow failed; inspect the Tdarr job log for details.';
    const file = args.originalLibraryFile?._id || args.inputFileObj?._id;
    const name = typeof file === 'string' ? file.split(/[\\/]/).pop().slice(0, 200) : '';
    const body = JSON.stringify({content: `❌ Tdarr flow failed${name ? ` (${name})` : ''}: ${reason}`.slice(0, 1900), allowed_mentions: {parse: []}});
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
    if (!(status >= 200 && status < 300)) throw new Error('Notification rejected');
    user.failure_notified = true;
    log('[Failure notification] Sent.');
  } catch (_) {
    // Avoid logging the webhook or network exception, which can contain credentials.
    log('[Failure notification] Delivery failed; see notification configuration and connectivity.');
  }
  return result;
};
