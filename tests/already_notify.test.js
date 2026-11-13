const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'already_notify.js'), 'utf8');
const helperCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'discord_webhook.js'), 'utf8');

function harness({status = 204, webhook = 'https://discord.invalid/api/test', failure} = {}) {
  const requests = [], logs = [];
  const https = {request(target, options, callback) {
    const request = new EventEmitter();
    request.setTimeout = (_ms, fn) => { request.timeout = fn; };
    request.destroy = () => request.emit('error', new Error('timeout'));
    request.end = body => {
      requests.push({target: String(target), options, body: JSON.parse(body)});
      if (failure === 'network') request.emit('error', new Error('network failed'));
      else if (failure === 'timeout') request.timeout();
      else {
        const response = new EventEmitter();
        response.statusCode = status;
        response.resume = () => {};
        callback(response);
        if (failure === 'res_error') response.emit('error', new Error('stream reset'));
        else response.emit('end');
      }
    };
    return request;
  }};
  const loadHelper = () => {
    const helperCtx = {
      module: {exports: {}},
      exports: {},
      require: name => { assert.equal(name, 'https'); return https; },
      URL,
      Buffer,
      setTimeout,
      clearTimeout
    };
    vm.runInNewContext(helperCode, helperCtx);
    return helperCtx.module.exports;
  };
  const context = {
    module: {exports: {}},
    require: name => {
      if (name === './discord_webhook') return loadHelper();
      assert.equal(name, 'https');
      return https;
    },
    process: {env: {TDARR_DISCORD_WEBHOOK: webhook}},
    URL,
    Buffer,
    Date,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(code, context);
  const inputFileObj = {
    _id: '/test/Already Processed Episode.mkv',
    ffProbeData: {format: {tags: {ENCODED_BY: 'ArcAV1_QSV_V14'}}},
  };
  const args = {
    inputFileObj,
    originalLibraryFile: {_id: inputFileObj._id},
    variables: {user: {}},
    jobLog: message => logs.push(message),
  };
  return {run: context.module.exports, requests, logs, args};
}

test('already-processed file sends an informational notice with its marker and does not change the file', async () => {
  const h = harness();
  const result = await h.run(h.args);
  assert.equal(result.outputFileObj, h.args.inputFileObj);
  assert.equal(result.outputNumber, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].target, 'https://discord.invalid/api/test');
  assert.equal(h.requests[0].options.method, 'POST');
  const embed = h.requests[0].body.embeds[0];
  assert.match(embed.title, /Already Processed Episode/);
  assert.match(embed.description, /already processed by the Tdarr AV1 flow \(ArcAV1_QSV_V14\)/);
  assert.match(embed.description, /No new encode ran/);
  assert.deepEqual(h.requests[0].body.allowed_mentions.parse, []);
  assert.ok(h.logs.includes('[Already processed notification] Sent.'));
});

test('already-processed notice is best-effort when the webhook is missing or delivery fails', async () => {
  for (const settings of [{webhook: ''}, {status: 500}, {failure: 'network'}, {failure: 'res_error'}, {failure: 'timeout'}]) {
    const h = harness(settings);
    const result = await h.run(h.args);
    assert.equal(result.outputFileObj, h.args.inputFileObj);
    assert.equal(result.outputNumber, 1);
    assert.ok(h.logs.includes('[Already processed notification] Delivery failed; see notification configuration and connectivity.'));
    if (Object.hasOwn(settings, 'webhook') && !settings.webhook) assert.equal(h.requests.length, 0);
    else assert.equal(h.requests.length, 1);
  }
});
