'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const {EventEmitter} = require('node:events');
const {sendDiscordWebhook} = require('../src/discord_webhook');

test('sendDiscordWebhook delivers HTTPS JSON payload and preserves explicit port', async t => {
  const calls = [];
  t.mock.method(https, 'request', (target, options, callback) => {
    const req = new EventEmitter();
    let body = '';
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = chunk => { body += chunk; };
    req.end = chunk => {
      if (chunk) body += chunk;
      calls.push({target: String(target), port: target.port, options, body: JSON.parse(body)});
      const res = new EventEmitter();
      res.statusCode = 204;
      res.resume = () => {};
      callback(res);
      res.emit('end');
    };
    return req;
  });

  const logs = [];
  const result = await sendDiscordWebhook('https://discord.invalid:8443/api/webhooks/secret-id/secret-token', {embeds: [{title: 'ok'}]}, {
    tag: 'Test Notifier',
    log: msg => logs.push(msg)
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 204);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].port, '8443');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].body.embeds[0].title, 'ok');
  assert.equal(logs.some(m => m.includes('secret-token')), false);
});

test('sendDiscordWebhook rejects missing, malformed, and non-https webhooks safely without sending', async t => {
  let called = 0;
  t.mock.method(https, 'request', () => {
    called += 1;
    throw new Error('should not be called');
  });

  for (const webhook of ['', '   ', undefined, 'not-a-url', 'http://discord.invalid/api/webhooks/1/secret']) {
    const logs = [];
    const result = await sendDiscordWebhook(webhook, {embeds: []}, {tag: 'Test Notifier', log: msg => logs.push(msg)});
    assert.equal(result.ok, false);
    assert.equal(called, 0);
    assert.ok(logs.length >= 1);
    assert.equal(logs.some(m => m.includes('secret')), false);
  }
});

test('sendDiscordWebhook handles network errors, mid-response stream errors, synchronous throws, and wall-clock timeouts', async t => {
  const secretUrl = 'https://discord.invalid/api/webhooks/123/super-secret-token';

  // 1. Network error (e.g. ENOTFOUND / EHOSTUNREACH when Unraid/internet goes down)
  await t.test('network error retries and redacts secret URL', async st => {
    let attempts = 0;
    st.mock.method(https, 'request', () => {
      attempts += 1;
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.write = () => {};
      req.end = () => {
        const err = new Error(`connect EHOSTUNREACH ${secretUrl}`);
        err.code = 'EHOSTUNREACH';
        req.emit('error', err);
      };
      return req;
    });
    const logs = [];
    const result = await sendDiscordWebhook(secretUrl, '{}', {
      tag: 'Test Notifier',
      maxRetries: 2,
      retryDelayMs: () => 1,
      log: msg => logs.push(msg)
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EHOSTUNREACH');
    assert.equal(attempts, 2);
    assert.equal(logs.some(m => m.includes('super-secret-token')), false);
  });

  // 2. Response stream emits 'error' after headers arrive
  await t.test('response stream error settles cleanly', async st => {
    st.mock.method(https, 'request', (_target, _options, callback) => {
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.resume = () => {};
        callback(res);
        const err = new Error('aborted');
        err.code = 'ECONNRESET';
        res.emit('error', err);
      };
      return req;
    });
    const logs = [];
    const result = await sendDiscordWebhook(secretUrl, '{}', {
      tag: 'Test Notifier',
      maxRetries: 1,
      log: msg => logs.push(msg)
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ECONNRESET');
  });

  // 3. Stalled DNS/socket where req.setTimeout never fires, caught by wall-clock timer
  await t.test('wall-clock timer aborts stalled requests', async st => {
    let destroyed = 0;
    st.mock.method(https, 'request', () => {
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => { destroyed += 1; };
      req.write = () => {};
      req.end = () => {};
      return req;
    });
    const result = await sendDiscordWebhook(secretUrl, '{}', {
      tag: 'Test Notifier',
      timeoutMs: 15,
      maxRetries: 1
    });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(destroyed, 1);
  });

  // 4. Synchronous throw from https.request is caught cleanly
  await t.test('synchronous request construction error does not throw', async st => {
    st.mock.method(https, 'request', () => {
      const err = new Error('sync failure');
      err.code = 'ERR_TLS_CERT';
      throw err;
    });
    const result = await sendDiscordWebhook(secretUrl, '{}', {maxRetries: 1});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'request_error');
  });
});

test('sendDiscordWebhook stops on 4xx, retries 5xx/429 with capped delay, and enforces maxTotalWaitMs', async t => {
  // 400 should not retry
  await t.test('non-retryable 4xx stops immediately', async st => {
    let attempts = 0;
    st.mock.method(https, 'request', (_target, _options, callback) => {
      attempts += 1;
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 400;
        res.resume = () => {};
        callback(res);
        res.emit('data', Buffer.from('{"message":"bad payload"}'));
        res.emit('end');
      };
      return req;
    });
    const result = await sendDiscordWebhook('https://discord.invalid/hook', '{}', {
      maxRetries: 3,
      retryDelayMs: () => 1
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.equal(attempts, 1);
  });

  // 5xx retries until maxRetries
  await t.test('5xx retries up to maxRetries', async st => {
    let attempts = 0;
    st.mock.method(https, 'request', (_target, _options, callback) => {
      attempts += 1;
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 502;
        res.resume = () => {};
        callback(res);
        res.emit('end');
      };
      return req;
    });
    const result = await sendDiscordWebhook('https://discord.invalid/hook', '{}', {
      maxRetries: 2,
      retryDelayMs: () => 1
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 502);
    assert.equal(attempts, 2);
  });

  // 429 retries and caps retry_after using maxRetryDelayMs and maxTotalWaitMs
  await t.test('429 caps retry_after delay', async st => {
    let attempts = 0;
    st.mock.method(https, 'request', (_target, _options, callback) => {
      attempts += 1;
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = attempts === 1 ? 429 : 204;
        res.resume = () => {};
        callback(res);
        if (attempts === 1) res.emit('data', Buffer.from('{"retry_after":60}'));
        res.emit('end');
      };
      return req;
    });
    const logs = [];
    const result = await sendDiscordWebhook('https://discord.invalid/hook', '{}', {
      maxRetries: 3,
      timeoutMs: 5000,
      maxRetryDelayMs: 5,
      maxTotalWaitMs: 20,
      log: msg => logs.push(msg)
    });
    assert.equal(result.ok, true);
    assert.equal(attempts, 2);
    assert.ok(logs.some(m => m.includes('retrying in 5ms')));
    assert.ok(logs.some(m => m.includes('Sent on attempt 2 (HTTP 204)')));
  });
});

test('sendDiscordWebhook ignores errors thrown by log callbacks', async t => {
  t.mock.method(https, 'request', (_target, _options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 204;
      res.resume = () => {};
      callback(res);
      res.emit('end');
    };
    return req;
  });
  const result = await sendDiscordWebhook('https://discord.invalid/hook', '{}', {
    log: () => { throw new Error('log failed'); }
  });
  assert.equal(result.ok, true);
});
