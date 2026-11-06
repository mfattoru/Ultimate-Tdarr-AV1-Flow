const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const path = require('node:path');

function harness({status = 204, failure, override, webhook = 'https://discord.invalid/api/example'} = {}) {
  const code = fs.readFileSync(path.join(__dirname, 'failure_notify.js'), 'utf8')
    .replace('__TDARR_DISCORD_WEBHOOK__', JSON.stringify(webhook));
  const requests = [], logs = [];
  const https = {request(url, options, callback) {
    const req = new EventEmitter();
    req.setTimeout = (_ms, fn) => { req.timeout = fn; };
    req.destroy = () => req.emit('error', new Error('timeout'));
    req.end = body => {
      requests.push({url: String(url), options, body: JSON.parse(body)});
      if (failure === 'timeout') req.timeout();
      else if (failure === 'network') req.emit('error', new Error('network failed'));
      else {
        const res = new EventEmitter(); res.statusCode = status; res.resume = () => {};
        callback(res); res.emit('end');
      }
    };
    return req;
  }};
  const context = {module:{exports:{}}, require: name => {
    assert.equal(name, 'https'); return https;
  }, process:{env: override ? {TDARR_DISCORD_WEBHOOK: override} : {}}, URL, setTimeout, clearTimeout};
  vm.runInNewContext(code, context);
  return {run: context.module.exports, requests, logs, args: {inputFileObj:{_id:'sample'}, variables:{user:{}}, jobLog: x => logs.push(x)}};
}

test('successful delivery records failure and prevents the error handler from sending again', async () => {
  const h = harness(); h.args.variables.user.failure_reason = 'subtitle validation failed';
  const result = await h.run(h.args);
  assert.equal(result.outputNumber, 1);
  assert.equal(result.outputFileObj, h.args.inputFileObj);
  assert.equal(h.args.variables.user.failure_notified, true);
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].body.content, /subtitle validation failed/);
  assert.match(h.requests[0].body.content, /sample/);
  assert.deepEqual(h.requests[0].body.allowed_mentions.parse, []);
  await h.run(h.args);
  assert.equal(h.requests.length, 1);
});

test('uses the environment webhook override and limits long failure content', async () => {
  const h = harness({override:'https://override.invalid/hook'});
  h.args.variables.user.failure_reason = 'x'.repeat(10000);
  await h.run(h.args);
  assert.equal(h.requests[0].url, 'https://override.invalid/hook');
  assert.ok(h.requests[0].body.content.length <= 2000);
});

test('failed HTTP response, network errors and timeouts leave the notification retryable', async () => {
  for (const settings of [{status:429}, {failure:'network'}, {failure:'timeout'}]) {
    const h = harness(settings);
    const result = await h.run(h.args);
    assert.equal(result.outputNumber, 1);
    assert.notEqual(h.args.variables.user.failure_notified, true);
    assert.equal(h.requests.length, 1);
    assert.match(h.requests[0].body.content, /fail/i);
  }
});

test('missing or invalid configuration does not throw or mark notification as sent', async () => {
  for (const webhook of ['', 'not-a-url', 'http://discord.invalid/']) {
    const h = harness({webhook});
    const result = await h.run(h.args);
    assert.equal(result.outputNumber, 1);
    assert.notEqual(h.args.variables.user.failure_notified, true);
    assert.equal(h.requests.length, 0);
  }
});
