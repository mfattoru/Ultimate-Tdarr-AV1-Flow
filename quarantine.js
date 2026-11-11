// Durable candidates are stored outside the media library so scanners never
// ingest an unapproved output. All manifest paths are derived from validated
// identifiers; a manifest cannot direct cleanup to an arbitrary filesystem path.
const quarantineFs = require('fs');
const quarantinePath = require('path');
const quarantineCrypto = require('crypto');
const QUARANTINE_DIRECTORY = 'tdarr-av1-quarantine';
const QUARANTINE_MANIFEST_MAX_BYTES = 64 * 1024;
const QUARANTINE_CHUNK_BYTES = 1024 * 1024;
const QUARANTINE_ID_RE = /^[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{24}$/;
const QUARANTINE_HASH_RE = /^[a-f0-9]{64}$/;
const QUARANTINE_MARKERS = new Set([
  'ArcAV1_QSV_V15',
  'ArcAV1_SVTAV1_HDRFallback_V15',
  'ArcAV1_SeekHeal_V15'
]);
const QUARANTINE_KINDS = new Set(['qsv_av1_encode', 'svt_av1_encode', 'seek_heal_remux']);

function quarantineRootPath(root) {
  if (typeof root !== 'string' || !quarantinePath.isAbsolute(root)) throw Error('Quarantine root must be an absolute existing directory');
  const real = quarantineFs.realpathSync(root);
  if (!quarantineFs.statSync(real).isDirectory()) throw Error('Quarantine root must be a directory');
  return real;
}

function quarantineAssertOutsideLibraries(root, libraryRoots) {
  const roots=Array.isArray(libraryRoots)
    ? libraryRoots.filter(folder=>typeof folder==='string'&&quarantinePath.isAbsolute(folder))
    : [];
  if(!roots.length)throw Error('Cannot confirm quarantine is outside scanned libraries; the current library folder is unavailable');
  const quarantineDirectory=quarantinePath.join(root,QUARANTINE_DIRECTORY);
  for(const folder of roots){
    let libraryRoot;
    try{libraryRoot=quarantineFs.realpathSync(folder);}
    catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(!quarantineFs.statSync(libraryRoot).isDirectory())throw Error('Tdarr library root is not a directory');
    const relative=quarantinePath.relative(libraryRoot,quarantineDirectory);
    const inside=relative===''||(relative!=='..'&&!relative.startsWith(`..${quarantinePath.sep}`)&&!quarantinePath.isAbsolute(relative));
    if(inside)throw Error(`Quarantine directory ${quarantineDirectory} is inside scanned library ${libraryRoot}`);
  }
}

function quarantineSourcePath(sourcePath) {
  if (typeof sourcePath !== 'string' || !quarantinePath.isAbsolute(sourcePath)) throw Error('Quarantine source path must be absolute');
  const real = quarantineFs.realpathSync(sourcePath);
  if (!quarantineFs.statSync(real).isFile()) throw Error('Quarantine source must be a regular file');
  return real;
}

function quarantineEnsureDirectory(root) {
  const directory = quarantinePath.join(root, QUARANTINE_DIRECTORY);
  try { quarantineFs.mkdirSync(directory, {mode: 0o700}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const entry = quarantineFs.lstatSync(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error('Quarantine directory is not a regular directory');
  if (quarantineFs.realpathSync(directory) !== directory) throw Error('Quarantine directory resolves outside its configured root');
  return directory;
}

function quarantineHashFile(filePath) {
  const fd = quarantineFs.openSync(filePath, 'r');
  try {
    const before = quarantineFs.fstatSync(fd, {bigint: true});
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Quarantine content is not a supported regular file');
    const buffer = Buffer.allocUnsafe(QUARANTINE_CHUNK_BYTES);
    const hash = quarantineCrypto.createHash('sha256');
    const size = Number(before.size);
    for (let position = 0; position < size; position += QUARANTINE_CHUNK_BYTES) {
      const wanted = Math.min(QUARANTINE_CHUNK_BYTES, size - position);
      let total = 0;
      while (total < wanted) {
        const count = quarantineFs.readSync(fd, buffer, total, wanted - total, position + total);
        if (count === 0) throw Error('Quarantine content changed or ended during hashing');
        total += count;
      }
      hash.update(buffer.subarray(0, wanted));
    }
    const after = quarantineFs.fstatSync(fd, {bigint: true});
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw Error('Quarantine content changed while hashing');
    }
    return hash.digest('hex');
  } finally {
    quarantineFs.closeSync(fd);
  }
}

function quarantinePathKey(sourcePath) {
  return quarantineCrypto.createHash('sha256').update(sourcePath).digest('hex');
}

function quarantineReadManifest(directory, manifestName) {
  if (typeof manifestName !== 'string' || !/^[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{24}\.json$/.test(manifestName)) {
    throw Error('Invalid quarantine manifest name');
  }
  const id = manifestName.slice(0, -5);
  const manifestPath = quarantinePath.join(directory, manifestName);
  const stat = quarantineFs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > QUARANTINE_MANIFEST_MAX_BYTES) throw Error('Quarantine manifest is not a bounded regular file');
  const manifest = JSON.parse(quarantineFs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || manifest.version !== 1 || manifest.id !== id
      || typeof manifest.sourcePath !== 'string' || !quarantinePath.isAbsolute(manifest.sourcePath)
      || manifest.sourcePath !== quarantinePath.resolve(manifest.sourcePath)
      || !QUARANTINE_HASH_RE.test(String(manifest.sourceHash || ''))
      || manifest.candidateName !== `${id}.mkv`
      || !QUARANTINE_HASH_RE.test(String(manifest.candidateHash || ''))
      || !QUARANTINE_MARKERS.has(manifest.marker)
      || !QUARANTINE_KINDS.has(manifest.kind)
      || !manifest.validationReport || typeof manifest.validationReport !== 'object' || Array.isArray(manifest.validationReport)) {
    throw Error(`Invalid quarantine manifest fields: ${manifestName}`);
  }
  return {id, manifest, manifestPath, candidatePath: quarantinePath.join(directory, manifest.candidateName)};
}

function quarantineVerifyCandidate(entry, allowMissing = false) {
  try {
    const stat = quarantineFs.lstatSync(entry.candidatePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Quarantine candidate is not a regular file');
    if (quarantineFs.realpathSync(entry.candidatePath) !== entry.candidatePath) throw Error('Quarantine candidate resolves outside its directory');
    if (quarantineHashFile(entry.candidatePath) !== entry.manifest.candidateHash) throw Error('Quarantine candidate SHA-256 does not match its manifest');
    return true;
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return false;
    throw error;
  }
}

function quarantineEntry(root, directory, loaded) {
  const sourceKey = loaded.id.split('-')[0];
  return {
    version: 1,
    id: loaded.id,
    root,
    quarantineRoot: directory,
    manifestPath: loaded.manifestPath,
    candidatePath: loaded.candidatePath,
    sourceKey,
    sourcePath: loaded.manifest.sourcePath,
    sourceHash: loaded.manifest.sourceHash,
    candidateHash: loaded.manifest.candidateHash,
    marker: loaded.manifest.marker,
    kind: loaded.manifest.kind,
    validationReport: loaded.manifest.validationReport
  };
}

function quarantineLoadEntry(entry, allowMissingCandidate = false) {
  if (!entry || entry.version !== 1 || !QUARANTINE_ID_RE.test(String(entry.id || ''))) throw Error('Invalid quarantine entry handle');
  const root = quarantineRootPath(entry.root);
  const directory = quarantinePath.join(root, QUARANTINE_DIRECTORY);
  if (entry.quarantineRoot !== directory || entry.manifestPath !== quarantinePath.join(directory, `${entry.id}.json`)
      || entry.candidatePath !== quarantinePath.join(directory, `${entry.id}.mkv`)) throw Error('Quarantine entry paths do not match their identifier');
  const loaded = quarantineReadManifest(directory, `${entry.id}.json`);
  if (loaded.manifest.sourcePath !== entry.sourcePath || loaded.manifest.sourceHash !== entry.sourceHash
      || loaded.manifest.candidateHash !== entry.candidateHash) throw Error('Quarantine entry no longer matches its manifest');
  quarantineVerifyCandidate(loaded, allowMissingCandidate);
  return {root, directory, loaded};
}

function quarantineSafeReport(report) {
  let safe;
  try { safe = JSON.parse(JSON.stringify(report || {})); }
  catch (_) { safe = {outcome: 'inconclusive', stage: 'unknown', message: 'Validation report was not JSON serializable'}; }
  let serialized = JSON.stringify(safe);
  if (Buffer.byteLength(serialized, 'utf8') > QUARANTINE_MANIFEST_MAX_BYTES / 2) {
    safe = {
      outcome: String(safe.outcome || 'inconclusive').slice(0, 32),
      stage: String(safe.stage || 'unknown').slice(0, 64),
      failure: {
        code: String(safe.failure?.code || '').slice(0, 80),
        message: String(safe.failure?.message || '').slice(-1200)
      },
      truncated: true
    };
    serialized = JSON.stringify(safe);
  }
  if (Buffer.byteLength(serialized, 'utf8') > QUARANTINE_MANIFEST_MAX_BYTES / 2) throw Error('Validation report exceeds the quarantine manifest size limit');
  return safe;
}

function quarantineWriteManifest(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.${quarantineCrypto.randomBytes(12).toString('hex')}.tmp`;
  try {
    quarantineFs.writeFileSync(temporaryPath, JSON.stringify(manifest), {flag: 'wx', mode: 0o600});
    quarantineFs.renameSync(temporaryPath, manifestPath);
  } catch (error) {
    try { quarantineFs.unlinkSync(temporaryPath); } catch (_) {}
    throw error;
  }
}

async function findQuarantineCandidate({root, sourcePath, sourceHash, libraryRoots}) {
  root = quarantineRootPath(root);
  quarantineAssertOutsideLibraries(root,libraryRoots);
  const canonicalSource = quarantineSourcePath(sourcePath);
  const directory = quarantinePath.join(root, QUARANTINE_DIRECTORY);
  try {
    const stat = quarantineFs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || quarantineFs.realpathSync(directory) !== directory) throw Error('Invalid quarantine directory');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const sourceKey = quarantinePathKey(canonicalSource);
  const prefix = `${sourceKey}-`;
  const names = quarantineFs.readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith('.json')).sort().reverse();
  if (names.length === 0) return null;
  const expectedHash = sourceHash === undefined ? quarantineHashFile(canonicalSource) : sourceHash;
  if (!QUARANTINE_HASH_RE.test(String(expectedHash || ''))) throw Error('Invalid source SHA-256 for quarantine lookup');
  for (const name of names) {
    try {
      const loaded = quarantineReadManifest(directory, name);
      if (loaded.manifest.sourcePath !== canonicalSource || loaded.manifest.sourceHash !== expectedHash) continue;
      quarantineVerifyCandidate(loaded);
      return quarantineEntry(root, directory, loaded);
    } catch (_) {
      // A damaged entry is not reusable, but it must not block another valid
      // candidate for this same source path and content hash.
      continue;
    }
  }
  return null;
}

async function storeQuarantineCandidate({root, sourcePath, sourceHash, candidatePath, marker, kind, validationReport, assertSourceUnchanged, libraryRoots}) {
  root = quarantineRootPath(root);
  quarantineAssertOutsideLibraries(root,libraryRoots);
  const canonicalSource = quarantineSourcePath(sourcePath);
  if ((sourceHash !== undefined && !QUARANTINE_HASH_RE.test(String(sourceHash || ''))) || !QUARANTINE_MARKERS.has(marker) || !QUARANTINE_KINDS.has(kind)) throw Error('Invalid quarantine source hash, marker, or candidate kind');
  if (typeof candidatePath !== 'string' || !quarantinePath.isAbsolute(candidatePath)) throw Error('Quarantine candidate path must be absolute');
  const canonicalCandidate = quarantineFs.realpathSync(candidatePath);
  const sourceEntry = quarantineFs.lstatSync(canonicalCandidate);
  if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink() || !/^tdarr-av1-[A-Za-z0-9_-]+$/.test(quarantinePath.basename(quarantinePath.dirname(canonicalCandidate)))) {
    throw Error('Candidate must be a regular output file in a job-owned Tdarr cache directory');
  }
  if (typeof assertSourceUnchanged === 'function') assertSourceUnchanged();
  const verifiedSourceHash = quarantineHashFile(canonicalSource);
  if (sourceHash !== undefined && verifiedSourceHash !== sourceHash) throw Error('Source SHA-256 changed before quarantine storage');
  sourceHash = verifiedSourceHash;
  if (typeof assertSourceUnchanged === 'function') assertSourceUnchanged();
  if (sourceEntry.size < 1) throw Error('Refusing to quarantine an empty candidate file');
  const candidateHash = quarantineHashFile(canonicalCandidate);
  if (typeof assertSourceUnchanged === 'function') assertSourceUnchanged();
  const directory = quarantineEnsureDirectory(root);
  const id = `${quarantinePathKey(canonicalSource)}-${sourceHash}-${quarantineCrypto.randomBytes(12).toString('hex')}`;
  const installedCandidate = quarantinePath.join(directory, `${id}.mkv`);
  const manifestPath = quarantinePath.join(directory, `${id}.json`);
  const safeReport = quarantineSafeReport(validationReport);
  const manifest = {
    version: 1,
    id,
    sourcePath: canonicalSource,
    sourceHash,
    candidateName: `${id}.mkv`,
    candidateHash,
    marker,
    kind,
    validationReport: safeReport,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  let moved = false, installed = false, manifestInstalled = false, temporaryReservation = null;
  const temporaryCopy = quarantinePath.join(directory, `.${id}.copying`);
  try {
    const sourceDevice = quarantineFs.statSync(canonicalCandidate, {bigint: true}).dev;
    const destinationDevice = quarantineFs.statSync(directory, {bigint: true}).dev;
    const copyCandidate = async () => {
      if (typeof reserveCapacity !== 'function' || typeof releaseCapacity !== 'function') throw Error('Cross-filesystem quarantine copy requires the reservation ledger');
      temporaryReservation = await reserveCapacity({root, candidate: directory, bytes: BigInt(sourceEntry.size), floorBytes: 0n});
      quarantineFs.copyFileSync(canonicalCandidate, temporaryCopy, quarantineFs.constants.COPYFILE_EXCL);
      if (quarantineHashFile(temporaryCopy) !== candidateHash) throw Error('Cross-filesystem quarantine copy failed SHA-256 verification');
      quarantineFs.renameSync(temporaryCopy, installedCandidate);
    };
    if (sourceDevice === destinationDevice) {
      try {
        quarantineFs.renameSync(canonicalCandidate, installedCandidate);
        moved = true;
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await copyCandidate();
      }
    } else {
      await copyCandidate();
    }
    installed = true;
    if (quarantineHashFile(installedCandidate) !== candidateHash) throw Error('Installed quarantine candidate SHA-256 does not match its source');
    if (typeof assertSourceUnchanged === 'function') assertSourceUnchanged();
    quarantineWriteManifest(manifestPath, manifest);
    manifestInstalled = true;
    const entry = quarantineEntry(root, directory, quarantineReadManifest(directory, `${id}.json`));
    if (temporaryReservation) {
      await releaseCapacity(temporaryReservation);
      temporaryReservation = null;
    }
    return entry;
  } catch (error) {
    if (manifestInstalled) { try { quarantineFs.unlinkSync(manifestPath); } catch (_) {} }
    if (installed) {
      if (moved) {
        try { quarantineFs.renameSync(installedCandidate, canonicalCandidate); }
        catch (_) { error.message = `${error.message || error}; candidate remains at ${installedCandidate}`; }
      } else {
        try { quarantineFs.unlinkSync(installedCandidate); } catch (_) {}
      }
    }
    try { quarantineFs.unlinkSync(temporaryCopy); } catch (_) {}
    throw error;
  } finally {
    if (temporaryReservation) {
      try { await releaseCapacity(temporaryReservation); }
      catch (_) {}
    }
  }
}

async function updateQuarantineFailure(entry, validationReport) {
  const {root, directory, loaded} = quarantineLoadEntry(entry);
  const manifest = {
    ...loaded.manifest,
    validationReport: quarantineSafeReport(validationReport),
    updatedAt: new Date().toISOString()
  };
  quarantineWriteManifest(loaded.manifestPath, manifest);
  return quarantineEntry(root, directory, quarantineReadManifest(directory, `${loaded.id}.json`));
}

async function removeQuarantineCandidate(entry) {
  const {directory, loaded} = quarantineLoadEntry(entry, true);
  try { quarantineFs.unlinkSync(loaded.candidatePath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  quarantineFs.unlinkSync(loaded.manifestPath);
}

async function removeQuarantineCandidatesForSource({root, sourcePath, libraryRoots}) {
  root = quarantineRootPath(root);
  quarantineAssertOutsideLibraries(root,libraryRoots);
  const canonicalSource = quarantineSourcePath(sourcePath);
  const directory = quarantinePath.join(root, QUARANTINE_DIRECTORY);
  try {
    const stat = quarantineFs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || quarantineFs.realpathSync(directory) !== directory) throw Error('Invalid quarantine directory');
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  const prefix = `${quarantinePathKey(canonicalSource)}-`;
  const names = quarantineFs.readdirSync(directory).filter(name => {
    if(!name.startsWith(prefix)||!name.endsWith('.json'))return false;
    return QUARANTINE_ID_RE.test(name.slice(0,-5));
  });
  let removed = 0;
  for (const name of names) {
    const id=name.slice(0,-5);
    const candidatePath=quarantinePath.join(directory,`${id}.mkv`);
    // Force-fresh is an explicit request to discard this source's stored copy.
    // The path key and candidate name are derived from the exact source and a
    // validated identifier; don't let one malformed manifest block the purge.
    try {
      const candidate = quarantineFs.lstatSync(candidatePath);
      if (candidate.isFile() || candidate.isSymbolicLink()) quarantineFs.unlinkSync(candidatePath);
      else throw Error('Quarantine candidate path is not a removable file');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    quarantineFs.unlinkSync(quarantinePath.join(directory,name));
    removed++;
  }
  return removed;
}

if (typeof module !== 'undefined') module.exports = {
  findQuarantineCandidate,
  storeQuarantineCandidate,
  updateQuarantineFailure,
  removeQuarantineCandidate,
  removeQuarantineCandidatesForSource
};
