const sourceIdentityFs = require('node:fs');
const sourceIdentityCrypto = require('node:crypto');
const SOURCE_COMPARE_CHUNK_BYTES = 1024 * 1024;

function sourceIdentityReadChunk(fd, buffer, length, position) {
  let total = 0;
  while (total < length) {
    const count = sourceIdentityFs.readSync(fd, buffer, total, length - total, position + total);
    if (count === 0) break;
    total += count;
  }
  return total;
}

function compareOpenFileToPath(sourceFd, currentPath) {
  let currentFd;
  try {
    currentFd = sourceIdentityFs.openSync(currentPath, 'r');
    const sourceStat = sourceIdentityFs.fstatSync(sourceFd, { bigint: true });
    const currentStat = sourceIdentityFs.fstatSync(currentFd, { bigint: true });
    if (!sourceStat.isFile() || !currentStat.isFile() || sourceStat.size !== currentStat.size) {
      return { identical: false };
    }
    if (sourceStat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('File exceeds the safe positional-read limit');
    }

    const size = Number(sourceStat.size);
    const sourceBuffer = Buffer.allocUnsafe(SOURCE_COMPARE_CHUNK_BYTES);
    const currentBuffer = Buffer.allocUnsafe(SOURCE_COMPARE_CHUNK_BYTES);
    const sourceHash = sourceIdentityCrypto.createHash('sha256');
    const currentHash = sourceIdentityCrypto.createHash('sha256');
    for (let position = 0; position < size; position += SOURCE_COMPARE_CHUNK_BYTES) {
      const length = Math.min(SOURCE_COMPARE_CHUNK_BYTES, size - position);
      const sourceRead = sourceIdentityReadChunk(sourceFd, sourceBuffer, length, position);
      const currentRead = sourceIdentityReadChunk(currentFd, currentBuffer, length, position);
      if (sourceRead !== length || currentRead !== length) return { identical: false };
      const sourceChunk = sourceBuffer.subarray(0, length);
      const currentChunk = currentBuffer.subarray(0, length);
      if (!sourceChunk.equals(currentChunk)) return { identical: false };
      sourceHash.update(sourceChunk);
      currentHash.update(currentChunk);
    }
    const hash = sourceHash.digest('hex');
    if (hash !== currentHash.digest('hex')) return { identical: false };
    return { identical: true, hash };
  } finally {
    if (currentFd !== undefined) sourceIdentityFs.closeSync(currentFd);
  }
}

function hashFilePath(filePath) {
  const fd = sourceIdentityFs.openSync(filePath, 'r');
  try {
    const stat = sourceIdentityFs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new Error('Path is not a regular file');
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('File exceeds the safe positional-read limit');
    const size = Number(stat.size);
    const buffer = Buffer.allocUnsafe(SOURCE_COMPARE_CHUNK_BYTES);
    const hash = sourceIdentityCrypto.createHash('sha256');
    for (let position = 0; position < size; position += SOURCE_COMPARE_CHUNK_BYTES) {
      const length = Math.min(SOURCE_COMPARE_CHUNK_BYTES, size - position);
      const read = sourceIdentityReadChunk(fd, buffer, length, position);
      if (read !== length) throw new Error('File changed or ended during content verification');
      hash.update(buffer.subarray(0, length));
    }
    return hash.digest('hex');
  } finally {
    sourceIdentityFs.closeSync(fd);
  }
}

/** Hash a regular file asynchronously in 1 MB chunks, yielding to the event loop and emitting throttled progress. */
async function hashFileAsync(filePath, { chunkBytes = SOURCE_COMPARE_CHUNK_BYTES, onProgress = null, minIntervalMs = 0 } = {}) {
  const fd = sourceIdentityFs.openSync(filePath, 'r');
  try {
    const before = sourceIdentityFs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error('Path is not a regular file');
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('File exceeds the safe positional-read limit');
    const size = Number(before.size);
    const step = Number.isSafeInteger(chunkBytes) && chunkBytes > 0 ? chunkBytes : SOURCE_COMPARE_CHUNK_BYTES;
    const buffer = Buffer.allocUnsafe(step);
    const hash = sourceIdentityCrypto.createHash('sha256');
    let lastEmitMs = 0;
    const emit = (bytesRead, ratio, force = false) => {
      if (typeof onProgress !== 'function') return;
      const now = Date.now();
      if (!force && minIntervalMs > 0 && now - lastEmitMs < minIntervalMs) return;
      lastEmitMs = now;
      onProgress({ bytesRead, totalBytes: size, ratio });
    };
    if (size === 0) {
      emit(0, 1, true);
    } else {
      for (let position = 0; position < size; position += step) {
        const length = Math.min(step, size - position);
        const read = sourceIdentityReadChunk(fd, buffer, length, position);
        if (read !== length) throw new Error('File changed or ended during content verification');
        hash.update(buffer.subarray(0, length));
        const bytesRead = position + length;
        const done = bytesRead >= size;
        emit(bytesRead, bytesRead / size, done);
        if (!done) await new Promise(resolve => setImmediate(resolve));
      }
    }
    const after = sourceIdentityFs.fstatSync(fd, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error('File changed during content verification');
    }
    return hash.digest('hex');
  } finally {
    sourceIdentityFs.closeSync(fd);
  }
}

/** Compare a saved source snapshot against current stat metadata to classify identity drift vs ctime-only updates. */
function diffOriginalSnapshot(saved, currentStat, currentRealPath) {
  const sameField = (a, b) => String(a) === String(b);
  const changed = [];
  if (currentRealPath !== saved.realPath) changed.push('path');
  if (!sameField(currentStat.dev, saved.dev)) changed.push('device');
  if (!sameField(currentStat.ino, saved.ino)) changed.push('inode');
  if (!sameField(currentStat.size, saved.size)) changed.push('size');
  if (!sameField(currentStat.mtimeNs, saved.mtimeNs)) changed.push('mtime');
  if (!sameField(currentStat.ctimeNs, saved.ctimeNs)) changed.push('ctime');
  const sameStableMetadata = currentRealPath === saved.realPath
    && sameField(currentStat.size, saved.size)
    && sameField(currentStat.mtimeNs, saved.mtimeNs);
  const identityMoved = !sameField(currentStat.dev, saved.dev)
    || !sameField(currentStat.ino, saved.ino);
  const ctimeOnly = changed.length > 0 && sameStableMetadata && !identityMoved;
  return { changed, sameStableMetadata, identityMoved, ctimeOnly };
}

module.exports = { compareOpenFileToPath, hashFilePath, hashFileAsync, diffOriginalSnapshot };
