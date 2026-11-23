'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');

const flow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flow.json'), 'utf8'));
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

function testEnvironment(mocks, extra = {}) {
  return {
    TDARR_ARR_RADARR_URL: mocks.movie.url,
    TDARR_ARR_RADARR_API_KEY: mocks.movie.key,
    TDARR_ARR_SONARR_TV_URL: mocks.tv.url,
    TDARR_ARR_SONARR_TV_API_KEY: mocks.tv.key,
    TDARR_ARR_SONARR_ANIME_URL: mocks.anime.url,
    TDARR_ARR_SONARR_ANIME_API_KEY: mocks.anime.key,
    ...extra
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
        const call = { method: options.method, path: options.path, key: options.headers?.['X-Api-Key'], headers: options.headers || {}, body };
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

async function invoke(filePath, reason, env, mocks, validationReport) {
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
    setTimeout,
    clearTimeout,
    console: { log() {} }
  };
  vm.runInNewContext(actionCode, context, { timeout: 1000 });
  const args = {
    inputFileObj: { _id: filePath },
    originalLibraryFile: { _id: filePath },
    variables: { user: { failure_reason: reason, ...(validationReport?{validation_report:validationReport}:{}) } },
    jobLog() {}
  };
  await module.exports(args);
  return args.variables.user;
}

test('inconclusive and candidate-only validation failures cannot request Arr searches from diagnostic text',async()=>{
 for(const outcome of ['inconclusive','rejected']){
  const user=await invoke('/media/movies/Test Movie/Test.mkv','[Source media corruption] Invalid data found',{}, {},{outcome,failure:{sourceCorruption:false}});
  assert.equal(user.arr_corruption_search_status,'not_applicable');
 }
});

test('legacy source diagnostic matching cannot mistake decoder memory failures for corruption',async()=>{
 const user=await invoke('/media/movies/Test Movie/Test.mkv','[Video guard] ffprobe failed (1): Error while decoding stream #0:0: Cannot allocate memory; original retained.',{},{});
 assert.equal(user.arr_corruption_search_status,'not_applicable');
});

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

test('ISO rescan degrades cleanly when Arr response stream emits an error mid-body', async () => {
  const module = { exports: {} };
  const fakeHttp = {
    request(_options, onResponse) {
      const req = new EventEmitter();
      req.write = () => {};
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        setImmediate(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.resume = () => {};
          onResponse(res);
          res.emit('error', new Error('connection reset mid-response'));
        });
      };
      return req;
    }
  };
  const context = {
    module,
    exports: module.exports,
    require: name => name === 'http' || name === 'https' ? fakeHttp : require(name),
    process: { env: { TDARR_ARR_RADARR_URL: 'http://movie.test', TDARR_ARR_RADARR_API_KEY: 'key' } },
    URL,
    Buffer,
    setTimeout,
    clearTimeout,
    console: { log() {} }
  };
  vm.runInNewContext(actionCode, context, { timeout: 1000 });
  const args = {
    inputFileObj: { _id: '/media/movies/Test Film/Test Film.iso' },
    originalLibraryFile: { _id: '/media/movies/Test Film/Test Film.iso' },
    variables: { user: { failure_reason: 'Disc image removed; check the Arr rescan log.' } },
    jobLog() {}
  };
  const res = await module.exports(args);
  assert.equal(res.outputNumber, 1);
  assert.equal(args.variables.user.arr_refetch_status, 'not_found');
});

function createExtendedMock(kind, contentRoot, fileName, itemId, options = {}) {
  const calls = [];
  const prefix = contentRoot.includes('/anime/') ? 'anime' : contentRoot.includes('/tv/') ? 'tv' : 'movie';
  return {
    calls,
    key: `test-${prefix}-key`,
    url: `http://${prefix}.test`,
    respond({ method, path: requestPath, body }) {
      const url = new URL(requestPath, 'http://mock.invalid');
      const sonarr = kind === 'sonarr';
      const collection = sonarr ? 'series' : 'movie';
      if (method === 'GET' && url.pathname === `/api/v3/${collection}`) {
        return { status: 200, data: [{ id: itemId, title: path.posix.basename(contentRoot), path: contentRoot }] };
      }
      if (method === 'GET' && url.pathname === '/api/v3/moviefile') {
        return { status: 200, data: options.movieFiles ?? [{ id: 501, path: path.posix.join(contentRoot, fileName), sceneName: options.sceneName || 'Release-BAD' }] };
      }
      if (method === 'GET' && url.pathname === '/api/v3/episodefile') {
        return { status: 200, data: options.episodeFiles ?? [{ id: 702, seasonNumber: 2, path: path.posix.join(contentRoot, 'Season 2', fileName), episodeIds: [314, 315] }] };
      }
      if (method === 'GET' && (url.pathname === '/api/v3/history/movie' || url.pathname === '/api/v3/history/series')) {
        return { status: options.historyStatus ?? 200, data: options.history ?? [] };
      }
      if (method === 'POST' && url.pathname.startsWith('/api/v3/history/failed/')) {
        return { status: options.failHistoryStatus ?? 200, data: {} };
      }
      if (method === 'DELETE' && (url.pathname.startsWith('/api/v3/moviefile/') || url.pathname.startsWith('/api/v3/episodefile/'))) {
        return { status: options.deleteStatus ?? 200, data: {} };
      }
      if (method === 'POST' && url.pathname === '/api/v3/command') {
        return { status: options.commandStatus ?? 201, data: { body } };
      }
      return { status: 404, data: { error: 'unexpected mock request' } };
    }
  };
}

test('confirmed Radarr source corruption blocklists exact grabbed release, deletes corrupt file by default, and searches', { skip: !envConfigReady }, async () => {
  const contentRoot = '/media/movies/Dragon The Bruce Lee Story (1993)';
  const fileName = 'Dragon The Bruce Lee Story (1993) Remux-2160p.mkv';
  const releaseTitle = 'Dragon.1993.2160p.REMUX-BAD';
  const mocks = {
    anime: startMock('sonarr', '/media/anime/Other', fileName, 81),
    tv: startMock('sonarr', '/media/tv/Other', fileName, 82),
    movie: createExtendedMock('radarr', contentRoot, fileName, 83, {
      sceneName: releaseTitle,
      history: [
        { id: 9004, movieId: 83, eventType: 'downloadFolderImported', downloadId: 'dl-new', sourceTitle: releaseTitle, date: '2026-11-22T05:00:00Z', data: { fileId: '501', importedPath: `${contentRoot}/${fileName}` } },
        { id: 9003, movieId: 83, eventType: 'downloadFolderImported', downloadId: 'dl-old', sourceTitle: 'Dragon.1993.OLDER', date: '2026-10-01T05:00:00Z', data: { fileId: '400', importedPath: `${contentRoot}/${fileName}` } },
        { id: 9002, movieId: 83, eventType: 'grabbed', downloadId: 'dl-new', sourceTitle: releaseTitle, date: '2026-11-22T04:00:00Z', data: {} },
        { id: 9001, movieId: 83, eventType: 'grabbed', downloadId: 'dl-old', sourceTitle: 'Dragon.1993.OLDER', date: '2026-10-01T04:00:00Z', data: {} }
      ]
    })
  };
  const user = await invoke(`${contentRoot}/${fileName}`, '[Source media corruption] Invalid NAL unit size (0 > 155162).', testEnvironment(mocks), mocks);
  const actions = mocks.movie.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`);
  assert.deepEqual(actions, [
    'POST /api/v3/history/failed/9002',
    'DELETE /api/v3/moviefile/501',
    'POST /api/v3/command'
  ]);
  const failedPost = mocks.movie.calls.find(c => c.path === '/api/v3/history/failed/9002');
  assert.equal(failedPost.headers['Content-Length'], 0);
  assert.deepEqual(mocks.movie.calls.at(-1).body, { name: 'MoviesSearch', movieIds: [83] });
  assert.equal(user.arr_corruption_blocklist_status, 'blocklisted');
  assert.equal(user.arr_corruption_blocklist_release, releaseTitle);
  assert.equal(user.arr_corruption_delete_status, 'deleted');
  assert.equal(user.arr_corruption_search_status, 'requested');
  assert.equal(user.arr_corruption_search_target, 'Radarr Movies');
});

test('confirmed Sonarr season-pack source corruption blocklists matching grab once, deletes episodefile, and searches', { skip: !envConfigReady }, async () => {
  const contentRoot = '/media/anime/Test Anime';
  const fileName = 'Test Anime - S02E03-E04.mkv';
  const mocks = {
    anime: createExtendedMock('sonarr', contentRoot, fileName, 77, {
      history: [
        { id: 8104, seriesId: 77, episodeId: 314, eventType: 'downloadFolderImported', downloadId: 'dl-pack', sourceTitle: 'Show.S02.Pack-GRP', date: '2026-11-22T06:00:00Z', data: { fileId: '702', importedPath: `${contentRoot}/Season 2/${fileName}` } },
        { id: 8103, seriesId: 77, episodeId: 315, eventType: 'downloadFolderImported', downloadId: 'dl-pack', sourceTitle: 'Show.S02.Pack-GRP', date: '2026-11-22T06:00:00Z', data: { fileId: '702', importedPath: `${contentRoot}/Season 2/${fileName}` } },
        { id: 8102, seriesId: 77, episodeId: 315, eventType: 'grabbed', downloadId: 'dl-pack', sourceTitle: 'Show.S02.Pack-GRP', date: '2026-11-22T05:00:00Z', data: {} },
        { id: 8101, seriesId: 77, episodeId: 314, eventType: 'grabbed', downloadId: 'dl-pack', sourceTitle: 'Show.S02.Pack-GRP', date: '2026-11-22T05:00:00Z', data: {} }
      ]
    }),
    tv: startMock('sonarr', '/media/tv/Other', fileName, 78),
    movie: startMock('radarr', '/media/movies/Other', fileName, 79)
  };
  const user = await invoke(`${contentRoot}/Season 2/${fileName}`, '[Source media corruption] Invalid data found', testEnvironment(mocks), mocks);
  const historyGet = mocks.anime.calls.find(c => c.method === 'GET' && c.path.startsWith('/api/v3/history/series'));
  assert.ok(historyGet.path.includes('seriesId=77') && historyGet.path.includes('seasonNumber=2'));
  const failedPosts = mocks.anime.calls.filter(c => c.method === 'POST' && c.path.startsWith('/api/v3/history/failed/'));
  assert.equal(failedPosts.length, 1);
  assert.equal(failedPosts[0].path, '/api/v3/history/failed/8102');
  assert.deepEqual(
    mocks.anime.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`),
    ['POST /api/v3/history/failed/8102', 'DELETE /api/v3/episodefile/702', 'POST /api/v3/command']
  );
  assert.deepEqual(mocks.anime.calls.at(-1).body, { name: 'EpisodeSearch', episodeIds: [314, 315] });
  assert.equal(user.arr_corruption_blocklist_status, 'blocklisted');
  assert.equal(user.arr_corruption_blocklist_release, 'Show.S02.Pack-GRP');
  assert.equal(user.arr_corruption_delete_status, 'deleted');
  assert.equal(user.arr_corruption_search_status, 'requested');
});

test('TDARR_ARR_DELETE_CORRUPT opt-out values keep corrupt file on disk while still blocklisting and searching', { skip: !envConfigReady }, async () => {
  const contentRoot = '/media/movies/Test Film';
  const fileName = 'Test Film.mkv';
  for (const flag of ['false', '0', 'no', 'off']) {
    const mocks = {
      anime: startMock('sonarr', '/media/anime/Other', fileName, 81),
      tv: startMock('sonarr', '/media/tv/Other', fileName, 82),
      movie: createExtendedMock('radarr', contentRoot, fileName, 83, {
        history: [
          { id: 102, movieId: 83, eventType: 'downloadFolderImported', downloadId: 'dl-1', sourceTitle: 'Test.Film.Bad-GRP', date: '2026-11-22T05:00:00Z', data: { fileId: '501', importedPath: `${contentRoot}/${fileName}` } },
          { id: 101, movieId: 83, eventType: 'grabbed', downloadId: 'dl-1', sourceTitle: 'Test.Film.Bad-GRP', date: '2026-11-22T04:00:00Z', data: {} }
        ]
      })
    };
    const user = await invoke(`${contentRoot}/${fileName}`, '[Source media corruption] Invalid bitstream', testEnvironment(mocks, { TDARR_ARR_DELETE_CORRUPT: flag }), mocks);
    assert.deepEqual(mocks.movie.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`), ['POST /api/v3/history/failed/101', 'POST /api/v3/command']);
    assert.equal(user.arr_corruption_blocklist_status, 'blocklisted');
    assert.equal(user.arr_corruption_delete_status, 'disabled');
    assert.equal(user.arr_corruption_search_status, 'requested');
  }
});

test('already-blocklisted release skips duplicate history/failed POST and still deletes and searches', { skip: !envConfigReady }, async () => {
  const contentRoot = '/media/movies/Test Film';
  const fileName = 'Test Film.mkv';
  const mocks = {
    anime: startMock('sonarr', '/media/anime/Other', fileName, 81),
    tv: startMock('sonarr', '/media/tv/Other', fileName, 82),
    movie: createExtendedMock('radarr', contentRoot, fileName, 83, {
      history: [
        { id: 203, movieId: 83, eventType: 'downloadFailed', downloadId: 'dl-dup', sourceTitle: 'Test.Film.Dup-GRP', date: '2026-11-22T05:30:00Z', data: {} },
        { id: 202, movieId: 83, eventType: 'downloadFolderImported', downloadId: 'dl-dup', sourceTitle: 'Test.Film.Dup-GRP', date: '2026-11-22T05:00:00Z', data: { fileId: '501', importedPath: `${contentRoot}/${fileName}` } },
        { id: 201, movieId: 83, eventType: 'grabbed', downloadId: 'dl-dup', sourceTitle: 'Test.Film.Dup-GRP', date: '2026-11-22T04:00:00Z', data: {} }
      ]
    })
  };
  const user = await invoke(`${contentRoot}/${fileName}`, '[Source media corruption] Invalid bitstream', testEnvironment(mocks), mocks);
  assert.deepEqual(mocks.movie.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`), ['DELETE /api/v3/moviefile/501', 'POST /api/v3/command']);
  assert.equal(user.arr_corruption_blocklist_status, 'already_blocklisted');
  assert.equal(user.arr_corruption_blocklist_release, 'Test.Film.Dup-GRP');
  assert.equal(user.arr_corruption_delete_status, 'deleted');
  assert.equal(user.arr_corruption_search_status, 'requested');
});

test('missing grab history prevents automatic file deletion while still running search', { skip: !envConfigReady }, async () => {
  const contentRoot = '/media/movies/Test Film';
  const fileName = 'Test Film.mkv';
  for (const history of [[], [{ id: 301, movieId: 83, eventType: 'downloadFolderImported', sourceTitle: 'ManualImport', data: { fileId: '501' } }]]) {
    const mocks = {
      anime: startMock('sonarr', '/media/anime/Other', fileName, 81),
      tv: startMock('sonarr', '/media/tv/Other', fileName, 82),
      movie: createExtendedMock('radarr', contentRoot, fileName, 83, { history })
    };
    const user = await invoke(`${contentRoot}/${fileName}`, '[Source media corruption] Invalid bitstream', testEnvironment(mocks), mocks);
    assert.deepEqual(mocks.movie.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`), ['POST /api/v3/command']);
    assert.equal(user.arr_corruption_blocklist_status, 'no_history');
    assert.equal(user.arr_corruption_delete_status, 'skipped_no_blocklist');
    assert.equal(user.arr_corruption_search_status, 'requested');
  }
});

test('failed blocklist POST refuses to delete file on disk while still running search', { skip: !envConfigReady }, async () => {
  const contentRoot = '/media/movies/Test Film';
  const fileName = 'Test Film.mkv';
  const mocks = {
    anime: startMock('sonarr', '/media/anime/Other', fileName, 81),
    tv: startMock('sonarr', '/media/tv/Other', fileName, 82),
    movie: createExtendedMock('radarr', contentRoot, fileName, 83, {
      failHistoryStatus: 400,
      history: [
        { id: 402, movieId: 83, eventType: 'downloadFolderImported', downloadId: 'dl-err', sourceTitle: 'Bad.Release', date: '2026-11-22T05:00:00Z', data: { fileId: '501', importedPath: `${contentRoot}/${fileName}` } },
        { id: 401, movieId: 83, eventType: 'grabbed', downloadId: 'dl-err', sourceTitle: 'Bad.Release', date: '2026-11-22T04:00:00Z', data: {} }
      ]
    })
  };
  const user = await invoke(`${contentRoot}/${fileName}`, '[Source media corruption] Invalid bitstream', testEnvironment(mocks), mocks);
  assert.deepEqual(mocks.movie.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`), ['POST /api/v3/history/failed/401', 'POST /api/v3/command']);
  assert.equal(user.arr_corruption_blocklist_status, 'failed');
  assert.equal(user.arr_corruption_delete_status, 'skipped_no_blocklist');
  assert.equal(user.arr_corruption_search_status, 'requested');
});

test('delete failure after successful blocklist records delete_status=failed and still runs search', { skip: !envConfigReady }, async () => {
  const contentRoot = '/media/movies/Test Film';
  const fileName = 'Test Film.mkv';
  const mocks = {
    anime: startMock('sonarr', '/media/anime/Other', fileName, 81),
    tv: startMock('sonarr', '/media/tv/Other', fileName, 82),
    movie: createExtendedMock('radarr', contentRoot, fileName, 83, {
      deleteStatus: 500,
      history: [
        { id: 502, movieId: 83, eventType: 'downloadFolderImported', downloadId: 'dl-del-err', sourceTitle: 'Bad.Release', date: '2026-11-22T05:00:00Z', data: { fileId: '501', importedPath: `${contentRoot}/${fileName}` } },
        { id: 501, movieId: 83, eventType: 'grabbed', downloadId: 'dl-del-err', sourceTitle: 'Bad.Release', date: '2026-11-22T04:00:00Z', data: {} }
      ]
    })
  };
  const user = await invoke(`${contentRoot}/${fileName}`, '[Source media corruption] Invalid bitstream', testEnvironment(mocks), mocks);
  assert.deepEqual(mocks.movie.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`), [
    'POST /api/v3/history/failed/501',
    'DELETE /api/v3/moviefile/501',
    'POST /api/v3/command'
  ]);
  assert.equal(user.arr_corruption_blocklist_status, 'blocklisted');
  assert.equal(user.arr_corruption_delete_status, 'failed');
  assert.equal(user.arr_corruption_search_status, 'requested');
});

test('non-corruption paths never query history, blocklist, or delete Arr files', { skip: !envConfigReady }, async () => {
  const contentRoot = '/media/movies/Test Film';
  const fileName = 'Test Film.mkv';
  const mocks = {
    anime: createExtendedMock('sonarr', '/media/anime/Other', fileName, 81),
    tv: createExtendedMock('sonarr', '/media/tv/Other', fileName, 82),
    movie: createExtendedMock('radarr', contentRoot, `${fileName.replace('.mkv', '.iso')}`, 83)
  };
  const isoUser = await invoke(`${contentRoot}/Test Film.iso`, 'Disc image removed; check the Arr rescan log.', testEnvironment(mocks), mocks);
  assert.equal(isoUser.arr_corruption_blocklist_status, 'not_applicable');
  assert.equal(isoUser.arr_corruption_delete_status, 'not_applicable');
  assert.equal(mocks.movie.calls.some(c => c.path.includes('history') || c.method === 'DELETE'), false);

  mocks.movie.calls.length = 0;
  const candUser = await invoke(`${contentRoot}/${fileName}`, '[Source media corruption] Invalid data found', testEnvironment(mocks), mocks, { outcome: 'rejected', failure: { sourceCorruption: false } });
  assert.equal(candUser.arr_corruption_blocklist_status, 'not_applicable');
  assert.equal(candUser.arr_corruption_delete_status, 'not_applicable');
  assert.equal(mocks.movie.calls.length, 0);
});
