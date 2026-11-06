const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const flow = JSON.parse(fs.readFileSync(path.join(__dirname, 'ArcAV1-safety-review.json')));
let code = flow.flowPlugins.find(p => p.id === 'arc_av1_monolithic').inputsDB.code;
code = code.replace(/https:\/\/discord\.com\/api\/webhooks\/[^"\s]+/g, 'YOUR_WEBHOOK');
const mod = { exports: {} };
new Function('require', 'module', 'exports', code)(require, mod, mod.exports);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-flow-integration-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const sample = path.join(dir, 'sample.mkv');
child.execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=440','-t','5','-c:v','libsvtav1','-preset','12','-svtav1-params','lp=1:log-level=0','-c:a','aac','-y',sample], {stdio:'ignore'});
const probe = JSON.parse(child.execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',sample],{encoding:'utf8'}));
const file = {_id: sample, file: sample, container:'mkv', file_size:fs.statSync(sample).size / 1024 / 1024, fileNameWithoutExtension:'sample', ffProbeData:probe};
const runArgs = () => ({inputFileObj:{...file}, originalLibraryFile:{...file}, workDir:dir, variables:{user:{min_cache_free_mb:1}}, ffmpegPath:'ffmpeg', librarySettings:{folder:dir}, jobLog:()=>{}});

test('AV1 stream-copy creates a validated output and preserves the original', async () => {
  const result = await mod.exports(runArgs());
  assert.equal(result.outputNumber, 1);
  assert.notEqual(result.outputFileObj._id, sample);
  assert.equal(fs.existsSync(result.outputFileObj._id), true);
  assert.equal(fs.existsSync(sample), true);
  assert.ok(path.dirname(result.outputFileObj._id).startsWith(path.join(dir,'tdarr-av1-')));
});

test('existing target with a different extension blocks replacement', async () => {
  const other = path.join(dir, 'sample.mp4'); fs.copyFileSync(sample,other);
  const args=runArgs(); args.originalLibraryFile={...file,_id:other};
  const result=await mod.exports(args);
  assert.equal(result.outputNumber,2);
  assert.equal(fs.existsSync(sample),true);
  assert.equal(fs.existsSync(other),true);
});

test('ISO deletion selects the Arr rescan path', async () => {
  const iso=path.join(dir,'test.iso'); fs.writeFileSync(iso,'fixture');
  const args=runArgs(); args.inputFileObj={_id:iso,container:'iso'}; args.originalLibraryFile={_id:iso,file_size:1};
  const result=await mod.exports(args);
  assert.equal(result.outputNumber,3);
  assert.equal(fs.existsSync(iso),false);
});

test('successful and failed job paths include safe cache cleanup', async () => {
  const success = flow.flowPlugins.find(p => p.id === 'cleanup_success');
  const failure = flow.flowPlugins.find(p => p.id === 'cleanup_failure');
  assert.ok(success && failure, 'both flow paths need cache cleanup');
  const tmp = fs.mkdtempSync(path.join(dir, 'tdarr-av1-'));
  const output = path.join(tmp,'output.mkv'); fs.writeFileSync(output,'partial');
  const cleanup = {exports:{}};
  new Function('require','module','exports',failure.inputsDB.code)(require,cleanup,cleanup.exports);
  await cleanup.exports({inputFileObj:file,variables:{user:{safety_temp_dir:tmp,safety_temp_output:output}},jobLog:()=>{}});
  assert.equal(fs.existsSync(tmp),false);
});

test('unavailable configured Arc device fails before starting a video encode', async () => {
  const args=runArgs();
  args.inputFileObj.ffProbeData=structuredClone(probe);
  args.inputFileObj.ffProbeData.streams.find(s => s.codec_type === 'video').codec_name='h264';
  process.env.TDARR_ARC_DEVICE=path.join(dir,'missing-gpu');
  try { const result=await mod.exports(args); assert.equal(result.outputNumber,2); }
  finally { delete process.env.TDARR_ARC_DEVICE; }
});

test('workflow contains no recovery-copy implementation', () => {
  assert.equal(code.includes('backupOriginal'),false);
  assert.equal(code.includes('TDARR_BACKUP_DIR'),false);
});


test('failed ISO deletion does not select the rescan path', async () => {
  const iso=path.join(dir,'refuse.iso'); fs.writeFileSync(iso,'fixture');
  const args=runArgs(); args.inputFileObj={_id:iso,container:'iso'}; args.originalLibraryFile={_id:path.join(dir,'other.iso'),file_size:1};
  const result=await mod.exports(args);
  assert.equal(result.outputNumber,2);
  assert.equal(fs.existsSync(iso),true);
});

test('ISO rescan has a separate flow route leading to failure status', () => {
  const edge=flow.flowEdges.find(e => e.source === 'arc_av1_monolithic' && e.sourceHandle === '3');
  assert.ok(edge, 'missing ISO rescan output');
  const notifier=flow.flowPlugins.find(p => p.id === edge.target);
  assert.ok(notifier && notifier.pluginName === 'customFunction');
  assert.ok(flow.flowEdges.some(e => e.source === notifier.id && e.target === 'fail_flow'));
});

test('ISO notifier selects the correct Arr instance and sends its rescan command', async () => {
  const {EventEmitter} = require('node:events');
  const notifierCode = flow.flowPlugins.find(p => p.id === 'notify_arr_iso').inputsDB.code;
  for (const [category, port, listEndpoint, command, key] of [
    ['movies', 7878, '/api/v3/movie', 'RescanMovie', 'movieId'],
    ['tv', 8989, '/api/v3/series', 'RescanSeries', 'seriesId'],
    ['anime', 8990, '/api/v3/series', 'RescanSeries', 'seriesId'],
  ]) {
    const requests=[];
    const fakeHttp={request(options, callback) {
      const req=new EventEmitter(); let body='';
      req.write=chunk=>{body+=chunk;}; req.setTimeout=()=>{}; req.destroy=()=>{};
      req.end=()=>process.nextTick(()=>{
        requests.push({port:Number(options.port),path:options.path,method:options.method,body});
        const res=new EventEmitter(); res.statusCode=200; callback(res);
        res.emit('data',options.method==='GET' ? JSON.stringify([{id:42,path:`/mnt/media/${category}/Title`,title:'Title'}]) : '{}');
        res.emit('end');
      });
      return req;
    }};
    const notifier={exports:{}};
    const fakeRequire=(name)=>(name==='http'||name==='https') ? fakeHttp : require(name);
    new Function('require','module','exports',notifierCode)(fakeRequire,notifier,notifier.exports);
    const iso=`/mnt/media/${category}/Title/disc.iso`;
    await notifier.exports({inputFileObj:{_id:iso},originalLibraryFile:{_id:iso},variables:{user:{}},jobLog:()=>{}});
    assert.equal(requests.length,2);
    assert.equal(requests[0].port,port);
    assert.equal(requests[0].path,listEndpoint);
    assert.equal(requests[1].path,'/api/v3/command');
    assert.deepEqual(JSON.parse(requests[1].body),{name:command,[key]:42});
  }
});
