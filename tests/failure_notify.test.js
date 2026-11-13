const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const path = require('node:path');

function harness({status = 204, failure, override, webhook = 'https://discord.invalid/api/example'} = {}) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'failure_notify.js'), 'utf8')
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
  }, process:{env:{TDARR_DISCORD_WEBHOOK: override ?? webhook}}, URL, setTimeout, clearTimeout};
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
  assert.ok(Array.isArray(h.requests[0].body.embeds),'expected Discord embed');
  assert.match(h.requests[0].body.embeds[0].description, /subtitle validation failed/);
  assert.match(h.requests[0].body.embeds[0].title, /sample/);
  assert.deepEqual(h.requests[0].body.allowed_mentions.parse, []);
  await h.run(h.args);
  assert.equal(h.requests.length, 1);
});

test('uses the environment webhook override and limits long failure content', async () => {
  const h = harness({override:'https://override.invalid/hook'});
  h.args.variables.user.failure_reason = 'x'.repeat(10000);
  await h.run(h.args);
  assert.equal(h.requests[0].url, 'https://override.invalid/hook');
  assert.ok(Array.isArray(h.requests[0].body.embeds),'expected Discord embed');
  assert.ok(h.requests[0].body.embeds[0].description.length <= 4096);
});

test('quarantine notice provides the exact original path for the force-fresh variable', async () => {
 const h=harness();
 const original="/mnt/media/movies/The King's Man (2021)/The King's Man (2021).mkv";
 h.args.originalLibraryFile={_id:original};
 h.args.inputFileObj._id='/temp/tdarr-av1-job/candidate.mkv';
 h.args.variables.user.quarantine_entry={candidatePath:'/cache/candidate.mkv'};
 h.args.variables.user.validation_report={outcome:'inconclusive',failure:{stage:'video_decode'}};
 await h.run(h.args);
 const description=h.requests[0].body.embeds[0].description;
 assert.match(description,/arc_force_fresh_path/);
 assert.ok(description.includes(original),'notice must contain the complete node-visible original path');
 assert.ok(!description.includes('/temp/tdarr-av1-job/candidate.mkv'));
});
test('quarantine notice does not substitute a cache path when the original path is unavailable', async () => {
 const h=harness();
 h.args.inputFileObj._id='/temp/tdarr-av1-job/candidate.mkv';
 h.args.variables.user.quarantine_entry={candidatePath:'/cache/candidate.mkv'};
 await h.run(h.args);
 const description=h.requests[0].body.embeds[0].description;
 assert.match(description,/original path could not be safely displayed/i);
 assert.ok(!description.includes('/temp/tdarr-av1-job/candidate.mkv'));
});

test('failed HTTP response, network errors and timeouts leave the notification retryable', async () => {
  for (const settings of [{status:429}, {failure:'network'}, {failure:'timeout'}]) {
    const h = harness(settings);
    const result = await h.run(h.args);
    assert.equal(result.outputNumber, 1);
    assert.notEqual(h.args.variables.user.failure_notified, true);
    assert.equal(h.requests.length, 1);
    assert.ok(Array.isArray(h.requests[0].body.embeds),'expected Discord embed');
    assert.match(h.requests[0].body.embeds[0].title, /fail|sample/i);
  }
});

test('quality-floor failure uses a rich embed with an accurate retained-original status', async () => {
  const h=harness();h.args.originalLibraryFile={_id:'/test/Episode.mkv',file_size:123.4};
  h.args.variables.user.failure_reason='[Size guard] No smaller output at ICQ 23; quality floor reached. Original retained.';
  h.args.variables.user.workflow_start_epoch=Date.now()-61000;
  await h.run(h.args);assert.ok(Array.isArray(h.requests[0].body.embeds),'expected Discord embed');const embed=h.requests[0].body.embeds[0];
  assert.match(embed.title,/Episode/);assert.match(embed.description,/quality floor/i);
  assert.match(embed.description,/original retained/i);assert.match(embed.description,/123\.4 MB/);
  assert.match(embed.description,/duration/i);assert.equal(embed.color,15105570);
});

test('malformed H.264 source errors get a source-side explanation and recovery guidance', async () => {
  const h = harness();
  h.args.variables.user.failure_reason = '[Video guard] ffprobe exited 0 but emitted stderr: [h264] Invalid NAL unit size (882555247 > 14316). Error splitting the input into NAL units.; original retained.';
  await h.run(h.args);
  const embed = h.requests[0].body.embeds[0];
  assert.match(embed.description, /malformed H\.264 NAL units/i);
  assert.match(embed.description, /source video/i);
  assert.match(embed.description, /kept the original/i);
  assert.match(embed.description, /playback|seeking/i);
  assert.match(embed.description, /Invalid NAL unit size/);
});

test('oversized source audio DTS repair is explained as a timestamp issue, not confirmed corruption',async()=>{
 const h=harness();
 h.args.variables.user.failure_reason='[Arc AV1] Job failed: [Audio guard] Source audio stream 0:1 needs up to 1476450.0 ms of DTS correction, above the 100 ms repair limit.';
 await h.run(h.args);
 const embed=h.requests[0].body.embeds[0];
 assert.match(embed.description,/audio packet timestamps/i);
 assert.match(embed.description,/24 min 36 sec/i);
 assert.match(embed.description,/AV1 encoding did not start/i);
 assert.match(embed.description,/does not confirm audio corruption/i);
 assert.match(embed.description,/1,476,450\.0 ms/);
 assert.equal(embed.color,15105570);
});
test('unsafe source ASS timing reports a controlled subtitle hold',async()=>{
 const h=harness();
 h.args.variables.user.failure_reason='[Subtitle guard] ASS/SSA source stream 0:4 would require 3.140s of timestamp repair at packet 4, above the 0.5s limit; original retained.';
 await h.run(h.args);
 const embed=h.requests[0].body.embeds[0];
 assert.match(embed.description,/subtitle/i);
 assert.match(embed.description,/original/i);
 assert.match(embed.description,/3\.140/);
 assert.equal(embed.color,15105570);
});

test('additional decoded video tracks are explained as an unsupported layout without recommending Arr search', async () => {
  const h = harness();
  h.args.variables.user.failure_reason = '[Video guard] Additional video stream 1 decoded at least one frame; multiple-video policy is unsupported; keeping original.';
  await h.run(h.args);
  const embed = h.requests[0].body.embeds[0];
  assert.match(embed.description, /additional video track with decoded frames/i);
  assert.match(embed.description, /original file was kept/i);
  assert.match(embed.description, /does not establish source corruption/i);
  assert.match(embed.description, /does not trigger an Arr search/i);
  assert.match(embed.description, /Additional video stream 1/);
});

test('subtitle packet loss is described as an output validation failure, not source corruption', async () => {
  const h = harness();
  h.args.variables.user.failure_reason = '[Safety check failed] Output subtitle packet count 4027 is less than source 4028 for stream 3. Original will not be replaced.';
  await h.run(h.args);
  const embed = h.requests[0].body.embeds[0];
  assert.match(embed.description, /new output has 1 fewer subtitle packet/i);
  assert.match(embed.description, /4,028 source → 4,027 output/);
  assert.match(embed.description, /kept the original/i);
  assert.match(embed.description, /does not show source corruption/i);
  assert.match(embed.description, /Output subtitle packet count 4027/);
});

test('cache exhaustion explains that the original was kept and how to retry',async()=>{
 const h=harness();h.args.variables.user.failure_reason='[Cache reservation] Seek-healing remux stopped: Insufficient available capacity to grow reservation; original retained.';
 await h.run(h.args);const embed=h.requests[0].body.embeds[0];
 assert.match(embed.description,/could not reserve enough safe space/i);
 assert.match(embed.description,/original was kept/i);
 assert.match(embed.description,/free space.*cache/i);
 assert.match(embed.description,/Insufficient available capacity/);
});

test('oversized ASS/SSA conversion failures point to styled subtitle preservation',async()=>{
 const h=harness();h.args.variables.user.failure_reason='[Arc AV1] Transcode execution failed: FFmpeg exit 190: Subtitle encoding failed. Error encoding a frame: Buffer too small; original retained.';
 await h.run(h.args);const embed=h.requests[0].body.embeds[0];
 assert.match(embed.description,/could not encode a subtitle event/i);
 assert.match(embed.description,/ASS\/SSA/i);
 assert.match(embed.description,/original file/i);
});

test('inconclusive verification explains that the check could not finish without claiming corruption',async()=>{
 const h=harness();
 h.args.variables.user.failure_reason='[Validation inconclusive] Cannot allocate memory. Original retained.';
 h.args.variables.user.validation_report={outcome:'inconclusive',failure:{stage:'video_decode',code:'decode_unverified'}};
 await h.run(h.args);const embed=h.requests[0].body.embeds[0];
 assert.match(embed.description,/could not complete/i);
 assert.match(embed.description,/does not establish.*damag/i);
 assert.match(embed.footer.text,/validation inconclusive/i);
 assert.match(embed.description,/original.*kept/i);
});

test('a rejected metadata contract is explained without calling the source corrupt',async()=>{
 const h=harness();h.args.variables.user.failure_reason='[Validation rejected] HDR mastering metadata conflicts with decoded frames. Original retained.';
 h.args.variables.user.validation_report={outcome:'rejected',failure:{stage:'hdr_color',code:'validation_mismatch',sourceCorruption:false}};
 await h.run(h.args);const embed=h.requests[0].body.embeds[0];
 assert.match(embed.description,/did not preserve/i);
 assert.match(embed.footer.text,/candidate rejected/i);
 assert.doesNotMatch(embed.description,/targeted.*search/i);
});

test('ambiguous HDR signaling is described without recommending an automatic replacement',async()=>{
 const h=harness();h.args.variables.user.failure_reason='[HDR guard] HDR color signaling is unsupported or ambiguous; original retained.';
 await h.run(h.args);const embed=h.requests[0].body.embeds[0];
 assert.match(embed.description,/color or HDR signaling is incomplete/i);
 assert.match(embed.description,/original was kept/i);
 assert.match(embed.description,/Do not relabel or replace/i);
});

test('ISO deletion and unexpected errors do not claim the original was retained', async () => {
  for(const reason of ['Disc image removed; check the Arr rescan log.','Unexpected flow error after replacement']) {
    const h=harness();h.args.variables.user.failure_reason=reason;await h.run(h.args);
    assert.ok(Array.isArray(h.requests[0].body.embeds),'expected Discord embed');const embed=h.requests[0].body.embeds[0];assert.doesNotMatch(embed.description,/original retained/i);
  }
});

test('ISO removal sends a warning that reports deletion and whether an Arr rescan was accepted', async () => {
  for (const [status, expected] of [
    ['requested', /A rescan request was accepted so Arr can locate and refetch a non-ISO release/],
    ['skipped', /This path did not match a configured library, so no rescan request was sent/],
  ]) {
    const h = harness();
    h.args.variables.user.failure_reason = 'Disc image removed; check the Arr rescan log.';
    h.args.variables.user.arr_refetch_status = status;
    const result = await h.run(h.args);
    const embed = h.requests[0].body.embeds[0];
    assert.equal(result.outputNumber, 2);
    assert.match(embed.title, /^⚠️/);
    assert.match(embed.description, /The ISO disc image was deleted from the library/);
    assert.match(embed.description, expected);
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
