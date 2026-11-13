// Shared HTTPS Discord webhook helper.
// Never log the webhook URL or raw network error objects that may carry credentials.
const webhookHttps = require('https');

function sanitizeWebhookDetail(result) {
  if (result?.reason === 'missing_webhook') return 'TDARR_DISCORD_WEBHOOK is not configured';
  if (result?.reason === 'invalid_url') return 'invalid webhook URL';
  if (result?.reason === 'invalid_protocol') return 'invalid webhook protocol';
  const status = Number(result?.statusCode);
  if (Number.isInteger(status) && status > 0) return `HTTP ${status}`;
  if (typeof result?.code === 'string' && /^[A-Z0-9_]+$/.test(result.code)) return result.code;
  if (result?.timedOut) return 'request timed out';
  return 'request or URL error';
}

function safeWebhookLog(logFn, message) {
  if (typeof logFn !== 'function') return;
  try { logFn(message); } catch (_) {}
}

async function sendDiscordWebhook(webhookUrl, payloadData, options = {}) {
  const tag = typeof options.tag === 'string' && options.tag ? options.tag : 'Discord Notifier';
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 1 ? options.maxRetries : 1;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 10000;
  const maxRetryDelayMs = Number.isFinite(options.maxRetryDelayMs) && options.maxRetryDelayMs >= 0 ? options.maxRetryDelayMs : 10000;
  const maxTotalWaitMs = Number.isFinite(options.maxTotalWaitMs) && options.maxTotalWaitMs >= 0 ? options.maxTotalWaitMs : 30000;
  const retryDelayFn = typeof options.retryDelayMs === 'function' ? options.retryDelayMs : (attempt => attempt * 2000);
  const log = options.log;

  if (typeof webhookUrl !== 'string' || !webhookUrl.trim()) {
    const res = {ok: false, reason: 'missing_webhook', statusCode: 0, code: '', timedOut: false, attempts: 0};
    safeWebhookLog(log, `[${tag}] Delivery failed: TDARR_DISCORD_WEBHOOK is not configured.`);
    return res;
  }

  let target;
  try {
    target = new URL(webhookUrl.trim());
  } catch (_) {
    const res = {ok: false, reason: 'invalid_url', statusCode: 0, code: '', timedOut: false, attempts: 0};
    safeWebhookLog(log, `[${tag}] Delivery failed (${sanitizeWebhookDetail(res)}); check TDARR_DISCORD_WEBHOOK and node connectivity.`);
    return res;
  }

  if (target.protocol !== 'https:') {
    const res = {ok: false, reason: 'invalid_protocol', statusCode: 0, code: '', timedOut: false, attempts: 0};
    safeWebhookLog(log, `[${tag}] Delivery failed (${sanitizeWebhookDetail(res)}); check TDARR_DISCORD_WEBHOOK and node connectivity.`);
    return res;
  }

  const postData = typeof payloadData === 'string' ? payloadData : JSON.stringify(payloadData);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Tdarr-DiscordNotifier/1.0',
    'Content-Length': Buffer.byteLength(postData)
  };
  let remainingWaitMs = maxTotalWaitMs;
  let lastResult = {ok: false, reason: 'request_error', statusCode: 0, code: '', timedOut: false, attempts: 0};

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const attemptResult = await new Promise(resolve => {
      let settled = false;
      let timer;
      const done = result => {
        if (settled) return;
        settled = true;
        if (typeof clearTimeout === 'function' && timer !== undefined) clearTimeout(timer);
        resolve(result);
      };

      let request;
      try {
        request = webhookHttps.request(target, {method: 'POST', headers}, response => {
          let rawBody = '';
          response.on('data', chunk => {
            if (rawBody.length < 4096) rawBody += String(chunk).slice(0, 4096 - rawBody.length);
          });
          response.on('error', err => {
            const code = typeof err?.code === 'string' && /^[A-Z0-9_]+$/.test(err.code) ? err.code : '';
            done({ok: false, retry: true, statusCode: 0, code, timedOut: false, reason: 'response_error'});
          });
          response.on('end', () => {
            const status = Number(response.statusCode) || 0;
            if (status >= 200 && status < 300) {
              done({ok: true, retry: false, statusCode: status, code: '', timedOut: false, reason: ''});
              return;
            }
            if (status === 429) {
              let retryAfter = 2000;
              try {
                const parsed = JSON.parse(rawBody);
                const rawRetry = Number(parsed?.retry_after);
                if (Number.isFinite(rawRetry) && rawRetry > 0) retryAfter = Math.ceil(rawRetry * 1000);
              } catch (_) {}
              done({ok: false, retry: true, delayMs: retryAfter, statusCode: 429, code: '', timedOut: false, reason: 'rate_limited'});
              return;
            }
            if (status >= 500) {
              done({ok: false, retry: true, statusCode: status, code: '', timedOut: false, reason: 'server_error'});
              return;
            }
            done({ok: false, retry: false, statusCode: status, code: '', timedOut: false, reason: 'rejected'});
          });
        });

        request.on('error', err => {
          const code = typeof err?.code === 'string' && /^[A-Z0-9_]+$/.test(err.code) ? err.code : '';
          done({ok: false, retry: true, statusCode: 0, code, timedOut: false, reason: 'network_error'});
        });

        if (typeof setTimeout === 'function') {
          timer = setTimeout(() => {
            try { request.destroy(); } catch (_) {}
            done({ok: false, retry: true, statusCode: 0, code: '', timedOut: true, reason: 'timeout'});
          }, timeoutMs);
        }

        if (typeof request.setTimeout === 'function') {
          request.setTimeout(timeoutMs, () => {
            try { request.destroy(); } catch (_) {}
            done({ok: false, retry: true, statusCode: 0, code: '', timedOut: true, reason: 'timeout'});
          });
        }

        if (typeof request.write === 'function') {
          request.write(postData);
          request.end();
        } else {
          request.end(postData);
        }
      } catch (err) {
        const code = typeof err?.code === 'string' && /^[A-Z0-9_]+$/.test(err.code) ? err.code : '';
        done({ok: false, retry: false, statusCode: 0, code, timedOut: false, reason: 'request_error'});
      }
    });

    lastResult = {
      ok: attemptResult.ok,
      statusCode: attemptResult.statusCode,
      code: attemptResult.code,
      timedOut: attemptResult.timedOut,
      reason: attemptResult.reason,
      attempts: attempt
    };

    if (attemptResult.ok) {
      safeWebhookLog(log, attempt === 1
        ? `[${tag}] Sent.`
        : `[${tag}] Sent on attempt ${attempt} (HTTP ${attemptResult.statusCode}).`);
      return lastResult;
    }

    if (!attemptResult.retry || attempt >= maxRetries || remainingWaitMs <= 0) {
      break;
    }

    const requestedDelay = Number.isFinite(attemptResult.delayMs)
      ? attemptResult.delayMs
      : Number(retryDelayFn(attempt, attemptResult.statusCode));
    const boundedDelay = Math.min(maxRetryDelayMs, remainingWaitMs, Math.max(1, Number.isFinite(requestedDelay) ? requestedDelay : 2000));
    remainingWaitMs -= boundedDelay;

    safeWebhookLog(log, `[${tag}] Delivery attempt ${attempt}/${maxRetries} failed (${sanitizeWebhookDetail(lastResult)}); retrying in ${boundedDelay}ms.`);
    await new Promise(resolve => {
      if (typeof setTimeout === 'function') setTimeout(resolve, boundedDelay);
      else resolve();
    });
  }

  safeWebhookLog(log, `[${tag}] Delivery failed (${sanitizeWebhookDetail(lastResult)}); check TDARR_DISCORD_WEBHOOK and node connectivity.`);
  return lastResult;
}

if (typeof module !== 'undefined') module.exports = {sendDiscordWebhook, sanitizeWebhookDetail};

