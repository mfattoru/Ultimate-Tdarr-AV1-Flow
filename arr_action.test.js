'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');

const flow = JSON.parse(fs.readFileSync(path.join(__dirname, 'flow.json'), 'utf8'));
const actionCode = flow.flowPlugins.find(p => p.id === 'notify_arr_iso').inputsDB.code;
const envConfigReady = actionCode.includes('TDARR_ARR_SONARR_ANIME_URL') && !actionCode.includes('192.168.50.217');

function startMock(kind, contentRoot, fileName, id) {
  const calls = [];
  return {
    calls,
    key: `test-${kind === 'radarr' ? 'radarr' : contentRoot.includes('/anime/') ? 'sonarr-anime' : 'sonarr-tv'}-key`,
    url: `http://${contentRoot.includes('/anime/') ? 'anime' : contentRoot.includes('/tv/') ? 'tv' : 'movie'}.test`,
    respond({ method, path: requestPath, body }) {
      const url = new URL(requestPath, 'http://mock.invalid');
      const sonarr = kind === 'sonarr';
      const collection = sonarr ? 'series' : 'movie';
      if (method === 'GET' && url.pathname === `/api/v3/${collection}`) {
        return { status: 200, data: [{ id, title: path.posix.basename(contentRoot), path: contentRoot }] };
      }
      if (method === 'GET' && url.pathname === '/api/v3/episodefile') {
        return { status: 200, data: [{ path: path.posix.join(contentRoot, 'Season 2', fileName), episodeIds: [314, 315] }] };
      }
      if (method === 'GET' && url.pathname === '/api/v3/moviefile') {
        return { status: 200, data: [{ path: path.posix.join(contentRoot, fileName) }] };
      }
      if (method === 'POST' && url.pathname === '/api/v3/command') {
        return { status: 201, data: {} };
      }
      return { status: 404, data: { error: 'unexpected mock request' } };
    }
  };
}

function testEnvironment(mocks) {
  return {
    TDARR_ARR_RADARR_URL: mocks.movie.url,
    TDARR_ARR_RADARR_API_KEY: 'rkey-test',
    TDARR_ARR_SONARR_TV_URL: mocks.tv.url,
    TDARR_ARR_SONARR_TV_API_KEY: 'tvkey-test',
    TDARR_ARR_SONARR_ANIME_URL: mocks.anime.url,
    TDARR_ARR_SONARR_ANIME_API_KEY: 'akey-test'
  };
}

function testTransport(mocks) {
  return {
    request(options, onResponse) {
      const req = new EventEmitter();
      const chunks = [];
      req.write = data => chunks.push(Buffer.from(data));
      req.setTimeout = () => {};
      req.destroy = error => { if (error) req.emit('error', error); };
      req.end = () => {
        const host = options.hostname.split('.')[0];
        const mock = mocks[host];
        const bodyText = Buffer.concat(chunks).toString();
        const body = bodyText ? JSON.parse(bodyText) : null;
        const call = { method: options.method, path: options.path, key: options.headers?.['X-Api-Key'], body };
        let response = mock ? mock.respond(call) : { status: 404, data: {} };
        if (mock) mock.calls.push(call);
        setImmediate(() => {
          const res = new EventEmitter();
          res.statusCode = response.status;
          res.resume = () => {};
          onResponse(res);
          res.emit('data', Buffer.from(JSON.stringify(response.data)));
          res.emit('end');
        });
      };
      return req;
    }
  };
}

async function invoke(filePath, reason, env, mocks) {
  const module = { exports: {} };
  const fakeHttp = testTransport(mocks);
  const mockRequire = name => name === 'http' || name === 'https' ? fakeHttp : require(name);
  const context = {
    module,
    exports: module.exports,
    require: mockRequire,
    process: { env },
    URL,
    Buffer,
    console: { log() {} }
  };
  vm.runInNewContext(actionCode, context, { timeout: 1000 });
  const args = {
    inputFileObj: { _id: filePath },
    originalLibraryFile: { _id: filePath },
    variables: { user: { failure_reason: reason } },
    jobLog() {}
  };
  await module.exports(args);
  return args.variables.user;
}

test('ISO rescan uses the matching anime, TV, or movie Arr target and payload', { skip: !envConfigReady }, async () => {
  const mocks = {
    anime: startMock('sonarr', '/media/anime/Test Anime', 'Test Anime S01E01.iso', 41),
    tv: startMock('sonarr', '/media/tv/Test Show', 'Test Show S01E01.iso', 52),
    movie: startMock('radarr', '/media/movies/Test Film', 'Test Film.iso', 63)
  };
  const cases = [
    { target: 'anime', file: '/media/anime/Test Anime/Season 1/Test Anime S01E01.iso', item: 'series', id: 41 },
    { target: 'tv', file: '/media/tv/Test Show/Season 1/Test Show S01E01.iso', item: 'series', id: 52 },
    { target: 'movie', file: '/media/movies/Test Film/Test Film.iso', item: 'movie', id: 63 }
  ];
  for (const item of cases) {
    const user = await invoke(item.file, 'Disc image removed; check the Arr rescan log.', testEnvironment(mocks), mocks);
    assert.equal(user.arr_refetch_status, 'requested');
    const selected = mocks[item.target];
    assert.equal(selected.calls.at(-1).key, selected.key);
    assert.deepEqual(selected.calls.at(-1).body, item.item === 'series' ? { name: 'RescanSeries', seriesId: item.id } : { name: 'RescanMovie', movieId: item.id });
    for (const [name, mock] of Object.entries(mocks)) if (name !== item.target) assert.equal(mock.calls.length, 0, `${item.target} path must not contact ${name} Arr`);
    for (const mock of Object.values(mocks)) mock.calls.length = 0;
  }
});

test('confirmed anime source corruption sends an exact EpisodeSearch request to anime Sonarr', { skip: !envConfigReady }, async () => {
  const contentRoot = '/media/anime/Test Anime';
  const fileName = 'Test Anime - S02E03.mkv';
  const mocks = {
    anime: startMock('sonarr', contentRoot, fileName, 77),
    tv: startMock('sonarr', '/media/tv/Other', fileName, 78),
    movie: startMock('radarr', '/media/movies/Other', fileName, 79)
  };
  const user = await invoke(`${contentRoot}/Season 2/${fileName}`, '[Video guard] ffprobe exited 0 but emitted stderr: Invalid NAL unit size', testEnvironment(mocks), mocks);
  assert.equal(user.arr_corruption_search_status, 'requested');
  assert.equal(user.arr_corruption_search_target, 'Sonarr Anime');
  assert.deepEqual(mocks.anime.calls.at(-1).body, { name: 'EpisodeSearch', episodeIds: [314, 315] });
  assert.equal(mocks.tv.calls.length, 0);
  assert.equal(mocks.movie.calls.length, 0);
});

test('confirmed movie source corruption sends MoviesSearch only for the exact Radarr movie file', { skip: !envConfigReady }, async () => {
  const contentRoot = '/media/movies/Test Film';
  const fileName = 'Test Film.mkv';
  const mocks = {
    anime: startMock('sonarr', '/media/anime/Other', fileName, 81),
    tv: startMock('sonarr', '/media/tv/Other', fileName, 82),
    movie: startMock('radarr', contentRoot, fileName, 83)
  };
  const user = await invoke(`${contentRoot}/${fileName}`, '[Source media corruption] invalid data found when processing input', testEnvironment(mocks), mocks);
  assert.equal(user.arr_corruption_search_status, 'requested');
  assert.equal(user.arr_corruption_search_target, 'Radarr Movies');
  assert.deepEqual(mocks.movie.calls.at(-1).body, { name: 'MoviesSearch', movieIds: [83] });
  assert.equal(mocks.anime.calls.length, 0);
  assert.equal(mocks.tv.calls.length, 0);
});

test('candidate-only validation failures do not contact any Arr target', { skip: !envConfigReady }, async () => {
  const mocks = {
    anime: startMock('sonarr', '/media/anime/Other', 'Other.mkv', 91),
    tv: startMock('sonarr', '/media/tv/Other', 'Other.mkv', 92),
    movie: startMock('radarr', '/media/movies/Other', 'Other.mkv', 93)
  };
  const user = await invoke('/media/anime/Other/Other.mkv', '[Safety check failed] Candidate video decode failed', testEnvironment(mocks), mocks);
  assert.equal(user.arr_corruption_search_status, 'not_applicable');
  assert.equal(user.arr_refetch_status, 'not_attempted');
  for (const mock of Object.values(mocks)) assert.equal(mock.calls.length, 0);
});
