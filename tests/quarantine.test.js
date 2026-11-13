const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {reserveCapacity,releaseCapacity} = require('../src/reservations');
const {
  findQuarantineCandidate,
  storeQuarantineCandidate,
  updateQuarantineFailure,
  removeQuarantineCandidate,
  removeQuarantineCandidatesForSource
} = require('../src/quarantine');

function makeFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-quarantine-suite-'));
  t.after(() => fs.rmSync(base, {recursive:true,force:true}));
  const library = path.join(base, 'library');
  const cache = path.join(base, 'cache');
  fs.mkdirSync(library);fs.mkdirSync(cache);
  const sourcePath = path.join(library, 'source.mkv');
  fs.writeFileSync(sourcePath, 'original media bytes');
  return {base,library,cache,sourcePath};
}

function makeCandidate(fixture, name, contents='complete candidate bytes') {
  const scratch = path.join(fixture.base, 'scratch', `tdarr-av1-${name}`);
  fs.mkdirSync(scratch, {recursive:true});
  const candidatePath = path.join(scratch, 'candidate.mkv');
  fs.writeFileSync(candidatePath, contents);
  return candidatePath;
}

function store(fixture, candidatePath, overrides={}) {
  return storeQuarantineCandidate({
    root:fixture.cache,
    sourcePath:fixture.sourcePath,
    candidatePath,
    marker:'ArcAV1_QSV_V15',
    kind:'qsv_av1_encode',
    validationReport:{outcome:'inconclusive',stage:'audio_decode'},
    libraryRoots:[fixture.library],
    ...overrides
  });
}

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

test('stored candidates can be found, updated and explicitly removed', async t => {
  const fixture=makeFixture(t),candidatePath=makeCandidate(fixture,'roundtrip');
  const entry=await store(fixture,candidatePath);
  assert.equal(fs.existsSync(candidatePath),false,'same-filesystem storage moves the candidate into quarantine');
  assert.equal(fs.readFileSync(entry.candidatePath,'utf8'),'complete candidate bytes');
  assert.match(entry.sourceHash,/^[a-f0-9]{64}$/);

  const found=await findQuarantineCandidate({root:fixture.cache,sourcePath:fixture.sourcePath,libraryRoots:[fixture.library]});
  assert.equal(found.id,entry.id);
  assert.equal(await findQuarantineCandidate({root:fixture.cache,sourcePath:fixture.sourcePath,sourceHash:'f'.repeat(64),libraryRoots:[fixture.library]}),null);

  const report={outcome:'rejected',stage:'video_decode',failure:{code:'frame_mismatch'}};
  const updated=await updateQuarantineFailure(found,report);
  assert.deepEqual(updated.validationReport,report);
  assert.deepEqual(JSON.parse(fs.readFileSync(updated.manifestPath,'utf8')).validationReport,report);

  await removeQuarantineCandidate(updated);
  assert.equal(fs.existsSync(updated.candidatePath),false);
  assert.equal(fs.existsSync(updated.manifestPath),false);
  assert.equal(await findQuarantineCandidate({root:fixture.cache,sourcePath:fixture.sourcePath,libraryRoots:[fixture.library]}),null);
});

test('quarantine removal also deletes associated precheck evidence',async t=>{
  const fixture=makeFixture(t),entry=await store(fixture,makeCandidate(fixture,'precheck-cleanup'));
  const evidencePath=`${entry.candidatePath}.prechecks.gz`;
  fs.writeFileSync(evidencePath,'cached evidence');
  await removeQuarantineCandidate(entry);
  assert.equal(fs.existsSync(evidencePath),false);
});
test('force-fresh purge also deletes associated precheck evidence',async t=>{
  const fixture=makeFixture(t),entry=await store(fixture,makeCandidate(fixture,'precheck-purge'));
  const evidencePath=`${entry.candidatePath}.prechecks.gz`;
  fs.writeFileSync(evidencePath,'cached evidence');
  assert.equal(await removeQuarantineCandidatesForSource({root:fixture.cache,sourcePath:fixture.sourcePath,libraryRoots:[fixture.library]}),1);
  assert.equal(fs.existsSync(evidencePath),false);
});

test('a missing candidate can be removed without leaving its manifest reusable', async t => {
  const fixture=makeFixture(t),entry=await store(fixture,makeCandidate(fixture,'missing'));
  fs.unlinkSync(entry.candidatePath);
  await removeQuarantineCandidate(entry);
  assert.equal(fs.existsSync(entry.manifestPath),false);
});

test('lookup skips a damaged newer manifest and still returns an older verified candidate', async t => {
  const fixture=makeFixture(t),entry=await store(fixture,makeCandidate(fixture,'lookup'));
  const sourceKey=crypto.createHash('sha256').update(fixture.sourcePath).digest('hex');
  const id=`${sourceKey}-${entry.sourceHash}-${'f'.repeat(24)}`;
  const directory=path.join(fixture.cache,'tdarr-av1-quarantine');
  fs.writeFileSync(path.join(directory,`${id}.json`),JSON.stringify({
    version:1,id,sourcePath:fixture.sourcePath,sourceHash:entry.sourceHash,
    candidateName:`${id}.mkv`,candidateHash:entry.candidateHash,
    marker:'untrusted-marker',kind:'qsv_av1_encode',validationReport:{}
  }));
  const found=await findQuarantineCandidate({root:fixture.cache,sourcePath:fixture.sourcePath,libraryRoots:[fixture.library]});
  assert.equal(found.id,entry.id,'invalid entries must not block a separately verified candidate');
});

test('changed candidate bytes are never returned from quarantine lookup', async t => {
  const fixture=makeFixture(t),entry=await store(fixture,makeCandidate(fixture,'tamper'));
  fs.writeFileSync(entry.candidatePath,'changed after verification');
  assert.equal(await findQuarantineCandidate({root:fixture.cache,sourcePath:fixture.sourcePath,libraryRoots:[fixture.library]}),null);
});

test('force-fresh purge removes every candidate for only the requested source', async t => {
  const fixture=makeFixture(t);
  const first=await store(fixture,makeCandidate(fixture,'purge-a1'));
  const second=await store(fixture,makeCandidate(fixture,'purge-a2'));
  const otherSource=path.join(fixture.library,'other.mkv');
  fs.writeFileSync(otherSource,'other original');
  const otherCandidate=makeCandidate(fixture,'purge-b');
  const other=await store(fixture,otherCandidate,{sourcePath:otherSource});

  assert.equal(await removeQuarantineCandidatesForSource({root:fixture.cache,sourcePath:fixture.sourcePath,libraryRoots:[fixture.library]}),2);
  assert.equal(fs.existsSync(first.manifestPath),false);
  assert.equal(fs.existsSync(second.candidatePath),false);
  assert.equal(fs.existsSync(other.manifestPath),true);
  assert.equal(await removeQuarantineCandidatesForSource({root:fixture.cache,sourcePath:fixture.sourcePath,libraryRoots:[fixture.library]}),0);
});

test('purge tolerates a missing quarantine directory and a missing candidate file', async t => {
  const fixture=makeFixture(t);
  assert.equal(await removeQuarantineCandidatesForSource({root:fixture.cache,sourcePath:fixture.sourcePath,libraryRoots:[fixture.library]}),0);
  const entry=await store(fixture,makeCandidate(fixture,'purge-missing'));
  fs.unlinkSync(entry.candidatePath);
  assert.equal(await removeQuarantineCandidatesForSource({root:fixture.cache,sourcePath:fixture.sourcePath,libraryRoots:[fixture.library]}),1);
  assert.equal(fs.existsSync(entry.manifestPath),false);
});

test('validation reports are safely serialized and truncated before manifest storage', async t => {
  const fixture=makeFixture(t),candidatePath=makeCandidate(fixture,'report');
  const report={outcome:'rejected',stage:'video_decode',failure:{code:'diagnostic',message:'x'.repeat(40000)}};
  const entry=await store(fixture,candidatePath,{validationReport:report});
  const safe=JSON.parse(fs.readFileSync(entry.manifestPath,'utf8')).validationReport;
  assert.equal(safe.truncated,true);
  assert.equal(safe.failure.message.length,1200);

  const circular={};circular.self=circular;
  const second=await store(fixture,makeCandidate(fixture,'circular'),{validationReport:circular});
  assert.deepEqual(JSON.parse(fs.readFileSync(second.manifestPath,'utf8')).validationReport,{
    outcome:'inconclusive',stage:'unknown',message:'Validation report was not JSON serializable'
  });
});

test('source changes during quarantine storage roll the candidate back to its job cache', async t => {
  const fixture=makeFixture(t),candidatePath=makeCandidate(fixture,'rollback');
  let checks=0;
  await assert.rejects(store(fixture,candidatePath,{assertSourceUnchanged(){if(++checks===4)throw Error('source changed during install');}}),/source changed during install/);
  assert.equal(fs.readFileSync(candidatePath,'utf8'),'complete candidate bytes');
  const directory=path.join(fixture.cache,'tdarr-av1-quarantine');
  assert.deepEqual(fs.readdirSync(directory),[],'failed storage removes its installed candidate and manifest');
});

test('quarantine refuses library-local roots, missing library scope, invalid identities and empty candidates', async t => {
  const fixture=makeFixture(t),candidatePath=makeCandidate(fixture,'invalid');
  await assert.rejects(store(fixture,candidatePath,{libraryRoots:[]}),/Cannot confirm quarantine is outside scanned libraries/);
  await assert.rejects(store(fixture,candidatePath,{root:fixture.library}),/inside scanned library/);
  await assert.rejects(store(fixture,candidatePath,{sourceHash:'not-a-hash'}),/Invalid quarantine source hash/);
  await assert.rejects(store(fixture,candidatePath,{marker:'unknown'}),/Invalid quarantine source hash/);
  await assert.rejects(store(fixture,candidatePath,{kind:'unknown'}),/Invalid quarantine source hash/);
  const empty=makeCandidate(fixture,'empty','');
  await assert.rejects(store(fixture,empty),/empty candidate/);
});

test('failed post-install manifest write restores a moved candidate', async t => {
  const fixture=makeFixture(t),candidatePath=makeCandidate(fixture,'manifest-rollback');
  const originalRename=fs.renameSync;
  let failedManifest=false;
  fs.renameSync=function(from,to,...args){
    if(!failedManifest&&String(from).endsWith('.tmp')&&String(to).endsWith('.json')){
      failedManifest=true;throw Error('simulated manifest install failure');
    }
    return originalRename.call(this,from,to,...args);
  };
  try {
    await assert.rejects(store(fixture,candidatePath),/simulated manifest install failure/);
  } finally {fs.renameSync=originalRename;}
  assert.equal(failedManifest,true);
  assert.equal(fs.readFileSync(candidatePath,'utf8'),'complete candidate bytes');
  assert.deepEqual(fs.readdirSync(path.join(fixture.cache,'tdarr-av1-quarantine')),[]);
});

test('findQuarantineCandidate returns null when quarantine dir is missing and skips damaged manifests', async t => {
  const fixture=makeFixture(t);
  assert.equal(await findQuarantineCandidate({root:fixture.cache,sourcePath:fixture.sourcePath,libraryRoots:[fixture.library]}),null);

  const candidatePath=makeCandidate(fixture,'damaged');
  const entry=await store(fixture,candidatePath);
  const qDir=path.dirname(entry.manifestPath);
  // Write a corrupt manifest with the same source key prefix so it is read and skipped
  const badManifest=path.join(qDir,`${entry.sourceKey}-${entry.sourceHash}-${'0'.repeat(24)}.json`);
  fs.writeFileSync(badManifest,'{not valid json');
  const found=await findQuarantineCandidate({root:fixture.cache,sourcePath:fixture.sourcePath,libraryRoots:[fixture.library]});
  assert.equal(found.id,entry.id);
});

test('storeQuarantineCandidate truncates oversized validation reports cleanly', async t => {
  const fixture=makeFixture(t),candidatePath=makeCandidate(fixture,'big-report');
  const entry=await store(fixture,candidatePath,{
    validationReport:{outcome:'rejected',stage:'video_decode',failure:{code:'x',message:'a'.repeat(50000)}}
  });
  assert.equal(entry.validationReport.truncated,true);
  assert.equal(entry.validationReport.failure.message.length,1200);
});
