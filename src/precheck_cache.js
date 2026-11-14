const precheckFs = require('fs');
const precheckPath = require('path');
const precheckCrypto = require('crypto');
const precheckZlib = require('zlib');

const PRECHECK_HASH_RE = /^[a-f0-9]{64}$/;
const PRECHECK_ID_RE = /^[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{24}$/;
const PRECHECK_SOURCE_FILE_RE = /^([a-f0-9]{64})-([a-f0-9]{64})\.prechecks\.gz$/;
const PRECHECK_MAX_RAW = 16 * 1024 * 1024;
const PRECHECK_MAX_COMPRESSED = 4 * 1024 * 1024;

/** Verify quarantine root and directory exist on canonical paths without symlink hops. */
function precheckAssertDirectory(entry) {
  const root = precheckFs.realpathSync(String(entry?.root || ''));
  const directory = precheckPath.join(root, 'tdarr-av1-quarantine');
  if (entry?.quarantineRoot !== directory || precheckFs.realpathSync(directory) !== directory) {
    throw Error('Invalid precheck cache path');
  }
  return directory;
}

/** Return legacy candidate-coupled precheck path (maintained for compatibility tests). */
function precheckPathFor(entry) {
  const id = String(entry?.id || ''), sourceHash = String(entry?.sourceHash || '');
  if (!PRECHECK_ID_RE.test(id) || id.split('-')[1] !== sourceHash) {
    throw Error('Invalid precheck source identity');
  }
  const directory = precheckAssertDirectory(entry);
  if (entry.candidatePath !== precheckPath.join(directory, `${id}.mkv`)) {
    throw Error('Invalid precheck cache path');
  }
  return `${entry.candidatePath}.prechecks.gz`;
}

/** Return canonical source-scoped precheck path (<sourceKey>-<sourceHash>.prechecks.gz). */
function sourcePrecheckPathFor(entry) {
  const idParts = PRECHECK_ID_RE.test(String(entry?.id || '')) ? String(entry.id).split('-') : null;
  const sourceKey = String(entry?.sourceKey || idParts?.[0] || '');
  const sourceHash = String(entry?.sourceHash || '');
  if (!PRECHECK_HASH_RE.test(sourceKey) || !PRECHECK_HASH_RE.test(sourceHash)) {
    throw Error('Invalid precheck source identity');
  }
  if (idParts && (idParts[0] !== sourceKey || idParts[1] !== sourceHash)) {
    throw Error('Invalid precheck source identity');
  }
  const directory = precheckAssertDirectory(entry);
  return precheckPath.join(directory, `${sourceKey}-${sourceHash}.prechecks.gz`);
}

/** Return candidate frame-scan cache path (${candidatePath}.frames.gz). */
function candidateFramesPathFor(entry) {
  const id = String(entry?.id || ''), candidateHash = String(entry?.candidateHash || '');
  if (!PRECHECK_ID_RE.test(id) || !PRECHECK_HASH_RE.test(candidateHash)) {
    throw Error('Invalid candidate frames identity');
  }
  const directory = precheckAssertDirectory(entry);
  if (entry.candidatePath !== precheckPath.join(directory, `${id}.mkv`)) {
    throw Error('Invalid candidate frames cache path');
  }
  return `${entry.candidatePath}.frames.gz`;
}

/** Validate serialized frame scan structure reused by source and candidate caches. */
function validFrameScanEvidence(f, { requireStaticInfo = true } = {}) {
  const staticOk = !requireStaticInfo ? (f?.staticInfo === undefined || (!!f.staticInfo && typeof f.staticInfo === 'object')) : (!!f?.staticInfo && typeof f.staticInfo === 'object');
  const timestampsOk = f?.timestamps === undefined
    ? !requireStaticInfo
    : Array.isArray(f.timestamps) && f.timestamps.length === f.frames && f.timestamps.every(Number.isFinite);
  return !!f && Number.isSafeInteger(f.frames) && f.frames > 0
    && timestampsOk
    && ['interlaced', 'dovi', 'hdr10plus', 'otherDynamic'].every(k => Number.isSafeInteger(f[k]) && f[k] >= 0)
    && staticOk
    && !!f.colorInfo && typeof f.colorInfo === 'object';
}

/** Validate serialized audio precheck stream metadata and DTS repair records. */
function validAudioPrecheckEvidence(a) {
  return !!a && Array.isArray(a.streams) && Array.isArray(a.repairs)
    && a.streams.every(s => Number.isSafeInteger(s.index) && s.index >= 0 && typeof s.timeBase === 'string')
    && a.repairs.every(r => Array.isArray(r) && r.length === 2 && Number.isSafeInteger(r[0]) && r[1] && typeof r[1] === 'object');
}

function validPrecheckEvidence(data) {
  return validFrameScanEvidence(data?.frameScan) && validAudioPrecheckEvidence(data?.audio);
}

function safeUnlink(filePath) {
  try {
    precheckFs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/** Atomically write a SHA-256 checksummed gzipped JSON envelope. */
function writeSignedEnvelope(destination, record) {
  let temporary;
  try {
    const payload = JSON.stringify(record);
    if (Buffer.byteLength(payload) > PRECHECK_MAX_RAW) return false;
    const checksum = precheckCrypto.createHash('sha256').update(payload).digest('hex');
    const compressed = precheckZlib.gzipSync(JSON.stringify({ checksum, payload }));
    if (compressed.length > PRECHECK_MAX_COMPRESSED) return false;
    temporary = `${destination}.${precheckCrypto.randomBytes(8).toString('hex')}.tmp`;
    precheckFs.writeFileSync(temporary, compressed, { flag: 'wx', mode: 0o600 });
    precheckFs.renameSync(temporary, destination);
    return true;
  } catch (_) {
    if (temporary) try { safeUnlink(temporary); } catch (_) {}
    return false;
  }
}

/** Read and verify a bounded gzipped SHA-256 envelope, distinguishing missing vs corrupt files. */
function readSignedEnvelope(filePath) {
  try {
    const stat = precheckFs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PRECHECK_MAX_COMPRESSED) {
      return { status: 'corrupt', record: null };
    }
    const outer = JSON.parse(
      precheckZlib.gunzipSync(precheckFs.readFileSync(filePath), { maxOutputLength: PRECHECK_MAX_RAW + 1024 }).toString('utf8')
    );
    if (typeof outer?.payload !== 'string' || precheckCrypto.createHash('sha256').update(outer.payload).digest('hex') !== outer.checksum) {
      return { status: 'corrupt', record: null };
    }
    return { status: 'ok', record: JSON.parse(outer.payload) };
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'missing' : 'corrupt', record: null };
  }
}

function savePrecheckCache(entry, signature, data) {
  try {
    if (!PRECHECK_HASH_RE.test(signature) || !validPrecheckEvidence(data)) return false;
    const destination = precheckPathFor(entry);
    return writeSignedEnvelope(destination, { version: 1, sourceHash: entry.sourceHash, signature, data });
  } catch (_) {
    return false;
  }
}

function loadPrecheckCache(entry, signature) {
  try {
    if (!PRECHECK_HASH_RE.test(signature)) return null;
    const result = readSignedEnvelope(precheckPathFor(entry));
    if (result.status !== 'ok') return null;
    const record = result.record;
    if (record.version !== 1 || record.sourceHash !== entry.sourceHash || record.signature !== signature || !validPrecheckEvidence(record.data)) {
      return null;
    }
    return record.data;
  } catch (_) {
    return null;
  }
}

function removePrecheckCache(entry) {
  safeUnlink(precheckPathFor(entry));
}

/** Save split video/audio source precheck evidence at the source-scoped path. */
function saveSourcePrecheck(entry, signatures, data) {
  try {
    const videoSignature = String(signatures?.videoSignature || '');
    const audioSignature = signatures?.audioSignature ? String(signatures.audioSignature) : null;
    if (!PRECHECK_HASH_RE.test(videoSignature) || !validFrameScanEvidence(data?.frameScan)) return false;
    if (audioSignature !== null && (!PRECHECK_HASH_RE.test(audioSignature) || !validAudioPrecheckEvidence(data?.audio))) {
      return false;
    }
    const destination = sourcePrecheckPathFor(entry);
    const payloadData = {
      frameScan: data.frameScan,
      audio: audioSignature !== null ? data.audio : null
    };
    return writeSignedEnvelope(destination, {
      version: 2,
      sourceHash: entry.sourceHash,
      videoSignature,
      audioSignature,
      data: payloadData
    });
  } catch (_) {
    return false;
  }
}

/** Load source-scoped precheck evidence with independent video/audio hit state and miss reasons. */
function loadSourcePrecheck(entry, signatures) {
  const miss = (reason) => ({
    hit: 'none',
    frameScan: null,
    audio: null,
    videoReason: reason,
    audioReason: reason,
    migratedFromLegacy: false
  });
  try {
    const videoSignature = String(signatures?.videoSignature || '');
    const audioSignature = String(signatures?.audioSignature || '');
    if (!PRECHECK_HASH_RE.test(videoSignature) || !PRECHECK_HASH_RE.test(audioSignature)) {
      return miss('invalid_signature');
    }
    let result = readSignedEnvelope(sourcePrecheckPathFor(entry));
    let migratedFromLegacy = false;
    if (result.status === 'missing' && entry?.candidatePath && entry?.id) {
      try {
        const legacy = readSignedEnvelope(precheckPathFor(entry));
        if (legacy.status === 'ok' && legacy.record?.version === 2) {
          result = legacy;
          migratedFromLegacy = true;
        }
      } catch (_) {}
    }
    if (result.status !== 'ok') return miss(result.status);
    const record = result.record;
    if (record?.version !== 2) return miss('version_changed');
    if (record.sourceHash !== entry.sourceHash) return miss('source_hash_changed');

    const frameValid = validFrameScanEvidence(record.data?.frameScan);
    const videoMatch = frameValid && record.videoSignature === videoSignature;
    const videoReason = videoMatch ? 'matched' : (!frameValid ? 'corrupt' : 'video_signature_changed');

    const audioValid = validAudioPrecheckEvidence(record.data?.audio);
    const audioMatch = audioValid && record.audioSignature === audioSignature;
    const audioReason = audioMatch ? 'matched'
      : (record.data?.audio != null && !audioValid ? 'corrupt' : 'audio_signature_changed');

    const hit = (videoMatch && audioMatch) ? 'full'
      : videoMatch ? 'video_only'
      : audioMatch ? 'audio_only'
      : 'none';
    return {
      hit,
      frameScan: videoMatch ? record.data.frameScan : null,
      audio: audioMatch ? record.data.audio : null,
      videoReason,
      audioReason,
      migratedFromLegacy
    };
  } catch (_) {
    return miss('corrupt');
  }
}

function removeSourcePrecheck(entry) {
  safeUnlink(sourcePrecheckPathFor(entry));
  if (entry?.candidatePath && entry?.id) {
    try { safeUnlink(precheckPathFor(entry)); } catch (_) {}
  }
}

function saveCandidateFramesCache(entry, signature, frameScan) {
  try {
    const sig = String(signature || '');
    if (!PRECHECK_HASH_RE.test(sig) || !PRECHECK_HASH_RE.test(String(entry?.candidateHash || '')) || !validFrameScanEvidence(frameScan, { requireStaticInfo: false })) {
      return false;
    }
    const destination = candidateFramesPathFor(entry);
    return writeSignedEnvelope(destination, {
      version: 1,
      candidateHash: entry.candidateHash,
      signature: sig,
      frameScan
    });
  } catch (_) {
    return false;
  }
}

function loadCandidateFramesCache(entry, signature) {
  const miss = (reason) => ({ hit: false, frameScan: null, reason });
  try {
    const sig = String(signature || '');
    if (!PRECHECK_HASH_RE.test(sig)) return miss('invalid_signature');
    const result = readSignedEnvelope(candidateFramesPathFor(entry));
    if (result.status !== 'ok') return miss(result.status);
    const record = result.record;
    if (record?.version !== 1 || !validFrameScanEvidence(record.frameScan, { requireStaticInfo: false })) return miss('corrupt');
    if (record.candidateHash !== entry.candidateHash) return miss('candidate_hash_changed');
    if (record.signature !== sig) return miss('signature_changed');
    return { hit: true, frameScan: record.frameScan, reason: 'matched' };
  } catch (_) {
    return miss('corrupt');
  }
}

function removeCandidateFramesCache(entry) {
  safeUnlink(candidateFramesPathFor(entry));
}

if (typeof module !== 'undefined') {
  module.exports = {
    sourcePrecheckPathFor,
    candidateFramesPathFor,
    validFrameScanEvidence,
    validAudioPrecheckEvidence,
    savePrecheckCache,
    loadPrecheckCache,
    removePrecheckCache,
    saveSourcePrecheck,
    loadSourcePrecheck,
    removeSourcePrecheck,
    saveCandidateFramesCache,
    loadCandidateFramesCache,
    removeCandidateFramesCache
  };
}
