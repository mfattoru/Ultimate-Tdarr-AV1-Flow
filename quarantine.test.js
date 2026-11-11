const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {reserveCapacity,releaseCapacity} = require('./reservations');
const {storeQuarantineCandidate} = require('./quarantine');

test('a rename that reports EXDEV stores the complete candidate through a reserved copy', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-quarantine-exdev-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const library = path.join(root, 'library');
  const cache = path.join(root, 'cache');
  const scratch = path.join(root, 'scratch', 'tdarr-av1-job');
  fs.mkdirSync(library);
  fs.mkdirSync(cache);
  fs.mkdirSync(scratch, {recursive:true});
  const sourcePath = path.join(library, 'source.mkv');
  const candidatePath = path.join(scratch, 'candidate.mkv');
  fs.writeFileSync(sourcePath, 'original media bytes');
  fs.writeFileSync(candidatePath, 'complete candidate bytes');

  const originalRename = fs.renameSync;
  let simulatedExdev = false;
  const canonicalCandidatePath = fs.realpathSync(candidatePath);
  const quarantineDirectory = path.join(fs.realpathSync(cache), 'tdarr-av1-quarantine');
  fs.renameSync = function(from, to, ...args) {
    if (!simulatedExdev && from === canonicalCandidatePath && path.dirname(to) === quarantineDirectory) {
      simulatedExdev = true;
      const error = Error('simulated cross-filesystem rename');
      error.code = 'EXDEV';
      throw error;
    }
    return originalRename.call(this, from, to, ...args);
  };
  const previousReserve = global.reserveCapacity;
  const previousRelease = global.releaseCapacity;
  global.reserveCapacity = reserveCapacity;
  global.releaseCapacity = releaseCapacity;
  t.after(() => {
    fs.renameSync = originalRename;
    if (previousReserve === undefined) delete global.reserveCapacity;
    else global.reserveCapacity = previousReserve;
    if (previousRelease === undefined) delete global.releaseCapacity;
    else global.releaseCapacity = previousRelease;
  });

  const entry = await storeQuarantineCandidate({
    root: cache,
    sourcePath,
    candidatePath,
    marker: 'ArcAV1_QSV_V15',
    kind: 'qsv_av1_encode',
    validationReport: {outcome:'inconclusive',stage:'audio_decode',failure:{code:'decode_unverified'}},
    libraryRoots: [library]
  });

  assert.equal(simulatedExdev, true);
  assert.equal(fs.readFileSync(entry.candidatePath, 'utf8'), 'complete candidate bytes');
  assert.equal(fs.readFileSync(candidatePath, 'utf8'), 'complete candidate bytes');
  assert.equal(fs.existsSync(entry.manifestPath), true);
  const ledger = path.join(fs.realpathSync(cache), '.tdarr-av1-reservations');
  assert.deepEqual(fs.readdirSync(ledger).filter(name => name.endsWith('.json')), []);
});
